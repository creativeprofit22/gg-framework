import { createHash } from "node:crypto";
import type {
  NotesPhase,
  NotesRoadmapCompletionReview,
  NotesRoadmapStatusUpdate,
} from "@kenkaiiii/gg-core";
import type { AppSidecarFinalReviewExecutionResult } from "./app-sidecar-autopilot-phase-review.js";

export interface AppSidecarRoadmapReviewTrigger {
  projectKey: string;
  phaseId: string;
  verificationStatusUpdateId: string;
  triggerId: string;
  reviewId: string;
}

export type AppSidecarRoadmapReviewQueueOutcome =
  | { status: "queued"; trigger: AppSidecarRoadmapReviewTrigger }
  | { status: "duplicate"; trigger: AppSidecarRoadmapReviewTrigger };

export type AppSidecarRoadmapReviewExecutionOutcome =
  | { status: "started"; trigger: AppSidecarRoadmapReviewTrigger; attempt: number }
  | {
      status: "completed";
      trigger: AppSidecarRoadmapReviewTrigger;
      attempt: number;
      result: AppSidecarFinalReviewExecutionResult;
    }
  | {
      status: "retry-scheduled";
      trigger: AppSidecarRoadmapReviewTrigger;
      attempt: number;
      nextAttemptAt: number;
      result: AppSidecarFinalReviewExecutionResult;
    }
  | {
      status: "failed";
      trigger: AppSidecarRoadmapReviewTrigger;
      attempt: number;
      result: AppSidecarFinalReviewExecutionResult;
    };

interface QueuedReview {
  trigger: AppSidecarRoadmapReviewTrigger;
  attempts: number;
  readyAt: number;
}

export interface AppSidecarRoadmapReviewSchedulerOptions {
  now?: () => number;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
}

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
    headline: "Roadmap final review will retry",
    message: `${code}: phase ${trigger.phaseId}, trigger ${trigger.triggerId}, observed revision ${observedRevision ?? "unavailable"}.`,
    guidance: "The persisted Review trigger remains eligible and will be rediscovered after recovery.",
  };
}

export function resolveAppSidecarRoadmapReviewFailure(
  _trigger: AppSidecarRoadmapReviewTrigger | undefined,
  error: unknown,
): AppSidecarFinalReviewExecutionResult {
  return {
    status: "retryable-reviewer-error",
    message: safeReviewerError(error),
  };
}

export function shouldRetryAppSidecarRoadmapReview(
  status: "missing" | "stale-revision" | "committed" | "duplicate" | "failed",
): boolean {
  return status === "missing" || status === "stale-revision";
}

export function appSidecarRoadmapReviewTrigger(
  phase: NotesPhase,
  projectKey = "unknown-project",
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
  return createAppSidecarRoadmapReviewTrigger(phase.id, verification.id, projectKey);
}

export function createAppSidecarRoadmapReviewTrigger(
  phaseId: string,
  verificationStatusUpdateId: string,
  projectKey = "unknown-project",
): AppSidecarRoadmapReviewTrigger {
  const digest = createHash("sha256")
    .update(JSON.stringify([projectKey, phaseId, verificationStatusUpdateId]))
    .digest("hex");
  return {
    projectKey,
    phaseId,
    verificationStatusUpdateId,
    triggerId: `roadmap-final-review-${digest}`,
    reviewId: `autopilot-final-${digest}`,
  };
}

export class AppSidecarRoadmapReviewScheduler {
  private readonly queued = new Map<string, QueuedReview>();
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxAttempts: number;

  constructor(options: AppSidecarRoadmapReviewSchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000];
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  enqueue(trigger: AppSidecarRoadmapReviewTrigger): AppSidecarRoadmapReviewQueueOutcome {
    if (this.queued.has(trigger.triggerId) || this.inFlight.has(trigger.triggerId)) {
      return { status: "duplicate", trigger };
    }
    this.queued.set(trigger.triggerId, { trigger, attempts: 0, readyAt: this.now() });
    return { status: "queued", trigger };
  }

  replay(
    phases: readonly NotesPhase[],
    projectKey = "unknown-project",
  ): AppSidecarRoadmapReviewQueueOutcome[] {
    return phases.flatMap((phase) => {
      const trigger = appSidecarRoadmapReviewTrigger(phase, projectKey);
      return trigger ? [this.enqueue(trigger)] : [];
    });
  }

  async drain(
    execute: (
      trigger: AppSidecarRoadmapReviewTrigger,
      attempt: number,
    ) => Promise<AppSidecarFinalReviewExecutionResult>,
    onOutcome?: (outcome: AppSidecarRoadmapReviewExecutionOutcome) => void,
  ): Promise<AppSidecarRoadmapReviewExecutionOutcome[]> {
    const outcomes: AppSidecarRoadmapReviewExecutionOutcome[] = [];
    const ready = [...this.queued.entries()].filter(([, queued]) => queued.readyAt <= this.now());
    for (const [triggerId, queued] of ready) {
      this.queued.delete(triggerId);
      this.inFlight.add(triggerId);
      const attempt = queued.attempts + 1;
      const started = { status: "started", trigger: queued.trigger, attempt } as const;
      outcomes.push(started);
      onOutcome?.(started);
      let result: AppSidecarFinalReviewExecutionResult;
      try {
        result = await execute(queued.trigger, attempt);
      } catch (error) {
        result = resolveAppSidecarRoadmapReviewFailure(queued.trigger, error);
      } finally {
        this.inFlight.delete(triggerId);
      }

      if (shouldRetryResult(result, attempt) && attempt < this.maxAttempts) {
        const delay = this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 0;
        const nextAttemptAt = this.now() + delay;
        this.queued.set(triggerId, { trigger: queued.trigger, attempts: attempt, readyAt: nextAttemptAt });
        const scheduled = {
          status: "retry-scheduled",
          trigger: queued.trigger,
          attempt,
          nextAttemptAt,
          result,
        } as const;
        outcomes.push(scheduled);
        onOutcome?.(scheduled);
      } else if (shouldRetryResult(result, attempt)) {
        const failed = { status: "failed", trigger: queued.trigger, attempt, result } as const;
        outcomes.push(failed);
        onOutcome?.(failed);
      } else {
        const completed = { status: "completed", trigger: queued.trigger, attempt, result } as const;
        outcomes.push(completed);
        onOutcome?.(completed);
      }
    }
    return outcomes;
  }
}

function shouldRetryResult(result: AppSidecarFinalReviewExecutionResult, attempt: number): boolean {
  return (
    result.status === "retryable-reviewer-error" ||
    (result.status === "typed-non-commit" && result.retryable) ||
    (result.status === "no-attempt" && attempt === 1)
  );
}

function safeReviewerError(error: unknown): string {
  if (!(error instanceof Error)) return "Reviewer execution failed.";
  const message = error.message.trim().replace(/[\r\n]+/g, " ");
  return message.slice(0, 512) || "Reviewer execution failed.";
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
