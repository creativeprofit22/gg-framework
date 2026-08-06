import type { ProjectNotesLoadOutcome } from "@kenkaiiii/gg-core/project-notes";
import type { ActivePhaseContextV1, ActivePhaseExecutionStage } from "./phase-context.js";
import { isActivePhaseReadyForReview } from "./active-phase-verification.js";

export interface ActivePhaseVerificationSession {
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  updateActivePhaseStage(executionStage: ActivePhaseExecutionStage): Promise<unknown>;
}

export interface ActivePhaseVerificationRepository {
  load(projectCwd: string): Promise<ProjectNotesLoadOutcome>;
}

export async function reconcileActivePhaseVerificationStage(input: {
  cwd: string;
  repository: ActivePhaseVerificationRepository;
  session: ActivePhaseVerificationSession;
}): Promise<ActivePhaseExecutionStage | undefined> {
  const context = input.session.getActivePhaseContext();
  if (
    !context ||
    (context.executionStage !== "implementing" && context.executionStage !== "reviewing")
  ) {
    return context?.executionStage;
  }

  const loaded = await input.repository.load(input.cwd);
  const phase =
    loaded.status === "ok"
      ? loaded.snapshot.document.phases.find((candidate) => candidate.id === context.phase.id)
      : undefined;
  const nextStage =
    phase && isActivePhaseReadyForReview(phase, context.session) ? "reviewing" : "implementing";
  if (nextStage !== context.executionStage) {
    await input.session.updateActivePhaseStage(nextStage);
  }
  return nextStage;
}
