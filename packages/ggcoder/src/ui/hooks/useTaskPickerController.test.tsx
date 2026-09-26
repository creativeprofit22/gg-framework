import React from "react";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import type * as Os from "node:os";
import { render } from "ink";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, StreamResult, type Message, type Provider } from "@kenkaiiii/gg-ai";
import { z } from "zod";
import { useTaskPickerController } from "./useTaskPickerController.js";
import { useAgentLoop, type UseAgentLoopReturn } from "./useAgentLoop.js";
import { admitTerminalTask } from "../task-execution.js";
import {
  createTaskRecord,
  getNextRunnableTask,
  loadTasksSync,
  saveTasks,
} from "../../core/tasks-store.js";
import { QWEN_UNATTENDED_ERROR, isUnattendedWorker } from "../../core/provider-execution-policy.js";
import { childSubAgentEnv } from "../../tools/subagent-shared.js";
import { ScreenRecorder, makeRecordingStdout } from "../testing/screen-recorder.js";

vi.mock("node:os", async (original) => {
  const os = await original<typeof Os>();
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(os.tmpdir(), "terminal-qwen-policy-"));
  return { ...os, homedir: () => home };
});
// Only inference I/O is replaced. The hooks, reusable loop and task store are real.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stream: vi.fn(),
}));
afterAll(async () => {
  await rm(homedir(), { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(stream).mockReset();
});
const cwd = "terminal-qwen-policy-fixture";
const mount = (element: React.ReactElement) =>
  render(element, {
    stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })),
    patchConsole: false,
  });

it("rejects Run All before batch state, selection dispatch, task mutation or inference", async () => {
  const task = createTaskRecord("First", "Do first");
  await saveTasks(cwd, [task, createTaskRecord("Next", "Do next")]);
  const before = loadTasksSync(cwd);
  const onStartTask = vi.fn();
  const onRunAllTasksChange = vi.fn();
  const onError = vi.fn();
  let picker!: ReturnType<typeof useTaskPickerController>;
  function Harness() {
    picker = useTaskPickerController({
      displayedCwd: cwd,
      provider: "qwen-cloud",
      onStartTask,
      onRunAllTasksChange,
      onError,
    });
    return null;
  }
  const mounted = mount(<Harness />);
  try {
    await vi.waitFor(() => expect(picker).toBeDefined());
    picker.runAll();
    picker.runAll(task);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]![0].message).toBe(QWEN_UNATTENDED_ERROR);
    expect(onRunAllTasksChange).not.toHaveBeenCalled();
    expect(onStartTask).not.toHaveBeenCalled();
    expect(loadTasksSync(cwd)).toEqual(before);
    expect(stream).not.toHaveBeenCalled();
    picker.start(task);
    expect(onRunAllTasksChange).toHaveBeenCalledWith(false);
    expect(onStartTask).toHaveBeenCalledWith(task.title, task.prompt, task.id, false);
  } finally {
    mounted.unmount();
  }
});

it("rejects direct and remounted pending batch work before credentials or inference, without advancing the queue", async () => {
  const first = createTaskRecord("First", "Do first");
  const next = createTaskRecord("Next", "Do next");
  await saveTasks(cwd, [first, next]);
  const before = loadTasksSync(cwd);
  const resolveCredentials = vi.fn(async () => ({ apiKey: "sk-sp-fake-terminal-regression-key" }));
  const onDone = vi.fn();
  vi.mocked(stream).mockImplementation(
    () =>
      new StreamResult(
        (async function* () {
          yield { type: "text_delta", text: "Unexpected inference" };
          return {
            message: { role: "assistant", content: "Unexpected inference" },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        })(),
      ),
  );
  let loop!: UseAgentLoopReturn;
  const messages = { current: [] as Message[] };
  function Harness() {
    loop = useAgentLoop(
      messages,
      {
        provider: "qwen-cloud",
        model: "qwen-cloud/qwen3.8-max",
        tools: [],
        maxTokens: 100,
        resolveCredentials,
      },
      { onDone },
    );
    return null;
  }
  // Explicit pending metadata is serialized, not dependent on async-local context.
  const pendingAction = JSON.parse(JSON.stringify({ prompt: first.prompt, unattended: true }));
  for (let mountIndex = 0; mountIndex < 2; mountIndex++) {
    const mounted = mount(<Harness />);
    try {
      await vi.waitFor(() => expect(loop).toBeDefined());
      await expect(
        loop.run(pendingAction.prompt, { unattended: pendingAction.unattended }),
      ).rejects.toThrow(QWEN_UNATTENDED_ERROR);
      // Same admission used by App's delayed next-task callback, including after a provider switch.
      const selected = getNextRunnableTask(cwd)!;
      expect(() => admitTerminalTask("qwen-cloud", cwd, selected.id, true)).toThrow(
        QWEN_UNATTENDED_ERROR,
      );
      expect(loadTasksSync(cwd)).toEqual(before);
      expect(messages.current).toEqual([]);
      expect(onDone).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
    }
  }
});

it.each<[Provider, boolean, boolean]>([
  ["qwen-cloud", false, false],
  ["openai", true, true],
])(
  "preserves interactive work and propagates batch intent to delegated workers (%s, %s)",
  async (provider, unattended, expectedChildIntent) => {
    let loop!: UseAgentLoopReturn;
    const childIntents: boolean[] = [];
    const messages = { current: [] as Message[] };
    const task = createTaskRecord("Individual", "Do this task");
    await saveTasks(cwd, [task]);
    admitTerminalTask(provider, cwd, task.id, unattended);
    expect(loadTasksSync(cwd)[0]!.status).toBe("in-progress");
    function Harness() {
      loop = useAgentLoop(messages, {
        provider,
        model: provider === "qwen-cloud" ? "qwen-cloud/qwen3.8-max" : "gpt-5",
        apiKey: "sk-sp-fake-terminal-regression-key",
        maxTokens: 100,
        tools: [
          {
            name: "delegate",
            description: "Fixture delegated worker",
            parameters: z.object({}),
            execute: async () => {
              childIntents.push(isUnattendedWorker(childSubAgentEnv({})));
              return "Child completed";
            },
          },
        ],
      });
      return null;
    }
    let requests = 0;
    vi.mocked(stream).mockImplementation(
      () =>
        new StreamResult(
          (async function* () {
            requests++;
            if (requests === 1) {
              const call = { type: "tool_call" as const, id: "child", name: "delegate", args: {} };
              yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
              return {
                message: { role: "assistant", content: [call] },
                stopReason: "tool_use",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            }
            return {
              message: { role: "assistant", content: "Done" },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        ),
    );
    const mounted = mount(<Harness />);
    try {
      await vi.waitFor(() => expect(loop).toBeDefined());
      await loop.run(task.prompt, { unattended });
      expect(childIntents).toEqual([expectedChildIntent]);
      expect(stream).toHaveBeenCalledTimes(2);
      expect(vi.mocked(stream).mock.calls.every(([params]) => params.provider === provider)).toBe(
        true,
      );
      // Batch context must not contaminate the next user-started turn.
      await loop.run("Ordinary interactive follow-up");
      expect(isUnattendedWorker(childSubAgentEnv({}))).toBe(false);
      if (unattended) {
        // A completed allowed-provider batch turn must not admit the next task
        // after the user switches to Qwen during the auto-advance delay.
        const next = createTaskRecord("Next queued task", "Do next");
        await saveTasks(cwd, [{ ...task, status: "done" }, next]);
        const beforeAdvance = loadTasksSync(cwd);
        const selected = getNextRunnableTask(cwd)!;
        expect(selected.id).toBe(next.id);
        const inferenceCount = vi.mocked(stream).mock.calls.length;
        expect(() => admitTerminalTask("qwen-cloud", cwd, selected.id, true)).toThrow(
          QWEN_UNATTENDED_ERROR,
        );
        expect(loadTasksSync(cwd)).toEqual(beforeAdvance);
        expect(stream).toHaveBeenCalledTimes(inferenceCount);
      }
    } finally {
      mounted.unmount();
    }
  },
);

// Wiring assertions complement the real hook/store tests: both App branches must
// retain intent, and auto-advance must not mutate the queue before shared admission.
describe("App task intent wiring", () => {
  it("carries intent through direct, pending/remount and auto-advance paths", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toContain("admitTerminalTask(currentProvider, cwdRef.current, taskId, unattended)");
    expect(app).not.toContain("markTaskInProgress");
    expect(app).toContain("startTaskRef.current(next.title, next.prompt, next.id, true)");
    expect(app).toContain("pendingAction: { prompt: fullPrompt, unattended }");
    expect(app).toContain("agentLoop.run(fullPrompt, { unattended })");
    expect(app).toContain("agentLoop.run(action.prompt, { unattended: action.unattended })");
  });
});
