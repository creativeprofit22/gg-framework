import { describe, expect, it } from "vitest";
import {
  createAppSidecarRoadmapPhaseAdvancementCoordinator,
  selectLatestRoadmapPhaseAdvancement,
  selectNextEligibleRoadmapPhase,
  type RoadmapPhaseAdvancementMode,
  type RoadmapPhaseAdvancementSession,
  type RoadmapPhaseEligibility,
} from "./app-sidecar-phase-advancement.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type {
  NotesPhase,
  NotesRoadmapCompletionReview,
  NotesRoadmapPhaseAdvancementCheckpoint,
  NotesRoadmapStatusUpdate,
  ProjectNotesAutomaticPhaseAdvancementOutcome,
  ProjectNotesRepository,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

const NOW = "2026-08-12T12:00:00.000Z";
const LATER = "2026-08-12T12:01:00.000Z";

function completionReview(
  overrides: Partial<NotesRoadmapCompletionReview> = {},
): NotesRoadmapCompletionReview {
  return {
    type: "completion-review",
    id: "review-complete",
    reviewer: "ken",
    decision: "accepted",
    evidence: ["All completion gates passed"],
    reason: null,
    implementationCheckpointId: "checkpoint-complete",
    verificationStatusUpdateId: "verification-complete",
    acceptsVerificationException: false,
    gateOutcome: "done",
    unmetGateCodes: [],
    timestamp: NOW,
    ...overrides,
  };
}

function phase(
  id: string,
  order: number,
  status: NotesPhase["status"] = "not-started",
  overrides: Partial<NotesPhase> = {},
): NotesPhase {
  return {
    id,
    title: id,
    goal: `Complete ${id}`,
    doneWhen: [`${id} is complete`],
    order,
    status,
    sourcePrompt: `Implement ${id}`,
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "done" || status === "cancelled" ? NOW : null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
    ...overrides,
  };
}

function completedSource(
  reviews: NotesRoadmapCompletionReview[] = [completionReview()],
  overrides: Partial<NotesPhase> = {},
): NotesPhase {
  return phase("source", 10, "done", {
    session: { sessionId: "completed-session", sessionPath: "/sessions/completed.jsonl" },
    roadmapEvents: reviews,
    ...overrides,
  });
}

function snapshot(phases: NotesPhase[]): ProjectNotesSnapshot {
  return {
    projectKey: "/project",
    revision: 12,
    document: {
      version: 3,
      reference: "",
      currentFocus: "Advance the Roadmap",
      tasks: [],
      handoff: { text: "", updatedAt: null, readAt: null },
      updatedAt: NOW,
      legacyImportedAt: null,
      phases,
      references: [],
    },
  };
}

const directSession = {
  sessionId: "direct-session",
  sessionPath: "/sessions/direct.jsonl",
};

function directCompletionFixture(kind: "malformed-evidence" | "later-untyped-status") {
  const verification: NotesRoadmapStatusUpdate = {
    type: "status-update",
    id: "verification-direct",
    actor: "gg-coder",
    transition: kind === "malformed-evidence" ? "in-progress" : "done",
    progress: "Verification passed",
    blocker: null,
    requiredExternalAction: null,
    evidence: ["pnpm test exited successfully"],
    verification: "passed",
    verificationReason: null,
    verificationSession: directSession,
    statusOutcome: kind === "malformed-evidence" ? "applied" : "completion-pending",
    proposedReferences: [],
    timestamp: NOW,
  };
  const events: NotesPhase["roadmapEvents"] = [verification];
  if (kind === "later-untyped-status") {
    events.push({
      ...verification,
      id: "status-after-verification",
      transition: "in-progress",
      progress: "Work continued after verification",
      evidence: [],
      verification: null,
      verificationSession: null,
      statusOutcome: "applied",
    });
  }
  events.push({
    type: "implementation-checkpoint",
    id: "implementation-direct",
    session: directSession,
    planStepTotal: 1,
    completedPlanSteps: kind === "malformed-evidence" ? [] : [1],
    runOutcome: "succeeded",
    verificationStatusUpdateId: verification.id,
    timestamp: NOW,
  });
  const checkpoint: NotesRoadmapPhaseAdvancementCheckpoint = {
    type: "phase-advancement-checkpoint",
    id: "advancement-direct",
    implementationCheckpointId: "implementation-direct",
    verificationStatusUpdateId: verification.id,
    completedPhaseId: "source",
    nextPhaseId: "candidate",
    timestamp: NOW,
  };
  events.push(checkpoint);
  return {
    checkpoint,
    phases: [
      completedSource([], { session: directSession, roadmapEvents: events }),
      phase("candidate", 20),
    ],
  };
}

function select(
  phases: NotesPhase[],
  reviewId = "review-complete",
  mode: RoadmapPhaseAdvancementMode = "manual",
): RoadmapPhaseEligibility {
  return selectNextEligibleRoadmapPhase(snapshot(phases), {
    type: "phase-advancement-checkpoint",
    id: "advancement-select",
    completionReviewId: reviewId,
    completedPhaseId: "source",
    nextPhaseId: "candidate",
    reviewer: mode === "autopilot" ? "ken-autopilot" : "ken",
    timestamp: NOW,
  });
}

describe("selectNextEligibleRoadmapPhase", () => {
  it.each([
    ["manual", "ken"],
    ["autopilot", "ken-autopilot"],
  ] as const)("classifies one eligible phase for %s completion", (mode, reviewer) => {
    const candidate = phase("candidate", 20, mode === "manual" ? "not-started" : "planning");

    expect(
      select(
        [completedSource([completionReview({ reviewer })]), candidate],
        "review-complete",
        mode,
      ),
    ).toEqual({ kind: "unique", phase: candidate });
  });

  it("requires an authoritative latest accepted Done review", () => {
    const candidate = phase("candidate", 20);
    const superseded = completedSource([
      completionReview(),
      completionReview({
        id: "review-later",
        decision: "rejected",
        gateOutcome: "review",
        timestamp: LATER,
      }),
    ]);

    expect(select([superseded, candidate])).toEqual({ kind: "none" });
    expect(select([completedSource([]), candidate])).toEqual({ kind: "none" });
    expect(
      select([completedSource([completionReview({ reviewer: "ken-autopilot" })]), candidate]),
    ).toEqual({ kind: "none" });
  });

  it.each(["malformed-evidence", "later-untyped-status"] as const)(
    "does not present %s direct completion as advancement authority",
    (kind) => {
      const fixture = directCompletionFixture(kind);

      expect(selectNextEligibleRoadmapPhase(snapshot(fixture.phases), fixture.checkpoint)).toEqual({
        kind: "none",
      });
    },
  );

  it("classifies every eligible branch regardless of order", () => {
    const earlier = phase("earlier", 5, "not-started");
    const later = phase("later", 30, "planning");

    expect(select([later, completedSource(), earlier])).toEqual({
      kind: "ambiguous",
      phases: [earlier, later],
    });
  });

  it("does not break equal-order ambiguity by document position", () => {
    const left = phase("left", 20, "not-started");
    const right = phase("right", 20, "planning");

    expect(select([completedSource(), left, right])).toEqual({
      kind: "ambiguous",
      phases: [left, right],
    });
  });

  it("excludes blocked, waiting, archived, overridden, terminal, and bound phases", () => {
    const excluded = [
      phase("blocked", 20, "needs-attention"),
      phase("waiting", 30, "waiting-for-approval"),
      phase("archived", 40, "not-started", { archivedAt: LATER }),
      phase("done", 50, "done"),
      phase("cancelled", 60, "cancelled"),
      phase("bound", 70, "planning", {
        session: { sessionId: "other", sessionPath: "/sessions/other.jsonl" },
      }),
      phase("overridden", 80, "not-started", {
        overrides: {
          status: { value: "not-started", source: "user", updatedAt: LATER },
          referenceIds: null,
        },
      }),
    ];
    const eligible = phase("eligible", 90, "not-started");

    expect(select([completedSource(), ...excluded, eligible])).toEqual({
      kind: "unique",
      phase: eligible,
    });
  });

  it("returns none when no phase is automatically eligible", () => {
    expect(select([completedSource()])).toEqual({ kind: "none" });
  });
});

describe("AppSidecarRoadmapPhaseAdvancementCoordinator", () => {
  const sessionLink = {
    sessionId: "completed-session",
    sessionPath: "/sessions/completed.jsonl",
  };

  function advancementSnapshot(
    confirmed: boolean,
    reviewer: "ken" | "ken-autopilot" = "ken-autopilot",
  ) {
    const review = completionReview({ reviewer });
    const checkpoint = {
      type: "phase-advancement-checkpoint",
      id: "checkpoint-auto",
      completionReviewId: review.id,
      completedPhaseId: "source",
      nextPhaseId: "next",
      reviewer,
      timestamp: LATER,
    } as const;
    const source = completedSource([review], {
      roadmapEvents: [
        review,
        checkpoint,
        ...(confirmed
          ? [
              {
                type: "phase-advancement-confirmation" as const,
                id: "confirmation-auto",
                checkpointId: checkpoint.id,
                nextPhaseId: "next",
                actor: "system" as const,
                operationId: `automatic-phase-advancement:${checkpoint.id}`,
                timestamp: LATER,
              },
            ]
          : []),
      ],
    });
    const target = phase("next", 20, "not-started", {
      session: confirmed ? sessionLink : null,
    });
    return { checkpoint, snapshot: snapshot([source, target]), target };
  }

  function interleavedSnapshot(confirmed: boolean) {
    const current = advancementSnapshot(confirmed);
    const otherSession = {
      sessionId: "other-session",
      sessionPath: "/sessions/other.jsonl",
    };
    const otherReview = completionReview({
      id: "review-other",
      reviewer: "ken-autopilot",
      timestamp: "2026-08-12T12:02:00.000Z",
    });
    const otherCheckpoint = {
      type: "phase-advancement-checkpoint",
      id: "checkpoint-other",
      completionReviewId: otherReview.id,
      completedPhaseId: "source-other",
      nextPhaseId: "next-other",
      reviewer: "ken-autopilot",
      timestamp: "2026-08-12T12:03:00.000Z",
    } as const;
    const otherSource = completedSource([otherReview], {
      id: "source-other",
      order: 30,
      session: otherSession,
      roadmapEvents: [
        otherReview,
        otherCheckpoint,
        {
          type: "phase-advancement-confirmation",
          id: "confirmation-other",
          checkpointId: otherCheckpoint.id,
          nextPhaseId: otherCheckpoint.nextPhaseId,
          actor: "system",
          operationId: `automatic-phase-advancement:${otherCheckpoint.id}`,
          timestamp: "2026-08-12T12:04:00.000Z",
        },
      ],
    });
    const otherTarget = phase("next-other", 40, "planning", { session: otherSession });
    return {
      ...current,
      snapshot: snapshot([
        current.snapshot.document.phases[0]!,
        current.target,
        otherSource,
        otherTarget,
      ]),
    };
  }
  it.each([false, true])("restores planning context when Notes commit is %s", async (confirmed) => {
    const fixture = advancementSnapshot(confirmed);
    const status = confirmed ? "already-bound" : "accepted";
    const outcome: ProjectNotesAutomaticPhaseAdvancementOutcome = {
      status,
      operationId: `automatic-phase-advancement:${fixture.checkpoint.id}`,
      snapshot: fixture.snapshot,
      phase: fixture.target,
      references: [],
      session: sessionLink,
    };
    const calls: Array<Parameters<ProjectNotesRepository["confirmAutomaticPhaseAdvancement"]>> = [];
    const repository: Pick<ProjectNotesRepository, "load" | "confirmAutomaticPhaseAdvancement"> = {
      async load(_cwd) {
        return { status: "ok", snapshot: fixture.snapshot, recoveredFromBackup: false };
      },
      async confirmAutomaticPhaseAdvancement(...args) {
        calls.push(args);
        return outcome;
      },
    };
    let context: ActivePhaseContextV1 | undefined;
    const session: RoadmapPhaseAdvancementSession = {
      getState: () => ({ cwd: "/project", ...sessionLink }),
      async setActivePhaseContext(next) {
        context = next;
      },
    };
    const coordinator = createAppSidecarRoadmapPhaseAdvancementCoordinator({
      repository,
      now: () => LATER,
    });

    await expect(coordinator.recover(session)).resolves.toMatchObject({ status });
    expect(calls).toEqual([
      [
        "/project",
        expect.objectContaining({
          checkpointId: fixture.checkpoint.id,
          destinationSession: sessionLink,
        }),
      ],
    ]);
    expect(context).toMatchObject({
      phase: { id: "next" },
      session: sessionLink,
      executionStage: "planning",
    });
  });

  it("preserves manual Ken's explicit Start gate after review and restart", async () => {
    const fixture = advancementSnapshot(false, "ken");
    let confirmationCalls = 0;
    let contextWrites = 0;
    const repository: Pick<ProjectNotesRepository, "load" | "confirmAutomaticPhaseAdvancement"> = {
      async load() {
        return { status: "ok", snapshot: fixture.snapshot, recoveredFromBackup: false };
      },
      async confirmAutomaticPhaseAdvancement() {
        confirmationCalls += 1;
        throw new Error("Manual advancement must use the explicit Start gate");
      },
    };
    const session: RoadmapPhaseAdvancementSession = {
      getState: () => ({ cwd: "/project", ...sessionLink }),
      async setActivePhaseContext() {
        contextWrites += 1;
      },
    };

    await expect(
      createAppSidecarRoadmapPhaseAdvancementCoordinator({ repository }).recover(session),
    ).resolves.toEqual({ status: "none" });
    await expect(
      createAppSidecarRoadmapPhaseAdvancementCoordinator({ repository }).recover(session),
    ).resolves.toEqual({ status: "none" });
    expect(confirmationCalls).toBe(0);
    expect(contextWrites).toBe(0);
  });

  it("recovers its pending checkpoint when another session has the globally newest record", async () => {
    const fixture = interleavedSnapshot(false);
    expect(selectLatestRoadmapPhaseAdvancement(fixture.snapshot)).toMatchObject({
      checkpoint: { id: "checkpoint-other" },
    });
    const calls: string[] = [];
    const repository: Pick<ProjectNotesRepository, "load" | "confirmAutomaticPhaseAdvancement"> = {
      async load() {
        return { status: "ok", snapshot: fixture.snapshot, recoveredFromBackup: false };
      },
      async confirmAutomaticPhaseAdvancement(_cwd, request) {
        calls.push(request.checkpointId);
        return {
          status: "accepted",
          operationId: `automatic-phase-advancement:${fixture.checkpoint.id}`,
          snapshot: fixture.snapshot,
          phase: fixture.target,
          references: [],
          session: sessionLink,
        };
      },
    };
    const coordinator = createAppSidecarRoadmapPhaseAdvancementCoordinator({ repository });
    const session: RoadmapPhaseAdvancementSession = {
      getState: () => ({ cwd: "/project", ...sessionLink }),
      async setActivePhaseContext() {},
    };

    await expect(coordinator.recover(session)).resolves.toMatchObject({ status: "accepted" });
    expect(calls).toEqual([fixture.checkpoint.id]);
  });

  it("retries its system-confirmed checkpoint after restart despite a newer other-session record", async () => {
    const fixture = interleavedSnapshot(true);
    const calls: string[] = [];
    const repository: Pick<ProjectNotesRepository, "load" | "confirmAutomaticPhaseAdvancement"> = {
      async load() {
        return { status: "ok", snapshot: fixture.snapshot, recoveredFromBackup: false };
      },
      async confirmAutomaticPhaseAdvancement(_cwd, request) {
        calls.push(request.checkpointId);
        return {
          status: "already-bound",
          operationId: `automatic-phase-advancement:${fixture.checkpoint.id}`,
          snapshot: fixture.snapshot,
          phase: fixture.target,
          references: [],
          session: sessionLink,
        };
      },
    };
    const session: RoadmapPhaseAdvancementSession = {
      getState: () => ({ cwd: "/project", ...sessionLink }),
      async setActivePhaseContext() {},
    };

    await expect(
      createAppSidecarRoadmapPhaseAdvancementCoordinator({ repository }).recover(session),
    ).resolves.toMatchObject({ status: "already-bound" });
    await expect(
      createAppSidecarRoadmapPhaseAdvancementCoordinator({ repository }).recover(session),
    ).resolves.toMatchObject({ status: "already-bound" });
    expect(calls).toEqual([fixture.checkpoint.id, fixture.checkpoint.id]);
  });

  it("fails closed when the matching checkpoint has ambiguous phase candidates", async () => {
    const fixture = advancementSnapshot(false);
    fixture.snapshot.document.phases.push(phase("competing", 30));
    let confirmationCalls = 0;
    const repository: Pick<ProjectNotesRepository, "load" | "confirmAutomaticPhaseAdvancement"> = {
      async load() {
        return { status: "ok", snapshot: fixture.snapshot, recoveredFromBackup: false };
      },
      async confirmAutomaticPhaseAdvancement() {
        confirmationCalls += 1;
        throw new Error("Ambiguous recovery must not reach repository confirmation");
      },
    };
    const session: RoadmapPhaseAdvancementSession = {
      getState: () => ({ cwd: "/project", ...sessionLink }),
      async setActivePhaseContext() {},
    };

    await expect(
      createAppSidecarRoadmapPhaseAdvancementCoordinator({ repository }).recover(session),
    ).resolves.toEqual({ status: "none" });
    expect(confirmationCalls).toBe(0);
  });
});

describe("selectLatestRoadmapPhaseAdvancement", () => {
  function checkpointSource(
    reviewer: "ken" | "ken-autopilot" = "ken",
    overrides: Partial<NotesPhase> = {},
  ): NotesPhase {
    const review = completionReview({ reviewer });
    return completedSource([review], {
      roadmapEvents: [
        review,
        {
          type: "phase-advancement-checkpoint",
          id: `checkpoint-${reviewer}`,
          completionReviewId: review.id,
          completedPhaseId: overrides.id ?? "source",
          nextPhaseId: "next",
          reviewer,
          timestamp: LATER,
        },
      ],
      ...overrides,
    });
  }

  it.each([
    ["ken", "manual"],
    ["ken-autopilot", "autopilot"],
  ] as const)("selects a pending persisted %s checkpoint without launching", (reviewer, _mode) => {
    const source = checkpointSource(reviewer);
    const next = phase("next", 20);
    const launchCount = 0;
    const restarted = structuredClone(snapshot([source, next]));

    expect(selectLatestRoadmapPhaseAdvancement(restarted)).toMatchObject({
      state: "pending",
      checkpoint: { completedPhaseId: "source", nextPhaseId: "next", reviewer },
      completedPhase: { id: "source" },
      nextPhase: { id: "next" },
    });
    expect(launchCount).toBe(0);
  });

  it("reports a consumed checkpoint after human confirmation", () => {
    const source = checkpointSource();
    source.roadmapEvents.push({
      type: "phase-advancement-confirmation",
      id: "confirmation-1",
      checkpointId: "checkpoint-ken",
      nextPhaseId: "next",
      actor: "user",
      operationId: "operation-1",
      timestamp: "2026-08-12T12:02:00.000Z",
    });
    const next = phase("next", 20, "planning", {
      session: { sessionId: "next-session", sessionPath: "/sessions/next.jsonl" },
    });

    expect(selectLatestRoadmapPhaseAdvancement(snapshot([source, next]))).toMatchObject({
      state: "confirmed",
      confirmation: { actor: "user", operationId: "operation-1" },
      nextPhase: { id: "next" },
    });
  });

  it.each([
    [
      "superseded review",
      (source: NotesPhase) =>
        source.roadmapEvents.push(
          completionReview({
            id: "later-review",
            decision: "rejected",
            gateOutcome: "review",
            timestamp: "2026-08-12T12:03:00.000Z",
          }),
        ),
    ],
    [
      "status override",
      (source: NotesPhase) => {
        source.overrides.status = { value: "done", source: "user", updatedAt: LATER };
      },
    ],
    [
      "bound target",
      (_source: NotesPhase, next: NotesPhase) => {
        next.session = { sessionId: "bound", sessionPath: "/bound.jsonl" };
      },
    ],
  ] as const)("reports a stale checkpoint after %s", (_name, mutate) => {
    const source = checkpointSource();
    const next = phase("next", 20);
    mutate(source, next);

    expect(selectLatestRoadmapPhaseAdvancement(snapshot([source, next]))).toMatchObject({
      state: "stale",
      checkpoint: { id: "checkpoint-ken" },
    });
  });

  it("selects the newest checkpoint by timestamp and Roadmap order", () => {
    const older = checkpointSource("ken", { id: "older", order: 10 });
    const olderCheckpoint = older.roadmapEvents.find(
      (event) => event.type === "phase-advancement-checkpoint",
    )!;
    olderCheckpoint.id = "checkpoint-older";
    olderCheckpoint.completedPhaseId = "older";
    olderCheckpoint.timestamp = NOW;
    const newer = checkpointSource("ken-autopilot", { id: "newer", order: 15 });
    const newerCheckpoint = newer.roadmapEvents.find(
      (event) => event.type === "phase-advancement-checkpoint",
    )!;
    newerCheckpoint.id = "checkpoint-newer";
    newerCheckpoint.completedPhaseId = "newer";
    newerCheckpoint.timestamp = LATER;

    expect(
      selectLatestRoadmapPhaseAdvancement(snapshot([older, newer, phase("next", 20)])),
    ).toMatchObject({ checkpoint: { id: "checkpoint-newer" } });
  });
});
