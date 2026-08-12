/** Maximum raw textarea length accepted for a human plan revision request. */
export const PLAN_REVISION_FEEDBACK_MAX_CHARS = 32_000;

/** Authoritative durable plan gate projected by state, SSE, and mutation conflicts. */
export interface PendingPlanReview {
  checkpointId: string;
  generation: number;
  planPath: string;
  content: string;
  contentHash: string;
  state: "pending-review" | "revision-requested";
  reviewStatus: "unreviewed" | "ready";
  feedback: string | null;
}

export interface PlanMutationOwner {
  operationId: string;
  kind: string;
}

export interface PlanAcceptResult {
  ok: true;
  planTotal: number;
  operationId: string;
}

export interface PlanRevisionResult {
  ok: true;
  operationId: string;
}

/** Structured 400/409 body returned when a plan mutation is rejected safely. */
interface PlanMutationFailureDetails {
  message?: string;
  guidance?: string;
  pendingPlanReview?: PendingPlanReview | null;
}

export interface PlanMutationErrorFailure extends PlanMutationFailureDetails {
  error: string;
  status?: never;
  code?: never;
  state?: string;
  operationId?: string;
  retryable?: never;
  phaseId?: never;
  owner?: PlanMutationOwner;
}

export interface PlanMutationCheckpointFailure extends PlanMutationFailureDetails {
  status: "failed";
  code: string;
  message: string;
  guidance: string;
  error?: never;
  state?: never;
  operationId: string;
  retryable: boolean;
  phaseId: string;
  owner?: never;
}

export type PlanMutationFailure = PlanMutationErrorFailure | PlanMutationCheckpointFailure;

export function isPlanMutationFailure(value: unknown): value is PlanMutationFailure {
  if (!isRecord(value)) return false;
  if ("error" in value) {
    return (
      isNonEmptyString(value.error) &&
      value.status === undefined &&
      value.code === undefined &&
      value.retryable === undefined &&
      value.phaseId === undefined &&
      isOptionalNonEmptyString(value.message) &&
      isOptionalNonEmptyString(value.guidance) &&
      isOptionalNonEmptyString(value.state) &&
      isOptionalNonEmptyString(value.operationId) &&
      (value.owner === undefined || isPlanMutationOwner(value.owner)) &&
      (value.pendingPlanReview === undefined ||
        value.pendingPlanReview === null ||
        isPendingPlanReview(value.pendingPlanReview))
    );
  }
  return (
    value.status === "failed" &&
    isNonEmptyString(value.code) &&
    value.error === undefined &&
    value.state === undefined &&
    isNonEmptyString(value.operationId) &&
    typeof value.retryable === "boolean" &&
    isNonEmptyString(value.phaseId) &&
    value.owner === undefined &&
    isNonEmptyString(value.message) &&
    isNonEmptyString(value.guidance) &&
    (value.pendingPlanReview === undefined ||
      value.pendingPlanReview === null ||
      isPendingPlanReview(value.pendingPlanReview))
  );
}

export function isPendingPlanReview(value: unknown): value is PendingPlanReview {
  return (
    isRecord(value) &&
    isNonEmptyString(value.checkpointId) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 1 &&
    isNonEmptyString(value.planPath) &&
    typeof value.content === "string" &&
    isNonEmptyString(value.contentHash) &&
    (value.state === "pending-review" || value.state === "revision-requested") &&
    (value.reviewStatus === "unreviewed" || value.reviewStatus === "ready") &&
    (value.feedback === null || isNonEmptyString(value.feedback))
  );
}

function isPlanMutationOwner(value: unknown): value is PlanMutationOwner {
  return (
    isRecord(value) && isNonEmptyString(value.operationId) && isNonEmptyString(value.kind)
  );
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
