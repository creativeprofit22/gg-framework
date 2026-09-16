import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type ToolCall } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { createProgrammaticScanTool } from "../tools/programmatic-scan.js";
import type { AskUserRequest } from "./ask-user.js";
import { AuthStorage, NotLoggedInError } from "./auth-storage.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { isProgrammaticAssessmentEvent, type ProgrammaticAssessmentEvent } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./programmatic/profile.js";

// Script only the network boundary; use the real public session, guards, review and scan owners.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({ ...(await original<Record<string, unknown>>()), stream: vi.fn() }));
let cwd: string;
let restore: () => void;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "assessment-entry-"));
  restore = useFakeHome(path.join(cwd, "home"));
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({ accessToken: "scripted", refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER });
  vi.mocked(stream).mockReset();
  reply();
});
afterEach(async () => { restore(); vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true }); });
function reply(call?: ToolCall) {
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    const next = call; call = undefined;
    if (next) {
      yield { type: "toolcall_done", id: next.id, name: next.name, args: next.args };
      return { message: { role: "assistant", content: [next] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { message: { role: "assistant", content: "Scripted bounded assessment." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
}
const base = () => ({ cwd, provider: "anthropic" as const, model: "claude-sonnet-5", transient: true, mcpEnabled: false, systemPrompt: "Scripted assessment", allowedTools: ["find", "read", "write", "programmatic_profile", "programmatic_scan", "command_information", "programmatic_advisory_result"] });
async function configure() {
  const proposal = await buildProgrammaticProfileProposal(cwd);
  expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
}
it.each(["setup", "configured"] as const)("publishes bounded host assessment events for actual slash %s", async (mode) => {
  const session = new AgentSession({ ...base(), transient: false });
  const events: ProgrammaticAssessmentEvent[] = [];
  session.eventBus.on("programmatic_assessment", (event) => events.push(event));
  try {
    await session.initialize();
    if (mode === "configured") await configure();
    reply({ type: "tool_call", id: "result", name: "programmatic_advisory_result", args: {
      version: 1, kind: "advisory", coverage: { status: "limited", scope: "Fixture", reason: "Scripted provider" }, recommendations: [],
    } });
    await session.prompt(mode === "setup" ? "/setup-programmatic" : "/programmatic");
    expect(events).toHaveLength(2);
    expect(events.every(isProgrammaticAssessmentEvent)).toBe(true);
    const { conversationId, sessionId } = session.getConversationIdentity();
    expect(events[0]).toEqual({ conversationId, sessionId, phase: "started", sequence: 1 });
    expect(events[1]).toMatchObject({ phase: "completed", sequence: 1, assessment: { mode, status: "completed" } });
    expect(JSON.stringify(events)).not.toMatch(/"(?:profileJson|proposalHandle|setupFacts|scanFacts|recommendations)"\s*:/);
  } finally { await session.dispose(); }
});

it.each(["completed", "unavailable", "failed", "cancelled"] as const)("slash configured emits bounded %s independently of model tool activity", async (scenario) => {
  const controller = new AbortController();
  const session = new AgentSession({ ...base(), transient: false, signal: controller.signal });
  const events: ProgrammaticAssessmentEvent[] = [];
  const tools: string[] = [];
  session.eventBus.on("programmatic_assessment", (event) => events.push(event));
  session.eventBus.on("tool_call_start", (event) => tools.push(event.name));
  try {
    await session.initialize(); await configure();
    if (scenario === "unavailable") vi.mocked(AuthStorage.prototype.resolveCredentials).mockRejectedValue(new NotLoggedInError("anthropic"));
    if (scenario === "failed") await fs.writeFile(path.join(cwd, ".gg/programmatic/state.json"), "corrupt");
    if (scenario === "cancelled") vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
      controller.abort();
      throw new Error("Scripted cancellation");
      yield { type: "text_delta", text: "unreachable" };
    })()));
    if (scenario === "completed") reply({ type: "tool_call", id: "result", name: "programmatic_advisory_result", args: {
      version: 1, kind: "advisory", coverage: { status: "limited", scope: "Fixture", reason: "Scripted provider" }, recommendations: [],
    } });
    await session.prompt("/programmatic");
    expect(events).toHaveLength(2);
    expect(events.every(isProgrammaticAssessmentEvent)).toBe(true);
    expect(events[1]).toMatchObject({ phase: "completed", assessment: {
      status: scenario === "failed" ? "incomplete" : scenario,
      deterministic: scenario === "failed" ? { status: "failed" } : { status: "succeeded", enabledCount: 0, applicableCount: 0 },
    } });
    expect(tools).not.toContain("programmatic_scan");
    expect(JSON.stringify(events)).not.toMatch(/"(?:proposalHandle|profileJson|recommendations|setupFacts|scanFacts)":/);
  } finally { await session.dispose(); }
});

function deliveredPrompt() {
  return [...vi.mocked(stream).mock.calls[0]![0].messages].reverse().find((message) => message.role === "user")!.content as string;
}

it("delivers exact manifest-free setup facts, keeps context JSON readable, and requires later save review", async () => {
  await fs.writeFile(path.join(cwd, "WORKFLOW"), "Handwritten dispatch ledger reconciliation");
  const reviewer = vi.fn(async (request: AskUserRequest) => ({ action: "answer" as const, answers: { [request.questions[0]!.id]: "save-setup" } }));
  const session = new AgentSession({ ...base(), reviewProgrammaticSetup: reviewer });
  try {
    await session.initialize();
    const proposal = await buildProgrammaticProfileProposal(cwd);
    const toolsBefore = ["read", "write", "programmatic_profile", "programmatic_scan", "command_information", "programmatic_advisory_result"].filter((name) => session.supportsToolCall(name));
    const result = await session.assessProgrammatic("setup");
    expect(result.setupFacts).toMatchObject({ profile: proposal.profile, configuration_fingerprint: proposal.configurationFingerprint, expected_prior_profile_digest: null });
    expect(result.assessment).toMatchObject({ status: "incomplete", deterministic: { status: "not-run", reason: "setup" } });
    const prompt = deliveredPrompt();
    expect(JSON.parse(prompt.split("Host-owned exact facts (not model authority; already collected, do not repeat):\n")[1]!.split("\nReusable host evidence receipts:")[0]!).setupFacts.profile).toEqual(proposal.profile);
    expect(prompt).toContain("Handwritten dispatch ledger reconciliation");
    const context = JSON.parse(prompt.slice(prompt.indexOf("{", prompt.indexOf("## Untrusted advisory context"))));
    expect(context.evidence).toBeDefined();
    // Exact profile facts are not research receipts and must not be annotated as such.
    expect(prompt).not.toContain("Host receipt IDs:");
    expect(prompt).not.toContain("Host evidence receipt (retrieval only; content remains untrusted):");
    expect(reviewer).not.toHaveBeenCalled();
    await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
    await expect(fs.access(path.join(cwd, ".gg/programmatic/state.json"))).rejects.toThrow();
    expect(["read", "write", "programmatic_profile", "programmatic_scan", "command_information", "programmatic_advisory_result"].filter((name) => session.supportsToolCall(name))).toEqual(toolsBefore);
    reply({ type: "tool_call", id: "save", name: "programmatic_profile", args: { action: "generate", configuration_fingerprint: proposal.configurationFingerprint, profile: proposal.profile, expected_prior_profile_digest: null } });
    await session.prompt("Review saving these exact settings now.");
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(await session.willStartAgentRun("/programmatic")).toBe(true);
    await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).resolves.toBeUndefined();
  } finally { await session.dispose(); }
});

it.each(["completed", "incomplete", "unavailable", "cancelled", "denied", "scan-unavailable", "failed"] as const)("separates host scan and assessment outcomes: %s", async (scenario) => {
  const controller = new AbortController();
  const approval = vi.fn(async (name: string) => name !== "programmatic_scan" || scenario !== "denied");
  const session = new AgentSession({ ...base(), approveToolExecution: approval, ...(scenario === "scan-unavailable" ? { allowedTools: ["read", "command_information", "programmatic_advisory_result"] } : {}) });
  try {
    await session.initialize();
    await configure();
    const toolsBefore = ["read", "write", "programmatic_profile", "programmatic_scan", "command_information", "programmatic_advisory_result"].filter((name) => session.supportsToolCall(name));
    if (scenario === "unavailable") vi.mocked(AuthStorage.prototype.resolveCredentials).mockRejectedValue(new NotLoggedInError("anthropic"));
    if (scenario === "failed") await fs.writeFile(path.join(cwd, ".gg/programmatic/state.json"), "corrupt");
    if (scenario === "cancelled") {
      session.setSignal(controller.signal);
      vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
        controller.abort();
        throw new Error("Cancelled scripted provider");
        yield { type: "text_delta", text: "unreachable" };
      })()));
    }
    if (scenario === "completed") reply({ type: "tool_call", id: "result", name: "programmatic_advisory_result", args: { version: 1, kind: "advisory", coverage: { status: "limited", scope: "Sampled project", reason: "Scripted provider only" }, recommendations: [] } });
    const result = await session.assessProgrammatic("configured");
    expect(result.assessment.status).toBe(["completed", "unavailable", "cancelled"].includes(scenario) ? scenario : "incomplete");
    expect(result.assessment.deterministic).toMatchObject(scenario === "denied" ? { status: "denied" } : scenario === "failed" ? { status: "failed" } : scenario === "scan-unavailable" ? { status: "unavailable" } : { status: "succeeded", enabledCount: 0, applicableCount: 0 });
    if (!["denied", "failed", "scan-unavailable"].includes(scenario)) {
      // Assert the lifecycle -> tool -> public-entry projection, not just the final outcome.
      expect(result.scanFacts).toMatchObject({ ok: true, scan_counts: { enabledCount: 0, applicableCount: 0 } });
    }
    expect(approval.mock.calls.filter(([name]) => name === "programmatic_scan")).toHaveLength(scenario === "scan-unavailable" ? 0 : 1);
    expect(["read", "write", "programmatic_profile", "programmatic_scan", "command_information", "programmatic_advisory_result"].filter((name) => session.supportsToolCall(name))).toEqual(toolsBefore);
    expect(session.supportsToolCall("programmatic_advisory_result")).toBe(false);
  } finally { await session.dispose(); }
});

it.each(["setup", "configured"] as const)("retains bounded evidence and strict inventory failure in the real %s caller", async (mode) => {
  await fs.writeFile(path.join(cwd, "WORKFLOW"), "Bounded paper ledger workflow");
  const session = new AgentSession(base());
  try {
    await session.initialize();
    if (mode === "configured") await configure();
    // A sparse oversized ordinary source hits the unchanged strict inventory byte
    // ceiling while the advisory prefix reader can still safely sample it.
    const file = await fs.open(path.join(cwd, "large.unfamiliar"), "w");
    try { await file.write("partial source evidence\n".repeat(1000)); await file.truncate(16 * 1024 * 1024 + 1); }
    finally { await file.close(); }
    if (mode === "configured") {
      await expect(session.assessProgrammatic(mode)).rejects.toThrow("unreadable or unsafe");
      expect(vi.mocked(stream)).not.toHaveBeenCalled();
      await expect(fs.access(path.join(cwd, ".gg/programmatic/state.json"))).rejects.toThrow();
      // Keep the configured readiness gate strict. With only advisory evidence
      // truncated (not strict inventory), the real caller can proceed below.
      await fs.truncate(path.join(cwd, "large.unfamiliar"), 23_000);
    }
    const result = await session.assessProgrammatic(mode);
    expect(vi.mocked(stream)).toHaveBeenCalledOnce();
    expect(deliveredPrompt()).toContain("Bounded paper ledger workflow");
    expect(result.assessment).toMatchObject({ status: "incomplete", observations: [],
      deterministic: mode === "setup" ? { status: "not-run" } : { status: "succeeded", enabledCount: 0, applicableCount: 0 } });
    expect(result.assessment.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "project", status: "budget-limited" }),
      expect.objectContaining({ scope: "project", status: "uninspected" }),
    ]));
    expect(result.assessment.summary).toContain("incomplete");
    if (mode === "setup") {
      expect(result.setupFacts).not.toHaveProperty("profile");
      await expect(fs.access(path.join(cwd, ".gg/programmatic/state.json"))).rejects.toThrow();
    }
  } finally { await session.dispose(); }
});

it("corrupt settings allow safe explanatory evidence but no replacement proposal", async () => {
  await fs.writeFile(path.join(cwd, "WORKFLOW"), "Safe workflow evidence despite unsafe settings");
  const session = new AgentSession(base());
  try {
    await session.initialize(); await configure();
    const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
    await fs.writeFile(profilePath, "corrupt settings");
    const result = await session.assessProgrammatic("setup");
    expect(deliveredPrompt()).toContain("Safe workflow evidence despite unsafe settings");
    expect(result.setupFacts).not.toHaveProperty("profile");
    expect(result.assessment.status).toBe("incomplete");
    expect(await fs.readFile(profilePath, "utf8")).toBe("corrupt settings");
  } finally { await session.dispose(); }
});

it.each(["allowed-tools", "approval", "unavailable", "capability", "approval-revocation", "validation-revocation", "delivery-revocation", "find-denied", "unregistered", "permitted"] as const)("authorizes initial evidence without leaking denied bytes: %s", async (scenario) => {
  const secret = "PRIVATE_INITIAL_EVIDENCE_SENTINEL";
  await fs.writeFile(path.join(cwd, "WORKFLOW"), secret);
  let reading = false;
  const approval = vi.fn(async (name: string, args: unknown) => {
    reading = name === "read";
    if (name === "read") {
      expect(args).toEqual({ file_path: "WORKFLOW", limit: 16385 });
      if (scenario === "approval-revocation") {
        await Promise.resolve();
        session.setToolCapabilityPolicy({ allowedToolNames: base().allowedTools.filter((item) => item !== "read") });
      }
    }
    if (name === "programmatic_profile" && scenario === "delivery-revocation") session.setToolAvailability(["read"], false);
    return !(scenario === "approval" && name === "read") && !(scenario === "find-denied" && name === "find");
  });
  const session = new AgentSession({ ...base(),
    ...(scenario === "allowed-tools" ? { allowedTools: base().allowedTools.filter((name) => name !== "read") } : {}),
    approveToolExecution: approval,
    validateToolExecution: async () => {
      if (reading && scenario === "validation-revocation") {
        await Promise.resolve();
        session.setToolAvailability(["read"], false);
      }
    },
  });
  try {
    await session.initialize();
    if (scenario === "unregistered") {
      // The initial host collector is authorized by policy, not registry membership.
      (session as unknown as { registeredTools: Map<string, unknown> }).registeredTools.delete("read");
      session.setToolAvailability([], true);
      expect(session.supportsToolCall("read")).toBe(false);
    }
    if (scenario === "unavailable") session.setToolAvailability(["read"], false);
    if (scenario === "capability") session.setToolCapabilityPolicy({ allowedToolNames: base().allowedTools.filter((name) => name !== "read") });
    const result = await session.assessProgrammatic("setup");
    expect(result.setupFacts).toHaveProperty("profile");
    const permitted = scenario === "permitted" || scenario === "unregistered";
    expect(deliveredPrompt().includes(secret)).toBe(permitted);
    if (!permitted) {
      expect(JSON.stringify(vi.mocked(stream).mock.calls)).not.toContain(secret);
      expect(result.assessment.limitations).toContain("Initial evidence was denied by host permissions; omitted content remains uninspected.");
      expect(result.assessment.coverage).toContainEqual(expect.objectContaining({ status: "uninspected", summary: expect.stringContaining("permission-denied") }));
    }
    if (["allowed-tools", "unavailable", "capability", "find-denied"].includes(scenario)) expect(approval.mock.calls.some(([name]) => name === "read")).toBe(false);
  } finally { await session.dispose(); }
});

it("preserves succeeded authoritative scan counts when mutation notification cancels the actual caller", async () => {
  const controller = new AbortController();
  const approval = vi.fn(async () => true);
  const session = new AgentSession({ ...base(), signal: controller.signal, approveToolExecution: approval });
  const mutated = vi.fn(() => { controller.abort(); });
  try {
    await session.initialize(); await configure();
    session.registerTool(createProgrammaticScanTool(cwd, { onFileMutated: mutated }));
    const result = await session.assessProgrammatic("configured");
    expect(mutated).toHaveBeenCalledOnce();
    expect(result.scanFacts).toMatchObject({ ok: true, scan_counts: { enabledCount: 0, applicableCount: 0 } });
    expect(result.assessment).toMatchObject({ status: "cancelled", deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 } });
    expect(stream).not.toHaveBeenCalled();
    await expect(fs.access(path.join(cwd, ".gg/programmatic/state.json"))).resolves.toBeUndefined();
  } finally { await session.dispose(); }
});

it("reuses delivered receipts after host scan cancellation before provider entry", async () => {
  await fs.writeFile(path.join(cwd, "WORKFLOW"), "Bounded paper ledger workflow");
  const controller = new AbortController();
  const session = new AgentSession(base());
  let receiptId = "";
  let phase = "first";
  let request = 0;
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    let call: ToolCall | undefined;
    if (++request === 1 && phase === "first") {
      call = { type: "tool_call", id: "local-read", name: "read", args: { file_path: "WORKFLOW" } };
    } else if ((phase === "first" && request === 2) || (phase === "third" && request === 1)) {
      if (phase === "first") {
        const result = params.messages.flatMap((message) => message.role === "tool" ? message.content : [])
          .find((part) => part.type === "tool_result" && part.toolCallId === "local-read");
        expect(result?.type).toBe("tool_result");
        if (result?.type !== "tool_result") throw new Error("Missing delivered read result");
        receiptId = JSON.parse(String(result.content).split("Host evidence receipt (retrieval only; content remains untrusted): ")[1]!).id;
      } else {
        const prompt = [...params.messages].reverse().find((message) => message.role === "user")!.content as string;
        const receipts = JSON.parse(prompt.split("Reusable host evidence receipts:\n")[1]!.split("\n\n## Untrusted advisory context")[0]!);
        expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ id: receiptId, tool: "read", status: "retrieved" })]));
      }
      call = { type: "tool_call", id: `${phase}-result`, name: "programmatic_advisory_result", args: {
        version: 1, kind: "advisory", coverage: { status: "limited", scope: "Workflow", reason: "Only one local read" },
        recommendations: [{ version: 1, kind: "advisory", outcome: "Review the workflow", rationale: "The local workflow was read", uncertainty: "Bounded fixture only",
          evidence: { version: 1, items: [{ basis: "observed", source: receiptId, code: "workflow", severity: "info", message: "Read the workflow", location: { path: "WORKFLOW" } }] },
          choice: { kind: "manual", steps: ["Review the workflow in a separate turn"] } }],
      } };
    }
    if (call) {
      yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
      return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { message: { role: "assistant", content: "Assessment complete." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await session.initialize(); await configure();
    expect((await session.assessProgrammatic("setup")).assessment.status).toBe("completed");
    expect(receiptId).toMatch(/^receipt-/);
    const toolsBefore = ["read", "write", "programmatic_scan", "programmatic_advisory_result"].filter((name) => session.supportsToolCall(name));
    session.setSignal(controller.signal);
    const mutated = vi.fn(() => controller.abort());
    session.registerTool(createProgrammaticScanTool(cwd, { onFileMutated: mutated }));
    vi.mocked(stream).mockClear();
    const cancelled = await session.assessProgrammatic("configured");
    expect(cancelled.assessment).toMatchObject({ status: "cancelled", deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 } });
    expect(cancelled.scanFacts).toMatchObject({ ok: true, scan_counts: { enabledCount: 0, applicableCount: 0 } });
    expect(mutated).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
    expect(["read", "write", "programmatic_scan", "programmatic_advisory_result"].filter((name) => session.supportsToolCall(name))).toEqual(toolsBefore);
    session.setSignal(new AbortController().signal);
    session.registerTool(createProgrammaticScanTool(cwd));
    phase = "third"; request = 0;
    const resumed = await session.assessProgrammatic("configured");
    expect(resumed.assessment.status).toBe("completed");
    expect(resumed.assessment.observations).toContainEqual(expect.objectContaining({ evidenceSources: [receiptId] }));
  } finally { await session.dispose(); }
});

it("blocks duplicate model scan after the host scan and restores scope after cancellation before evidence", async () => {
  const approval = vi.fn(async (_name: string) => true);
  const session = new AgentSession({ ...base(), approveToolExecution: approval });
  try {
    await session.initialize(); await configure();
    reply({ type: "tool_call", id: "duplicate", name: "programmatic_scan", args: {} });
    await session.prompt("/programmatic");
    expect(approval.mock.calls.filter(([name]) => name === "programmatic_scan")).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(stream).mock.calls)).toContain("one unchanged programmatic_scan");
    const controller = new AbortController(); controller.abort(); session.setSignal(controller.signal);
    const result = await session.assessProgrammatic("setup");
    expect(result.assessment.status).toBe("cancelled");
    expect(session.supportsToolCall("programmatic_advisory_result")).toBe(false);
    expect(session.supportsToolCall("programmatic_scan", {})).toBe(true);
  } finally { await session.dispose(); }
});
