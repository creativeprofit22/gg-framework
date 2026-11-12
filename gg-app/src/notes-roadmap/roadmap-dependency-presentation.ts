import { isNotesPhaseDeleted } from "@kenkaiiii/gg-core/project-notes";
import { listUnfinishedPrerequisites } from "@kenkaiiii/gg-core/roadmap-phase-dependencies";
import type { NotesPhase, NotesPhaseStatus } from "../notes-types";

const WAITING_ON_NAMED_LIMIT = 3;

export interface PhaseDependencyEntry {
  id: string;
  title: string;
  status: NotesPhaseStatus | null;
  archived: boolean;
  deleted: boolean;
}

/** Unfinished prerequisites to show as "Waiting on"; none once the phase itself is Done. */
export function unfinishedPrerequisitesFor(
  phases: readonly NotesPhase[],
  phase: NotesPhase,
): NotesPhase[] {
  if (phase.status === "done") return [];
  return listUnfinishedPrerequisites(phases, phase.id) ?? [];
}

/** "Waiting on: A, B and C", or "Waiting on: A, B and 2 more" past three titles. */
export function waitingOnLabel(prerequisites: readonly Pick<NotesPhase, "title">[]): string {
  const titles = prerequisites.map((prerequisite) => prerequisite.title);
  if (titles.length <= WAITING_ON_NAMED_LIMIT) {
    const last = titles.pop();
    return `Waiting on: ${titles.length > 0 ? `${titles.join(", ")} and ${last}` : last}`;
  }
  const named = titles.slice(0, WAITING_ON_NAMED_LIMIT - 1).join(", ");
  return `Waiting on: ${named} and ${titles.length - (WAITING_ON_NAMED_LIMIT - 1)} more`;
}

export function dependencyEntries(
  phases: readonly NotesPhase[],
  dependsOn: readonly string[],
): PhaseDependencyEntry[] {
  return dependsOn.map((id) => {
    const target = phases.find((candidate) => candidate.id === id);
    if (!target)
      return { id, title: "Missing phase", status: null, archived: false, deleted: false };
    return {
      id,
      title: target.title,
      status: target.status,
      archived: target.archivedAt !== null,
      deleted: isNotesPhaseDeleted(target),
    };
  });
}

/** Phases that can still be added as prerequisites: present, not this phase, not linked yet. */
export function dependencyCandidates(
  phases: readonly NotesPhase[],
  phaseId: string,
  dependsOn: readonly string[],
): NotesPhase[] {
  const linked = new Set(dependsOn);
  return phases.filter(
    (candidate) =>
      candidate.id !== phaseId && !linked.has(candidate.id) && !isNotesPhaseDeleted(candidate),
  );
}
