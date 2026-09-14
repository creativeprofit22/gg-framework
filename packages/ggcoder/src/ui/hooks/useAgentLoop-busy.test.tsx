import React from "react";
import { render } from "ink";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type Message } from "@kenkaiiii/gg-ai";
import { useAgentLoop, type UseAgentLoopReturn } from "./useAgentLoop.js";
import { submitPromptCommand } from "../submit-prompt-command.js";
import { ScreenRecorder, makeRecordingStdout } from "../testing/screen-recorder.js";
import { useFakeHome } from "../../test-support/fake-home.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "../../core/programmatic/profile.js";

// Only provider I/O is replaced; Ink, submission, the hook and agentLoop are real.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()), stream: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each([[false, false], [true, false], [false, true], [true, true]])("holds one terminal run owner with current setup=%s, abort=%s", async (approved, abort) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-busy-"));
  const restore = useFakeHome(path.join(cwd, "home"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(stream).mockClear();
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    started();
    await held;
    yield { type: "text_delta", text: "Fixture response" };
    return { message: { role: "assistant", content: "Fixture response" }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  const messages = { current: [] as Message[] };
  let loop!: UseAgentLoopReturn;
  const onQueuedStart = vi.fn();
  function Harness() {
    loop = useAgentLoop(messages, { provider: "openai", model: "gpt-5", tools: [], maxTokens: 100 }, { onQueuedStart });
    return null;
  }
  const mounted = render(<Harness />, { stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })), patchConsole: false });
  let running: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(loop).toBeDefined());
    if (approved) {
      const proposal = await buildProgrammaticProfileProposal(cwd);
      expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    }
    const profile = path.join(cwd, ".gg/programmatic/profile.json");
    const before = await fs.readFile(profile).catch(() => null);
    running = loop.run("initial request");
    // This submission races React's isRunning update, not just an already rendered busy UI.
    await expect(loop.run("overlapping request")).rejects.toThrow("Wait for the current work to finish");
    await ready;
    const signal = vi.mocked(stream).mock.calls[0]![0].signal!;
    for (const trimmed of ["/setup-programmatic", "/programmatic focus", "/programmatic-run"]) {
      const finalize = vi.fn();
      const display = vi.fn();
      expect(await submitPromptCommand({ cwd, trimmed, inputImages: [], currentModel: "gpt-5",
        isBusy: loop.isBusy, runAgent: loop.run, setLastUserMessage: vi.fn(), setDoneStatus: vi.fn(),
        finalizeSubmittedUserItem: finalize, setLiveItems: display, getId: () => "busy", reloadCustomCommands: vi.fn(),
      })).toBe(true);
      expect(finalize).not.toHaveBeenCalled();
      expect(JSON.stringify(display.mock.calls[0]![0]([]))).toContain("Wait for the current work to finish");
      expect(() => loop.queueMessage(trimmed)).toThrow("Wait for the current work to finish");
    }
    expect(stream).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    expect(messages.current.filter((m) => m.role === "user")).toHaveLength(1);
    expect(await fs.readFile(profile).catch(() => null)).toEqual(before);
    await expect(fs.stat(path.join(cwd, ".gg/programmatic/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    if (abort) {
      loop.abort();
      expect(signal.aborted).toBe(true);
      expect(loop.isBusy()).toBe(true);
      await expect(loop.run("teardown overlap")).rejects.toThrow("Wait for the current work to finish");
    }
    loop.queueMessage("ordinary first");
    loop.queueMessage("ordinary second");
    release();
    await running;
    expect(onQueuedStart).toHaveBeenCalledOnce();
    expect(String(onQueuedStart.mock.calls[0]![0])).toMatch(/ordinary first[\s\S]*ordinary second/);
    expect(loop.isBusy()).toBe(false);
    expect(loop.drainQueuedText()).toBe("");
    // Ownership is released after draining, allowing a later fresh submission.
    running = loop.run("later request");
    await running;
  } finally {
    release();
    await running?.catch(() => {});
    mounted.unmount();
    restore();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
