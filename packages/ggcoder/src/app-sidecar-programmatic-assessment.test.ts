import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type ToolCall } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./core/agent-session.js";
import { AuthStorage, NotLoggedInError } from "./core/auth-storage.js";
import { RunClaim } from "./core/run-claim.js";
import { isProgrammaticAssessmentEvent, type ProgrammaticAssessmentEvent } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import { canonicalJson } from "./core/tauri-package/paths.js";
import { useFakeHome } from "./test-support/fake-home.js";
import { AppSidecarProgrammaticChat, bindProgrammaticAssessmentEvents } from "./app-sidecar-programmatic-chat.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./core/programmatic/profile.js";

// Real session/tool loop and filesystem owners; only network provider streaming is scripted.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({ ...(await original<Record<string, unknown>>()), stream: vi.fn() }));
let cwd: string;
let restore: () => void;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-assessment-"));
  restore = useFakeHome(path.join(cwd, "home"));
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({ accessToken: "fixture", refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER });
  vi.mocked(stream).mockReset();
  await fs.writeFile(path.join(cwd, "WORKFLOW"), "Paper ledger dispatch reconciliation.\n");
});
afterEach(async () => { restore(); vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true }); });

it.each(["setup", "configured"] as const)("forwards actual slash %s completion through the desktop session binding", async (mode) => {
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", mcpEnabled: false,
    allowedTools: ["programmatic_profile", "programmatic_scan", "programmatic_advisory_result"], systemPrompt: "Scripted assessment" });
  const broadcast = vi.fn();
  const unbind = bindProgrammaticAssessmentEvents(session, () => session, broadcast);
  let submitted = false;
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    if (!submitted) {
      submitted = true;
      const call: ToolCall = { type: "tool_call", id: "result", name: "programmatic_advisory_result", args: {
        version: 1, kind: "advisory", coverage: { status: "limited", scope: "Fixture", reason: "Scripted provider" }, recommendations: [],
      } };
      yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
      return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { message: { role: "assistant", content: "Bounded submission complete." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await session.initialize();
    if (mode === "configured") {
      const proposal = await buildProgrammaticProfileProposal(cwd);
      expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    }
    await session.prompt(mode === "setup" ? "/setup-programmatic" : "/programmatic");
    expect(broadcast).toHaveBeenCalledTimes(2);
    const events = broadcast.mock.calls.map(([type, event]) => {
      expect(type).toBe("programmatic_assessment");
      expect(isProgrammaticAssessmentEvent(event)).toBe(true);
      return event;
    });
    const { conversationId, sessionId } = session.getConversationIdentity();
    expect(events[0]).toEqual({ conversationId, sessionId, sequence: 1, phase: "started" });
    expect(events[1]).toMatchObject({ conversationId, sessionId, sequence: 1, phase: "completed",
      assessment: { mode, status: "completed", deterministic: mode === "setup"
        ? { status: "not-run", reason: "setup" }
        : { status: "succeeded", enabledCount: 0, applicableCount: 0 } } });
    expect(JSON.stringify(events)).not.toMatch(/"(?:proposalHandle|profileJson|recommendations|setupFacts|scanFacts)"\s*:/);
  } finally { unbind(); await session.dispose(); }
});

it("explicitly forwards validated current-session assessment events on the sidecar broadcast surface", async () => {
  const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
  expect(source).toContain("bindProgrammaticAssessmentEvents(target, () => session, broadcast)");
  const target = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", systemPrompt: "Fixture", mcpEnabled: false });
  const replacement = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", systemPrompt: "Fixture", mcpEnabled: false });
  let current = target;
  const broadcast = vi.fn();
  const unbind = bindProgrammaticAssessmentEvents(target, () => current, broadcast);
  try {
    await target.initialize();
    const { sessionId, conversationId } = target.getConversationIdentity();
    const started = { sessionId, conversationId, sequence: 1, phase: "started" as const };
    target.eventBus.emit("programmatic_assessment", started);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith("programmatic_assessment", started);
    target.eventBus.emit("programmatic_assessment", { ...started, conversationId: "retired" });
    target.eventBus.emit("programmatic_assessment", { ...started, sessionId: "retired" });
    target.eventBus.emit("programmatic_assessment", { ...started, proposalHandle: "forged" } as ProgrammaticAssessmentEvent);
    current = replacement;
    target.eventBus.emit("programmatic_assessment", started);
    expect(broadcast).toHaveBeenCalledOnce();
  } finally { unbind(); await target.dispose(); await replacement.dispose(); }
});

it.each([
  ["setup", "manifest-free"], ["configured", "manifest-free"],
  ["setup", "mixed-monorepo"], ["configured", "mixed-monorepo"],
] as const)("desktop %s uses real current-session assessment under one claim in %s", async (mode, project) => {
  if (project === "mixed-monorepo") {
    await fs.mkdir(path.join(cwd, "apps/desktop/src-tauri"), { recursive: true });
    await fs.writeFile(path.join(cwd, "apps/desktop/package.json"), '{"name":"desktop"}');
    await fs.writeFile(path.join(cwd, "apps/desktop/src-tauri/Cargo.toml"), '[package]\nname="desktop"');
    await fs.writeFile(path.join(cwd, "apps/desktop/src-tauri/tauri.conf.json"), "{}");
    await fs.mkdir(path.join(cwd, "services"));
    await fs.writeFile(path.join(cwd, "services/reconcile.py"), "# paper ledger\n");
  }
  const count = project === "manifest-free" ? 0 : 1;
  const proposal = await buildProgrammaticProfileProposal(cwd);
  if (mode === "configured") expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  const calls: string[] = [];
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5",
    systemPrompt: "Read-only fixture", mcpEnabled: false, allowedTools: ["find", "read", "programmatic_profile", "programmatic_scan", "programmatic_advisory_result"],
    approveToolExecution: async (name) => { calls.push(name); return true; } });
  const claim = new RunClaim();
  const release = vi.fn(() => claim.release());
  const settled = vi.fn(() => expect(claim.active).toBe(false));
  const events: ProgrammaticAssessmentEvent[] = [];
  bindProgrammaticAssessmentEvents(session, () => session, (_name, event) => {
    expect(claim.active).toBe(true);
    events.push(event);
  });
  const assess = vi.fn(async (selected: "setup" | "configured") => { expect(claim.active).toBe(true); return session.assessProgrammatic(selected); });
  const adapter = new AppSidecarProgrammaticChat(() => ({ cwd, identity: "current", codeMode: true, planMode: false, busy: claim.active }),
    () => claim.claim(), release, undefined, settled, assess);
  let submitted = false;
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    expect(JSON.stringify(params.messages)).toContain("Paper ledger dispatch reconciliation.");
    expect(claim.active).toBe(true);
    expect((await adapter.handle({ version: 1, action: "report", offset: 0 })).status).toBe(409);
    if (!submitted) {
      submitted = true;
      const call: ToolCall = { type: "tool_call", id: "result", name: "programmatic_advisory_result", args: { version: 1, kind: "advisory", coverage: { status: "limited", scope: "Sampled project", reason: "Scripted provider only" }, recommendations: [] } };
      yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
      return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return { message: { role: "assistant", content: "Bounded submission complete." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await session.initialize();
    const result = await adapter.handle({ version: 1, action: mode === "setup" ? "inspect-setup" : "scan" });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(2);
    expect(events.every(isProgrammaticAssessmentEvent)).toBe(true);
    expect(events[0]).toMatchObject({ phase: "started", sequence: 1 });
    expect(events[1]).toMatchObject({ phase: "completed", sequence: 1,
      assessment: "assessment" in result.body ? result.body.assessment : undefined });
    // Reject authority/detail fields at any depth, not those words in display copy.
    expect(JSON.stringify(events)).not.toMatch(/"(?:proposalHandle|profileJson|recommendations|setupFacts|scanFacts)"\s*:/);
    expect(result.body).toMatchObject({ ok: true, assessment: { mode, status: "completed", deterministic: mode === "setup" ? { status: "not-run" } : { status: "succeeded", enabledCount: count, applicableCount: count } } });
    expect(result.body).toMatchObject({ assessment: { summary: expect.stringContaining("not a universal clean bill of health") } });
    expect(assess).toHaveBeenCalledOnce();
    expect(calls.filter((name) => !["find", "read", "programmatic_advisory_result"].includes(name))).toEqual([mode === "setup" ? "programmatic_profile" : "programmatic_scan"]);
    expect(calls).toContain("find");
    expect(calls).toContain("read");
    expect(release).toHaveBeenCalledOnce(); expect(settled).toHaveBeenCalledOnce();
    if (mode === "setup") {
      expect(result.body).toMatchObject({ proposal: { profileJson: canonicalJson(proposal.profile) } });
      await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
    }
  } finally { adapter.dispose(); await session.dispose(); }
});

it.each(["budget", "scan-failure", "unavailable", "cancel"] as const)("desktop empty-profile Check preserves %s without a false clean zero", async (scenario) => {
  const controller = new AbortController();
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", transient: true,
    signal: controller.signal, systemPrompt: "Fixture", mcpEnabled: false,
    allowedTools: ["find", "read", "programmatic_scan", "programmatic_advisory_result"] });
  const claim = new RunClaim();
  const assess = vi.fn((mode: "setup" | "configured") => session.assessProgrammatic(mode));
  const adapter = new AppSidecarProgrammaticChat(() => ({ cwd, identity: "current", codeMode: true, planMode: false, busy: claim.active }),
    () => claim.claim(), () => claim.release(), undefined, undefined, assess);
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    yield* []; // This fixture completes without streaming deltas.
    expect(JSON.stringify(params.messages)).toContain("Paper ledger dispatch reconciliation.");
    if (scenario === "cancel") controller.abort();
    return { message: { role: "assistant", content: "Evidence remains incomplete." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await session.initialize();
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect(proposal.profile.scanners).toEqual([]);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    if (scenario === "budget") await fs.writeFile(path.join(cwd, "large.unfamiliar"), "partial text\n".repeat(2000));
    if (scenario === "scan-failure") await fs.writeFile(path.join(cwd, ".gg/programmatic/state.json"), "corrupt state");
    if (scenario === "unavailable") vi.mocked(AuthStorage.prototype.resolveCredentials).mockRejectedValue(new NotLoggedInError("anthropic"));
    const result = await adapter.handle({ version: 1, action: "scan" });
    expect(result.body).toMatchObject({ ok: true, assessment: {
      status: scenario === "cancel" ? "cancelled" : scenario === "unavailable" ? "unavailable" : "incomplete",
      deterministic: scenario === "scan-failure" ? { status: "failed" } : { status: "succeeded", enabledCount: 0, applicableCount: 0 },
      observations: [],
    } });
    if (scenario === "budget") expect(result.body).toMatchObject({ assessment: { coverage: expect.arrayContaining([
      expect.objectContaining({ scope: "project", status: "budget-limited" }),
    ]) } });
    expect(assess).toHaveBeenCalledOnce();
    expect(claim.active).toBe(false);
  } finally { adapter.dispose(); await session.dispose(); }
});

it.each(["current", "stale"] as const)("desktop corrupt settings assess read-only with no approval and preserve bytes: %s", async (owner) => {
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", transient: true,
    systemPrompt: "Fixture", mcpEnabled: false, allowedTools: ["find", "read", "programmatic_profile"] });
  const claim = new RunClaim();
  const acquire = vi.fn(() => claim.claim());
  const release = vi.fn(() => claim.release());
  const settled = vi.fn(() => expect(claim.active).toBe(false));
  const assess = vi.fn((mode: "setup" | "configured") => {
    expect(claim.active).toBe(true);
    return session.assessProgrammatic(mode);
  });
  const adapter = new AppSidecarProgrammaticChat(() => ({ cwd, identity: "current", codeMode: true, planMode: false, busy: claim.active }),
    acquire, release, undefined, settled, assess);
  const providerEvidence: string[] = [];
  const providerTools: string[][] = [];
  const providerClaims: boolean[] = [];
  const competingStatuses: number[] = [];
  vi.mocked(stream).mockImplementation((params) => new StreamResult((async function* () {
    yield* []; // This fixture completes without streaming deltas.
    providerEvidence.push(JSON.stringify(params.messages));
    providerTools.push(params.tools?.map((tool) => tool.name) ?? []);
    providerClaims.push(claim.active);
    competingStatuses.push((await adapter.handle({ version: 1, action: "report", offset: 0 })).status);
    if (owner === "stale") adapter.reset();
    return { message: { role: "assistant", content: "Safe bounded evidence only; setup is unavailable." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await session.initialize();
    await fs.mkdir(path.join(cwd, ".gg/programmatic"), { recursive: true });
    const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
    await fs.writeFile(profilePath, "corrupt settings");
    const result = await adapter.handle({ version: 1, action: "inspect-setup" });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false });
    expect(result.body).not.toHaveProperty("proposal");
    expect(result.body).not.toHaveProperty("approvableProposalHandle");
    if (owner === "current") expect(result.body).toMatchObject({ assessment: { mode: "setup", status: "incomplete", deterministic: { status: "not-run" } } });
    else expect(result.body).not.toHaveProperty("assessment");
    expect(assess).toHaveBeenCalledExactlyOnceWith("setup");
    expect(vi.mocked(stream)).toHaveBeenCalled();
    expect(providerEvidence.length).toBeGreaterThan(0);
    expect(providerClaims).toEqual(providerEvidence.map(() => true));
    expect(competingStatuses).toEqual(providerEvidence.map(() => 409));
    for (const evidence of providerEvidence) {
      expect(evidence).toContain("Paper ledger dispatch reconciliation.");
      expect(evidence).toContain("Repair is required before approval or scanning.");
      expect(evidence).toContain("Untrusted advisory context");
    }
    for (const tools of providerTools)
      for (const name of ["write", "edit", "bash", "programmatic_scan"])
        expect(tools).not.toContain(name);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
    expect(claim.active).toBe(false);
    expect(await fs.readFile(profilePath, "utf8")).toBe("corrupt settings");
  } finally { adapter.dispose(); await session.dispose(); }
});

it.each(["cancel", "project", "session", "provider", "unavailable"] as const)("rejects stale owners and preserves incomplete outcomes: %s", async (event) => {
  const controller = new AbortController();
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", transient: true, signal: controller.signal,
    systemPrompt: "Fixture", mcpEnabled: false, allowedTools: ["find", "read", "programmatic_profile"] });
  const claim = new RunClaim();
  const target = { cwd, identity: "one", codeMode: true, planMode: false, busy: false };
  const settled = vi.fn(() => expect(claim.active).toBe(false));
  const adapter = new AppSidecarProgrammaticChat(() => target, () => claim.claim(), () => claim.release(), undefined, settled,
    (mode) => session.assessProgrammatic(mode));
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    yield* []; // This fixture completes without streaming deltas.
    if (event === "cancel") controller.abort();
    if (event === "project") target.cwd = path.join(cwd, "other");
    if (event === "session") target.identity = "two";
    if (event === "provider") throw new Error("Scripted provider failure");
    return { message: { role: "assistant", content: "Interrupted." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  try {
    await session.initialize();
    if (event === "unavailable") vi.mocked(AuthStorage.prototype.resolveCredentials).mockRejectedValue(new NotLoggedInError("anthropic"));
    const result = await adapter.handle({ version: 1, action: "inspect-setup" });
    if (event === "project" || event === "session") expect(result.status).toBe(409);
    else expect(result.body).toMatchObject({ ok: true, assessment: { status: event === "cancel" ? "cancelled" : event === "unavailable" ? "unavailable" : "incomplete" } });
    expect(settled).toHaveBeenCalledOnce();
    expect(claim.active).toBe(false);
    await expect(fs.access(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toThrow();
  } finally { adapter.dispose(); await session.dispose(); }
});
