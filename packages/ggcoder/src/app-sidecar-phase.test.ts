import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppSidecarCancellationPersistence,
  handleCancellationPersistenceRetryRoute,
} from "./app-sidecar-cancellation.js";
import { commitPlanApprovalCheckpoint } from "./app-sidecar-phase-checkpoint.js";
import { AppSidecarPhaseCandidateStore } from "./app-sidecar-phase-candidates.js";
import {
  launchBoundPhase,
  type BoundPhaseCandidate,
  type BoundPhaseSession,
  type PhaseLaunchRepository,
  type PhaseStartResponseBody,
} from "./app-sidecar-phase-launch.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { AppSidecarRoadmapDraftDecisionService } from "./app-sidecar-roadmap-draft-route.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";
import {
  AppSidecarPhaseLifecycleCoordinator,
  type BoundPhaseLifecycleContext,
  type PhaseLifecycleRepositoryOutcome,
} from "./app-sidecar-phase-lifecycle.js";
import type { ActivePhaseContextV1, ActivePhaseExecutionStage } from "./phase-context.js";
import {
  ProjectNotesRepository,
  type NotesDocumentV3,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";

const NOW = "2026-07-26T00:00:00.000Z";
const roots: string[] = [];

function document(): NotesDocumentV3 {
  return {
    version: 3,
    reference: "unrelated free-form Notes",
    currentFocus: "another phase",
    tasks: [],
    handoff: { text: "unrelated handoff", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    references: [
      {
        id: "ref-1",
        provider: "github",
        tool: "searchCode",
        canonicalUrl: "https://github.com/acme/repo/blob/main/src/phase.ts#L1-L2",
        owner: "acme",
        repo: "repo",
        revision: "main",
        path: "src/phase.ts",
        range: { startLine: 1, endLine: 2 },
        issue: null,
        pullRequest: null,
        query: "launchPhase(",
        anchor: "launchPhase",
        relevance: "Transaction source",
        capturedAt: NOW,
      },
    ],
    phases: [
      {
        id: "phase-21",
        title: "Bound phase",
        goal: "Create one session",
        doneWhen: ["Binding commits before prompt"],
        order: 0,
        status: "not-started",
        sourcePrompt: "Plan only this phase",
        referenceIds: ["ref-1"],
        session: null,
        reminder: null,
        attentionReason: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
        overrides: { status: null, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [],
        roadmapEvents: [],
      },
    ],
  };
}

interface ResponseRecord {
  status: number;
  body: PhaseStartResponseBody;
}

class FakePhaseSession implements BoundPhaseSession {
  readonly state: {
    provider: "anthropic";
    model: string;
    sessionId: string;
    sessionPath: string;
  };
  activeContext: ActivePhaseContextV1 | undefined;
  disposeCalls = 0;
  promptCalls = 0;
  lastPrompt = "";
  planMode = false;
  readonly #paneEventListeners = new Set<(event: string) => void>();

  constructor(
    sessionNumber: number,
    private readonly events: string[],
    private readonly failures: { initialize?: boolean; context?: boolean; prompt?: boolean } = {},
    private readonly label = `candidate-${sessionNumber}`,
  ) {
    this.state = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      sessionId: `session-${sessionNumber}`,
      sessionPath: `/sessions/session-${sessionNumber}.jsonl`,
    };
  }

  async initialize(): Promise<void> {
    this.events.push("candidate-initialize");
    if (this.failures.initialize) throw new Error("session creation failed");
  }

  getState() {
    return { ...this.state };
  }

  async setActivePhaseContext(context: ActivePhaseContextV1): Promise<void> {
    this.events.push("context-persisted");
    if (this.failures.context) throw new Error("active phase context persistence failed");
    this.activeContext = structuredClone(context);
  }

  getActivePhaseContext(): ActivePhaseContextV1 | undefined {
    return this.activeContext ? structuredClone(this.activeContext) : undefined;
  }

  getMessages(): Message[] {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "phase-verification",
            name: "bash",
            args: { command: "vitest run phase.test.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "phase-verification",
            content: "Exit code: 0",
          },
        ],
      },
    ];
  }

  async updateActivePhaseStage(
    executionStage: ActivePhaseExecutionStage,
    approvedPlanPath?: string,
  ): Promise<ActivePhaseContextV1> {
    const activeContext = this.activeContext;
    if (!activeContext) throw new Error("No active phase context is bound.");
    this.events.push("stage-persisted");
    const updated: ActivePhaseContextV1 = {
      ...activeContext,
      session: {
        sessionId: this.state.sessionId,
        sessionPath: this.state.sessionPath,
      },
      executionStage,
      ...(approvedPlanPath ? { approvedPlanPath } : { approvedPlanPath: undefined }),
    };
    this.activeContext = updated;
    return structuredClone(updated);
  }

  setIdealReviewSuppressed(suppressed: boolean): void {
    this.events.push(`ideal-review:${String(suppressed)}`);
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls += 1;
    this.lastPrompt = text;
    this.events.push("prompt");
    if (this.failures.prompt) throw new Error("provider unavailable");
  }

  async newSession(preserveConversation = false): Promise<void> {
    this.events.push(`fresh-session:${String(preserveConversation)}`);
    const next = Number(this.state.sessionId.split("-").at(-1)) + 100;
    this.state.sessionId = `session-${next}`;
    this.state.sessionPath = `/sessions/session-${next}.jsonl`;
    if (!preserveConversation) this.activeContext = undefined;
  }

  onPaneEvent(listener: (event: string) => void): void {
    this.#paneEventListeners.add(listener);
  }

  emitPaneEvent(event: string): void {
    for (const listener of this.#paneEventListeners) listener(event);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.events.push(`${this.label}-disposed`);
    this.#paneEventListeners.clear();
  }
}

function createApprovalLifecycle(
  repository: ProjectNotesRepository,
  cwd: string,
  session: FakePhaseSession,
  broadcastSnapshot: (snapshot: ProjectNotesSnapshot) => void = () => undefined,
): AppSidecarPhaseLifecycleCoordinator {
  return new AppSidecarPhaseLifecycleCoordinator({
    cwd,
    repository,
    getActivePhase: () => {
      const active = session.getActivePhaseContext();
      if (!active) return undefined;
      const state = session.getState();
      return {
        phaseId: active.phase.id,
        session: { sessionId: state.sessionId, sessionPath: state.sessionPath },
        executionStage: active.executionStage,
      };
    },
    broadcastSnapshot,
  });
}

interface FixtureOptions {
  mode?: "code" | "chat";
  busyState?: { running: boolean; autopilotActive: boolean; runLifecycleRunning: boolean };
  autopilotEnabled?: boolean;
  failInitializeCount?: number;
  failContextCount?: number;
  failPromptCount?: number;
  failBindingCount?: number;
  failAttention?: boolean;
  failEnterPlanMode?: boolean;
  pauseBinding?: { promise: Promise<void> };
  pauseAttention?: { promise: Promise<void> };
  sessionNumberBase?: number;
}

class ProductionPhaseFixture {
  readonly events: string[] = [];
  readonly paneEvents: string[] = [];
  readonly responses: ResponseRecord[] = [];
  readonly broadcasts: Array<{ type: string; data: unknown }> = [];
  readonly candidates = new AppSidecarPhaseCandidateStore<BoundPhaseCandidate<FakePhaseSession>>();
  readonly mutations: AppSidecarSessionMutationCoordinator;
  readonly reconciliations = new AppSidecarRoadmapReconciliationCoordinator();
  readonly previousSession: FakePhaseSession;
  currentSession: FakePhaseSession;
  createdSessions: FakePhaseSession[] = [];
  createCalls = 0;
  promptSettled: Promise<void> = Promise.resolve();
  private sequence = 0;
  private failInitializeCount: number;
  private failContextCount: number;
  private failPromptCount: number;
  private failBindingCount: number;

  constructor(
    readonly repository: ProjectNotesRepository,
    readonly cwd: string,
    readonly options: FixtureOptions = {},
  ) {
    this.mutations = new AppSidecarSessionMutationCoordinator(() => `operation-${++this.sequence}`);
    this.previousSession = new FakePhaseSession(0, this.events, {}, "previous");
    this.currentSession = this.previousSession;
    this.bindPaneEvents(this.previousSession);
    this.failInitializeCount = options.failInitializeCount ?? 0;
    this.failContextCount = options.failContextCount ?? 0;
    this.failPromptCount = options.failPromptCount ?? 0;
    this.failBindingCount = options.failBindingCount ?? 0;
  }

  async start(
    phaseId = "phase-21",
    advancementConfirmation?: {
      checkpointId: string;
      nextPhaseId: string;
      action: "start-next-phase";
    },
  ): Promise<ResponseRecord> {
    let responseRecord: ResponseRecord | undefined;
    const repository = this.phaseRepository();
    await launchBoundPhase({
      phaseId,
      advancementConfirmation,
      mode: this.options.mode ?? "code",
      busyState: this.options.busyState ?? {
        running: false,
        autopilotActive: false,
        runLifecycleRunning: false,
      },
      mutations: this.mutations,
      reconciliations: this.reconciliations,
      repository,
      cwd: this.cwd,
      candidates: this.candidates,
      getSession: () => this.currentSession,
      getThinkingLevel: () => "high",
      createSession: () => {
        this.createCalls += 1;
        this.events.push("candidate-created");
        const session = new FakePhaseSession(
          (this.options.sessionNumberBase ?? 0) + this.createCalls,
          this.events,
          {
            initialize: this.takeFailure("initialize"),
            context: this.takeFailure("context"),
            prompt: this.takeFailure("prompt"),
          },
        );
        this.createdSessions.push(session);
        return session;
      },
      replaceSession: (session) => {
        this.events.push("session-replaced");
        this.currentSession = session;
      },
      bindSessionEvents: (session) => {
        this.events.push("events-bound");
        this.bindPaneEvents(session);
      },
      autopilotEnabled: this.options.autopilotEnabled ?? false,
      broadcastNotesSnapshot: () => this.events.push("notes-fan-out"),
      broadcast: (type, data) => {
        this.events.push(type === "session_reset" ? "session-reset" : type);
        this.broadcasts.push({ type, data });
      },
      resetSessionState: () => this.events.push("phase-state-reset"),
      enterPlanMode: async () => {
        this.currentSession.planMode = true;
        this.events.push("plan-mode");
        if (this.options.failEnterPlanMode) throw new Error("plan mode failed");
      },
      startPrompt: (_label, run, onFailure) => {
        this.events.push("prompt-started");
        this.promptSettled = run()
          .catch(onFailure)
          .then(() => undefined);
      },
      respond: (status, body) => {
        this.events.push(`response:${status}`);
        responseRecord = { status, body };
        this.responses.push(responseRecord);
      },
      onLaunchFailure: () => this.events.push("launch-failure-reported"),
      onAttentionFailure: () => this.events.push("attention-failure-reported"),
    });
    if (!responseRecord) throw new Error("phase launch did not respond");
    return responseRecord;
  }

  async resetSession(): Promise<void> {
    await this.candidates.clear();
    await this.currentSession.newSession();
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.candidates.dispose(), this.currentSession.dispose()]);
  }

  private phaseRepository(): PhaseLaunchRepository {
    return {
      launchPhase: async (cwd, phaseId, createBinding) => {
        this.events.push("bind-started");
        const outcome = await this.repository.launchPhase(cwd, phaseId, async (frozen) => {
          const binding = await createBinding(frozen);
          await this.options.pauseBinding?.promise;
          if (this.failBindingCount > 0) {
            this.failBindingCount -= 1;
            throw new Error("bind persistence failed");
          }
          return binding;
        });
        this.events.push("bind-committed");
        return outcome;
      },
      confirmPhaseAdvancement: async (cwd, request, createBinding) => {
        this.events.push("bind-started");
        const outcome = await this.repository.confirmPhaseAdvancement(cwd, request, createBinding);
        this.events.push("bind-committed");
        return outcome;
      },
      recordPhaseLaunchAttention: async (cwd, phaseId, reason, expectedSession) => {
        await this.options.pauseAttention?.promise;
        if (this.options.failAttention) {
          throw new Error("attention persistence failed");
        }
        return this.repository.recordPhaseLaunchAttention(cwd, phaseId, reason, expectedSession);
      },
    };
  }

  private bindPaneEvents(session: FakePhaseSession): void {
    session.onPaneEvent((event) => this.paneEvents.push(event));
  }
  private takeFailure(kind: "initialize" | "context" | "prompt"): boolean {
    const key =
      kind === "initialize"
        ? "failInitializeCount"
        : kind === "context"
          ? "failContextCount"
          : "failPromptCount";
    if (this[key] <= 0) return false;
    this[key] -= 1;
    return true;
  }
}

async function setup(migrate = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-phase-route-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd, { recursive: true });
  const repository = new ProjectNotesRepository(path.join(root, ".gg"));
  if (migrate) await repository.migrate(cwd, document());
  return { repository, cwd, root };
}

async function updatePhase(
  repository: ProjectNotesRepository,
  cwd: string,
  update: (document: NotesDocumentV3) => void,
): Promise<void> {
  const loaded = await repository.load(cwd);
  if (loaded.status !== "ok") throw new Error(`Project Notes load failed: ${loaded.status}`);
  const next = structuredClone(loaded.snapshot.document);
  update(next);
  const saved = await repository.save(cwd, loaded.snapshot.revision, next);
  if (saved.status !== "ok") throw new Error(`Project Notes save failed: ${saved.status}`);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("cancel route phase persistence", () => {
  const activeCancellation: BoundPhaseLifecycleContext = {
    phaseId: "phase-21",
    session: { sessionId: "session-21", sessionPath: "/sessions/session-21.jsonl" },
    executionStage: "implementing",
  };

  function cancellationFixture(outcomes: Array<PhaseLifecycleRepositoryOutcome | Error>): {
    persistence: AppSidecarCancellationPersistence;
    broadcasts: Array<{ type: string; data: unknown }>;
    successfulWrites: number;
  } {
    const broadcasts: Array<{ type: string; data: unknown }> = [];
    let successfulWrites = 0;
    const lifecycle = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository: {
        recordPhaseLifecycleTransition: vi.fn(async () => {
          const outcome = outcomes.shift();
          if (outcome instanceof Error) throw outcome;
          if (!outcome) throw new Error("missing test outcome");
          if (outcome.status === "ok") successfulWrites += 1;
          return outcome;
        }),
      },
      getActivePhase: () => activeCancellation,
      broadcastSnapshot: vi.fn(),
    });
    return {
      persistence: new AppSidecarCancellationPersistence({
        lifecycle,
        broadcast: (type, data) => broadcasts.push({ type, data }),
        createOperationId: () => "cancel-operation-1",
      }),
      broadcasts,
      get successfulWrites() {
        return successfulWrites;
      },
    };
  }

  function cancellationSnapshot(): ProjectNotesSnapshot {
    const notes = document();
    const phase = notes.phases[0]!;
    phase.status = "cancelled";
    phase.completedAt = NOW;
    phase.session = { ...activeCancellation.session };
    phase.lifecycleEvents.push({
      id: "cancel-event-1",
      fromStatus: "in-progress",
      toStatus: "cancelled",
      source: "user",
      timestamp: NOW,
      reason: "Phase run cancelled by user",
      kind: "other",
    });
    return { projectKey: "/project", revision: 2, document: notes };
  }

  it("reports a committed Cancelled record without a partial failure", async () => {
    const fixture = cancellationFixture([{ status: "ok", snapshot: cancellationSnapshot() }]);

    await expect(
      fixture.persistence.recordConfirmedCancellation(activeCancellation),
    ).resolves.toMatchObject({
      roadmapStatusSaved: true,
      roadmapStatusOutcome: "committed",
      roadmapStatusRetryable: false,
    });
    expect(fixture.broadcasts).toEqual([]);
  });

  it.each(["manual-override", "done-terminal"] as const)(
    "keeps the cancelled run truthful when Project Notes is protected by %s",
    async (status) => {
      const fixture = cancellationFixture([
        status === "manual-override" ? { status, snapshot: cancellationSnapshot() } : { status },
      ]);

      const response = {
        cancelled: true,
        ...(await fixture.persistence.recordConfirmedCancellation(activeCancellation)),
      };
      expect(response).toEqual({
        cancelled: true,
        roadmapStatusSaved: false,
        roadmapStatusOutcome: status,
        roadmapStatusRetryable: false,
      });
      expect(fixture.broadcasts).toEqual([]);
    },
  );

  it.each(["stale-session", "missing", "corrupt", "phase-not-found", "phase-archived"] as const)(
    "surfaces %s as a typed cancellation persistence partial failure",
    async (status) => {
      const fixture = cancellationFixture([{ status }]);

      const response = {
        cancelled: true,
        ...(await fixture.persistence.recordConfirmedCancellation(activeCancellation)),
      };
      expect(response).toMatchObject({
        cancelled: true,
        roadmapStatusSaved: false,
        roadmapStatusOutcome: status,
        roadmapStatusRetryable: true,
        roadmapStatusFailure: {
          operationId: "cancel-operation-1",
          phaseId: "phase-21",
          code: status,
          recovery: expect.stringContaining("Project Notes"),
        },
      });
      expect(fixture.broadcasts).toEqual([
        {
          type: "phase_cancellation_persistence_failed",
          data: expect.objectContaining({ code: status, phaseId: "phase-21" }),
        },
      ]);
    },
  );

  it("surfaces a thrown storage failure while leaving cancellation acknowledged", async () => {
    const fixture = cancellationFixture([new Error("disk full")]);

    const response = {
      cancelled: true,
      ...(await fixture.persistence.recordConfirmedCancellation(activeCancellation)),
    };
    expect(response).toMatchObject({
      cancelled: true,
      roadmapStatusSaved: false,
      roadmapStatusOutcome: "storage-failure",
      roadmapStatusRetryable: true,
      roadmapStatusFailure: { code: "storage-failure", detail: "disk full" },
    });
  });

  it("retries the captured phase through the route and appends exactly one Cancelled event", async () => {
    const fixture = cancellationFixture([
      new Error("temporary storage failure"),
      { status: "ok", snapshot: cancellationSnapshot() },
    ]);
    await fixture.persistence.recordConfirmedCancellation(activeCancellation);
    const response = new Promise<{ status: number; body: unknown }>((resolve) => {
      expect(
        handleCancellationPersistenceRetryRoute({
          method: "POST",
          url: "/cancel/roadmap-status/retry",
          retry: () => fixture.persistence.retry(),
          respond: (status, body) => resolve({ status, body }),
        }),
      ).toBe(true);
    });

    await expect(response).resolves.toMatchObject({
      status: 200,
      body: {
        roadmapStatusSaved: true,
        roadmapStatusOutcome: "committed",
        roadmapStatusRetryable: false,
      },
    });
    expect(fixture.successfulWrites).toBe(1);
    expect(cancellationSnapshot().document.phases[0]!.lifecycleEvents).toHaveLength(1);
    await expect(fixture.persistence.retry()).resolves.toMatchObject({
      roadmapStatusOutcome: "not-pending",
    });
    expect(fixture.successfulWrites).toBe(1);
    expect(fixture.broadcasts.at(-1)).toMatchObject({
      type: "phase_cancellation_persistence_recovered",
      data: { phaseId: "phase-21", roadmapStatusSaved: true },
    });
  });
});

describe("production launchBoundPhase orchestration", () => {
  it("uses the production bind → fan-out → replacement → reset → Plan Mode → response → prompt order", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);

    const response = await fixture.start();
    await fixture.promptSettled;

    expect(response).toMatchObject({
      status: 202,
      body: {
        status: "accepted",
        operationId: "operation-1",
        session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
        packageTokenCount: expect.any(Number),
      },
    });
    expect(fixture.events).toEqual([
      "bind-started",
      "candidate-created",
      "candidate-initialize",
      "context-persisted",
      "bind-committed",
      "notes-fan-out",
      "session-replaced",
      "events-bound",
      "ideal-review:false",
      "phase-state-reset",
      "session-reset",
      "plan-mode",
      "previous-disposed",
      "response:202",
      "prompt-started",
      "prompt",
    ]);
    expect(fixture.currentSession.planMode).toBe(true);
    expect(fixture.currentSession.activeContext).toMatchObject({
      phase: { id: "phase-21" },
      references: [{ id: "ref-1" }],
      session: { sessionId: "session-1" },
    });
    expect(fixture.currentSession.lastPrompt).toContain('"id": "phase-21"');
    expect(fixture.currentSession.lastPrompt).toContain('"id": "ref-1"');
    expect(fixture.currentSession.lastPrompt).not.toContain("unrelated free-form Notes");
    expect(fixture.currentSession.lastPrompt).not.toContain("another phase");
    expect(fixture.mutations.owner).toBeNull();
    const promoted = fixture.createdSessions[0]!;
    expect(promoted.disposeCalls).toBe(0);
    expect(fixture.candidates.has("phase-21")).toBe(false);

    await fixture.dispose();

    expect(promoted.disposeCalls).toBe(1);
  });

  it("isolates a parent-root draft from a child repo while launching it in-place at the exact cwd", async () => {
    const { repository, cwd: parentCwd } = await setup();
    const childCwd = path.join(parentCwd, "repo");
    await fs.mkdir(childCwd, { recursive: true });
    const baseline = await repository.load(parentCwd);
    if (baseline.status !== "ok") throw new Error("Expected parent Roadmap baseline");

    const sourcePrompt = "Plan and implement the exact parent-root phase";
    const ids = ["draft-parent-scope", "phase-parent-scope"];
    const drafts = new AppSidecarRoadmapDraftCoordinator({ createId: () => ids.shift()! });
    const drafted = drafts.create({
      cwd: parentCwd,
      sessionId: "research-chat-at-parent-root",
      request: {
        expectedRevision: baseline.snapshot.revision,
        summary: "Parent-root scope regression",
        phases: [
          {
            title: "Parent-root phase",
            goal: "Prove exact canonical cwd isolation and same-cwd launch",
            doneWhen: ["The parent-root phase launches only from its exact project"],
            sourcePrompt,
          },
        ],
      },
    });
    expect(drafted).toMatchObject({
      status: "drafted",
      draft: { projectKey: baseline.snapshot.projectKey },
    });
    if (drafted.status !== "drafted") throw new Error("Expected parent-root Roadmap draft");
    expect(drafts.pending(childCwd)).toBeNull();

    const draftDecision = new AppSidecarRoadmapDraftDecisionService({
      drafts,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      onCommittedSnapshot: () => undefined,
    });
    await expect(draftDecision.approve(parentCwd, drafted.draft.id)).resolves.toMatchObject({
      status: "created",
      phaseIds: ["phase-parent-scope"],
    });
    await expect(repository.load(childCwd)).resolves.toEqual({ status: "missing" });

    const childFixture = new ProductionPhaseFixture(repository, childCwd);
    await expect(childFixture.start("phase-parent-scope")).resolves.toMatchObject({
      status: 404,
      body: { status: "failed", code: "notes-missing" },
    });
    expect(childFixture.createCalls).toBe(0);
    expect(childFixture.currentSession).toBe(childFixture.previousSession);
    expect(childFixture.events).not.toContain("session-replaced");
    expect(childFixture.broadcasts).toEqual([]);

    const parentFixture = new ProductionPhaseFixture(repository, parentCwd);
    const outerMutationCoordinator = parentFixture.mutations;
    const previousInnerSession = parentFixture.currentSession;
    previousInnerSession.emitPaneEvent("before-phase-bind");

    await expect(parentFixture.start("phase-parent-scope")).resolves.toMatchObject({
      status: 202,
      body: {
        status: "accepted",
        session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
      },
    });
    await parentFixture.promptSettled;

    expect(parentFixture.mutations).toBe(outerMutationCoordinator);
    expect(parentFixture.currentSession).not.toBe(previousInnerSession);
    expect(previousInnerSession.disposeCalls).toBe(1);
    expect(parentFixture.events).toContain("session-replaced");
    expect(parentFixture.broadcasts).toContainEqual({
      type: "session_reset",
      data: expect.objectContaining({
        phaseId: "phase-parent-scope",
        sessionId: "session-1",
      }),
    });
    expect(parentFixture.currentSession.activeContext?.phase.sourcePrompt).toBe(sourcePrompt);
    expect(parentFixture.currentSession.lastPrompt).toContain(sourcePrompt);
    parentFixture.currentSession.emitPaneEvent("after-phase-bind");
    expect(parentFixture.paneEvents).toEqual(["before-phase-bind", "after-phase-bind"]);
    expect(parentFixture.events).not.toContain("fresh-session:false");

    await childFixture.dispose();
    await parentFixture.dispose();
  });

  it("gives a double-click one mutation winner and releases the lease for retry", async () => {
    const { repository, cwd } = await setup();
    const pause = deferred();
    const fixture = new ProductionPhaseFixture(repository, cwd, { pauseBinding: pause });

    const winner = fixture.start();
    await viWaitFor(() => fixture.candidates.has("phase-21"));
    const loser = await fixture.start();

    expect(loser).toEqual({
      status: 409,
      body: {
        status: "failed",
        code: "session-mutation-in-progress",
        operationId: "operation-1",
        message: "Another session action is already in progress.",
      },
    });
    pause.resolve();
    await expect(winner).resolves.toMatchObject({ status: 202, body: { status: "accepted" } });
    await fixture.promptSettled;
    expect(fixture.createCalls).toBe(1);
    expect(fixture.currentSession.promptCalls).toBe(1);
    expect(fixture.mutations.owner).toBeNull();
  });

  it("allows one cross-window binding winner and makes the loser an exact Resume response", async () => {
    const { repository, cwd, root } = await setup();
    const first = new ProductionPhaseFixture(repository, cwd);
    const second = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
    );

    const [left, right] = await Promise.all([first.start(), second.start()]);
    await Promise.all([first.promptSettled, second.promptSettled]);

    expect(new Set([left.body.status, right.body.status])).toEqual(
      new Set(["accepted", "already-bound"]),
    );
    const resume = left.body.status === "already-bound" ? left : right;
    expect(resume).toMatchObject({
      status: 200,
      body: {
        status: "already-bound",
        session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
        packageTokenCount: 0,
      },
    });
    expect(first.createCalls + second.createCalls).toBe(1);
    expect(first.currentSession.promptCalls + second.currentSession.promptCalls).toBe(1);
  });

  it.each(["not-started", "needs-attention", "cancelled"] as const)(
    "recovers a null-path %s binding with one authoritative replacement",
    async (status) => {
      const { repository, cwd } = await setup(false);
      const seeded = document();
      const phase = seeded.phases[0]!;
      phase.status = status;
      phase.session = { sessionId: "bound", sessionPath: null };
      phase.attentionReason =
        status === "needs-attention" ? "Previous launch lost its session path." : null;
      phase.completedAt = status === "cancelled" ? NOW : null;
      phase.overrides.status = null;
      phase.lifecycleEvents = [];
      await repository.migrate(cwd, seeded);
      const fixture = new ProductionPhaseFixture(repository, cwd);

      const response = await fixture.start();
      await fixture.promptSettled;

      expect(response).toMatchObject({
        status: 202,
        body: {
          status: "accepted",
          session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
        },
      });
      expect(fixture.createCalls).toBe(1);
      expect(fixture.currentSession.promptCalls).toBe(1);
      expect(await repository.load(cwd)).toMatchObject({
        status: "ok",
        snapshot: {
          document: {
            phases: [
              {
                status: "planning",
                session: {
                  sessionId: "session-1",
                  sessionPath: "/sessions/session-1.jsonl",
                },
                lifecycleEvents: [
                  expect.objectContaining({ fromStatus: status, toStatus: "planning" }),
                ],
              },
            ],
          },
        },
      });
      await fixture.dispose();
    },
  );

  it("records launch attention against the original null-path binding when replacement commit fails", async () => {
    const { repository, cwd } = await setup();
    await updatePhase(repository, cwd, (notes) => {
      const phase = notes.phases[0]!;
      phase.session = { sessionId: "bound", sessionPath: null };
    });
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "needs-attention",
              session: { sessionId: "bound", sessionPath: null },
              attentionReason: "Phase launch failed. Retry Start phase.",
            },
          ],
        },
      },
    });
    expect(fixture.events.filter((event) => event === "notes-fan-out")).toHaveLength(1);
    await fixture.dispose();
  });

  it("rejects losing pre-binding attention after a cross-window winner commits", async () => {
    const { repository, cwd, root } = await setup();
    const bindingGate = deferred();
    const attentionGate = deferred();
    const loser = new ProductionPhaseFixture(repository, cwd, {
      failBindingCount: 1,
      pauseBinding: bindingGate,
      pauseAttention: attentionGate,
    });
    const winner = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
      { sessionNumberBase: 100 },
    );

    const losingStart = loser.start();
    await viWaitFor(() => loser.candidates.has("phase-21"));
    const winningStart = winner.start();
    await viWaitFor(() => winner.events.includes("bind-started"));

    bindingGate.resolve();
    await viWaitFor(() => loser.events.includes("launch-failure-reported"));
    await expect(winningStart).resolves.toMatchObject({
      status: 202,
      body: { status: "accepted", session: { sessionId: "session-101" } },
    });
    await winner.promptSettled;
    attentionGate.resolve();
    await expect(losingStart).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "planning",
              session: {
                sessionId: "session-101",
                sessionPath: "/sessions/session-101.jsonl",
              },
              attentionReason: null,
              lifecycleEvents: [
                expect.objectContaining({
                  fromStatus: "not-started",
                  toStatus: "planning",
                  source: "user",
                }),
              ],
            },
          ],
        },
      },
    });
    expect(loser.events.filter((event) => event === "notes-fan-out")).toHaveLength(0);
  });

  it("retires the previous session after promotion when Plan Mode entry fails", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failEnterPlanMode: true });
    const previous = fixture.previousSession;

    await expect(fixture.start()).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    const promoted = fixture.createdSessions[0]!;
    expect(previous.disposeCalls).toBe(1);
    expect(fixture.currentSession).toBe(promoted);
    expect(promoted.disposeCalls).toBe(0);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    expect(fixture.events.filter((event) => event === "session-replaced")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "events-bound")).toHaveLength(1);

    previous.emitPaneEvent("stale-previous-session-event");
    promoted.emitPaneEvent("promoted-session-event");
    expect(fixture.paneEvents).toEqual(["promoted-session-event"]);

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "needs-attention",
              session: {
                sessionId: "session-1",
                sessionPath: "/sessions/session-1.jsonl",
              },
              attentionReason: "Phase launch failed. Retry Start phase.",
            },
          ],
        },
      },
    });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 200,
      body: {
        status: "already-bound",
        session: {
          sessionId: "session-1",
          sessionPath: "/sessions/session-1.jsonl",
        },
      },
    });
    expect(fixture.createCalls).toBe(1);
    expect(fixture.currentSession).toBe(promoted);
    expect(promoted.promptCalls).toBe(0);
    expect(promoted.disposeCalls).toBe(0);
    expect(previous.disposeCalls).toBe(1);
    expect(fixture.events.filter((event) => event === "session-replaced")).toHaveLength(1);

    await fixture.dispose();
    expect(promoted.disposeCalls).toBe(1);
    expect(previous.disposeCalls).toBe(1);
  });

  it("guards post-binding launch failure attention with the committed session", async () => {
    const { repository, cwd } = await setup();
    const attentionGate = deferred();
    const fixture = new ProductionPhaseFixture(repository, cwd, {
      failEnterPlanMode: true,
      pauseAttention: attentionGate,
    });

    const start = fixture.start();
    await viWaitFor(() => fixture.events.includes("launch-failure-reported"));
    await expect(
      repository.updatePhaseSessionLink(cwd, "phase-21", {
        sessionId: "session-new-owner",
        sessionPath: "/sessions/new-owner.jsonl",
      }),
    ).resolves.toMatchObject({ status: "ok" });
    attentionGate.resolve();
    await expect(start).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "planning",
              session: {
                sessionId: "session-new-owner",
                sessionPath: "/sessions/new-owner.jsonl",
              },
              attentionReason: null,
              lifecycleEvents: [
                expect.objectContaining({
                  fromStatus: "not-started",
                  toStatus: "planning",
                  source: "user",
                }),
              ],
            },
          ],
        },
      },
    });
    expect(fixture.events.filter((event) => event === "notes-fan-out")).toHaveLength(1);
  });

  it.each([
    ["session initialization", { failInitializeCount: 1 }],
    ["active-context persistence", { failContextCount: 1 }],
  ])(
    "disposes a failed %s candidate, releases mutation, and retries safely",
    async (_name, options) => {
      const { repository, cwd } = await setup();
      const fixture = new ProductionPhaseFixture(repository, cwd, options);

      const failed = await fixture.start();

      expect(failed).toMatchObject({ status: 500, body: { code: "launch-failed" } });
      expect(fixture.createdSessions[0]?.disposeCalls).toBe(1);
      expect(fixture.previousSession.disposeCalls).toBe(0);
      expect(fixture.candidates.has("phase-21")).toBe(false);
      expect(fixture.mutations.owner).toBeNull();
      expect(await repository.load(cwd)).toMatchObject({
        status: "ok",
        snapshot: {
          document: {
            phases: [
              {
                status: "needs-attention",
                session: null,
                lifecycleEvents: [
                  expect.objectContaining({
                    fromStatus: "not-started",
                    toStatus: "needs-attention",
                    source: "system",
                  }),
                ],
              },
            ],
          },
        },
      });

      await expect(fixture.start()).resolves.toMatchObject({
        status: 202,
        body: { status: "accepted" },
      });
      await fixture.promptSettled;
      expect(fixture.createCalls).toBe(2);
      expect(fixture.createdSessions[0]?.disposeCalls).toBe(1);
      expect(fixture.previousSession.disposeCalls).toBe(1);
      expect(fixture.currentSession.promptCalls).toBe(1);
    },
  );

  it("retains one initialized candidate across bind failure and reuses it on retry", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    const failed = await fixture.start();

    expect(failed).toMatchObject({ status: 500, body: { code: "launch-failed" } });
    expect(fixture.candidates.has("phase-21")).toBe(true);
    expect(fixture.createdSessions[0]?.disposeCalls).toBe(0);
    expect(fixture.currentSession.promptCalls).toBe(0);
    expect(fixture.mutations.owner).toBeNull();

    const retried = await fixture.start();
    await fixture.promptSettled;

    expect(retried).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(fixture.createCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    expect(fixture.currentSession).toBe(fixture.createdSessions[0]);
    expect(fixture.currentSession.promptCalls).toBe(1);
  });

  it("disposes a retained bind-failure candidate exactly once with its logical owner", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    await fixture.start();
    const retained = fixture.createdSessions[0]!;
    expect(retained.disposeCalls).toBe(0);

    await fixture.dispose();
    await fixture.candidates.dispose();

    expect(retained.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
  });

  it("disposes a retained candidate when an external owner wins before retry", async () => {
    const { repository, cwd, root } = await setup();
    const staleOwner = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });
    const winner = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
    );

    await staleOwner.start();
    const stale = staleOwner.createdSessions[0]!;
    await expect(winner.start()).resolves.toMatchObject({
      status: 202,
      body: { status: "accepted" },
    });
    await winner.promptSettled;

    await expect(staleOwner.start()).resolves.toMatchObject({
      status: 200,
      body: { status: "already-bound" },
    });
    expect(stale.disposeCalls).toBe(1);
    expect(staleOwner.candidates.has("phase-21")).toBe(false);

    await staleOwner.dispose();
    await winner.dispose();
    expect(stale.disposeCalls).toBe(1);
  });

  it("disposes a retained candidate exactly once on explicit New Session reset", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    await fixture.start();
    const stale = fixture.createdSessions[0]!;

    await fixture.resetSession();

    expect(stale.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    await fixture.dispose();
    expect(stale.disposeCalls).toBe(1);
  });

  it("responds before prompting and turns provider failure into durable retry attention", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failPromptCount: 1 });

    const accepted = await fixture.start();
    expect(accepted).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(fixture.events.indexOf("response:202")).toBeLessThan(fixture.events.indexOf("prompt"));
    await fixture.promptSettled;

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              session: { sessionId: "session-1" },
              attentionReason:
                "The phase session was created, but its first planning prompt failed. Resume the phase to retry.",
            },
          ],
        },
      },
    });
    expect(fixture.broadcasts.at(-1)).toMatchObject({
      type: "phase_launch_error",
      data: { code: "prompt-failed", detail: "provider unavailable" },
    });
    expect(fixture.mutations.owner).toBeNull();
  });

  it("broadcasts prompt failure even when durable attention cannot be saved", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, {
      failPromptCount: 1,
      failAttention: true,
    });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 202,
      body: { status: "accepted" },
    });
    await fixture.promptSettled;

    expect(fixture.events).toContain("attention-failure-reported");
    expect(fixture.broadcasts.at(-1)).toMatchObject({
      type: "phase_launch_error",
      data: { code: "prompt-failed", detail: "provider unavailable" },
    });
  });

  it.each([
    ["missing", false, 404, "notes-missing"],
    ["corrupt", true, 409, "notes-corrupt"],
    ["phase-not-found", true, 409, "phase-not-found"],
    ["phase-archived", true, 409, "phase-archived"],
  ])(
    "returns the exact %s response without replacement or prompt",
    async (kind, migrate, status, code) => {
      const { repository, cwd } = await setup(migrate);
      if (kind === "corrupt") {
        const paths = repository.paths(cwd);
        await Promise.all([
          fs.writeFile(paths.primary, "{malformed"),
          fs.writeFile(paths.backup, "{malformed"),
        ]);
      } else if (kind === "phase-not-found") {
        await updatePhase(repository, cwd, (notes) => {
          notes.phases = [];
        });
      } else if (kind === "phase-archived") {
        await updatePhase(repository, cwd, (notes) => {
          notes.phases[0]!.archivedAt = NOW;
        });
      }
      const fixture = new ProductionPhaseFixture(repository, cwd);

      const response = await fixture.start();

      expect(response).toMatchObject({ status, body: { status: "failed", code } });
      expect(fixture.createCalls).toBe(0);
      expect(fixture.events).not.toContain("session-replaced");
      expect(fixture.events).not.toContain("prompt");
      expect(fixture.mutations.owner).toBeNull();
    },
  );

  it("returns the durable binding after restart so the caller can Resume without a second prompt", async () => {
    const { repository, cwd, root } = await setup();
    const first = new ProductionPhaseFixture(repository, cwd);
    const accepted = await first.start();
    await first.promptSettled;
    await first.dispose();

    const restarted = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
    );
    const resume = await restarted.start();

    expect(accepted).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(resume).toMatchObject({
      status: 200,
      body: {
        status: "already-bound",
        session: accepted.body.status === "accepted" ? accepted.body.session : undefined,
        packageTokenCount: 0,
      },
    });
    expect(restarted.createCalls).toBe(0);
    expect(restarted.currentSession.promptCalls).toBe(0);
  });

  it.each(["manual", "Autopilot"])(
    "keeps the launched phase linked through the %s approval checkpoint",
    async (approvalSource) => {
      const { repository, cwd } = await setup();
      const fixture = new ProductionPhaseFixture(repository, cwd, {
        autopilotEnabled: approvalSource === "Autopilot",
      });
      await fixture.start();
      await fixture.promptSettled;
      const session = fixture.currentSession;
      const approvalLifecycle = createApprovalLifecycle(repository, cwd, session, () =>
        fixture.events.push("approval-notes-fan-out"),
      );

      const result = await commitPlanApprovalCheckpoint({
        session,
        repository,
        cwd,
        planPath: "/plans/phase-21.md",
        approvalSource: approvalSource === "Autopilot" ? "agent" : "user",
        reconcileLifecycle: (signal) => approvalLifecycle.enqueue(signal),
        prepareFreshSession: async () => {
          fixture.events.push(`${approvalSource}-approval`);
          await session.newSession(true);
          return 3;
        },
        onSnapshot: () => fixture.events.push("unexpected-direct-approval-fan-out"),
      });

      expect(result.planTotal).toBe(3);
      expect(fixture.events.slice(-4)).toEqual([
        `${approvalSource}-approval`,
        "fresh-session:true",
        "stage-persisted",
        "approval-notes-fan-out",
      ]);
      expect(session.activeContext).toMatchObject({
        executionStage: "implementing",
        approvedPlanPath: "/plans/phase-21.md",
      });
      expect(await repository.load(cwd)).toMatchObject({
        status: "ok",
        snapshot: {
          document: {
            phases: [
              {
                status: "in-progress",
                session: {
                  sessionId: session.state.sessionId,
                  sessionPath: session.state.sessionPath,
                },
                lifecycleEvents: expect.arrayContaining([
                  expect.objectContaining({
                    toStatus: "in-progress",
                    source: approvalSource === "Autopilot" ? "agent" : "user",
                    reason:
                      approvalSource === "Autopilot"
                        ? "Plan approved by Autopilot"
                        : "Plan approved by user",
                  }),
                ]),
              },
            ],
          },
        },
      });
    },
  );

  it("persists plan approval as the pending automatic target while a user override is active", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    await fixture.start();
    await fixture.promptSettled;
    await updatePhase(repository, cwd, (notes) => {
      const phase = notes.phases[0]!;
      phase.overrides.status = {
        value: phase.status,
        source: "user",
        updatedAt: phase.updatedAt,
      };
    });
    const session = fixture.currentSession;
    const snapshots: ProjectNotesSnapshot[] = [];
    const approvalLifecycle = createApprovalLifecycle(repository, cwd, session, (snapshot) =>
      snapshots.push(snapshot),
    );

    await commitPlanApprovalCheckpoint({
      session,
      repository,
      cwd,
      planPath: "/plans/phase-21.md",
      approvalSource: "user",
      reconcileLifecycle: (signal) => approvalLifecycle.enqueue(signal),
      prepareFreshSession: async () => {
        await session.newSession(true);
        return 3;
      },
      onSnapshot: () => {
        throw new Error(
          "manual override persistence must fan out through lifecycle reconciliation",
        );
      },
    });

    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "planning",
              overrides: { status: { value: "planning", source: "user" } },
              pendingAutomaticLifecycleTransition: {
                status: "in-progress",
                source: "user",
                reason: "Plan approved by user",
                kind: "approval-resolved",
                expectedSession: {
                  sessionId: session.state.sessionId,
                  sessionPath: session.state.sessionPath,
                },
              },
            },
          ],
        },
      },
    });
    expect(snapshots).toHaveLength(1);
    if (loaded.status !== "ok") throw new Error("Expected pending approval Notes");
    expect(snapshots[0]).toEqual(loaded.snapshot);
  });

  it("disposes a retained candidate when retry discovers a phase archive", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });
    await fixture.start();
    const stale = fixture.createdSessions[0]!;
    await updatePhase(repository, cwd, (notes) => {
      notes.phases[0]!.archivedAt = NOW;
    });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 409,
      body: { code: "phase-archived" },
    });
    expect(stale.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    await fixture.dispose();
    expect(stale.disposeCalls).toBe(1);
  });

  it("disposes a stale candidate when another window completes the phase before Start", async () => {
    const { repository, cwd } = await setup(false);
    const fixture = new ProductionPhaseFixture(repository, cwd);
    const staleCandidate = new FakePhaseSession(99, fixture.events);
    await fixture.candidates.add("phase-21", {
      session: staleCandidate,
      initialPrompt: "stale prompt",
      tokenCount: 1,
    });
    const completedNotes = document();
    const completedPhase = completedNotes.phases[0]!;
    completedPhase.status = "done";
    completedPhase.completedAt = NOW;
    completedPhase.overrides.status = null;
    completedPhase.lifecycleEvents.push({
      id: "event-done",
      fromStatus: "not-started",
      toStatus: "done",
      source: "user",
      timestamp: NOW,
      reason: "Completion review accepted",
      kind: "other",
    });
    await repository.migrate(cwd, completedNotes);
    const beforeStart = await repository.load(cwd);
    if (beforeStart.status !== "ok") throw new Error("Expected completed phase");

    await expect(fixture.start()).resolves.toEqual({
      status: 409,
      body: {
        status: "failed",
        code: "phase-inactive",
        operationId: "operation-1",
        message: "This phase is already Done. Reopen Roadmap to review its completion evidence.",
      },
    });

    expect(fixture.createCalls).toBe(0);
    expect(staleCandidate.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    expect(fixture.events).not.toContain("session-replaced");
    expect(fixture.events).not.toContain("phase-state-reset");
    expect(fixture.events).not.toContain("session-reset");
    expect(fixture.events).not.toContain("plan-mode");
    expect(fixture.events).not.toContain("prompt-started");
    expect(staleCandidate.promptCalls).toBe(0);
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: beforeStart.snapshot.revision,
        document: { phases: [{ status: "done", session: null }] },
      },
    });
    await fixture.dispose();
    expect(staleCandidate.disposeCalls).toBe(1);
  });
});
async function viWaitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("phase candidate ownership", () => {
  it("settles every remaining disposal even when one candidate throws", async () => {
    const calls = [0, 0];
    const candidates = new AppSidecarPhaseCandidateStore<{
      session: { dispose: () => void };
    }>();
    await candidates.add("phase-a", {
      session: {
        dispose: () => {
          calls[0] += 1;
          throw new Error("dispose failed");
        },
      },
    });
    await candidates.add("phase-b", {
      session: {
        dispose: () => {
          calls[1] += 1;
        },
      },
    });

    await expect(candidates.dispose()).resolves.toBeUndefined();

    expect(calls).toEqual([1, 1]);
  });
});
