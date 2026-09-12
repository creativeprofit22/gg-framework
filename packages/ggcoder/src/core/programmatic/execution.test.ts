import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { handleAppSidecarProgrammaticExecution, settleProgrammaticRun } from "../../app-sidecar-programmatic-execution.js";
import { RunLifecycle } from "../run-lifecycle.js";
import { AppSidecarPlanGate } from "../../app-sidecar-plan-gate.js";
import { createRunEndPayload } from "@kenkaiiii/gg-core/desktop-session-ux";
import type { ProgrammaticExecutionOutcome } from "./execution.js";
import { ProcessManager } from "../process-manager.js";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { useFakeHome } from "../../test-support/fake-home.js";
import { AgentSession } from "../agent-session.js";
import * as bashTool from "../../tools/bash.js";
import { getPromptCommand } from "../prompt-commands.js";
import { discoverTauriPackages } from "../tauri-package/discover.js";
import { detectHostTarget } from "../tauri-package/paths.js";
import { createAskUserBridge, type AskUserRequest, type AskUserResult } from "../ask-user.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./profile.js";
import { runProgrammaticScan, PROGRAMMATIC_STATE_PATH } from "./lifecycle.js";
import { programmaticLifecycleStateV1Schema } from "./contracts.js";
import { executeProgrammaticOpportunity, createResearchCorpusTool, RESEARCH_TOOLS, EXECUTION_DEADLINE_MS, type ProgrammaticExecutionOptions } from "./execution.js";

let home: string;
let root: string;
let restoreHome: () => void;
let selected: string;
let sha256: string;
let condition: string;
let commandFile: string;
let requests: Record<string, unknown>[];
const providerUrl = "https://isolated-provider.invalid/openai/v1/responses";
const body = "EXACT GLOBAL SPECIALIST $ARGUMENTS — inspect package.json, then report evidence.";

async function state() {
  return programmaticLifecycleStateV1Schema.parse(JSON.parse(await fs.readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8")));
}
async function json(file: string, value: unknown) { await fs.writeFile(file, JSON.stringify(value)); }
function answer(request: AskUserRequest): Promise<AskUserResult> {
  const question = request.questions[0]!;
  return Promise.resolve({ action: "answer", answers: { [question.id]: question.options![0]!.value! } });
}
function options(extra: Partial<ProgrammaticExecutionOptions> = {}): ProgrammaticExecutionOptions {
  return { cwd: root, opportunityId: selected, configurationSha256: sha256, provider: "azure", model: "azure:fixture", baseUrl: providerUrl,
    signal: new AbortController().signal, ask: answer, cancelQuestions: vi.fn(), progress: vi.fn(), ...extra };
}
async function executeThroughApp(input: ProgrammaticExecutionOptions, expectedStatus: ProgrammaticExecutionOutcome["status"]) {
  const journal = { started: vi.fn(), finished: vi.fn() };
  const lifecycle = new RunLifecycle(undefined, journal);
  const broadcast = vi.fn();
  let result: ProgrammaticExecutionOutcome | undefined;
  await handleAppSidecarProgrammaticExecution({
    text: `/programmatic-run ${input.opportunityId} ${input.configurationSha256}`,
    attachmentCount: 0, busy: false, automated: false, codeMode: true, planMode: false,
    claimStart: () => true, respond: vi.fn(),
    execute: (selection) => executeProgrammaticOpportunity({ ...input, ...selection }),
    runAgent: async (_label, run) => {
      const { generation } = lifecycle.begin(() => {});
      result = await run();
      const settlement = settleProgrammaticRun(result)!;
      lifecycle.settle(generation, settlement.journalOutcome);
      broadcast("run_end", { ...settlement.event, ...createRunEndPayload(settlement.journalOutcome, lifecycle.state) });
    },
  });
  expect(result?.status).toBe(expectedStatus);
  const cancelled = expectedStatus === "cancelled" || expectedStatus === "rejected";
  const succeeded = expectedStatus === "succeeded";
  expect(journal.finished).toHaveBeenCalledExactlyOnceWith(1, cancelled ? "aborted" : succeeded ? "completed" : expectedStatus === "blocked" ? "unverified" : "failed");
  expect(broadcast).toHaveBeenCalledExactlyOnceWith("run_end", {
    ...(cancelled ? { cancelled: true } : expectedStatus === "blocked" ? { unverified: true } : {}),
    outcome: cancelled ? "cancelled" : succeeded ? "completed" : expectedStatus === "blocked" ? "unverified" : "failed",
    runState: "idle", programmaticResult: expect.objectContaining({ status: expectedStatus }),
  });
  expect(JSON.stringify(broadcast.mock.calls)).not.toContain("fixture-provider-failure");
  return result!;
}
function sse(events: Record<string, unknown>[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function responseTool(name: string, args: unknown, id: string) {
  const item = { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) };
  return sse([
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } },
  ]);
}
function textResponse() { return sse([{ type: "response.output_text.delta", delta: "Fixture specialist finished." }, { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } }]); }
function provider(respond?: (index: number) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== providerUrl) throw new Error("Unexpected fixture network destination.");
    requests.push(JSON.parse(String(init?.body)));
    if (respond) return respond(requests.length);
    if (requests.length === 1) return responseTool("read", { file_path: "package.json" }, "read-evidence");
    if (requests.length === 2) return responseTool("programmatic_result", { summary: "Fixture manifest inspected.", successCondition: condition, toolCallIds: ["read-evidence"] }, "complete");
    return textResponse();
  }));
}
beforeEach(async () => {
  requests = [];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "execution-home-"));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-project-"));
  restoreHome = useFakeHome(home);
  vi.stubEnv("AZURE_OPENAI_API_KEY", "fixture-not-a-credential");
  vi.stubEnv("AZURE_OPENAI_BASE_URL", providerUrl);
  vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "fixture");
  await fs.mkdir(path.join(home, ".gg/commands"), { recursive: true });
  await json(path.join(home, ".gg/settings.json"), { autoCompact: false, idealReviewEnabled: false, deferredBuiltinTools: true });
  commandFile = path.join(home, ".gg/commands/research.md");
  await fs.writeFile(commandFile, `---\nname: research\ndescription: fixture\n---\n${body}\n`);
  await fs.mkdir(path.join(root, "src-tauri"));
  await fs.writeFile(path.join(root, ".gitignore"), ".gg/\n");
  await fs.writeFile(path.join(root, "AGENTS.md"), "NECESSARY PROJECT INSTRUCTION SENTINEL\n");
  await json(path.join(root, "package.json"), { name: "fixture" });
  await fs.writeFile(path.join(root, "src-tauri/Cargo.toml"), "[package]\nname='fixture'\n");
  await json(path.join(root, "src-tauri/tauri.conf.json"), {});
  const proposal = await buildProgrammaticProfileProposal(root);
  expect((await persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  await runProgrammaticScan(root);
  const seeded = await state();
  selected = seeded.records[0]!.opportunity.identity.id;
  sha256 = seeded.configurationFingerprint.sha256;
  condition = seeded.records[0]!.opportunity.verification;
  seeded.records[0]!.opportunity.route = { status: "routable", specialistCommand: "research" };
  const other = structuredClone(seeded.records[0]!);
  other.opportunity.identity.id = "f".repeat(64);
  other.lifecycle.opportunity.id = other.opportunity.identity.id;
  other.opportunity.currentProcess = "UNRELATED OPPORTUNITY SENTINEL";
  seeded.records.push(other);
  seeded.records.sort((a, b) => a.opportunity.identity.id.localeCompare(b.opportunity.identity.id));
  await json(path.join(root, PROGRAMMATIC_STATE_PATH), seeded);
  const profileFile = path.join(root, ".gg/programmatic/profile.json");
  const profile = JSON.parse(await fs.readFile(profileFile, "utf8"));
  profile.profile.scanners[0].specialistCommand = "research";
  await json(profileFile, profile);
  provider();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  restoreHome();
  await Promise.all([home, root].map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

describe("real transient specialist execution (mocked provider HTTP only)", () => {
  it("rejects an idle planning parent without a checkpoint before any execution side effects", async () => {
    const parent = new AgentSession({ provider: "azure", model: "azure:fixture", baseUrl: providerUrl, cwd: root, transient: true, allowedTools: [], mcpEnabled: false, loadExtensions: false, projectCustomization: false });
    await parent.initialize();
    await parent.setPlanMode(true);
    const persistCheckpoint = vi.fn();
    const planGate = new AppSidecarPlanGate(parent.getAppMarkers(), persistCheckpoint);
    const broadcast = vi.fn(() => { bridge.cancelAll(); });
    const bridge = createAskUserBridge({ broadcast });
    const ask = vi.fn(bridge.park);
    const journal = { started: vi.fn(), finished: vi.fn() };
    const lifecycle = new RunLifecycle(undefined, journal);
    const before = await fs.readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8");
    const write = vi.spyOn(fs, "writeFile");
    const rename = vi.spyOn(fs, "rename");
    const execute = vi.fn((selection: { opportunityId: string; configurationSha256: string }) => executeProgrammaticOpportunity(options({ ...selection, ask, cancelQuestions: () => bridge.cancelAll() })));
    const claimStart = vi.fn(() => true);
    const respond = vi.fn();
    const runAgent = vi.fn(async (_label: string, run: () => Promise<ProgrammaticExecutionOutcome>) => {
      const { generation } = lifecycle.begin(() => {});
      const result = await run();
      lifecycle.settle(generation, settleProgrammaticRun(result)!.journalOutcome);
    });
    try {
      expect(parent.getPlanMode()).toBe(true);
      expect(planGate.current()).toBeNull();
      expect(lifecycle.state).toBe("idle");
      const input = {
        text: `/programmatic-run ${selected} ${sha256}`,
        attachmentCount: 0, busy: lifecycle.running, automated: false, codeMode: true,
        planMode: parent.getPlanMode(), claimStart, respond, runAgent, execute,
      };
      expect(await handleAppSidecarProgrammaticExecution(input)).toBe(true);
      expect(respond).toHaveBeenCalledExactlyOnceWith(403, { error: "programmatic_execution_plan_mode", message: "Plan mode only allows review. Turn it off before starting a task." });
      expect(claimStart).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(bridge.pendingCount).toBe(0);
      expect(journal.started).not.toHaveBeenCalled();
      expect(journal.finished).not.toHaveBeenCalled();
      expect(persistCheckpoint).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8")).toBe(before);
      expect(requests).toHaveLength(0);
    } finally {
      bridge.cancelAll();
      await parent.dispose();
    }
  });

  it("isolates context, executes the pinned global body, records evidence and persists no child transcript", async () => {
    const parent = new AgentSession({ provider: "azure", model: "azure:fixture", baseUrl: providerUrl, cwd: root, transient: true, systemPrompt: "PARENT HISTORY SENTINEL", allowedTools: [], mcpEnabled: false, loadExtensions: false, projectCustomization: false });
    await parent.initialize();
    const before = await state();
    const progress = vi.fn();
    try {
      const result = await executeThroughApp(options({ progress }), "succeeded");
      expect(result).toMatchObject({ status: "succeeded", summary: "Fixture manifest inspected." });
      expect(progress).toHaveBeenCalledWith("\n[research] read\n");
      const input = JSON.stringify(requests[0]);
      expect(input).toContain(body);
      expect(input).toContain("NECESSARY PROJECT INSTRUCTION SENTINEL");
      expect(input).not.toContain("PARENT HISTORY SENTINEL");
      expect(input).not.toContain("UNRELATED OPPORTUNITY SENTINEL");
      const tools = requests[0]!.tools as { name: string }[];
      expect(tools.map((tool) => tool.name)).toContain("read");
      expect(tools.every((tool) => RESEARCH_TOOLS.includes(tool.name))).toBe(true);
      expect(await state()).toMatchObject({ records: before.records.map((record) => record.opportunity.identity.id === selected ? { ...record, lifecycle: { ...record.lifecycle, state: "completed" } } : record) });
      const files = await fs.readdir(home, { recursive: true });
      expect(files.filter((file) => file.endsWith(".jsonl"))).toEqual([]);
    } finally { await parent.dispose(); }
  }, 20_000);

  it.each(["cancel", "replay", "drift", "shadow", "missing"])("fails closed for approval %s without provider dispatch", async (mode) => {
    const result = await executeProgrammaticOpportunity(options({ ask: async (request) => {
      if (mode === "cancel") return { action: "cancel" };
      if (mode === "replay") return { action: "answer", answers: { "old-request": request.questions[0]!.options![0]!.value! } };
      if (mode === "drift") await fs.appendFile(commandFile, "Changed command");
      if (mode === "missing") await fs.rm(commandFile);
      if (mode === "shadow") { await fs.mkdir(path.join(root, ".gg/commands")); await fs.writeFile(path.join(root, ".gg/commands/research.md"), "Project shadow"); }
      return answer(request);
    } }));
    expect(result.status).not.toBe("succeeded");
    expect(requests).toHaveLength(0);
    expect((await state()).records.find((record) => record.opportunity.identity.id === selected)!.lifecycle.state).toBe("discovered");
  });

  it("settles a rejected approval as aborted in the parent without provider dispatch", async () => {
    await executeThroughApp(options({ ask: async () => ({ action: "cancel" }) }), "rejected");
    expect(requests).toHaveLength(0);
  });

  it("rejects two selected IDs concurrently and consumes one fresh question-card answer", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const bridge = createAskUserBridge({ broadcast: () => release() });
    const first = executeProgrammaticOpportunity(options({ ask: bridge.park, cancelQuestions: () => bridge.cancelAll() }));
    await ready;
    const second = await executeProgrammaticOpportunity(options({ opportunityId: "f".repeat(64) }));
    expect(second).toMatchObject({ status: "rejected" });
    bridge.cancelAll();
    expect((await first).status).not.toBe("succeeded");
  });

  it.each(["text-only", "bad-evidence", "provider-failure", "cancel-run"])("never completes %s output", async (mode) => {
    const abort = new AbortController();
    provider((index) => {
      if (mode === "text-only") return textResponse();
      if (mode === "bad-evidence") return index === 1 ? responseTool("programmatic_result", { summary: "Claim only", successCondition: condition, toolCallIds: ["invented"] }, "bad") : textResponse();
      if (index === 1) return responseTool("read", { file_path: "package.json" }, "partial");
      if (mode === "cancel-run") { abort.abort(); return textResponse(); }
      return sse([{ type: "response.output_text.delta", delta: "Partial text" }, { type: "response.failed", response: { error: { message: "fixture-provider-failure" } } }]);
    });
    const progress = vi.fn();
    const result = await executeThroughApp(options({ signal: abort.signal, progress }), mode === "cancel-run" ? "cancelled" : "failed");
    expect(result.status).not.toBe("succeeded");
    if (mode === "provider-failure") expect(progress).toHaveBeenCalledWith("Partial text");
    expect((await state()).records.find((record) => record.opportunity.identity.id === selected)!.lifecycle.state).toBe("queued");
  }, 20_000);

  it("bounds approval timeout and cancellation without queuing unapproved work", async () => {
    const abort = new AbortController();
    const run = executeProgrammaticOpportunity(options({ signal: abort.signal, ask: async () => { abort.abort(); return { action: "cancel" }; } }));
    expect((await run).status).toBe("cancelled");
    expect(requests).toHaveLength(0);
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => realSetTimeout(callback, delay === EXECUTION_DEADLINE_MS ? 30 : delay, ...args));
    const timeout = await executeThroughApp(options({ ask: () => new Promise(() => {}) }), "failed");
    expect(timeout).toMatchObject({ status: "failed", summary: expect.stringContaining("timeout") });
  });

  it.each(["execution", "action", "plan"])("settles the matching parked %s approval at the bounded deadline", async (mode) => {
    if (mode !== "execution") {
      await fs.writeFile(path.join(home, ".gg/commands/setup-sweep.md"), "---\nname: setup-sweep\ndescription: fixture\n---\nAct only after approval.\n");
      const seeded = await state();
      seeded.records.forEach((record) => { record.opportunity.route = { status: "routable", specialistCommand: "setup-sweep" }; });
      await json(path.join(root, PROGRAMMATIC_STATE_PATH), seeded);
      const file = path.join(root, ".gg/programmatic/profile.json");
      const profile = JSON.parse(await fs.readFile(file, "utf8"));
      profile.profile.scanners[0].specialistCommand = "setup-sweep";
      await json(file, profile);
      await fs.mkdir(path.join(root, ".gg/plans"), { recursive: true });
      await fs.writeFile(path.join(root, ".gg/plans/test.md"), "## Steps\n1. Inspect the manifest.\n");
      provider((index) => index === 1 ? mode === "plan"
        ? responseTool("exit_plan", { plan_path: ".gg/plans/test.md" }, "plan")
        : responseTool("write", { file_path: "not-approved.txt", content: "never write" }, "mutate") : textResponse());
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let ready!: () => void;
    const parked = new Promise<void>((resolve) => { ready = resolve; });
    let promptId = "";
    let replay: AskUserResult = { action: "cancel" };
    const onSettled = vi.fn();
    const bridge = createAskUserBridge({ timeoutMs: EXECUTION_DEADLINE_MS * 2, onSettled, broadcast: (prompt) => {
      promptId = prompt.id;
      const question = prompt.questions[0]!;
      replay = { action: "answer", answers: { [question.id]: question.options![0]!.value! } };
      ready();
    } });
    const parent = new AbortController();
    const run = executeThroughApp(options({ signal: parent.signal, cancelQuestions: () => bridge.cancelAll(), ask: (request) => {
      const question = request.questions[0]!.question;
      const shouldPark = mode === "execution" || (mode === "action" ? question.startsWith("Allow this step (") : question.startsWith("Approve this task's plan?"));
      return shouldPark ? bridge.park(request) : answer(request);
    } }), "failed");
    await parked;
    expect(bridge.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(EXECUTION_DEADLINE_MS);
    expect(await run).toMatchObject({ status: "failed", summary: expect.stringContaining("timeout") });
    expect(parent.signal.aborted).toBe(false);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ id: promptId, action: "cancel" });
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.settle(promptId, replay)).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    if (mode === "execution") expect(requests).toHaveLength(0);
    await expect(fs.stat(path.join(root, "not-approved.txt"))).rejects.toThrow();
  }, 20_000);

  it("cancels during real initialization and ignores late completion events", async () => {
    const abort = new AbortController();
    const initialize = AgentSession.prototype.initialize;
    vi.spyOn(AgentSession.prototype, "initialize").mockImplementation(async function (this: AgentSession) {
      await initialize.call(this);
      abort.abort();
      this.eventBus.emit("agent_done", { totalTurns: 0, totalUsage: { inputTokens: 0, outputTokens: 0 } });
    });
    expect(await executeProgrammaticOpportunity(options({ signal: abort.signal }))).toMatchObject({ status: "cancelled" });
    expect(requests).toHaveLength(0);
    expect((await state()).records.find((record) => record.opportunity.identity.id === selected)!.lifecycle.state).toBe("queued");
  });

  it("times out a provider wait and releases its run only after settlement", async () => {
    const original = globalThis.setTimeout;
    let shorten = false;
    let expire: (() => void) | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === EXECUTION_DEADLINE_MS) expire = () => callback(...args);
      return original(callback, delay, ...args);
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      shorten = true;
      return new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new Error("Fixture provider aborted"));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener("abort", fail, { once: true });
        expect(expire).toBeDefined();
        queueMicrotask(() => expire!());
      });
    }));
    const result = await executeProgrammaticOpportunity(options());
    expect(shorten).toBe(true);
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("timeout") });
    expect((await state()).records.find((record) => record.opportunity.identity.id === selected)!.lifecycle.state).toBe("queued");
  });

  it.each(["kill-failed", "close-pending"])("retains ownership for a real managed %s survivor and ignores late cleanup", async (mode) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(),
    }) as unknown as ChildProcess;
    const cleanup = vi.fn(async () => { if (mode === "kill-failed") throw new Error("injected kill failure"); });
    const kill = vi.fn();
    const disposal = vi.spyOn(AgentSession.prototype, "dispose");
    const manager = new ProcessManager({
      spawn: () => { queueMicrotask(() => child.emit("spawn")); return child; },
      cleanupProcessTree: cleanup, killProcessTree: kill, reapProcessWrapper: vi.fn(),
    }, undefined, { backgroundLogRoot: path.join(root, "logs") });
    let id = "";
    const initialize = AgentSession.prototype.initialize;
    const initialization = vi.spyOn(AgentSession.prototype, "initialize").mockImplementation(async function (this: AgentSession) {
      await initialize.call(this);
      (this as unknown as { processManager: ProcessManager }).processManager = manager;
      id = (await manager.start("injected background task", root)).id;
    });
    const timeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 5_000 ? 50 : ms));
    const progress = vi.fn();
    try {
      const result = await executeProgrammaticOpportunity(options({ progress }));
      expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("cleanup-unresolved") });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(disposal).toHaveBeenCalledWith(undefined, true);
      expect(kill).not.toHaveBeenCalled();
      expect((await manager.readOutput(id)).isRunning).toBe(true);
      const before = await state();
      expect(before.records.find((record) => record.opportunity.identity.id === selected)!.lifecycle.state).toBe("running");
      expect(await executeProgrammaticOpportunity(options({ opportunityId: "f".repeat(64) }))).toMatchObject({ status: "rejected" });
      const count = progress.mock.calls.length;
      child.emit("close", 0, null);
      await manager.waitForExit(id, 1000);
      await disposal.mock.results[0]!.value.catch(() => {});
      const session = initialization.mock.contexts[0];
      if (!(session instanceof AgentSession)) throw new Error("Expected the initialized child session");
      session.eventBus.emit("text_delta", { text: "late output" });
      session.eventBus.emit("agent_done", { totalTurns: 1, totalUsage: { inputTokens: 0, outputTokens: 0 } });
      expect(progress).toHaveBeenCalledTimes(count);
      expect(await state()).toEqual(before);
      expect(await executeProgrammaticOpportunity(options({ opportunityId: "f".repeat(64) }))).toMatchObject({ status: "rejected" });
    } finally {
      child.emit("close", 0, null);
      await manager.waitForExit(id, 1000);
    }
  });

  it("retains running ownership when disposal fails", async () => {
    const dispose = AgentSession.prototype.dispose;
    vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(async function (this: AgentSession) {
      await dispose.call(this);
      throw new Error("fixture cleanup failed");
    });
    expect(await executeProgrammaticOpportunity(options())).toMatchObject({ status: "failed", summary: expect.stringContaining("cleanup-unresolved") });
    expect((await state()).records.find((record) => record.opportunity.identity.id === selected)!.lifecycle.state).toBe("running");
    expect(await executeProgrammaticOpportunity(options())).toMatchObject({ status: "rejected" });
  });

  it("exposes bounded Tauri discovery and real inspection to the isolated provider", async () => {
    const seeded = await state();
    seeded.records.forEach((record) => { record.opportunity.route = { status: "routable", specialistCommand: "setup-tauri-package" }; });
    await json(path.join(root, PROGRAMMATIC_STATE_PATH), seeded);
    const file = path.join(root, ".gg/programmatic/profile.json");
    const profile = JSON.parse(await fs.readFile(file, "utf8"));
    profile.profile.scanners[0].specialistCommand = "setup-tauri-package";
    await json(file, profile);
    provider((index) => {
      if (index === 1) return responseTool("tool_search", { query: "tauri_package" }, "discover");
      if (index === 2) return responseTool("tauri_package", { action: "inspect" }, "inspect");
      return textResponse();
    });
    const ask = vi.fn(answer);
    await executeProgrammaticOpportunity(options({ ask }));
    const names = (requests[0]!.tools as { name: string }[]).map(({ name }) => name);
    expect(names).toContain("tool_search");
    expect(names).toContain("tauri_package");
    expect(names.some((name) => /^(mcp__|spawn_agent|subagent|programmatic_scan|programmatic_profile|bash|write|edit)/.test(name))).toBe(false);
    expect(JSON.stringify(requests[0])).toContain(JSON.stringify(getPromptCommand("setup-tauri-package")!.prompt).slice(1, -1));
    expect(JSON.stringify(requests[2])).toContain('evidence_sha256');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it.each(["complete", "provider-failure", "cancel"])("settles an approved manifest write after %s and requires fresh approval", async (mode) => {
    await fs.writeFile(path.join(home, ".gg/commands/setup-sweep.md"), "---\nname: setup-sweep\ndescription: fixture\n---\nWrite only after approval.\n");
    const seeded = await state();
    seeded.records.forEach((record) => { record.opportunity.route = { status: "routable", specialistCommand: "setup-sweep" }; });
    await json(path.join(root, PROGRAMMATIC_STATE_PATH), seeded);
    const file = path.join(root, ".gg/programmatic/profile.json");
    const profile = JSON.parse(await fs.readFile(file, "utf8"));
    profile.profile.scanners[0].specialistCommand = "setup-sweep";
    await json(file, profile);
    const abort = new AbortController();
    provider((index) => {
      if (index === 1) return responseTool("read", { file_path: "package.json" }, "read-manifest");
      if (index === 2) return responseTool("write", { file_path: "package.json", content: '{"name":"changed-fixture"}\n' }, "write-manifest");
      if (mode === "cancel") { abort.abort(); return textResponse(); }
      if (mode === "provider-failure") return sse([{ type: "response.failed", response: { error: { message: "fixture-provider-failure" } } }]);
      if (index === 3) return responseTool("programmatic_result", { summary: "Manifest updated.", successCondition: condition, toolCallIds: ["write-manifest"] }, "complete");
      return textResponse();
    });
    const ask = vi.fn(answer);
    const result = await executeProgrammaticOpportunity(options({ ask, signal: abort.signal }));
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe('{"name":"changed-fixture"}\n');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(mode === "complete" ? "succeeded" : mode === "cancel" ? "cancelled" : "failed");
    const settled = await state();
    expect(settled.configurationRefreshRequired).toBe(true);
    expect(settled.configurationFingerprint.sha256).toBe(sha256);
    expect(result).toMatchObject({ evidence: { items: expect.arrayContaining([expect.objectContaining({ code: "configuration-refresh-required" })]) } });
    expect(settled.records.find((record) => record.opportunity.identity.id === selected)!.lifecycle.state).toBe(mode === "complete" ? "completed" : "queued");
    expect(settled.records.find((record) => record.opportunity.identity.id !== selected)).toEqual(seeded.records.find((record) => record.opportunity.identity.id !== selected));
    expect(await runProgrammaticScan(root)).toMatchObject({ ok: false, error: "stale-configuration" });
    const nextAsk = vi.fn(answer);
    expect(await executeProgrammaticOpportunity(options({ opportunityId: "f".repeat(64), ask: nextAsk }))).toMatchObject({ status: "rejected", reason: "preflight-rejected" });
    expect(nextAsk).not.toHaveBeenCalled();
    await fs.mkdir(path.join(root, "other-app/src-tauri"), { recursive: true });
    await json(path.join(root, "other-app/package.json"), { name: "other-fixture" });
    await json(path.join(root, "other-app/src-tauri/tauri.conf.json"), {});
    await fs.writeFile(path.join(root, "other-app/src-tauri/Cargo.toml"), "[package]\nname = 'other-fixture'\n");
    const fresh = await buildProgrammaticProfileProposal(root);
    expect(fresh.configurationFingerprint.sha256).not.toBe(sha256);
    expect((await persistProgrammaticProfile(root, fresh.configurationFingerprint, fresh.profile)).ok).toBe(true);
    expect((await runProgrammaticScan(root)).ok).toBe(true);
    const available = (await state()).records.find((record) => record.presence === "present" && record.lifecycle.state !== "completed");
    expect(available).toBeDefined();
    const refreshedAsk = vi.fn(async () => ({ action: "cancel" as const }));
    expect(await executeProgrammaticOpportunity(options({ opportunityId: available!.opportunity.identity.id, configurationSha256: fresh.configurationFingerprint.sha256, ask: refreshedAsk }))).toMatchObject({ status: "rejected", reason: "approval-rejected" });
    expect(refreshedAsk).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("refuses mutating actions after initial execution approval", async () => {
    await fs.writeFile(path.join(home, ".gg/commands/setup-sweep.md"), "---\nname: setup-sweep\ndescription: fixture\n---\nWrite only after approval.\n");
    const seeded = await state();
    seeded.records.forEach((record) => { record.opportunity.route = { status: "routable", specialistCommand: "setup-sweep" }; });
    await json(path.join(root, PROGRAMMATIC_STATE_PATH), seeded);
    const file = path.join(root, ".gg/programmatic/profile.json");
    const profile = JSON.parse(await fs.readFile(file, "utf8"));
    profile.profile.scanners[0].specialistCommand = "setup-sweep";
    await json(file, profile);
    provider((index) => index === 1 ? responseTool("write", { file_path: "not-approved.txt", content: "never write" }, "mutate") : textResponse());
    let asks = 0;
    const result = await executeProgrammaticOpportunity(options({ ask: (request) => ++asks === 1 ? answer(request) : Promise.resolve({ action: "cancel" }) }));
    expect(result.status).toBe("failed");
    expect(asks).toBe(2);
    await expect(fs.stat(path.join(root, "not-approved.txt"))).rejects.toThrow();
  });

  it("separately approves real Tauri setup, calibration and packaging while preserving evidence gates", async () => {
    await fs.cp(path.join(import.meta.dirname, "../tauri-package/__fixtures__/valid"), root, { recursive: true });
    const cli = path.join(root, "apps/desktop/node_modules/@tauri-apps/cli");
    await fs.mkdir(cli, { recursive: true });
    await json(path.join(cli, "package.json"), { version: "2.11.2", bin: { tauri: "./tauri.js" } });
    await fs.writeFile(path.join(cli, "tauri.js"), "module.exports = {};\n");
    const host = detectHostTarget();
    const binaries = path.join(root, "apps/desktop/src-tauri/binaries");
    await fs.mkdir(binaries, { recursive: true });
    await fs.writeFile(path.join(binaries, `helper-${host.rust_triple}${host.platform === "win32" ? ".exe" : ""}`), "sidecar\n");
    const proposal = await buildProgrammaticProfileProposal(root);
    expect((await persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    await runProgrammaticScan(root);
    const seeded = await state();
    const record = seeded.records.find(({ opportunity }) => opportunity.route.status === "routable" && opportunity.route.specialistCommand === "setup-tauri-package")!;
    selected = record.opportunity.identity.id;
    sha256 = seeded.configurationFingerprint.sha256;
    const discovery = await discoverTauriPackages(root);
    expect(discovery.targets).toHaveLength(1);
    const target_id = discovery.targets[0]!.target_id;
    const launch = vi.spyOn(bashTool, "executeForegroundCommand").mockRejectedValue(new Error("Packaging operation mocked: no process launched."));
    const actions = [
      ["tool_search", { query: "MCP, recursion and all tools" }],
      ["tauri_package", { action: "inspect" }],
      ["tauri_package", { action: "setup", target_id, evidence_sha256: discovery.evidence_sha256 }],
      ["tauri_package", { action: "setup", target_id, evidence_sha256: "0".repeat(64) }],
      ["tauri_package", { action: "setup", target_id, evidence_sha256: discovery.evidence_sha256 }],
      ["tauri_package", { action: "calibrate", target_id }],
      ["tauri_package", { action: "package", target_id }],
      ["tauri_package", { action: "package", target_id }],
      ["tauri_package", { action: "verify", target_id }],
      ["programmatic_scan", {}],
      ["bash", { command: "echo forbidden" }],
      ["mcp__unapproved__write", {}],
      ["spawn_agent", { task_name: "forbidden", task: "never run" }],
    ] as const;
    provider(async (index) => {
      if (index === 4 || index === 5) {
        await expect(fs.stat(path.join(root, "scripts/package-tauri.config.json"))).rejects.toThrow();
      }
      const call = actions[index - 1];
      return call ? responseTool(call[0], call[1], `action-${index}`) : textResponse();
    });
    const approvedActions: string[] = [];
    const ask = vi.fn(async (request: AskUserRequest) => {
      const question = request.questions[0]!;
      if (question.question.startsWith("Allow /")) return answer(request);
      const action = JSON.parse(question.detail!).action as string;
      approvedActions.push(action);
      if (approvedActions.length === 1 || action === "calibrate" || (action === "package" && approvedActions.filter((value) => value === "package").length === 2)) {
        return { action: "cancel" } as const;
      }
      return answer(request);
    });
    const result = await executeProgrammaticOpportunity(options({ ask }));
    expect(result.status).toBe("failed");
    expect(approvedActions).toEqual(["setup", "setup", "setup", "calibrate", "package", "package"]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].command).toBe("tauri_package package");
    const transcript = JSON.stringify(requests.at(-1));
    expect(transcript).toContain("stale-evidence");
    expect(transcript).toContain('changed\\":true');
    expect(transcript).toContain("Tool execution was not approved");
    expect(transcript).toContain("Packaging operation mocked");
    for (const name of ["programmatic_scan", "bash", "mcp__unapproved__write", "spawn_agent"]) {
      expect(transcript).toContain(`Unknown tool: ${name}`);
    }
    for (const request of requests) {
      const names = (request.tools as { name: string }[]).map(({ name }) => name);
      expect(names).toContain("tauri_package");
      expect(names.some((name) => /^(mcp__|spawn_agent|subagent|programmatic_scan|bash|write|edit)/.test(name))).toBe(false);
    }
  }, 20_000);

  it.each(["missing-tool", "unsupported-action"])("fails Tauri preflight without provider dispatch for %s", async (mode) => {
    const seeded = await state();
    seeded.records.forEach((record) => { record.opportunity.route = { status: "routable", specialistCommand: "setup-tauri-package" }; });
    await json(path.join(root, PROGRAMMATIC_STATE_PATH), seeded);
    const file = path.join(root, ".gg/programmatic/profile.json");
    const profile = JSON.parse(await fs.readFile(file, "utf8"));
    profile.profile.scanners[0].specialistCommand = "setup-tauri-package";
    await json(file, profile);
    const supports = AgentSession.prototype.supportsToolCall;
    vi.spyOn(AgentSession.prototype, "supportsToolCall").mockImplementation(function (this: AgentSession, name, args) {
      if (name === "tauri_package" && (mode === "missing-tool" || (args as { action?: string } | undefined)?.action === "calibrate")) return false;
      return supports.call(this, name, args);
    });
    expect(await executeProgrammaticOpportunity(options())).toMatchObject({ status: "rejected", reason: "specialist-tools-unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("excludes initial, deferred, late MCP and stale tool references", async () => {
    const session = new AgentSession({ provider: "azure", model: "azure:fixture", baseUrl: providerUrl, cwd: root, transient: true, projectCustomization: false, loadExtensions: false, mcpEnabled: false, allowedTools: RESEARCH_TOOLS });
    session.setToolCapabilityPolicy({ allowedToolNames: RESEARCH_TOOLS });
    await session.initialize();
    try {
      const live = () => (session as unknown as { tools: AgentTool[] }).tools;
      expect(live().every((tool) => RESEARCH_TOOLS.includes(tool.name))).toBe(true);
      const execute = vi.fn(() => "forbidden");
      session.registerTool({ name: "mcp__mixed__write", parameters: z.object({}), description: "fixture", execute });
      expect(live().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
      const stale = live().find((tool) => tool.name === "read")!;
      session.setToolCapabilityPolicy({ allowedToolNames: [] });
      await expect(stale.execute({ file_path: "package.json" }, { toolCallId: "stale", signal: new AbortController().signal } as ToolContext)).rejects.toThrow("capability");
      expect(execute).not.toHaveBeenCalled();
      const corpus = createResearchCorpusTool("never-launch-this-binary");
      for (const args of [{ action: "add", repos: ["owner/repo"] }, { action: "discover", query: "repo", add: true }]) {
        await expect(corpus.execute(args, { signal: new AbortController().signal } as ToolContext)).rejects.toThrow("mutation");
      }
    } finally { await session.dispose(); }
  });
});
