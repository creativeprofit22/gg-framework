import React from "react";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { createProgrammaticProfileTool } from "../../tools/programmatic-profile.js";
import { createCommandInformationTool } from "../../tools/command-information.js";
import { render } from "ink";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type Message, type ToolCall } from "@kenkaiiii/gg-ai";
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

it("enforces inspect-only setup in terminal submission and fails closed on later unsupported generation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-setup-"));
  const restore = useFakeHome(path.join(cwd, "home"));
  const profileTool = createProgrammaticProfileTool(cwd);
  const write = vi.fn(async () => "must not execute");
  const tools: AgentTool[] = [profileTool, { name: "write", description: "Fixture", parameters: z.object({}), execute: write }];
  const messages = { current: [] as Message[] };
  let loop!: UseAgentLoopReturn;
  function Harness() {
    loop = useAgentLoop(messages, { provider: "openai", model: "gpt-5", tools, maxTokens: 100 });
    return null;
  }
  const mounted = render(<Harness />, { stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })), patchConsole: false });
  let request = 0;
  let generation: ToolCall["args"];
  const results = new Map<string, string>();
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    for (const message of params.messages) if (message.role === "tool") for (const result of message.content)
      results.set(result.toolCallId, String(result.content));
    request++;
    let call: ToolCall | undefined;
    if (request === 1) {
      expect(params.tools!.map((tool) => tool.name)).toEqual(["programmatic_profile"]);
      call = { type: "tool_call", id: "inspect", name: "programmatic_profile", args: { action: "inspect" } };
    }
    if (request === 2 || request === 4) {
      const proposal = JSON.parse(results.get("inspect")!);
      generation = { action: "generate", configuration_fingerprint: proposal.configuration_fingerprint,
        profile: proposal.profile, expected_prior_profile_digest: proposal.expected_prior_profile_digest };
      call = { type: "tool_call", id: `generate-${request}`, name: "programmatic_profile", args: generation };
    }
    if (call) {
      yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
      return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { message: { role: "assistant", content: "Fixture" }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await vi.waitFor(() => expect(loop).toBeDefined());
    await submitPromptCommand({ cwd, trimmed: "/setup-programmatic", inputImages: [], currentModel: "gpt-5", isBusy: loop.isBusy,
      runAgent: loop.run, setLastUserMessage: vi.fn(), setDoneStatus: vi.fn(), finalizeSubmittedUserItem: vi.fn(),
      setLiveItems: vi.fn(), getId: () => "setup", reloadCustomCommands: vi.fn() });
    expect(results.get("generate-2")).toContain("inspect-only");
    await loop.run("Save that proposed setup");
    expect(results.get("generate-4")).toContain("unsupported-host");
    expect(write).not.toHaveBeenCalled();
    await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
  } finally { profileTool.dispose(); mounted.unmount(); restore(); await fs.rm(cwd, { recursive: true, force: true }); }
});

it("provides the result tool and excludes mutation authority in the actual terminal loop", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-advisory-"));
  const restore = useFakeHome(path.join(cwd, "home"));
  const tools: AgentTool[] = [createCommandInformationTool(cwd), { name: "write", description: "Fixture", parameters: z.object({}), execute: async () => "must not execute" }];
  let loop!: UseAgentLoopReturn;
  const messages = { current: [] as Message[] };
  function Harness() {
    loop = useAgentLoop(messages, { provider: "openai", model: "gpt-5", tools, maxTokens: 100 });
    return null;
  }
  const mounted = render(<Harness />, { stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })), patchConsole: false });
  try {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    await vi.waitFor(() => expect(loop).toBeDefined());
    vi.mocked(stream).mockClear();
    vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
      yield { type: "text_delta", text: "Fixture" };
      return { message: { role: "assistant", content: "Fixture" }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    })()));
    await submitPromptCommand({ cwd, trimmed: "/programmatic", inputImages: [], currentModel: "gpt-5", isBusy: loop.isBusy, runAgent: loop.run, setLastUserMessage: vi.fn(), setDoneStatus: vi.fn(), finalizeSubmittedUserItem: vi.fn(), setLiveItems: vi.fn(), getId: () => "fixture", reloadCustomCommands: vi.fn() });
    const names = vi.mocked(stream).mock.calls[0]![0].tools!.map((tool) => tool.name);
    expect(names).toContain("programmatic_advisory_result");
    expect(names).not.toContain("write");
  } finally {
    mounted.unmount(); restore(); await fs.rm(cwd, { recursive: true, force: true });
  }
});

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
