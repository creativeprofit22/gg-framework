import { describe, expect, it } from "vitest";
import {
  findPendingAutopilotRoadmapAdvancement,
  resolvePendingAutopilotRoadmapAdvancement,
  selectNextEligibleRoadmapPhase,
  type RoadmapPhaseAdvancementMode,
} from "./app-sidecar-phase-advancement.js";
import type {
  NotesPhase,
  NotesRoadmapCompletionReview,
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

function select(
  phases: NotesPhase[],
  reviewId = "review-complete",
  mode: RoadmapPhaseAdvancementMode = "manual",
): NotesPhase | null {
  return selectNextEligibleRoadmapPhase(snapshot(phases), "source", reviewId, mode);
}

describe("selectNextEligibleRoadmapPhase", () => {
  it.each([
    ["manual", "ken"],
    ["autopilot", "ken-autopilot"],
  ] as const)("selects the next phase for %s completion", (mode, reviewer) => {
    const source = completedSource([completionReview({ reviewer })]);
    const candidate = phase("candidate", 20, mode === "manual" ? "not-started" : "planning");

    expect(select([source, candidate], "review-complete", mode)).toBe(candidate);
  });

  it.each([
    ["manual", "ken-autopilot"],
    ["autopilot", "ken"],
  ] as const)("requires the completion reviewer for %s mode", (mode, reviewer) => {
    const source = completedSource([completionReview({ reviewer })]);

    expect(select([source, phase("candidate", 20)], "review-complete", mode)).toBeNull();
  });

  it("is idempotent for a duplicate review replay and rejects a superseded review", () => {
    const candidate = phase("candidate", 20);
    const durableDuplicate = completedSource();

    expect(select([durableDuplicate, candidate])).toBe(candidate);
    expect(select([durableDuplicate, candidate])).toBe(candidate);

    const superseded = completedSource([
      completionReview(),
      completionReview({
        id: "review-later",
        decision: "rejected",
        gateOutcome: "review",
        timestamp: LATER,
      }),
    ]);
    expect(select([superseded, candidate])).toBeNull();
  });

  it("rejects stale and missing review IDs", () => {
    const candidate = phase("candidate", 20);
    const source = completedSource([
      completionReview({ id: "review-stale" }),
      completionReview({ id: "review-current", timestamp: LATER }),
    ]);

    expect(select([source, candidate], "review-stale")).toBeNull();
    expect(select([source, candidate], "review-missing")).toBeNull();
    expect(select([completedSource([]), candidate])).toBeNull();
  });

  it.each([
    ["rejected", { decision: "rejected" as const }],
    ["blocked", { gateOutcome: "needs-attention" as const }],
    ["partial gate", { gateOutcome: "review" as const }],
    ["approval gate", { gateOutcome: "waiting-for-approval" as const }],
  ])("rejects a %s completion review", (_name, reviewOverrides) => {
    const source = completedSource([completionReview(reviewOverrides)]);

    expect(select([source, phase("candidate", 20)])).toBeNull();
  });

  it("requires a non-archived source that is Done", () => {
    const candidate = phase("candidate", 20);
    const archived = completedSource(undefined, { archivedAt: LATER });
    const stillInReview = completedSource(undefined, { status: "review", completedAt: null });
    const userOverridden = completedSource(undefined, {
      overrides: {
        status: { value: "done", source: "user", updatedAt: LATER },
        referenceIds: null,
      },
    });

    expect(select([archived, candidate])).toBeNull();
    expect(select([stillInReview, candidate])).toBeNull();
    expect(select([userOverridden, candidate])).toBeNull();
  });

  it("skips archived and already-Done candidates", () => {
    const archived = phase("archived", 20, "not-started", { archivedAt: LATER });
    const done = phase("done", 30, "done");
    const candidate = phase("candidate", 40, "planning");

    expect(select([completedSource(), archived, done, candidate])).toBe(candidate);
  });

  it("skips cancelled and otherwise ineligible candidate statuses", () => {
    const candidates = [
      phase("cancelled", 20, "cancelled"),
      phase("waiting", 30, "waiting-for-approval"),
      phase("active", 40, "in-progress"),
      phase("review", 50, "review"),
      phase("attention", 60, "needs-attention"),
    ];
    const eligible = phase("eligible", 70, "not-started");

    expect(select([completedSource(), ...candidates, eligible])).toBe(eligible);
  });

  it("stops when the next phase is already bound or user-overridden", () => {
    const bound = phase("bound", 20, "planning", {
      session: { sessionId: "bound-session", sessionPath: "/sessions/bound.jsonl" },
    });
    const afterBound = phase("after-bound", 30, "not-started");
    const overridden = phase("overridden", 20, "not-started", {
      overrides: {
        status: { value: "not-started", source: "user", updatedAt: LATER },
        referenceIds: null,
      },
    });
    const afterOverride = phase("after-override", 30, "planning");

    expect(select([completedSource(), bound, afterBound])).toBeNull();
    expect(select([completedSource(), overridden, afterOverride])).toBeNull();
  });

  it("searches strictly after the source in stable Roadmap order", () => {
    const before = phase("before", 10, "not-started");
    const source = completedSource();
    const sameOrderAfter = phase("same-order-after", 10, "planning");
    const later = phase("later", 20, "not-started");

    expect(select([before, source, sameOrderAfter, later])).toBe(sameOrderAfter);
  });

  it("uses phase order rather than document position", () => {
    const later = phase("later", 30, "planning");
    const source = completedSource();
    const earlier = phase("earlier", 5, "not-started");

    expect(select([later, source, earlier])).toBe(later);
  });

  it("returns null at the end of the Roadmap", () => {
    expect(select([completedSource()])).toBeNull();
  });
});

describe("findPendingAutopilotRoadmapAdvancement", () => {
  it("recovers the newest pending advancement from a restarted snapshot", () => {
    const olderSource = completedSource(
      [
        completionReview({
          id: "review-older",
          reviewer: "ken-autopilot",
          timestamp: NOW,
        }),
      ],
      { id: "source-older", order: 10 },
    );
    const newerSource = completedSource(
      [
        completionReview({
          id: "review-newer",
          reviewer: "ken-autopilot",
          timestamp: LATER,
        }),
      ],
      { id: "source-newer", order: 20 },
    );
    const nextPhase = phase("next", 30, "planning");
    const restarted = JSON.parse(
      JSON.stringify(snapshot([olderSource, newerSource, nextPhase])),
    ) as ProjectNotesSnapshot;

    expect(findPendingAutopilotRoadmapAdvancement(restarted)).toEqual({
      completedPhaseId: "source-newer",
      reviewId: "review-newer",
      nextPhase: restarted.document.phases[2],
    });
  });

  it("does not fall back to an older completion after a newer rejected review", () => {
    const validSource = completedSource(
      [
        completionReview({
          id: "review-valid",
          reviewer: "ken-autopilot",
          timestamp: NOW,
        }),
      ],
      { id: "source-valid", order: 10 },
    );
    const supersededSource = completedSource(
      [
        completionReview({
          id: "review-old-accepted",
          reviewer: "ken-autopilot",
          timestamp: NOW,
        }),
        completionReview({
          id: "review-latest-rejected",
          reviewer: "ken-autopilot",
          decision: "rejected",
          gateOutcome: "review",
          timestamp: LATER,
        }),
      ],
      { id: "source-superseded", order: 20 },
    );
    const nextPhase = phase("next", 30);

    expect(
      findPendingAutopilotRoadmapAdvancement(snapshot([validSource, supersededSource, nextPhase])),
    ).toBeNull();
  });

  it("uses the later Roadmap phase to break equal reviewedAt ties", () => {
    const first = completedSource(
      [completionReview({ id: "review-first", reviewer: "ken-autopilot" })],
      { id: "source-first", order: 10 },
    );
    const second = completedSource(
      [completionReview({ id: "review-second", reviewer: "ken-autopilot" })],
      { id: "source-second", order: 10 },
    );
    const nextPhase = phase("next", 20);

    expect(findPendingAutopilotRoadmapAdvancement(snapshot([first, second, nextPhase]))).toEqual({
      completedPhaseId: "source-second",
      reviewId: "review-second",
      nextPhase,
    });
  });

  it("drops cancelled and stale runtime advancement requests", () => {
    const source = completedSource([completionReview({ reviewer: "ken-autopilot" })]);
    const nextPhase = phase("runtime-next", 20);
    const current = snapshot([source, nextPhase]);
    const pending = {
      completedPhaseId: source.id,
      reviewId: "review-complete",
      revision: current.revision,
    };

    expect(
      resolvePendingAutopilotRoadmapAdvancement(current, pending, {
        enabled: true,
        cancelled: false,
      }),
    ).toBe(nextPhase);
    expect(
      resolvePendingAutopilotRoadmapAdvancement(current, pending, {
        enabled: true,
        cancelled: true,
      }),
    ).toBeNull();
    expect(
      resolvePendingAutopilotRoadmapAdvancement(current, pending, {
        enabled: false,
        cancelled: false,
      }),
    ).toBeNull();
    expect(
      resolvePendingAutopilotRoadmapAdvancement(
        current,
        { ...pending, revision: 11 },
        {
          enabled: true,
          cancelled: false,
        },
      ),
    ).toBeNull();
  });

  it("returns null when the completed source is at the end of the Roadmap", () => {
    const finalSource = completedSource([completionReview({ reviewer: "ken-autopilot" })], {
      id: "final-source",
      order: 20,
    });

    expect(
      findPendingAutopilotRoadmapAdvancement(
        snapshot([phase("done-before", 10, "done"), finalSource]),
      ),
    ).toBeNull();
  });
});
