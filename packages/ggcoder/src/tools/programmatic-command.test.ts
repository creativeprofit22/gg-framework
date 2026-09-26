import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentLoop, type AgentTool } from "@kenkaiiii/gg-agent";
import { stream, StreamResult, type ToolCall } from "@kenkaiiii/gg-ai";
import { ASK_USER_TIMEOUT_MS, createAskUserBridge, type AskUserPrompt } from "../core/ask-user.js";
import { commandCreationReviewer } from "../core/programmatic/command-creation.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { createProgrammaticCommandTool, ProgrammaticCommandParams } from "./programmatic-command.js";
import { createCommandInformationTool, checkAdvisoryCommandSnapshot } from "./command-information.js";
import { discoverCommands } from "../core/command-discovery.js";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), stream: vi.fn(),
}));

async function guardedRun(tool: AgentTool, args: Record<string, unknown>) {
  let request = 0;
  let output: unknown;
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    if (++request === 1) {
      const call: ToolCall = { type: "tool_call", id: "guarded-command", name: tool.name, args };
      yield { type: "toolcall_done", id: call.id, name: call.name, args };
      return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    for (const message of params.messages) if (message.role === "tool") for (const result of message.content) {
      expect(result.isError).not.toBe(true);
      output = JSON.parse(String(result.content));
    }
    return { message: { role: "assistant", content: "Done" }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  for await (const event of agentLoop([{ role: "user", content: "Fixture" }], {
    provider: "anthropic", model: "fixture", tools: [tool], signal: new AbortController().signal,
  })) expect(event.type).not.toBe("error");
  return output;
}

let root: string;
let restore: (() => void) | undefined;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); restore?.(); if (root) await fs.rm(root, { recursive: true, force: true }); });
const proposal = {
  name: "bridge-fixture", requiredTools: ["read"],
  markdown: "## Inputs\nFixture\n## Outputs\nSummary\n## Required tools\nread\n## Limits\nNo writes\n## Arguments\nAppended scope\n",
  requirement: { version: 1, desiredOutcome: "Summarize", capabilityKind: "prompt-only", inputs: ["Fixture"], outputs: ["Summary"],
    prerequisites: ["read"], risks: ["Incomplete"], verificationExpectations: ["Fixture cases"] },
};
async function fixture(review = true, plan = false, broadcast?: (question: AskUserPrompt) => void) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-command-tool-"));
  restore = useFakeHome(path.join(root, "home"));
  const bridge = createAskUserBridge({ broadcast: broadcast ?? ((question) => queueMicrotask(() => {
    expect(question.questions[0]!.detail).toContain(proposal.markdown.replaceAll("\n", "\\n"));
    bridge.settle(question.id, { action: "answer", answers: { [question.questions[0]!.id]: question.questions[0]!.options![0]!.value! } });
  })) });
  const owner = createProgrammaticCommandTool(root, { availableTools: () => ["read"], readReadiness: async () => "missing",
    planModeRef: { current: plan }, ...(review ? { reviewCreation: commandCreationReviewer(bridge) } : {}) });
  const run = async (input: unknown) => {
    const result = await owner.tool.execute(ProgrammaticCommandParams.parse(input), { signal: new AbortController().signal, toolCallId: "fixture" });
    return typeof result === "string" && result.startsWith("{") ? JSON.parse(result) : result;
  };
  const catalog = await run({ action: "inspect", proposal });
  const preview = await run({ action: "inspect", proposal: { ...proposal, review: { inventorySha256: catalog.catalog.sha256,
    disposition: "create", rationale: "No suitable fixture command" } } });
  return { owner, run, preview, bridge };
}
it("routes a strict run selection to its host without any creation handle", async () => {
  const selection = { version: 1, command: { version: 1, name: "existing", source: "project-custom", invocationKind: "prompt" },
    arguments: "", outcome: "Check", successCondition: "Checked", helpers: [], prerequisites: [], requiredTools: ["read"], mode: "read-only", containment: "agent-session" };
  const executeCommand = vi.fn(async () => ({ version: 1 as const, runId: "00000000-0000-4000-8000-000000000000", status: "rejected" as const,
    summary: "Fixture declined", evidence: [], behavior: "unverified" as const, limitations: ["Fixture host only"] }));
  const owner = createProgrammaticCommandTool(".", { availableTools: () => ["read"], executeCommand });
  const input = ProgrammaticCommandParams.parse({ action: "run", selection });
  expect(ProgrammaticCommandParams.safeParse({ action: "run", selection, approved: true }).success).toBe(false);
  expect(ProgrammaticCommandParams.safeParse({ action: "run", selection, handle: "creation" }).success).toBe(false);
  try {
    expect(JSON.parse(String(await owner.tool.execute(input, { toolCallId: "run", signal: new AbortController().signal })))).toMatchObject({ status: "rejected" });
    expect(executeCommand).toHaveBeenCalledOnce();
    expect(executeCommand.mock.calls[0]).toBeDefined();
  } finally { owner.dispose(); }
  for (const context of [{}, { planModeRef: { current: true } }, { localFilesystem: false }]) {
    executeCommand.mockClear();
    const unavailable = createProgrammaticCommandTool(".", { availableTools: () => ["read"], ...("planModeRef" in context || "localFilesystem" in context ? { executeCommand } : {}), ...context });
    try {
      const output = String(await unavailable.tool.execute(input, { toolCallId: "denied", signal: new AbortController().signal }));
      expect(output).toMatch(/unavailable|plan mode/i);
      expect(executeCommand).not.toHaveBeenCalled();
    } finally { unavailable.dispose(); }
  }
});

it("creates through the existing human question bridge and loads without packaging", async () => {
  const { owner, run, preview, bridge } = await fixture();
  try {
    expect(preview.status).toBe("proposal");
    const created = await run({ action: "create", handle: preview.handle });
    expect(created).toMatchObject({ created: true, loads: true, executionApproved: false });
    const verification = await run({ action: "verification", handle: created.verificationHandle });
    expect(verification).toMatchObject({ recommendation: { loading: "current", behavior: "unavailable", executionApproved: false } });
    const information = createCommandInformationTool(root, { readReadiness: async () => "missing" });
    const resolved = JSON.parse(String(await information.execute({ action: "resolve", command: verification.report.snapshot.command }, {
      signal: new AbortController().signal, toolCallId: "resolved-recommendation",
    })));
    expect(resolved.snapshot).toEqual(verification.report.snapshot);
    expect(await checkAdvisoryCommandSnapshot(information, verification.report.snapshot, {
      signal: new AbortController().signal, toolCallId: "fresh-recommendation",
    })).toBe(true);
    expect(await fs.readFile(path.join(root, ".gg/commands/bridge-fixture.md"), "utf8")).toBe(proposal.markdown);
    expect(bridge.pendingCount).toBe(0);
    expect(await run({ action: "create", handle: preview.handle })).toMatchObject({ status: "unavailable" });
  } finally { owner.dispose(); bridge.cancelAll(); }
});
it.each(["forged", "evicted", "changed", "missing"])("serializes independent loading and unavailable %s evidence", async (change) => {
  const { owner, run, preview, bridge } = await fixture();
  const signal = new AbortController().signal;
  try {
    const created = await run({ action: "create", handle: preview.handle });
    let receipt = "f91fefda-c1f9-463f-a821-dff39c438be5";
    if (change === "evicted") {
      await fs.writeFile(path.join(root, "fixture-test.mjs"), "// Receipt fixture; never executed\n");
      const command = "node fixture-test.mjs";
      expect(await run({ action: "prepare_verification", handle: created.verificationHandle, plan: {
        command, testFiles: ["fixture-test.mjs"], cases: [{ category: "behavior", scenario: "normal", input: "fixture", assertion: "claim" }],
      } })).toMatchObject({ status: "prepared", executionApproved: false });
      for (let index = 0; index < 65; index++) {
        const toolCallId = `receipt-${index}`;
        const id = await owner.verification.observeStart("bash", { command }, { toolCallId, signal });
        expect(id).toEqual(expect.any(String));
        await owner.verification.observeEnd(id, "fixture output", signal);
        owner.verification.resultPrepared({ type: "tool_result", toolCallId, content: "fixture output" });
        if (index === 0) receipt = id!;
      }
    }
    const commandPath = path.join(root, ".gg/commands/bridge-fixture.md");
    if (change === "changed") await fs.appendFile(commandPath, "\nChanged content");
    if (change === "missing") await fs.unlink(commandPath);
    const resolved = (await discoverCommands(root, { readReadiness: async () => "missing" })).resolve("bridge-fixture");
    if (change === "missing") expect(resolved).toBeUndefined();
    else expect(resolved?.custom?.filePath).toBe(commandPath);
    const result = await run({ action: "verification", handle: created.verificationHandle, receipt_ids: [receipt],
      model_judgment: "I think it passed" });
    expect(result).toMatchObject({ status: "unavailable", loads: change !== "missing",
      reviewedContent: change === "changed" || change === "missing" ? "unavailable" : "current",
      behavior: "unavailable", executionApproved: false });
    for (const field of ["report", "receipts", "recommendation", "modelJudgment"]) expect(result).not.toHaveProperty(field);
  } finally { owner.dispose(); bridge.cancelAll(); }
});

it.each(["headless", "plan"])("does not write when %s cannot create", async (mode) => {
  const { owner, run, preview, bridge } = await fixture(mode !== "headless", mode === "plan");
  try {
    const result = await run({ action: "create", handle: preview.handle });
    if (mode === "plan") expect(result).toContain("restricted in plan mode");
    else expect(result).toMatchObject({ status: "unavailable" });
    await expect(fs.stat(path.join(root, ".gg/commands/bridge-fixture.md"))).rejects.toThrow();
    expect(bridge.pendingCount).toBe(0);
  } finally { owner.dispose(); bridge.cancelAll(); }
});
it.each(["cancel", "dispose", "supersede"])("clears retained command state on owner %s", async (ending) => {
  const { owner, run, preview, bridge } = await fixture();
  try {
    expect(await run({ action: "create", handle: preview.handle })).toMatchObject({ created: true });
    expect(await run({ action: "verification", handle: preview.handle })).toMatchObject({ loads: true });
    if (ending === "supersede") await run({ action: "inspect", proposal: { ...proposal, name: "replacement-fixture" } });
    else if (ending === "cancel") owner.cancel();
    else owner.dispose();
    expect(await run({ action: "verification", handle: preview.handle })).toMatchObject({ status: "unavailable" });
    expect(await run({ action: "create", handle: preview.handle })).toMatchObject({ status: "unavailable" });
  } finally { owner.dispose(); bridge.cancelAll(); }
});

it.each(["approve", "reject", "timeout"])("keeps guarded creation review past five minutes within the host bound: %s", async (answer) => {
  let ready!: (question: AskUserPrompt) => void;
  const questionReady = new Promise<AskUserPrompt>((resolve) => { ready = resolve; });
  const { owner, preview, bridge } = await fixture(true, false, ready);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const deadlines: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    deadlines.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Controlled deadline", "TimeoutError")), ms);
    return controller.signal;
  });
  const running = guardedRun(owner.tool, { action: "create", handle: preview.handle });
  try {
    const question = await questionReady;
    await vi.advanceTimersByTimeAsync(300_001);
    expect(bridge.pendingCount).toBe(1);
    expect(deadlines).toEqual([ASK_USER_TIMEOUT_MS + 30_000]);
    if (answer === "timeout") await vi.advanceTimersByTimeAsync(ASK_USER_TIMEOUT_MS - 300_001);
    else bridge.settle(question.id, { action: "answer", answers: {
      [question.questions[0]!.id]: answer === "approve" ? question.questions[0]!.options![0]!.value! : "reject",
    } });
    const result = await running;
    if (answer === "approve") expect(result).toMatchObject({ created: true, loads: true });
    else {
      expect(result).toMatchObject({ status: "unavailable" });
      await expect(fs.stat(path.join(root, ".gg/commands/bridge-fixture.md"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(bridge.pendingCount).toBe(0);
  } finally { owner.dispose(); bridge.cancelAll(); await running.catch(() => {}); }
});

it("rejects model-provided approval, execution operations and cross-session receipt-shaped input", () => {
  for (const input of [{ action: "execute" }, { action: "create", handle: "f91fefda-c1f9-463f-a821-dff39c438be5", accepted: true }])
    expect(ProgrammaticCommandParams.safeParse(input).success).toBe(false);
});
