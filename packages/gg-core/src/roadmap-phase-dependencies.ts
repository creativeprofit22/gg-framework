import { isNotesPhaseDeleted } from "./roadmap-phase-deletion.js";
import type { NotesPhase, NotesValidationError } from "./project-notes.js";

// Rules: docs/notes-roadmap-dependencies.md. This module is their only implementation.

const DISPLAY_LIMIT = 80;
const MESSAGE_LIMIT = 1024;
const LISTED_PHASE_LIMIT = 5;

type DependencyPhase = Pick<NotesPhase, "id" | "title" | "status" | "deletion" | "dependsOn">;

function clip(value: string): string {
  return value.length <= DISPLAY_LIMIT ? value : `${value.slice(0, DISPLAY_LIMIT - 1)}…`;
}

function describe(phase: Pick<NotesPhase, "id" | "title">): string {
  return `"${clip(phase.title)}" (${clip(phase.id)})`;
}

function describeList(phases: readonly Pick<NotesPhase, "id" | "title">[]): string {
  const listed = phases.slice(0, LISTED_PHASE_LIMIT).map(describe).join(", ");
  const rest = phases.length - LISTED_PHASE_LIMIT;
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}

function bounded(message: string): string {
  return message.length <= MESSAGE_LIMIT ? message : `${message.slice(0, MESSAGE_LIMIT - 1)}…`;
}

function fail(path: string, message: string): NotesValidationError {
  return { path, message };
}

/** Checks link shape, targets and cycles. Expects phases whose other fields already validated. */
export function validateRoadmapPhaseDependencies(
  phases: readonly DependencyPhase[],
): NotesValidationError | null {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  for (const [index, phase] of phases.entries()) {
    if (!("dependsOn" in phase)) continue;
    const path = `phases[${index}].dependsOn`;
    const links: unknown = phase.dependsOn;
    if (!Array.isArray(links)) return fail(path, "expected an array of phase IDs");
    if (links.length === 0) {
      return fail(path, `${describe(phase)} has an empty dependency list; omit dependsOn instead`);
    }
    const seen = new Set<string>();
    for (const [linkIndex, link] of links.entries()) {
      const linkPath = `${path}[${linkIndex}]`;
      if (typeof link !== "string" || link.trim().length === 0) {
        return fail(linkPath, "expected a non-empty phase ID");
      }
      if (link === phase.id) return fail(linkPath, `${describe(phase)} cannot depend on itself`);
      if (seen.has(link)) {
        return fail(linkPath, `${describe(phase)} lists phase ${clip(link)} more than once`);
      }
      seen.add(link);
      const target = byId.get(link);
      if (target === undefined) {
        return fail(linkPath, `${describe(phase)} depends on missing phase ${clip(link)}`);
      }
      if (!isNotesPhaseDeleted(phase) && isNotesPhaseDeleted(target)) {
        return fail(linkPath, `${describe(phase)} depends on deleted phase ${describe(target)}`);
      }
    }
  }
  return findCycle(phases, byId);
}

function findCycle(
  phases: readonly DependencyPhase[],
  byId: ReadonlyMap<string, DependencyPhase>,
): NotesValidationError | null {
  const indexById = new Map(phases.map((phase, index) => [phase.id, index]));
  const done = new Set<string>();
  const onStack = new Set<string>();
  const stack: DependencyPhase[] = [];
  const visit = (phase: DependencyPhase): NotesValidationError | null => {
    onStack.add(phase.id);
    stack.push(phase);
    for (const [linkIndex, link] of (phase.dependsOn ?? []).entries()) {
      if (onStack.has(link)) {
        const start = stack.findIndex((candidate) => candidate.id === link);
        const chain = [...stack.slice(start), byId.get(link)!].map(describe).join(" → ");
        return fail(
          `phases[${indexById.get(phase.id)}].dependsOn[${linkIndex}]`,
          bounded(`circular dependency chain: ${chain}`),
        );
      }
      const target = byId.get(link);
      if (target === undefined || done.has(link)) continue;
      const error = visit(target);
      if (error) return error;
    }
    stack.pop();
    onStack.delete(phase.id);
    done.add(phase.id);
    return null;
  };
  for (const phase of phases) {
    if (done.has(phase.id)) continue;
    const error = visit(phase);
    if (error) return error;
  }
  return null;
}

/** Store-version trigger: true when any phase, present or deleted, holds links. */
export function hasRoadmapPhaseDependencyLinks(
  phases: readonly Pick<NotesPhase, "dependsOn">[],
): boolean {
  return phases.some((phase) => phase.dependsOn !== undefined);
}

/** Finished means a present phase with status Done. Null when the phase is unknown. */
export function listUnfinishedPrerequisites<T extends DependencyPhase>(
  phases: readonly T[],
  phaseId: string,
): T[] | null {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const phase = byId.get(phaseId);
  if (phase === undefined) return null;
  return (phase.dependsOn ?? []).flatMap((link) => {
    const prerequisite = byId.get(link);
    if (prerequisite === undefined) return [];
    return !isNotesPhaseDeleted(prerequisite) && prerequisite.status === "done"
      ? []
      : [prerequisite];
  });
}

/** Delete: refused while present phases depend on it. Recover: refused while its prerequisites stay deleted. */
export function phaseDeletionDependencyConflict(
  phases: readonly DependencyPhase[],
  phaseId: string,
  action: "delete" | "recover",
): { message: string } | null {
  const phase = phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) return null;
  if (action === "delete") {
    const dependents = phases.filter(
      (candidate) =>
        candidate.id !== phaseId &&
        !isNotesPhaseDeleted(candidate) &&
        candidate.dependsOn?.includes(phaseId) === true,
    );
    if (dependents.length === 0) return null;
    return {
      message: bounded(
        `Cannot delete ${describe(phase)} because other phases depend on it: ${describeList(dependents)}. Remove those dependency links or delete those phases first.`,
      ),
    };
  }
  const deletedPrerequisites = (phase.dependsOn ?? []).flatMap((link) => {
    const prerequisite = phases.find((candidate) => candidate.id === link);
    return prerequisite !== undefined && isNotesPhaseDeleted(prerequisite) ? [prerequisite] : [];
  });
  if (deletedPrerequisites.length === 0) return null;
  return {
    message: bounded(
      `Cannot recover ${describe(phase)} because it depends on deleted phases: ${describeList(deletedPrerequisites)}. Recover ${deletedPrerequisites.length === 1 ? "that phase" : "those phases"} first.`,
    ),
  };
}
