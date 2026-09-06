import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { VerificationGate } from "./verification-gate.js";
import type { SessionVerificationEvidenceLedger } from "./verification-evidence.js";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as ModelRegistryModule from "./model-registry.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { runContextProfileRequest } from "../app-sidecar-context-profile.js";
import { handleAppSidecarChatResearchPrompt } from "../app-sidecar-chat-research-route.js";
import { resolveChatResearchCommandRoute } from "../app-sidecar-chat-research-handoff.js";
import {
  AppSidecarSessionMutationCoordinator,
  runAppSidecarPromptStartup,
  runAppSidecarNewSessionMutation,
} from "../app-sidecar-session-mutation.js";

const agentLoopMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());

const sourceModelRegistry = new URL("../../../gg-core/src/model-registry.ts", import.meta.url).href;
vi.doMock("./model-registry.js", async () => {
  const [local, source] = await Promise.all([
    vi.importActual<typeof ModelRegistryModule>("./model-registry.js"),
    import(sourceModelRegistry),
  ]);
  return { ...local, ...source };
});

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return { ...actual, compact: compactMock };
});

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-profile-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-profile-project-"));
  restoreHome = useFakeHome(tmpHome);
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    openai: {
      accessToken: ["test", "token"].join("-"),
      refreshToken: ["test", "refresh"].join("-"),
      expiresAt: Date.now() + 3_600_000,
      accountId: "chatgpt-account",
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
    autoCompact: false,
  });
  agentLoopMock.mockReset();
  compactMock.mockReset();
  agentLoopMock.mockImplementation(async function* (messages: Message[]) {
    messages.push({ role: "assistant", content: "done" });
    yield { type: "agent_done" };
  });
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function createSession(sessionId?: string) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "openai",
    model: "gpt-6-astra",
    cwd: tmpProject,
    systemPrompt: "test system prompt",
    sessionId,
    mcpEnabled: false,
    projectCustomization: false,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  return session;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const lockedEligibility = {
  canChange: false,
  reason: "Context mode is fixed after this session starts. Start a new session to change it.",
};

describe("continuation verification ownership", () => {
  it.each([false, true])("newSession(false) preserves evidence only when reset fails (%s)", async (fails) => {
    const session = await createSession();
    const internal = session as unknown as {
      verificationGate: VerificationGate;
      verificationEvidenceLedger: SessionVerificationEvidenceLedger;
      createNewSession(): Promise<void>;
    };
    try {
      await session.prompt("Lock the source context profile.");
      const identity = session.getConversationIdentity();
      internal.verificationGate.recordMutation("src/source.ts");
      internal.verificationGate.recordVerification(undefined, "npm test");
      internal.verificationGate.recordFailedVerification("npm lint");
      internal.verificationEvidenceLedger.recordToolResult({
        name: "bash", args: { command: "npm test" }, isError: false,
        details: { bashDiagnostics: {
          executionId: "source-check", command: "npm test", cwd: tmpProject,
          startedAt: Date.now(), reason: "completed", exitCode: 0,
        } },
      });
      const gate = internal.verificationGate.snapshot();
      const ledger = internal.verificationEvidenceLedger.snapshot();
      expect(ledger.currentEvidence).toHaveLength(1);
      expect(session.getVerificationProblem()).toContain("failed");
      if (fails) {
        vi.spyOn(internal, "createNewSession").mockRejectedValueOnce(new Error("destination unavailable"));
        await expect(session.newSession(false)).rejects.toThrow("destination unavailable");
        expect(session.getConversationIdentity()).toEqual(identity);
        expect(internal.verificationGate.snapshot()).toEqual(gate);
        expect(internal.verificationEvidenceLedger.snapshot()).toEqual(ledger);
        expect(session.getVerificationProblem()).toContain("failed");
      } else {
        await session.newSession(false);
        expect(session.getConversationIdentity()).not.toEqual(identity);
        expect(internal.verificationGate.snapshot()).toMatchObject({
          seq: 0, mutation: 0, verified: 0, files: [], failedChecks: [], unknown: false,
        });
        expect(internal.verificationEvidenceLedger.snapshot()).toEqual({
          currentEvidence: [], staleEvidence: [],
        });
        expect(session.getVerificationProblem()).toBeNull();
      }
    } finally {
      await session.dispose();
    }
  });

  it("does not admit a delayed source tool result into the fresh checkpoint", async () => {
    const session = await createSession();
    const internal = session as unknown as {
      trackHookEvent(event: AgentEvent): Promise<void>;
      verificationGate: VerificationGate;
      verificationEvidenceLedger: SessionVerificationEvidenceLedger;
    };
    try {
      await internal.trackHookEvent({
        type: "tool_call_start", toolCallId: "source-call", name: "bash",
        args: { command: "npm test" },
      } as AgentEvent);
      await session.newSession(false);
      internal.verificationGate.recordMutation("src/destination.ts");
      const gate = internal.verificationGate.snapshot();
      await internal.trackHookEvent({
        type: "tool_call_end", toolCallId: "source-call", result: "Exit code: 0\n",
        isError: false, durationMs: 1,
        details: { bashDiagnostics: {
          executionId: "source-check", command: "npm test", cwd: tmpProject,
          startedAt: Date.now(), reason: "completed", exitCode: 0,
        } },
      } as AgentEvent);
      expect(internal.verificationGate.snapshot()).toEqual(gate);
      expect(session.getVerificationProblem()).toContain("Unverified");
      expect(internal.verificationEvidenceLedger.snapshot()).toEqual({
        currentEvidence: [], staleEvidence: [],
      });
    } finally {
      await session.dispose();
    }
  });
});

describe("real continuation renderer, registry and durable core acceptance", () => {
  it.each(["stable", "experimental"] as const)("persists %s before exact acceptance, gates competitors and replays a lost acknowledgement", async (profile) => {
    const { AppSidecarContinuationSession, parseContinuationCommitRequest } = await import("../app-sidecar-continuation-session.js");
    const { AppSidecarContinuationHandoffService } = await import("../app-sidecar-continuation-handoff.js");
    const { RunClaim } = await import("./run-claim.js");
    const { SessionManager } = await import("./session-manager.js");
    const session = await createSession();
    await session.switchOpenAICodexContextProfile(profile === "stable" ? "experimental" : "stable");
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: `Verified status ${messages.length}: ${"supported detail ".repeat(26)}` });
      yield { type: "agent_done" };
    });
    for (let index = 0; index < 3; index++) await session.prompt(`Objective ${index}: ${"preserve scoped work ".repeat(45)}`);
    await session.prompt("UNRELATED HARNESS INSTRUCTION", { source: "runtime", kind: "automation", visibility: "hidden" });
    const instruction = "  Selected Ω instruction: literal \\n versus real\nnewline; ```matching``` — do exactly this.  ";
    const synthesis = vi.fn(async () => {});
    const handoff = new AppSidecarContinuationHandoffService({ createSynthesisSession: () => ({
      initialize: async () => {}, prompt: synthesis, dispose: async () => {},
      getMessages: () => [{ role: "assistant", content: "{malformed synthesis: UNRELATED HARNESS INSTRUCTION}" }],
    }) });
    const mutations = new AppSidecarSessionMutationCoordinator();
    const runClaim = new RunClaim();
    const saveEntered = deferred();
    const releaseSave = deferred();
    const providerEntered = deferred();
    const finishProvider = deferred();
    const runFinished = deferred();
    const events: string[] = [];
    const accepted = vi.fn(() => { events.push("accepted"); });
    const reset = vi.fn(async () => { await session.newSession(false); events.push("reset"); });
    const service = new AppSidecarContinuationSession({
      session, mutations, runClaim, busy: () => false,
      prepare: (text) => handoff.prepare(session, text), reset, accepted,
      prompt: async (text, onAccepted) => {
        try { await session.prompt(text, undefined, { onAccepted: async () => {
          const rows = (await fs.readFile(session.getState().sessionPath, "utf-8")).trim().split("\n").map((row) => JSON.parse(row));
          expect(rows[0].openAICodexContextProfile).toBe(profile);
          expect(rows.filter((row) => row.message?.role === "user").map((row) => row.message.content)).toEqual([text]);
          expect(rows.some((row) => row.id === session.getConversationIdentity().leafId)).toBe(true);
          await onAccepted();
        } }); } finally { runFinished.resolve(); }
      },
    });
    const synthesisEntered = deferred();
    const finishSynthesis = deferred();
    synthesis.mockImplementationOnce(async () => { synthesisEntered.resolve(); await finishSynthesis.promise; });
    const staleSynthesis = service.prepare(instruction);
    await synthesisEntered.promise;
    await session.persistKenTurn("new source activity", "mentor revision during synthesis");
    finishSynthesis.resolve();
    await expect(staleSynthesis).rejects.toThrow(/Source changed/);
    const stalePrepared = await service.prepare(instruction);
    await session.persistKenTurn("later source activity", "mentor revision before commit");
    expect((await service.commit({ preparedId: stalePrepared.preparedId, operationId: "stale-source", profile })).body)
      .toMatchObject({ outcome: "rejected", resetAttempted: false });
    expect(reset).not.toHaveBeenCalled();
    const source = session.getContinuationSourceRevision();
    const prepared = await service.prepare(instruction);
    expect(prepared.source).toEqual(source);
    expect(prepared.prompt.endsWith(instruction)).toBe(true);
    expect(prepared.prompt.indexOf(instruction)).toBeGreaterThan(1500);
    expect(prepared.prompt).not.toContain("UNRELATED HARNESS INSTRUCTION");
    expect(synthesis).toHaveBeenCalledTimes(3);
    const request = parseContinuationCommitRequest(JSON.parse(JSON.stringify({ preparedId: prepared.preparedId, operationId: "exact-operation", profile })))!;
    const originalSave = SessionManager.prototype.updateOpenAICodexContextProfile;
    vi.spyOn(SessionManager.prototype, "updateOpenAICodexContextProfile").mockImplementationOnce(async function (this: InstanceType<typeof SessionManager>, ...args) {
      saveEntered.resolve(); await releaseSave.promise; await originalSave.apply(this, args);
    });
    agentLoopMock.mockImplementationOnce(async function* () {
      expect(mutations.owner).toBeNull();
      expect(runClaim.active).toBe(true);
      events.push("provider"); providerEntered.resolve();
      await finishProvider.promise;
      yield { type: "agent_done" };
    });
    const committing = service.commit(request);
    await saveEntered.promise;
    const ordinaryPrompt = vi.fn(async (onAccepted: () => void) => session.prompt("competitor", undefined, { onAccepted }));
    const conflict = vi.fn();
    await runAppSidecarPromptStartup({ mutations, conflict, perform: ordinaryPrompt });
    expect(ordinaryPrompt).not.toHaveBeenCalled();
    expect(conflict).toHaveBeenCalledOnce();
    expect((await runContextProfileRequest({ body: { profile }, state: session.getState(), running: false, activeUsage: 0, mutations,
      switchProfile: (next) => session.switchOpenAICodexContextProfile(next) })).status).toBe(409);
    const competingReset = vi.fn(async () => session.newSession(false));
    expect((await runAppSidecarNewSessionMutation({ mutations, busyState: { running: false, autopilotActive: false, runLifecycleRunning: false }, perform: competingReset })).status).toBe(409);
    expect(competingReset).not.toHaveBeenCalled();
    expect((await service.commit(request)).body.error).toBe("continuation_in_progress");
    releaseSave.resolve();
    const receipt = await committing;
    await providerEntered.promise;
    expect(receipt.body).toMatchObject({ outcome: "accepted", destination: { profile }, accepted: true });
    expect(events).toEqual(["reset", "accepted", "provider"]);
    expect(await service.commit(request)).toEqual(receipt);
    expect(reset).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
    finishProvider.resolve(); await runFinished.promise;
    await session.dispose();
  });
});

describe("daemon startup with actual AgentSession persistence", () => {
  it("rejects prompt startup while a real profile save is pending, without queueing it", async () => {
    const session = await createSession();
    const { SessionManager } = await import("./session-manager.js");
    const entered = deferred();
    const resume = deferred();
    const original = SessionManager.prototype.updateOpenAICodexContextProfile;
    vi.spyOn(SessionManager.prototype, "updateOpenAICodexContextProfile").mockImplementation(async function (this: InstanceType<typeof SessionManager>, ...args) {
      entered.resolve();
      await resume.promise;
      await original.apply(this, args);
    });
    const mutations = new AppSidecarSessionMutationCoordinator();
    const save = runContextProfileRequest({
      body: { profile: "experimental" }, state: session.getState(), running: false,
      activeUsage: 0, mutations, switchProfile: (profile) => session.switchOpenAICodexContextProfile(profile),
    });
    await entered.promise;
    const perform = vi.fn(async (onAccepted: () => void) => session.prompt("must not run", undefined, { onAccepted }));
    const conflict = vi.fn();
    await runAppSidecarPromptStartup({ mutations, conflict, perform });
    expect(conflict).toHaveBeenCalledWith(expect.objectContaining({ error: "session_mutation_in_progress" }));
    expect(perform).not.toHaveBeenCalled();
    expect(session.getQueuedCount()).toBe(0);
    resume.resolve();
    expect((await save).status).toBe(200);
    expect(session.getState().openAICodexContextProfile).toBe("experimental");
    await session.dispose();
  });

  it.each(["text", "attachment", "template", "research"])("holds %s startup through durable acceptance, not the provider run", async (kind) => {
    const session = await createSession();
    const { SessionManager } = await import("./session-manager.js");
    const entered = deferred();
    const resume = deferred();
    const generating = deferred();
    const finish = deferred();
    const original = SessionManager.prototype.appendRequiredMessage;
    vi.spyOn(SessionManager.prototype, "appendRequiredMessage").mockImplementation(async function (this: InstanceType<typeof SessionManager>, ...args) {
      entered.resolve();
      await resume.promise;
      await original.apply(this, args);
    });
    agentLoopMock.mockImplementationOnce(async function* () {
      generating.resolve();
      await finish.promise;
      yield { type: "agent_done" };
    });
    const mutations = new AppSidecarSessionMutationCoordinator();
    const conflict = vi.fn();
    const prompt = runAppSidecarPromptStartup({ mutations, conflict, perform: async (onAccepted) => {
      if (kind === "research") {
        await handleAppSidecarChatResearchPrompt({
          route: resolveChatResearchCommandRoute({ mode: "chat", text: "/research exact focus", attachmentCount: 0, busy: false }),
          claimStart: () => true,
          respond: vi.fn(),
          runAgent: async (_label, run) => run(),
          operations: {
            session,
            commitResearchTransition: async () => { entered.resolve(); await resume.promise; },
            persistUserHint: (active, command) => active.persistAppMarker("user_hint", { command }, 1),
            prompt: (active, text) => active.prompt(text, undefined, { onAccepted }),
          },
        });
      } else if (kind === "attachment") {
        await session.promptWithAttachments("", [{ kind: "file", name: "notes.txt", mediaType: "text/plain", data: "", path: "/notes.txt" }], { onAccepted });
      } else {
        await session.prompt(kind === "template" ? "/programmatic" : "first", undefined, { onAccepted });
      }
    } });
    await entered.promise;
    const requestProfile = () => runContextProfileRequest({
      body: { profile: "experimental" }, state: session.getState(), running: false,
      activeUsage: 0, mutations, switchProfile: (profile) => session.switchOpenAICodexContextProfile(profile),
    });
    expect(await requestProfile()).toMatchObject({ status: 409, body: { error: "session_mutation_in_progress" } });
    expect(agentLoopMock).not.toHaveBeenCalled();
    resume.resolve();
    await generating.promise;
    expect(mutations.owner).toBeNull();
    const saved = await fs.readFile(session.getState().sessionPath, "utf-8");
    expect(saved).toContain('"role":"user"');
    expect(await requestProfile()).toMatchObject({ status: 409, body: { error: "context_profile_locked", reason: lockedEligibility.reason } });
    finish.resolve();
    await prompt;
    expect(conflict).not.toHaveBeenCalled();
    await session.dispose();
  });

  it.each(["", "/help", "/programmatic rejected"])("releases startup for non-accepted input %j", async (text) => {
    const session = await createSession();
    const mutations = new AppSidecarSessionMutationCoordinator();
    const accepted = vi.fn();
    await runAppSidecarPromptStartup({ mutations, conflict: vi.fn(), perform: (release) =>
      session.prompt(text, undefined, { onAccepted: () => { accepted(); release(); } }),
    });
    expect(accepted).not.toHaveBeenCalled();
    expect(mutations.owner).toBeNull();
    expect(session.getOpenAICodexContextProfileEligibility()).toEqual({ canChange: true });
    await session.dispose();
  });

  it.each([false, true])("awaits the server acceptance callback before generation (attachments=%s)", async (attachments) => {
    const session = await createSession();
    const accepted = deferred();
    const resume = deferred();
    const onAccepted = async () => { accepted.resolve(); await resume.promise; };
    const prompt = attachments
      ? session.promptWithAttachments("", [{ kind: "file", name: "notes.txt", mediaType: "text/plain", data: "", path: "/notes.txt" }], { onAccepted })
      : session.prompt("first", undefined, { onAccepted });
    await accepted.promise;
    expect(agentLoopMock).not.toHaveBeenCalled();
    expect(await fs.readFile(session.getState().sessionPath, "utf-8")).toContain('"role":"user"');
    resume.resolve();
    await prompt;
    expect(agentLoopMock).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it("releases failed required message persistence without accepting or generating", async () => {
    const session = await createSession();
    await fs.rm(session.getState().sessionPath);
    const mutations = new AppSidecarSessionMutationCoordinator();
    const accepted = vi.fn();
    await expect(runAppSidecarPromptStartup({ mutations, conflict: vi.fn(), perform: (release) =>
      session.prompt("first", undefined, { onAccepted: () => { accepted(); release(); } }),
    })).rejects.toThrow();
    expect(accepted).not.toHaveBeenCalled();
    expect(agentLoopMock).not.toHaveBeenCalled();
    expect(mutations.owner).toBeNull();
    await session.dispose();
  });
});

describe("AgentSession OpenAI Codex context profiles", () => {
  it("exposes cheap identity and revision changes for mentor, profile, acceptance, and reset", async () => {
    const session = await createSession();
    const original = session.getContinuationSourceRevision();
    expect(session.getState().conversationId).toBe(original.conversationId);
    await session.switchOpenAICodexContextProfile("experimental");
    const selected = session.getContinuationSourceRevision();
    expect(selected.fingerprint).not.toBe(original.fingerprint);
    await session.persistKenTurn("question", "exact selected instruction");
    expect(session.getContinuationSourceRevision().fingerprint).not.toBe(selected.fingerprint);
    await session.prompt("accepted", undefined, { onAccepted: async () => {
      const identity = session.getConversationIdentity();
      expect(identity.conversationId).toBe(original.conversationId);
      expect(identity.leafId).toBeTruthy();
      const entries = (await fs.readFile(session.getState().sessionPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.some((entry) => entry.id === identity.leafId && entry.message?.content === "accepted")).toBe(true);
    } });
    await session.newSession(false);
    expect(session.getConversationIdentity().conversationId).not.toBe(original.conversationId);
    await session.dispose();
  });
  it("keeps system-only sessions and empty or handled command input eligible", async () => {
    const session = await createSession();
    await session.prompt(" \n\t ");
    await session.prompt("/help");
    await session.prompt("/programmatic rejected arguments");
    await session.promptWithAttachments("/programmatic", [{
      kind: "file", mediaType: "text/plain", data: "", name: "notes.txt", path: "/notes.txt",
    }]);
    expect(agentLoopMock).not.toHaveBeenCalled();
    expect(session.getState().openAICodexContextProfileEligibility).toEqual({ canChange: true });
    await session.switchOpenAICodexContextProfile("experimental");
    const storedPath = session.getState().sessionPath;
    expect(JSON.parse((await fs.readFile(storedPath, "utf-8")).split("\n")[0]!).openAICodexContextProfile)
      .toBe("experimental");
    await session.dispose();
    const resumed = await createSession(storedPath);
    expect(resumed.getOpenAICodexContextProfileEligibility()).toEqual({ canChange: true });
    await resumed.switchOpenAICodexContextProfile("stable");
    await resumed.dispose();
  });

  it.each(["attachment", "mentor", "continuation", "queued"] as const)(
    "locks accepted %s turns and only unlocks after a fresh reset",
    async (kind) => {
      const session = await createSession();
      if (kind === "attachment") {
        await session.promptWithAttachments("", [{
          kind: "file", mediaType: "text/plain", data: "", name: "notes.txt", path: "/notes.txt",
        }]);
      } else if (kind === "mentor") {
        await session.persistKenTurn("What next?", "Keep the exact instruction.");
      } else if (kind === "continuation") {
        await session.prompt("Exact selected continuation instruction");
      } else {
        session.queueMessage("accepted steering");
        session.drainQueue();
      }
      expect(session.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
      await expect(session.switchOpenAICodexContextProfile("experimental")).rejects.toThrow(/fixed after/);
      await session.switchOpenAICodexContextProfile("stable"); // idempotent when locked
      await session.loadSessionCheckpoint(session.getState().sessionPath);
      expect(session.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
      await session.newSession(true);
      expect(session.getState().messageCount).toBe(1);
      expect(session.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
      const checkpointPath = session.getState().sessionPath;
      await session.dispose();
      const resumed = await createSession(checkpointPath);
      expect(resumed.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
      await expect(resumed.switchOpenAICodexContextProfile("experimental")).rejects.toThrow(/fixed after/);
      await resumed.newSession(false);
      expect(resumed.getOpenAICodexContextProfileEligibility()).toEqual({ canChange: true });
      await resumed.switchOpenAICodexContextProfile("experimental");
      await resumed.dispose();
    },
  );

  it("fails closed for an empty checkpoint even when its parent has no visible history", async () => {
    const session = await createSession();
    await session.newSession(true);
    const checkpointPath = session.getState().sessionPath;
    expect(session.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
    await session.dispose();
    const resumed = await createSession(checkpointPath);
    expect(resumed.getState().messageCount).toBe(1);
    await expect(resumed.switchOpenAICodexContextProfile("experimental")).rejects.toThrow(/fixed after/);
    await resumed.dispose();
  });

  it("keeps rewind and restored off-branch conversational history locked", async () => {
    const session = await createSession();
    await session.prompt("first");
    await session.prompt("second");
    await session.branch(3);
    expect(session.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
    await expect(session.switchOpenAICodexContextProfile("experimental")).rejects.toThrow(/fixed after/);
    await session.dispose();

    const { SessionManager } = await import("./session-manager.js");
    const manager = new SessionManager(path.join(tmpHome, ".gg", "sessions"));
    const stored = await manager.create(tmpProject, "openai", "gpt-6-astra");
    await manager.appendEntry(stored.path, {
      type: "message", id: "system", parentId: null, timestamp: new Date().toISOString(),
      message: { role: "system", content: "bootstrap" },
    });
    await manager.appendEntry(stored.path, {
      type: "message", id: "off-branch", parentId: "system", timestamp: new Date().toISOString(),
      message: { role: "user", content: "history outside the selected leaf" },
    });
    await manager.updateLeaf(stored.path, "system");
    const resumed = await createSession(stored.path);
    expect(resumed.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
    await expect(resumed.switchOpenAICodexContextProfile("experimental")).rejects.toThrow(/fixed after/);
    await resumed.dispose();
  });

  it("does not advertise a changed profile when required persistence fails; same-profile is a no-op", async () => {
    const session = await createSession();
    const storedPath = session.getState().sessionPath;
    const original = await fs.readFile(storedPath, "utf-8");
    await fs.rm(storedPath);
    await session.switchOpenAICodexContextProfile("stable");
    await expect(session.switchOpenAICodexContextProfile("experimental")).rejects.toThrow(/persist/i);
    expect(session.getState().openAICodexContextProfile).toBe("stable");
    expect(session.getOpenAICodexContextProfileEligibility()).toEqual({ canChange: true });
    await fs.writeFile(storedPath, original);
    await session.switchOpenAICodexContextProfile("experimental");
    expect(JSON.parse((await fs.readFile(storedPath, "utf-8")).split("\n")[0]!).openAICodexContextProfile)
      .toBe("experimental");
    await session.dispose();
  });
  it("locks after acceptance and preserves the selected profile through compaction and resume", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();

    expect(session.getState().openAICodexContextProfile).toBe("stable");
    expect(session.getOpenAICodexContextProfileEligibility()).toEqual({ canChange: true });
    await session.switchOpenAICodexContextProfile("experimental");
    await session.switchOpenAICodexContextProfile("stable");
    await session.switchOpenAICodexContextProfile("experimental");
    await session.prompt("small experimental turn");
    expect(agentLoopMock.mock.calls[0]?.[1]).toMatchObject({ maxTokens: 128_000 });
    expect(session.getContextUsage()).toMatchObject({
      size: 872_000,
      openAICodexContextProfile: "experimental",
    });

    await session.switchOpenAICodexContextProfile("experimental");
    expect(session.getContextUsage()).toMatchObject({
      size: 872_000,
      openAICodexContextProfile: "experimental",
    });
    await expect(session.switchOpenAICodexContextProfile("stable")).rejects.toThrow(/fixed after/);
    expect(session.getState().openAICodexContextProfile).toBe("experimental");
    await session.switchOpenAICodexContextProfile("experimental");
    await session.switchOpenAICodexFast(true);

    await session.prompt("x".repeat(1_100_000));
    expect(agentLoopMock.mock.calls[1]?.[1]).toMatchObject({ maxTokens: 128_000 });
    expect(session.getContextUsage().used).toBeGreaterThan(272_000);
    await expect(session.switchOpenAICodexContextProfile("stable")).rejects.toThrow(
      /fixed after/,
    );
    expect(session.getState().openAICodexContextProfile).toBe("experimental");

    compactMock.mockResolvedValue({
      messages: [
        { role: "system", content: "test system prompt" },
      ],
      result: {
        compacted: true,
        originalCount: 5,
        newCount: 1,
        tokensBeforeEstimate: 300_000,
        tokensAfterEstimate: 10,
      },
    });
    await session.compact();
    expect(session.getState().messageCount).toBe(1);
    expect(session.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
    await expect(session.switchOpenAICodexContextProfile("stable")).rejects.toThrow(/fixed after/);
    const checkpointPath = session.getState().sessionPath;
    const checkpointHeader = JSON.parse(
      (await fs.readFile(checkpointPath, "utf-8")).split("\n")[0]!,
    );
    expect(checkpointHeader.openAICodexContextProfile).toBe("experimental");
    expect(checkpointHeader.openAICodexFast).toBe(true);
    const { getAgentSessionContextWindow } = await import("../app-sidecar-context.js");
    expect(getAgentSessionContextWindow(session.getState())).toBe(872_000);
    await session.dispose();

    const resumed = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: checkpointPath,
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await resumed.initialize();
    expect(resumed.getContextUsage()).toMatchObject({
      size: 872_000,
      openAICodexContextProfile: "experimental",
    });
    expect(resumed.getState().openAICodexFast).toBe(true);
    expect(getAgentSessionContextWindow(resumed.getState())).toBe(872_000);

    await expect(resumed.switchOpenAICodexContextProfile("stable")).rejects.toThrow(/fixed after/);
    expect(resumed.getState().openAICodexContextProfile).toBe("experimental");
    await resumed.dispose();
  });

  it("hydrates OAuth identity and applies Fast only to Astra OAuth", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();

    expect(session.getState()).toMatchObject({
      accountId: "chatgpt-account",
      openAICodexFast: false,
    });
    await session.switchOpenAICodexFast(true);
    await session.prompt("fast turn");
    expect(agentLoopMock.mock.calls[0]?.[1]).toMatchObject({ serviceTier: "fast" });

    await session.switchModel("openai", "gpt-5.6-sol");
    expect(session.getState().openAICodexFast).toBe(true);
    await session.prompt("unsupported turn");
    expect(agentLoopMock.mock.calls[1]?.[1]?.serviceTier).toBeUndefined();

    await session.switchModel("openai", "gpt-6-astra");
    await session.prompt("fast again");
    expect(agentLoopMock.mock.calls[2]?.[1]).toMatchObject({ serviceTier: "fast" });
    await session.dispose();
  });

  it("refreshes shared OpenAI identity without refreshing an expired token", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();
    expect(session.getState().accountId).toBe("chatgpt-account");

    const authPath = path.join(tmpHome, ".gg", "auth.json");
    const storedAuth = JSON.parse(await fs.readFile(authPath, "utf-8")) as {
      openai: { expiresAt: number; accountId: string };
    };
    await writeJson(authPath, {});
    await session.refreshStoredAuthState();
    expect(session.getState().accountId).toBeUndefined();

    storedAuth.openai.expiresAt = 0;
    storedAuth.openai.accountId = "new-account";
    await writeJson(authPath, storedAuth);
    await session.refreshStoredAuthState();
    expect(session.getState().accountId).toBe("new-account");
    await session.dispose();
  });

  it("clears live OAuth identity when shared credentials switch to an API key", async () => {
    const authPath = path.join(tmpHome, ".gg", "auth.json");
    agentLoopMock.mockImplementationOnce(async function* (
      messages: Message[],
      options: GgAgentModule.AgentOptions,
    ) {
      expect(options).toMatchObject({
        serviceTier: "fast",
        serviceTierRequiresAccountId: true,
      });
      const resolveCredentials = options.resolveCredentials;
      if (!resolveCredentials) throw new Error("missing credential resolver");
      await expect(resolveCredentials()).resolves.toMatchObject({
        accountId: "chatgpt-account",
      });

      await writeJson(authPath, {
        openai: {
          accessToken: ["test", "api", "key"].join("-"),
          refreshToken: "",
          expiresAt: Date.now() + 3_600_000,
        },
      });
      const live = await resolveCredentials();
      expect(Object.prototype.hasOwnProperty.call(live, "accountId")).toBe(true);
      expect(live.accountId).toBeUndefined();

      messages.push({ role: "assistant", content: "done" });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();
    await session.switchOpenAICodexFast(true);
    await session.prompt("credential transition");

    expect(session.getState().accountId).toBeUndefined();
    await session.dispose();
  });

  it("omits Fast for a restored API-key session", async () => {
    const [{ AgentSession }, { SessionManager }] = await Promise.all([
      import("./agent-session.js"),
      import("./session-manager.js"),
    ]);
    await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
      openai: {
        accessToken: ["test", "api", "key"].join("-"),
        refreshToken: "",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const manager = new SessionManager(path.join(tmpHome, ".gg", "sessions"));
    const stored = await manager.create(tmpProject, "openai", "gpt-6-astra", {
      openAICodexFast: true,
    });
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: stored.path,
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();

    expect(session.getState()).toMatchObject({ accountId: undefined, openAICodexFast: true });
    await session.prompt("api-key turn");
    expect(agentLoopMock.mock.calls[0]?.[1]?.serviceTier).toBeUndefined();
    await session.dispose();
  });

  it("defaults legacy headers without a profile to stable and Fast off", async () => {
    const [{ AgentSession }, { SessionManager }] = await Promise.all([
      import("./agent-session.js"),
      import("./session-manager.js"),
    ]);
    const manager = new SessionManager(path.join(tmpHome, ".gg", "sessions"));
    const legacy = await manager.create(tmpProject, "openai", "gpt-6-astra");
    await manager.appendEntry(legacy.path, {
      type: "message",
      id: "legacy-message",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "legacy session" },
    });

    const resumed = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: legacy.path,
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await resumed.initialize();

    expect(resumed.getContextUsage()).toMatchObject({
      size: 272_000,
      openAICodexContextProfile: "stable",
    });
    expect(resumed.getState().openAICodexFast).toBe(false);
    expect(resumed.getOpenAICodexContextProfileEligibility()).toEqual(lockedEligibility);
    await expect(resumed.switchOpenAICodexContextProfile("experimental")).rejects.toThrow(/fixed after/);
    const { getAgentSessionContextWindow } = await import("../app-sidecar-context.js");
    expect(getAgentSessionContextWindow(resumed.getState())).toBe(272_000);
    await resumed.dispose();
  });
});
