import React from "react";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { createProgrammaticProfileTool } from "../../tools/programmatic-profile.js";
import { createCommandInformationTool } from "../../tools/command-information.js";
import { createProgrammaticScanTool } from "../../tools/programmatic-scan.js";
import { createReadTool } from "../../tools/read.js";
import { createFindTool } from "../../tools/find.js";
import { NotLoggedInError } from "../../core/auth-storage.js";
import { ASSESSMENT_EVIDENCE_LIMITS } from "../../core/programmatic/assessment-evidence.js";
import type { AgentLoopOptions } from "./useAgentLoop.js";
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
      expect(params.tools!.map((tool) => tool.name)).toEqual(["programmatic_profile", "programmatic_advisory_result"]);
      const prompt = params.messages.find((message) => message.role === "user")!.content as string;
      results.set("host-inspect", prompt.split("Host-owned exact facts (not model authority; already collected, do not repeat):\n")[1]!.split("\nReusable host evidence receipts:")[0]!);
      call = { type: "tool_call", id: "inspect", name: "programmatic_profile", args: { action: "inspect" } };
    }
    if (request === 2 || request === 4) {
      const proposal = JSON.parse(results.get("host-inspect")!).setupFacts;
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
    expect(results.get("inspect")).toContain("already inspected");
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

async function assessmentFixture(run: (fixture: {
  cwd: string; tools: AgentTool[]; messages: { current: Message[] }; loop: UseAgentLoopReturn;
  profile: ReturnType<typeof createProgrammaticProfileTool>; scan: AgentTool;
  submit: (command: string) => Promise<boolean>; rerender: (options: Partial<AgentLoopOptions>) => void;
}) => Promise<void>) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-assessment-"));
  const restore = useFakeHome(path.join(cwd, "home"));
  const profile = createProgrammaticProfileTool(cwd);
  const scan = createProgrammaticScanTool(cwd);
  const tools: AgentTool[] = [profile, scan, createCommandInformationTool(cwd), createReadTool(cwd), createFindTool(cwd),
    { name: "write", description: "No mutation", parameters: z.object({}), execute: vi.fn(async () => "ordinary write") }];
  const messages = { current: [] as Message[] };
  let loop!: UseAgentLoopReturn;
  function Harness({ options = {} }: { options?: Partial<AgentLoopOptions> }) {
    loop = useAgentLoop(messages, { provider: "openai", model: "gpt-5", tools, maxTokens: 100, ...options });
    return null;
  }
  const mounted = render(<Harness />, { stdout: makeRecordingStdout(new ScreenRecorder({ columns: 80, rows: 24 })), patchConsole: false });
  vi.mocked(stream).mockReset();
  try {
    await vi.waitFor(() => expect(loop).toBeDefined());
    await run({ cwd, tools, messages, loop, profile, scan,
      submit: (trimmed) => submitPromptCommand({ cwd, trimmed, inputImages: [], currentModel: "gpt-5", isBusy: loop.isBusy,
        runAgent: loop.run, setLastUserMessage: vi.fn(), setDoneStatus: vi.fn(), finalizeSubmittedUserItem: vi.fn(),
        setLiveItems: vi.fn(), getId: () => "assessment", reloadCustomCommands: vi.fn() }),
      rerender: (options) => mounted.rerender(<Harness options={options} />),
    });
  } finally { mounted.unmount(); profile.dispose(); restore(); await fs.rm(cwd, { recursive: true, force: true }); }
}

const emptyAdvice: ToolCall = { type: "tool_call", id: "advice", name: "programmatic_advisory_result", args: {
  version: 2, kind: "advisory", coverage: { status: "limited", scope: "Fixture", reason: "Bounded scripted provider" }, recommendations: [],
} };
function scriptAssessment(calls: ToolCall[], inspect?: (params: Parameters<typeof stream>[0]) => void) {
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    inspect?.(params);
    const call = calls.shift();
    if (call) {
      yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
      return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { message: { role: "assistant", content: "Scripted result" }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
}
function assessmentSummary(messages: Message[]) {
  const result = [...messages].reverse().find((message) => message.role === "assistant" && typeof message.content === "string" && message.content.startsWith("## Needs assessment\n\n"));
  return JSON.parse((result!.content as string).slice("## Needs assessment\n\n".length));
}

it.each((["setup", "configured"] as const).flatMap((mode) => [" \t\r\n ", "packaging", "  café\n日本語\r\n\tpackaging  "].map((focus) => ({ mode, focus }))))("prepares manifest-free $mode with focus $focus, exact facts and bounded evidence", async ({ mode, focus }) => {
  await assessmentFixture(async ({ cwd, tools, messages, loop, profile, scan, submit }) => {
    await fs.writeFile(path.join(cwd, "WORKFLOW"), "Handwritten dispatch ledger reconciliation");
    const proposal = await buildProgrammaticProfileProposal(cwd);
    if (mode === "configured") expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    const inspect = vi.spyOn(profile, "execute");
    const scanned = vi.spyOn(scan, "execute");
    const before = await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json")).catch(() => null);
    let prompt = "";
    scriptAssessment([{ type: "tool_call", id: "local", name: "read", args: { file_path: "WORKFLOW" } }, emptyAdvice], (params) => {
      expect(params.provider).toBe("openai");
      expect(params.model).toBe("gpt-5");
      const names = params.tools!.map((tool) => tool.name);
      expect(names).toContain("read"); expect(names).toContain("find"); expect(names).toContain("programmatic_advisory_result");
      expect(names).not.toContain("write"); expect(names).not.toContain("tool_search");
      if (mode === "setup") expect(names).not.toContain("programmatic_scan");
      prompt ||= params.messages.find((message) => message.role === "user")!.content as string;
    });
    await submit(`${mode === "setup" ? "/setup-programmatic" : "/programmatic"} ${focus}`);
    const context = JSON.parse(prompt.slice(prompt.indexOf("{", prompt.indexOf("## Untrusted advisory context"))));
    expect(context.assessment).toEqual({ version: 1, ...(focus.trim() ? { focus: focus.trim() } : {}) });
    expect(context.intent).toBe(focus.trim() ? "focused-assessment" : "general-assessment");
    expect(context.commands.entries.length).toBeGreaterThan(0);
    expect(context.commands.entries.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(context.commands).length).toBeLessThanOrEqual(32_000);
    expect(context.evidence.excerpts).toContainEqual({ path: "WORKFLOW", text: "Handwritten dispatch ledger reconciliation", truncated: false });
    expect(Buffer.byteLength(JSON.stringify(context.evidence))).toBeLessThanOrEqual(ASSESSMENT_EVIDENCE_LIMITS.maxDeliveredBytes);
    const facts = JSON.parse(prompt.split("Host-owned exact facts (not model authority; already collected, do not repeat):\n")[1]!.split("\nReusable host evidence receipts:")[0]!);
    if (mode === "setup") {
      expect(inspect).toHaveBeenCalledExactlyOnceWith({ action: "inspect" }, expect.anything());
      expect(facts.setupFacts).toMatchObject({ profile: proposal.profile, configuration_fingerprint: proposal.configurationFingerprint, expected_prior_profile_digest: null });
      expect(scanned).not.toHaveBeenCalled();
      await expect(fs.access(path.join(cwd, ".gg/programmatic/state.json"))).rejects.toThrow();
    } else {
      expect(scanned).toHaveBeenCalledExactlyOnceWith({}, expect.anything());
      expect(inspect).not.toHaveBeenCalled();
      expect(facts.scanFacts).toMatchObject({ ok: true, scan_counts: { enabledCount: 0, applicableCount: 0 } });
    }
    expect(assessmentSummary(messages.current)).toMatchObject({ mode, status: "completed", deterministic: mode === "setup" ? { status: "not-run", reason: "setup" } : { status: "succeeded", enabledCount: 0, applicableCount: 0 } });
    expect(assessmentSummary(messages.current).coverage).toContainEqual(expect.objectContaining({ scope: "project", status: "inspected" }));
    expect(await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json")).catch(() => null)).toEqual(before);
    expect(tools.find((tool) => tool.name === "write")!.execute).not.toHaveBeenCalled();
    scriptAssessment([{ type: "tool_call", id: "ordinary", name: "write", args: {} }]);
    await loop.run("Ordinary later work");
    expect(tools.find((tool) => tool.name === "write")!.execute).toHaveBeenCalledOnce();
  });
});

it.each(["scan-unavailable", "scan-failed", "model-unavailable", "cancelled"] as const)("retains independent terminal outcomes: %s", async (scenario) => {
  await assessmentFixture(async ({ cwd, tools, messages, loop, scan, submit, rerender }) => {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    const scanned = vi.spyOn(scan, "execute");
    if (scenario === "scan-unavailable") tools.splice(tools.indexOf(scan), 1);
    if (scenario === "scan-failed") await fs.writeFile(path.join(cwd, ".gg/programmatic/state.json"), "corrupt");
    if (scenario === "model-unavailable") {
      rerender({ resolveCredentials: async () => { throw new NotLoggedInError("openai"); } });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    scriptAssessment([emptyAdvice], () => { if (scenario === "cancelled") loop.abort(); });
    await submit("/programmatic");
    expect(scanned).toHaveBeenCalledTimes(scenario === "scan-unavailable" ? 0 : 1);
    if (scanned.mock.calls.length) expect(scanned.mock.calls[0]![0]).toEqual({});
    expect(assessmentSummary(messages.current)).toMatchObject({
      status: scenario === "model-unavailable" ? "unavailable" : scenario === "cancelled" ? "cancelled" : "completed",
      deterministic: { status: scenario === "scan-unavailable" ? "unavailable" : scenario === "scan-failed" ? "failed" : "succeeded" },
    });
    if (scenario === "model-unavailable") expect(stream).not.toHaveBeenCalled();
    expect(loop.isBusy()).toBe(false);
  });
});

it("rejects a model's second scan and restores ordinary queued permissions after cancelling host work", async () => {
  await assessmentFixture(async ({ cwd, tools, messages, loop, scan, submit }) => {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    const scanned = vi.spyOn(scan, "execute");
    scriptAssessment([{ type: "tool_call", id: "repeat", name: "programmatic_scan", args: {} }, emptyAdvice]);
    await submit("/programmatic");
    expect(scanned).toHaveBeenCalledExactlyOnceWith({}, expect.anything());
    expect(JSON.stringify(messages.current)).toContain("one unchanged programmatic_scan with {} only");
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    scanned.mockImplementationOnce(async (_args, context) => { entered(); await held; context.signal.throwIfAborted(); return "unreachable"; });
    const pending = submit("/programmatic");
    try {
      await ready;
      expect(loop.isBusy()).toBe(true);
      await expect(loop.run("overlap")).rejects.toThrow("Wait for the current work to finish");
      loop.abort();
      loop.queueMessage("ordinary queued work");
      scriptAssessment([{ type: "tool_call", id: "queued-write", name: "write", args: {} }]);
      release(); await pending;
      expect(assessmentSummary(messages.current)).toMatchObject({ status: "cancelled", deterministic: { status: "cancelled" } });
      expect(tools.find((tool) => tool.name === "write")!.execute).toHaveBeenCalledOnce();
      expect(loop.isBusy()).toBe(false);
    } finally { release(); await pending; }
  });
});

it("rechecks bounded evidence after credentials and refuses replaced read registrations", async () => {
  await assessmentFixture(async ({ cwd, tools, messages, submit, rerender }) => {
    await fs.writeFile(path.join(cwd, "WORKFLOW"), "revoked-evidence-marker");
    const read = tools.find((tool) => tool.name === "read")!;
    const replacement = { ...read, execute: vi.fn(read.execute) };
    rerender({ resolveCredentials: async () => {
      tools.splice(tools.indexOf(read), 1, replacement);
      return { apiKey: "fixture" };
    } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    scriptAssessment([{ type: "tool_call", id: "replaced-read", name: "read", args: { file_path: "WORKFLOW" } }, emptyAdvice]);
    await submit("/setup-programmatic");
    expect(JSON.stringify(vi.mocked(stream).mock.calls)).not.toContain("revoked-evidence-marker");
    expect(replacement.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(messages.current)).toContain("Tool unavailable in read-only advisory scope");
    expect(assessmentSummary(messages.current).limitations).toContain("Initial evidence was denied by host permissions; omitted content remains uninspected.");
  });
});

it("retains post-cap lead provenance instead of claiming a capped terminal read was inspected", async () => {
  await assessmentFixture(async ({ cwd, tools, messages, submit }) => {
    await fs.writeFile(path.join(cwd, "WORKFLOW"), "bounded sample");
    const read = tools.find((tool) => tool.name === "read")!;
    // Exercise the real loop's cap and onResultPrepared boundary with a large tool result.
    vi.spyOn(read, "execute").mockResolvedValue("source line\n".repeat(100_000));
    scriptAssessment([{ type: "tool_call", id: "capped-read", name: "read", args: { file_path: "WORKFLOW" } }, emptyAdvice]);
    await submit("/setup-programmatic");
    const summary = assessmentSummary(messages.current);
    expect(summary.status).toBe("completed");
    expect(summary.limitations).toContain("Tool call capped-read: source delivery was capped; complete inspection is not established.");
    expect(summary.coverage).not.toContainEqual(expect.objectContaining({ scope: "project", status: "inspected" }));
  });
});

it("saves exact setup only in a separate ordinary turn with a separate human review", async () => {
  await assessmentFixture(async ({ cwd, tools, loop, profile, submit }) => {
    const review = vi.fn<NonNullable<NonNullable<Parameters<typeof createProgrammaticProfileTool>[1]>["reviewer"]>>(async (request) => ({ action: "answer", answers: { [request.questions[0]!.id]: "save-setup" } }));
    const reviewed = createProgrammaticProfileTool(cwd, { reviewer: review });
    tools.splice(tools.indexOf(profile), 1, reviewed);
    const proposal = await buildProgrammaticProfileProposal(cwd);
    const save: ToolCall = { type: "tool_call", id: "save", name: "programmatic_profile", args: {
      action: "generate", configuration_fingerprint: proposal.configurationFingerprint, profile: proposal.profile, expected_prior_profile_digest: null,
    } };
    try {
      scriptAssessment([save, emptyAdvice]);
      await submit("/setup-programmatic");
      expect(review).not.toHaveBeenCalled();
      await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
      scriptAssessment([save]);
      await loop.run("Review saving these exact settings now.");
      expect(review).toHaveBeenCalledOnce();
      expect(JSON.parse(await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json"), "utf8"))).toEqual({
        version: 3, profile: proposal.profile, configurationFingerprint: proposal.configurationFingerprint,
        configurationSnapshot: proposal.configurationSnapshot,
        historyPolicy: { version: 1, enabled: true },
      });
    } finally { reviewed.dispose(); }
  });
});

it("does not erase a committed scan when terminal cancellation arrives before the provider", async () => {
  await assessmentFixture(async ({ cwd, tools, messages, loop, scan, submit }) => {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile);
    const mutated = vi.fn(() => loop.abort());
    const committedScan = createProgrammaticScanTool(cwd, { onFileMutated: mutated });
    const execute = vi.spyOn(committedScan, "execute");
    tools.splice(tools.indexOf(scan), 1, committedScan);
    scriptAssessment([]);
    await submit("/programmatic");
    expect(assessmentSummary(messages.current)).toMatchObject({ status: "cancelled", deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 } });
    expect(execute).toHaveBeenCalledExactlyOnceWith({}, expect.anything());
    expect(mutated).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
    expect(loop.isBusy()).toBe(false);
  });
});
