import type { NotesPhase, NotesRoadmapEvent } from "@kenkaiiii/gg-core";
import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarRoadmapReviewRunCoordinator,
  AppSidecarRoadmapReviewScheduler,
  appSidecarRoadmapReviewSchedulingFailure,
  appSidecarRoadmapReviewTrigger,
  createAppSidecarRoadmapReviewTrigger,
} from "./app-sidecar-roadmap-review-scheduler.js";

const session = { sessionId: "session-1", sessionPath: "/sessions/1.jsonl" };

function verification(
  result: "passed" | "failed" | "exception-requested" = "passed",
): Extract<NotesRoadmapEvent, { type: "status-update" }> {
  return {
    type: "status-update",
    id: `verification-${result}`,
    actor: "gg-coder",
    transition: "review",
    progress: "Verification completed",
    blocker: null,
    requiredExternalAction: null,
    evidence: ["pnpm test"],
    verification: result,
    verificationReason: null,
    verificationSession: session,
    statusOutcome: "applied",
    proposedReferences: [],
    timestamp: "2026-08-23T12:00:00.000Z",
  };
}

function review(
  decision: "accepted" | "rejected",
): Extract<NotesRoadmapEvent, { type: "completion-review" }> {
  return {
    type: "completion-review",
    id: `review-${decision}`,
    reviewer: "ken-autopilot",
    decision,
    evidence: [],
    reason: decision === "rejected" ? "Revise the implementation" : null,
    implementationCheckpointId: "checkpoint-1",
    verificationStatusUpdateId: "verification-passed",
    acceptsVerificationException: false,
    gateOutcome: decision === "accepted" ? "done" : "review",
    unmetGateCodes: [],
    timestamp: "2026-08-23T12:01:00.000Z",
  };
}

function phase(events: NotesRoadmapEvent[] = [verification()]): NotesPhase {
  return {
    id: "phase-1",
    title: "Review scheduling",
    goal: "Schedule one durable final review",
    doneWhen: ["Review is persisted"],
    order: 0,
    status: "review",
    sourcePrompt: "Implement review scheduling",
    referenceIds: [],
    session,
    reminder: null,
    attentionReason: null,
    createdAt: "2026-08-23T11:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: events,
  };
}

describe("appSidecarRoadmapReviewTrigger", () => {
  it.each(["passed", "exception-requested"] as const)(
    "derives a deterministic trigger for %s verification",
    (result) => {
      const candidate = phase([verification(result)]);

      expect(appSidecarRoadmapReviewTrigger(candidate)).toEqual(
        createAppSidecarRoadmapReviewTrigger(candidate.id, `verification-${result}`),
      );
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "settles the verification trigger after a %s completion review",
    (decision) => {
      expect(appSidecarRoadmapReviewTrigger(phase([verification(), review(decision)]))).toBeNull();
    },
  );

  it("rejects failed, non-review, and already-completed phases", () => {
    expect(appSidecarRoadmapReviewTrigger(phase([verification("failed")]))).toBeNull();
    expect(appSidecarRoadmapReviewTrigger({ ...phase(), status: "in-progress" })).toBeNull();
    expect(appSidecarRoadmapReviewTrigger({ ...phase(), status: "done" })).toBeNull();
  });
});

describe("AppSidecarRoadmapReviewRunCoordinator", () => {
  it("performs exactly one stale-revision retry", async () => {
    const coordinator = new AppSidecarRoadmapReviewRunCoordinator<string>();
    const trigger = appSidecarRoadmapReviewTrigger(phase())!;
    const reviewRun = vi.fn(async (attempt: 0 | 1) => {
      coordinator.record(attempt === 0 ? "stale-revision" : "stale-revision-again");
    });

    await expect(
      coordinator.run(trigger, reviewRun, (attempts) => attempts.at(-1) === "stale-revision"),
    ).resolves.toEqual(["stale-revision", "stale-revision-again"]);
    expect(reviewRun).toHaveBeenCalledTimes(2);
    expect(coordinator.activeClaim()).toBeNull();
  });

  it("clears the active claim and attempt sink after review failure", async () => {
    const coordinator = new AppSidecarRoadmapReviewRunCoordinator<string>();
    const trigger = appSidecarRoadmapReviewTrigger(phase())!;

    await expect(
      coordinator.run(
        trigger,
        async () => {
          expect(coordinator.activeClaim()).toEqual(trigger);
          coordinator.record("failed-run");
          throw new Error("reviewer unavailable");
        },
        () => false,
      ),
    ).rejects.toThrow("reviewer unavailable");
    expect(coordinator.activeClaim()).toBeNull();
    coordinator.record("leaked-attempt");

    await expect(
      coordinator.run(
        trigger,
        async () => coordinator.record("recovered-run"),
        () => false,
      ),
    ).resolves.toEqual(["recovered-run"]);
  });
});

describe("AppSidecarRoadmapReviewScheduler", () => {
  it("deduplicates repeated event delivery while queued and in flight", async () => {
    const scheduler = new AppSidecarRoadmapReviewScheduler();
    const trigger = appSidecarRoadmapReviewTrigger(phase())!;
    expect(scheduler.enqueue(trigger).status).toBe("queued");
    expect(scheduler.enqueue(trigger).status).toBe("duplicate");
    let release!: () => void;
    const executing = scheduler.drain(() => new Promise<void>((resolve) => (release = resolve)));
    expect(scheduler.enqueue(trigger).status).toBe("duplicate");
    release();
    await expect(executing).resolves.toEqual([
      { status: "started", trigger },
      { status: "completed", trigger },
    ]);
  });

  it("reports typed, actionable scheduling failure details", () => {
    const trigger = appSidecarRoadmapReviewTrigger(phase())!;

    expect(appSidecarRoadmapReviewSchedulingFailure(trigger, 25)).toEqual({
      code: "roadmap-final-review-scheduling-failed",
      headline: "Roadmap final review needs attention",
      message: `roadmap-final-review-scheduling-failed: phase phase-1, trigger ${trigger.triggerId}, observed revision 25.`,
      guidance:
        "After Autopilot recovers, submit a fresh roadmap_status Review transition to replay this verification trigger.",
    });
  });

  it("reports execution failure and permits durable replay", async () => {
    const scheduler = new AppSidecarRoadmapReviewScheduler();
    const candidate = phase();
    const error = new Error("reviewer unavailable");
    scheduler.replay([candidate]);

    await expect(scheduler.drain(async () => Promise.reject(error))).resolves.toEqual([
      { status: "started", trigger: appSidecarRoadmapReviewTrigger(candidate) },
      { status: "failed", trigger: appSidecarRoadmapReviewTrigger(candidate), error },
    ]);
    expect(scheduler.replay([candidate])[0]?.status).toBe("queued");
  });

  it("replays unresolved durable Review state after coordinator restart", async () => {
    const candidate = phase();
    const execute = vi.fn(async () => undefined);
    const scheduler = new AppSidecarRoadmapReviewScheduler();

    expect(scheduler.replay([candidate])[0]?.status).toBe("queued");
    await scheduler.drain(execute);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(appSidecarRoadmapReviewTrigger(candidate));
  });

  it("uses different authoritative IDs for conflicting verification triggers", () => {
    const first = createAppSidecarRoadmapReviewTrigger("phase-1", "verification-1");
    const conflicting = createAppSidecarRoadmapReviewTrigger("phase-1", "verification-2");

    expect(first.reviewId).not.toBe(conflicting.reviewId);
    expect(first.triggerId).not.toBe(conflicting.triggerId);
  });
});
