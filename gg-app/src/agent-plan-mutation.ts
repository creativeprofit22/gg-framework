import type {
  PendingPlanReview,
  PlanAcceptResult,
  PlanMutationFailure,
  PlanRevisionResult,
} from "@kenkaiiii/gg-core";
import { isRecord } from "./agent-record";

function parsePendingPlanReview(value: unknown): PendingPlanReview | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.checkpointId !== "string" ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.planPath !== "string" ||
    typeof value.content !== "string" ||
    typeof value.contentHash !== "string" ||
    (value.state !== "pending-review" && value.state !== "revision-requested") ||
    (value.reviewStatus !== "unreviewed" && value.reviewStatus !== "ready") ||
    (value.feedback !== null && typeof value.feedback !== "string")
  ) {
    return undefined;
  }
  return value as unknown as PendingPlanReview;
}

function planMutationMessage(payload: PlanMutationFailure, fallback: string): string {
  const detail = payload.message?.trim();
  const guidance = payload.guidance?.trim();
  if (detail && guidance) return `${detail} ${guidance}`;
  if (detail) return detail;
  if (guidance) return guidance;
  switch (payload.error) {
    case "stale-plan-checkpoint":
      return "The plan changed before this action completed. Review the latest checkpoint and try again.";
    case "session_busy":
      return "The session is busy. Wait for the active run to finish, then try again.";
    case "session_mutation_in_progress":
      return "Another session change is still completing. Wait a moment, then try again.";
    case "cannot accept a plan while the agent is running":
      return "The agent is still running. Wait for it to finish, then approve the plan.";
    case "invalid plan approval body":
    case "invalid plan revision body":
      return "The plan request was rejected as invalid. Reload the pane before trying again.";
    default:
      return payload.error?.trim() || fallback;
  }
}

/** Typed plan mutation rejection with any authoritative recovery checkpoint attached. */
export class PlanMutationError extends Error {
  readonly pendingPlanReview: PendingPlanReview | null | undefined;

  constructor(
    message: string,
    readonly payload: PlanMutationFailure,
  ) {
    super(message);
    this.name = "PlanMutationError";
    this.pendingPlanReview = Object.prototype.hasOwnProperty.call(payload, "pendingPlanReview")
      ? payload.pendingPlanReview
      : undefined;
  }
}

export function asPlanMutationError(error: unknown, fallback: string): PlanMutationError {
  if (error instanceof PlanMutationError) return error;
  let candidate: unknown = error;
  const serialized =
    typeof error === "string" ? error : error instanceof Error ? error.message : null;
  if (serialized !== null) {
    try {
      candidate = JSON.parse(serialized);
    } catch {
      candidate = error;
    }
  }
  if (isRecord(candidate)) {
    const payload = candidate as unknown as PlanMutationFailure;
    if (Object.prototype.hasOwnProperty.call(candidate, "pendingPlanReview")) {
      const pendingPlanReview = parsePendingPlanReview(candidate.pendingPlanReview);
      if (pendingPlanReview !== undefined) payload.pendingPlanReview = pendingPlanReview;
      else delete payload.pendingPlanReview;
    }
    return new PlanMutationError(planMutationMessage(payload, fallback), payload);
  }
  const message = error instanceof Error ? error.message : fallback;
  return new PlanMutationError(message || fallback, { error: message || fallback });
}

export function requirePlanAcceptResult(value: unknown): PlanAcceptResult {
  if (!isRecord(value)) throw new Error("invalid plan acceptance response");
  const planTotal = value.planTotal;
  const operationId = value.operationId;
  if (
    value.ok !== true ||
    typeof planTotal !== "number" ||
    !Number.isSafeInteger(planTotal) ||
    planTotal < 0 ||
    typeof operationId !== "string" ||
    operationId.length === 0
  ) {
    throw new Error("invalid plan acceptance response");
  }
  return { ok: true, planTotal, operationId };
}

export function requirePlanRevisionResult(value: unknown): PlanRevisionResult {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0
  ) {
    throw new Error("invalid plan revision response");
  }
  return { ok: true, operationId: value.operationId };
}
