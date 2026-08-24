import { createHash } from "node:crypto";
import type {
  NotesPhase,
  NotesRoadmapCompletionReview,
  NotesRoadmapStatusUpdate,
} from "@kenkaiiii/gg-core";

export interface AppSidecarRoadmapReviewTrigger {
  phaseId: string;
  verificationStatusUpdateId: string;
  triggerId: string;
  reviewId: string;
}

export type AppSidecarRoadmapReviewQueueOutcome =
  | { status: "queued"; trigger: AppSidecarRoadmapReviewTrigger }
  | { status: "duplicate"; trigger: AppSidecarRoadmapReviewTrigger };

export type AppSidecarRoadmapReviewExecutionOutcome =
  | { status: "started"; trigger: AppSidecarRoadmapReviewTrigger }
  | { status: "completed"; trigger: AppSidecarRoadmapReviewTrigger }
  | { status: "failed"; trigger: AppSidecarRoadmapReviewTrigger; error: unknown };

export function appSidecarRoadmapReviewSchedulingFailure(
  trigger: AppSidecarRoadmapReviewTrigger,
  observedRevision: number | null,
): {
  code: "roadmap-final-review-scheduling-failed";
  headline: string;
  message: string;
  guidance: string;
} {
  const code = "roadmap-final-review-scheduling-failed" as const;
  return {
    code,
    headline: "Roadmap final review needs attention",
    message: `${code}: phase ${trigger.phaseId}, trigger ${trigger.triggerId}, observed revision ${observedRevision ?? "unavailable"}.`,
    guidance:
      "After Autopilot recovers, submit a fresh roadmap_status Review transition to replay this verification trigger.",
  };
}

export function appSidecarRoadmapReviewTrigger(
  phase: NotesPhase,
): AppSidecarRoadmapReviewTrigger | null {
  if (phase.status !== "review" || !Array.isArray(phase.roadmapEvents)) return null;
  const verification = [...phase.roadmapEvents]
    .reverse()
    .find(
      (event): event is NotesRoadmapStatusUpdate =>
        event.type === "status-update" && event.actor === "gg-coder" && event.verification !== null,
    );
  if (
    !verification ||
    verification.transition !== "review" ||
    (verification.verification !== "passed" && verification.verification !== "exception-requested")
  ) {
    return null;
  }
  const settled = phase.roadmapEvents.some(
    (event): event is NotesRoadmapCompletionReview =>
      event.type === "completion-review" && event.verificationStatusUpdateId === verification.id,
  );
  if (settled) return null;
  return createAppSidecarRoadmapReviewTrigger(phase.id, verification.id);
}

export function createAppSidecarRoadmapReviewTrigger(
  phaseId: string,
  verificationStatusUpdateId: string,
): AppSidecarRoadmapReviewTrigger {
  const digest = createHash("sha256")
    .update(JSON.stringify([phaseId, verificationStatusUpdateId]))
    .digest("hex");
  return {
    phaseId,
    verificationStatusUpdateId,
    triggerId: `roadmap-final-review-${digest}`,
    reviewId: `autopilot-final-${digest}`,
  };
}

export class AppSidecarRoadmapReviewScheduler {
  private readonly queued = new Map<string, AppSidecarRoadmapReviewTrigger>();
  private readonly inFlight = new Set<string>();

  enqueue(trigger: AppSidecarRoadmapReviewTrigger): AppSidecarRoadmapReviewQueueOutcome {
    if (this.queued.has(trigger.triggerId) || this.inFlight.has(trigger.triggerId)) {
      return { status: "duplicate", trigger };
    }
    this.queued.set(trigger.triggerId, trigger);
    return { status: "queued", trigger };
  }

  replay(phases: readonly NotesPhase[]): AppSidecarRoadmapReviewQueueOutcome[] {
    return phases.flatMap((phase) => {
      const trigger = appSidecarRoadmapReviewTrigger(phase);
      return trigger ? [this.enqueue(trigger)] : [];
    });
  }

  async drain(
    execute: (trigger: AppSidecarRoadmapReviewTrigger) => Promise<void>,
    onOutcome?: (outcome: AppSidecarRoadmapReviewExecutionOutcome) => void,
  ): Promise<AppSidecarRoadmapReviewExecutionOutcome[]> {
    const outcomes: AppSidecarRoadmapReviewExecutionOutcome[] = [];
    for (const [triggerId, trigger] of this.queued) {
      this.queued.delete(triggerId);
      this.inFlight.add(triggerId);
      const started = { status: "started", trigger } as const;
      outcomes.push(started);
      onOutcome?.(started);
      try {
        await execute(trigger);
        const completed = { status: "completed", trigger } as const;
        outcomes.push(completed);
        onOutcome?.(completed);
      } catch (error) {
        const failed = { status: "failed", trigger, error } as const;
        outcomes.push(failed);
        onOutcome?.(failed);
      } finally {
        this.inFlight.delete(triggerId);
      }
    }
    return outcomes;
  }
}

export class AppSidecarRoadmapReviewRunCoordinator<TAttempt> {
  private claim: AppSidecarRoadmapReviewTrigger | null = null;
  private attemptSink: ((attempt: TAttempt) => void) | null = null;

  activeClaim(): AppSidecarRoadmapReviewTrigger | null {
    return this.claim;
  }

  record(attempt: TAttempt): void {
    this.attemptSink?.(attempt);
  }

  async run(
    trigger: AppSidecarRoadmapReviewTrigger | null,
    review: (attempt: 0 | 1) => Promise<void>,
    shouldRetry: (attempts: readonly TAttempt[]) => boolean,
  ): Promise<readonly TAttempt[]> {
    const attempts: TAttempt[] = [];
    const previousClaim = this.claim;
    const previousAttemptSink = this.attemptSink;
    this.claim = trigger;
    this.attemptSink = (attempt) => attempts.push(attempt);
    try {
      await review(0);
      if (trigger && shouldRetry(attempts)) await review(1);
      return attempts;
    } finally {
      this.claim = previousClaim;
      this.attemptSink = previousAttemptSink;
    }
  }
}
