import type { NotesSessionLink } from "@kenkaiiii/gg-core/project-notes";

/** Optional progress widget data, never completion authority. */
export interface PhaseImplementationPlanProgress {
  total: number;
  completed: number[];
}

export class AppSidecarPhaseImplementationPlanTracker {
  private retained:
    | (PhaseImplementationPlanProgress & { phaseId: string; planHash: string | null })
    | null = null;

  clear(): void {
    this.retained = null;
  }

  resolve(input: {
    phaseId: string;
    session: NotesSessionLink;
    current: PhaseImplementationPlanProgress;
    planHash?: string | null;
  }): PhaseImplementationPlanProgress | null {
    if (input.current.total > 0) {
      const retainedCompleted =
        this.retained?.phaseId === input.phaseId && this.retained.total === input.current.total
          ? this.retained.completed
          : [];
      const completed = [...new Set([...retainedCompleted, ...input.current.completed])].sort(
        (left, right) => left - right,
      );
      this.retained = {
        phaseId: input.phaseId,
        planHash: input.planHash ?? this.retained?.planHash ?? null,
        total: input.current.total,
        completed,
      };
      return { total: input.current.total, completed: [...completed] };
    }
    if (this.retained?.phaseId !== input.phaseId) return null;
    if (input.planHash !== undefined && this.retained.planHash !== input.planHash) return null;
    return { total: this.retained.total, completed: [...this.retained.completed] };
  }
}
