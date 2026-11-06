import { PLAN_REVISION_FEEDBACK_MAX_CHARS } from "@kenkaiiii/gg-core";
import type {
  PersistedPlanReviewCheckpoint,
  PlanGateTransitionResult,
} from "./app-sidecar-plan-gate.js";

export interface PlanRevisionRequest {
  checkpointId: string;
  generation: number;
  actor: "user" | "ken-autopilot";
  feedback: string;
}

export type ParsedPlanRevisionBody = Omit<PlanRevisionRequest, "actor">;

export function parsePlanRevisionBody(raw: string): ParsedPlanRevisionBody | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 3 ||
    typeof body.checkpointId !== "string" ||
    !Number.isSafeInteger(body.generation) ||
    typeof body.feedback !== "string" ||
    body.feedback.length > PLAN_REVISION_FEEDBACK_MAX_CHARS
  ) {
    return null;
  }

  const feedback = body.feedback.trim();
  if (!feedback) return null;
  return {
    checkpointId: body.checkpointId,
    generation: body.generation as number,
    feedback,
  };
}

interface PlanRevisionExecutionDependencies {
  requestRevision: (
    checkpointId: string,
    generation: number,
    actor: "user" | "ken-autopilot",
    feedback: string,
  ) => Promise<PlanGateTransitionResult>;
  /** Stop and settle an in-flight reviewer before the revision run takes ownership. */
  supersedeAutopilot?: (checkpoint: PersistedPlanReviewCheckpoint) => Promise<void>;
  onCommitted: (checkpoint: PersistedPlanReviewCheckpoint) => void;
  run: (prompt: string, checkpoint: PersistedPlanReviewCheckpoint) => Promise<void>;
}

export function isPlanRevisionSessionBusy(state: {
  running: boolean;
  autopilotActive: boolean;
  autopilotReviewing: boolean;
}): boolean {
  // The shared lifecycle keeps `running` true during Ken-only review. Preserve
  // the build-run guard while carving out only that human-authority window.
  const supersedingAutopilotReview = state.autopilotActive && state.autopilotReviewing;
  return state.running && !supersedingAutopilotReview;
}

export function planRevisionPrompt(checkpoint: PersistedPlanReviewCheckpoint): string {
  if (checkpoint.state !== "revision-requested" || !checkpoint.feedback?.trim()) {
    throw new Error("A persisted revision request with feedback is required");
  }
  return (
    "Revise the submitted implementation plan using this human feedback. " +
    "Do not implement it. Submit the revised plan with exit_plan when ready.\n\n" +
    checkpoint.feedback
  );
}

/**
 * Commit or resume one exact revision request, acknowledge it, then run it.
 * The prompt is always rebuilt from the persisted checkpoint, never caller bytes.
 */
export async function executePlanRevisionRequest(
  request: PlanRevisionRequest,
  dependencies: PlanRevisionExecutionDependencies,
): Promise<PlanGateTransitionResult> {
  const transition = await dependencies.requestRevision(
    request.checkpointId,
    request.generation,
    request.actor,
    request.feedback,
  );
  if (transition.status === "conflict") return transition;

  const prompt = planRevisionPrompt(transition.checkpoint);
  await dependencies.supersedeAutopilot?.(transition.checkpoint);
  dependencies.onCommitted(transition.checkpoint);
  await dependencies.run(prompt, transition.checkpoint);
  return transition;
}
