import type { NotesPhase, NotesRoadmapEvent } from "@kenkaiiii/gg-core";
import { describe, expect, it, vi } from "vitest";
import type { AppSidecarFinalReviewExecutionResult } from "./app-sidecar-autopilot-phase-review.js";
import type { AppSidecarFinalReviewAttempt } from "./app-sidecar-roadmap-tool-host.js";
import {
  AppSidecarRoadmapReviewRunCoordinator,
  AppSidecarRoadmapReviewScheduler,
  appSidecarRoadmapReviewSchedulingFailure,
  appSidecarRoadmapReviewTrigger,
  createAppSidecarRoadmapReviewTrigger,
  shouldRetryAppSidecarRoadmapReview,
} from "./app-sidecar-roadmap-review-scheduler.js";

const session = { sessionId: "session-1", sessionPath: "/sessions/1.jsonl" };
const projectKey = "/work/project";

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

const opaqueAttempt = {} as AppSidecarFinalReviewAttempt;
const committed: AppSidecarFinalReviewExecutionResult = {
  status: "committed",
  attempt: opaqueAttempt,
  verdict: { kind: "all_clear" },
};

describe("appSidecarRoadmapReviewTrigger", () => {
  it.each(["passed", "exception-requested"] as const)(
    "derives project-scoped deterministic IDs for %s verification",
    (result) => {
      const candidate = phase([verification(result)]);
      expect(appSidecarRoadmapReviewTrigger(candidate, projectKey)).toEqual(
        createAppSidecarRoadmapReviewTrigger(candidate.id, `verification-${result}`, projectKey),
      );
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "settles the verification trigger after a %s persisted review",
    (decision) => {
      expect(
        appSidecarRoadmapReviewTrigger(phase([verification(), review(decision)]), projectKey),
      ).toBeNull();
    },
  );

  it("rejects failed, non-review, and completed phases", () => {
    expect(appSidecarRoadmapReviewTrigger(phase([verification("failed")]), projectKey)).toBeNull();
    expect(appSidecarRoadmapReviewTrigger({ ...phase(), status: "in-progress" }, projectKey)).toBeNull();
    expect(appSidecarRoadmapReviewTrigger({ ...phase(), status: "done" }, projectKey)).toBeNull();
  });

  it("keeps deterministic, distinct event IDs across unrelated Notes revisions", () => {
    const before = appSidecarRoadmapReviewTrigger(phase(), projectKey)!;
    const after = appSidecarRoadmapReviewTrigger(
      { ...phase(), updatedAt: "2026-08-23T12:05:00.000Z" },
      projectKey,
    );
    expect(after).toEqual(before);
    expect(before.statusUpdateId).toMatch(/^autopilot-final-status-/);
    expect(before.reviewId).toMatch(/^autopilot-final-/);
    expect(before.statusUpdateId).not.toBe(before.reviewId);
  });

  it("separates identical phase triggers from different projects", () => {
    expect(createAppSidecarRoadmapReviewTrigger("phase-1", "verification-1", "/project-a")).not.toEqual(
      createAppSidecarRoadmapReviewTrigger("phase-1", "verification-1", "/project-b"),
    );
  });
});

describe("AppSidecarRoadmapReviewRunCoordinator", () => {
  it("performs exactly one corrective prompt for a missing attempt", async () => {
    const coordinator = new AppSidecarRoadmapReviewRunCoordinator<"committed">();
    const trigger = appSidecarRoadmapReviewTrigger(phase(), projectKey)!;
    const reviewRun = vi.fn(async (attempt: 0 | 1) => {
      if (attempt === 1) coordinator.record("committed");
    });

    await expect(
      coordinator.run(trigger, reviewRun, (attempts) =>
        shouldRetryAppSidecarRoadmapReview(attempts.length === 0 ? "missing" : "committed"),
      ),
    ).resolves.toEqual(["committed"]);
    expect(reviewRun).toHaveBeenCalledTimes(2);
    expect(coordinator.activeClaim()).toBeNull();
  });
});

describe("AppSidecarRoadmapReviewScheduler", () => {
  it("retries a reviewer failure with the same trigger and event IDs", async () => {
    let now = 1_000;
    const scheduler = new AppSidecarRoadmapReviewScheduler({ now: () => now, retryDelaysMs: [50] });
    const trigger = appSidecarRoadmapReviewTrigger(phase(), projectKey)!;
    const seenTriggers: typeof trigger[] = [];
    const execute = vi.fn(async (candidate: typeof trigger): Promise<AppSidecarFinalReviewExecutionResult> => {
      seenTriggers.push(candidate);
      return seenTriggers.length === 1
        ? { status: "retryable-reviewer-error", message: "provider unavailable" }
        : committed;
    });
    scheduler.enqueue(trigger);

    const first = await scheduler.drain(execute);
    expect(first.map((outcome) => outcome.status)).toEqual(["started", "retry-scheduled"]);
    expect(await scheduler.drain(execute)).toEqual([]);
    now += 50;
    const second = await scheduler.drain(execute);
    expect(second.map((outcome) => outcome.status)).toEqual(["started", "completed"]);
    expect(seenTriggers).toEqual([trigger, trigger]);
    expect(seenTriggers.map(({ statusUpdateId, reviewId }) => ({ statusUpdateId, reviewId }))).toEqual([
      { statusUpdateId: trigger.statusUpdateId, reviewId: trigger.reviewId },
      { statusUpdateId: trigger.statusUpdateId, reviewId: trigger.reviewId },
    ]);
  });

  it("deduplicates callbacks while queued and in flight", async () => {
    const scheduler = new AppSidecarRoadmapReviewScheduler();
    const trigger = appSidecarRoadmapReviewTrigger(phase(), projectKey)!;
    scheduler.enqueue(trigger);
    expect(scheduler.enqueue(trigger).status).toBe("duplicate");
    let release!: (result: AppSidecarFinalReviewExecutionResult) => void;
    const running = scheduler.drain(() =>
      new Promise<AppSidecarFinalReviewExecutionResult>((resolve) => (release = resolve)),
    );
    expect(scheduler.enqueue(trigger).status).toBe("duplicate");
    release(committed);
    await running;
  });

  it("allows one retry for no-attempt and bounds failures per daemon lifetime", async () => {
    let now = 0;
    const scheduler = new AppSidecarRoadmapReviewScheduler({
      now: () => now,
      retryDelaysMs: [1],
      maxAttempts: 3,
    });
    const trigger = appSidecarRoadmapReviewTrigger(phase(), projectKey)!;
    scheduler.enqueue(trigger);
    const noAttempt = async (): Promise<AppSidecarFinalReviewExecutionResult> => ({
      status: "no-attempt",
      message: "tool call missing",
    });

    expect((await scheduler.drain(noAttempt)).at(-1)?.status).toBe("retry-scheduled");
    now += 1;
    expect((await scheduler.drain(noAttempt)).at(-1)?.status).toBe("completed");
  });

  it("rediscovers the same trigger and event IDs after scheduler restart", async () => {
    const candidate = phase();
    const first = new AppSidecarRoadmapReviewScheduler();
    const originalTrigger = first.replay([candidate], projectKey)[0]!.trigger;
    await first.drain(async () => ({
      status: "retryable-reviewer-error",
      message: "daemon stopping",
    }));

    const restarted = new AppSidecarRoadmapReviewScheduler();
    const rediscovered = restarted.replay([candidate], projectKey)[0]!;
    expect(rediscovered.status).toBe("queued");
    expect(rediscovered.trigger).toEqual(originalTrigger);
    expect(rediscovered.trigger.statusUpdateId).toBe(originalTrigger.statusUpdateId);
    expect(rediscovered.trigger.reviewId).toBe(originalTrigger.reviewId);
    const execute = vi.fn(async () => committed);
    await restarted.drain(execute);
    expect(execute).toHaveBeenCalledWith(rediscovered.trigger, 1);
  });
  it("reports safe recoverable failure details without requiring fresh verification", () => {
    const trigger = appSidecarRoadmapReviewTrigger(phase(), projectKey)!;
    expect(appSidecarRoadmapReviewSchedulingFailure(trigger, 25)).toEqual({
      code: "roadmap-final-review-scheduling-failed",
      headline: "Roadmap final review will retry",
      message: `roadmap-final-review-scheduling-failed: phase phase-1, trigger ${trigger.triggerId}, observed revision 25.`,
      guidance: "The persisted Review trigger remains eligible and will be rediscovered after recovery.",
    });
  });
});
