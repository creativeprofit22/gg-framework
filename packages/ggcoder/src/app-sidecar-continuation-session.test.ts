import { describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentSession } from "./core/agent-session.js";
import { RunClaim } from "./core/run-claim.js";
import { sourceFingerprint } from "./core/session-compaction.js";
import { AppSidecarSessionMutationCoordinator, runAppSidecarPromptStartup, runAppSidecarNewSessionMutation } from "./app-sidecar-session-mutation.js";
import { runContextProfileRequest } from "./app-sidecar-context-profile.js";
import { AppSidecarContinuationHandoffService } from "./app-sidecar-continuation-handoff.js";
import { AppSidecarContinuationSession, parseContinuationCommitRequest } from "./app-sidecar-continuation-session.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let now = 1_000;
  let identity = { conversationId: "source", sessionId: "source-file", leafId: "source-leaf" as string | null };
  let profile: "stable" | "experimental" = "stable";
  const messages: Message[] = [{ role: "user", content: "Implement the scoped change." }];
  const events: string[] = [];
  const mutations = new AppSidecarSessionMutationCoordinator();
  const runClaim = new RunClaim();
  const state = (): ReturnType<AgentSession["getState"]> => ({
    provider: "openai", model: "gpt-6-astra", cwd: "/project", sessionPath: "/project/session.jsonl",
    ...identity, messageCount: messages.length, planMode: false, accountId: "oauth-account",
    openAICodexContextProfile: profile, openAICodexContextProfileEligibility: { canChange: true }, openAICodexFast: false,
  });
  const session = {
    getState: state,
    getMessages: () => messages,
    getApprovedPlanConsumption: () => undefined,
    getContinuationReviewRecord: () => undefined,
    persistRequiredAppMarker: vi.fn(async () => {}),
    getConversationIdentity: () => ({ ...identity }),
    getContinuationSourceRevision: () => ({ ...identity, fingerprint: sourceFingerprint(messages) + profile }),
    switchOpenAICodexContextProfile: vi.fn(async (next: "stable" | "experimental") => {
      events.push("profile"); profile = next;
    }),
  };
  const renderer = new AppSidecarContinuationHandoffService({
    createSynthesisSession: () => { throw new Error("deterministic fallback; no provider"); },
  });
  const deps = {
    session, mutations, runClaim,
    now: () => now,
    busy: () => false,
    prepare: vi.fn((instruction: string) => renderer.prepare({ getState: state, getMessages: () => messages }, instruction)),
    reset: vi.fn(async () => {
      events.push("reset");
      identity = { conversationId: "destination", sessionId: "destination-file", leafId: null };
      messages.splice(0);
    }),
    prompt: vi.fn(async (prompt: string, onAccepted: () => Promise<void>) => {
      events.push("append");
      messages.push({ role: "user", content: prompt });
      identity.leafId = "accepted-user-id";
      await onAccepted();
      expect(mutations.owner).toBeNull();
      expect(runClaim.active).toBe(true);
      events.push("provider");
    }),
    accepted: vi.fn(() => { events.push("accepted-event"); }),
  };
  return { deps, service: new AppSidecarContinuationSession(deps), messages, events,
    advance: () => { now += 600_001; } };
}

describe("pane-owned continuation startup", () => {
  it.each(["x".repeat(8001), "🙂".repeat(4000) + "x", " \r\n\t "])(
    "rejects invalid instructions before preparation or mutation (%#. case)", async (instruction) => {
      const f = fixture();
      await expect(f.service.prepare(instruction)).rejects.toThrow("Invalid continuation instruction");
      expect(f.deps.prepare).not.toHaveBeenCalled();
      expect(f.deps.reset).not.toHaveBeenCalled();
      expect(f.deps.prompt).not.toHaveBeenCalled();
      expect(f.deps.mutations.owner).toBeNull();
      expect(f.deps.runClaim.active).toBe(false);
    },
  );

  it("accepts exactly 8000 raw UTF-16 units unchanged through preparation and commit", async () => {
    const f = fixture();
    const instruction = "  🙂\r\n\tKeep whitespace  \r\n".padEnd(8000, " ");
    expect(instruction).toHaveLength(8000);
    const prepared = await f.service.prepare(instruction);
    expect(f.deps.prepare).toHaveBeenCalledExactlyOnceWith(instruction);
    expect(prepared.prompt.split("## Immediate next action\n")[1]).toBe(instruction);
    expect(f.deps.reset).not.toHaveBeenCalled();
    const result = await f.service.commit({ preparedId: prepared.preparedId, operationId: "boundary" });
    expect(result.body.accepted).toBe(true);
    expect(f.deps.prompt.mock.calls[0]![0]).toBe(prepared.prompt);
  });
  it("commits the real rendered envelope after profile persistence; replays receipt without duplicate acceptance", async () => {
    const f = fixture();
    const instruction = "  Exact \\n and actual\nUnicode Ω — keep whitespace.  ";
    const prepared = await f.service.prepare(instruction);
    expect(prepared.prompt.endsWith(instruction)).toBe(true);
    const request = { preparedId: prepared.preparedId, operationId: "operation-1", profile: "experimental" as const };
    const result = await f.service.commit(request);
    expect(result).toMatchObject({ status: 200, body: { outcome: "accepted", accepted: true,
      acceptedMessageId: "accepted-user-id", destination: { conversationId: "destination", profile: "experimental" } } });
    expect(f.deps.prompt.mock.calls[0]![0]).toBe(prepared.prompt);
    expect(f.events.slice(0, 4)).toEqual(["reset", "profile", "append", "accepted-event"]);
    expect(await f.service.commit(request)).toEqual(result);
    expect(f.deps.reset).toHaveBeenCalledOnce();
    expect(f.deps.prompt).toHaveBeenCalledOnce();
    expect(f.deps.accepted).toHaveBeenCalledOnce();
    expect((await f.service.commit({ ...request, profile: "stable" })).status).toBe(409);
  });

  it("bounds pending preparation and validates source after synthesis and again at commit", async () => {
    const f = fixture();
    const wait = deferred();
    const original = f.deps.prepare.getMockImplementation()!;
    f.deps.prepare.mockImplementation(async (text) => { await wait.promise; return original(text); });
    const pending = Array.from({ length: 8 }, () => f.service.prepare("exact"));
    await expect(f.service.prepare("ninth")).rejects.toThrow(/Too many/);
    f.messages.push({ role: "user", content: "changed while preparing" });
    wait.resolve();
    expect((await Promise.allSettled(pending)).every((r) => r.status === "rejected")).toBe(true);
    const prepared = await f.service.prepare("exact");
    f.messages.push({ role: "user", content: "changed after preparing" });
    const result = await f.service.commit({ preparedId: prepared.preparedId, operationId: "source-change" });
    expect(result.body).toMatchObject({ outcome: "rejected", resetAttempted: false });
    expect(f.deps.reset).not.toHaveBeenCalled();
  });

  it("fails closed for wrong panes, expired IDs, and client envelope replacement", async () => {
    const f = fixture();
    const prepared = await f.service.prepare("exact");
    const request = { preparedId: prepared.preparedId, operationId: "operation" };
    expect((await fixture().service.commit(request)).body.outcome).toBe("outcome-unknown");
    f.advance();
    expect((await f.service.commit(request)).body.outcome).toBe("outcome-unknown");
    expect(parseContinuationCommitRequest({ ...request, prompt: "replacement" })).toBeNull();
    expect(parseContinuationCommitRequest({ ...request, source: {} })).toBeNull();
    expect(parseContinuationCommitRequest(request)).toEqual(request);
  });

  it("rejects startup competitors and in-flight retries, releasing before a deferred provider completes", async () => {
    const f = fixture();
    const prepared = await f.service.prepare("exact");
    const save = deferred();
    const provider = deferred();
    const append = f.deps.prompt.getMockImplementation()!;
    f.deps.session.switchOpenAICodexContextProfile.mockImplementationOnce(async () => { await save.promise; });
    f.deps.prompt.mockImplementationOnce(async (...args) => { await append(...args); await provider.promise; });
    const request = { preparedId: prepared.preparedId, operationId: "operation", profile: "stable" as const };
    const response = f.service.commit(request);
    expect(f.deps.mutations.tryAcquire("prompt-start")).toBeNull();
    expect((await f.service.commit(request)).body).toMatchObject({ outcome: "outcome-unknown", error: "continuation_in_progress" });
    save.resolve();
    expect((await response).body.outcome).toBe("accepted");
    expect(f.deps.mutations.owner).toBeNull();
    expect(f.deps.runClaim.active).toBe(true);
    provider.resolve();
  });

  it.each(["prompt", "reset", "profile"])("rejects continuation when ordinary %s startup owns the shared gate", async (kind) => {
    const f = fixture();
    const prepared = await f.service.prepare("exact");
    const wait = deferred();
    const perform = async () => { await wait.promise; };
    const operation = kind === "prompt"
      ? runAppSidecarPromptStartup({ mutations: f.deps.mutations, conflict: vi.fn(), perform })
      : kind === "reset"
        ? runAppSidecarNewSessionMutation({ mutations: f.deps.mutations, busyState: { running: false, autopilotActive: false, runLifecycleRunning: false }, perform })
        : runContextProfileRequest({ mutations: f.deps.mutations, state: f.deps.session.getState(), running: false, activeUsage: 0,
          body: { profile: "experimental" }, switchProfile: perform });
    const result = await f.service.commit({ preparedId: prepared.preparedId, operationId: "loser" });
    expect(result.body).toMatchObject({ outcome: "rejected", error: "session_mutation_in_progress", resetAttempted: false });
    expect(f.deps.reset).not.toHaveBeenCalled();
    expect(f.deps.prompt).not.toHaveBeenCalled();
    wait.resolve(); await operation;
  });

  it.each(["conversationId", "sessionId", "leafId", "profile"] as const)("fails closed when destination %s is invalid at required acceptance", async (field) => {
    const f = fixture();
    const prepared = await f.service.prepare("exact");
    const append = f.deps.prompt.getMockImplementation()!;
    f.deps.prompt.mockImplementationOnce((text, accept) => append(text, async () => {
      const actual = f.deps.session.getConversationIdentity();
      if (field === "profile") {
        vi.spyOn(f.deps.session, "getState").mockReturnValue({ ...f.deps.session.getState(), openAICodexContextProfile: "experimental" });
      } else {
        vi.spyOn(f.deps.session, "getConversationIdentity").mockReturnValue({ ...actual, [field]: field === "leafId" ? null : "wrong-destination" });
      }
      await accept();
    }));
    const request = { preparedId: prepared.preparedId, operationId: "wrong-destination" };
    const result = await f.service.commit(request);
    expect(result.body).toMatchObject({ outcome: "partial", accepted: null, resetAttempted: true });
    expect(f.deps.accepted).not.toHaveBeenCalled();
    expect(await f.service.commit(request)).toEqual(result);
    expect(f.deps.prompt).toHaveBeenCalledOnce();
  });

  it.each(["reset", "reset-partial", "profile", "profile-mismatch", "prompt"])("caches truthful partial %s failures with exact recovery text", async (stage) => {
    const f = fixture();
    const prepared = await f.service.prepare("recover this exact text");
    if (stage === "reset") f.deps.reset.mockImplementationOnce(async () => { throw new Error("reset failed"); });
    if (stage === "reset-partial") {
      const reset = f.deps.reset.getMockImplementation()!;
      f.deps.reset.mockImplementationOnce(async () => { await reset(); throw new Error("bookkeeping failed after reset"); });
    }
    if (stage === "profile") f.deps.session.switchOpenAICodexContextProfile.mockRejectedValueOnce(new Error("save failed"));
    if (stage === "profile-mismatch") f.deps.session.switchOpenAICodexContextProfile.mockResolvedValueOnce();
    if (stage === "prompt") f.deps.prompt.mockRejectedValueOnce(new Error("append outcome unknown"));
    const request = { preparedId: prepared.preparedId, operationId: "partial", profile: "experimental" as const };
    const result = await f.service.commit(request);
    expect(result.body).toMatchObject({ outcome: "partial", resetAttempted: true,
      accepted: stage === "prompt" ? null : false, selectedProfile: "experimental", recoveryPrompt: prepared.prompt });
    if (stage === "profile" || stage === "profile-mismatch") {
      expect(result.body.destination?.profile).toBe("stable");
      expect(f.deps.prompt).not.toHaveBeenCalled();
    }
    if (stage === "reset-partial") expect(result.body.destination?.conversationId).toBe("destination");
    expect(await f.service.commit(request)).toEqual(result);
    expect(f.deps.reset).toHaveBeenCalledOnce();
    expect(f.deps.mutations.owner).toBeNull();
    expect(f.deps.runClaim.active).toBe(false);
  });
});
