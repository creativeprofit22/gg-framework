import { isNotesPhaseDeleted } from "./roadmap-phase-deletion.js";
import type {
  NotesPhase,
  NotesRoadmapDependencyOverride,
  NotesSessionLink,
  NotesValidationError,
} from "./project-notes.js";

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

type DraftDependencyPhase = Pick<NotesPhase, "id" | "title" | "dependsOn">;

/** Validates the graph a draft would create once its phases are appended, with saving's errors. */
export function validateRoadmapDraftDependencies(
  currentPhases: readonly DependencyPhase[],
  draftPhases: readonly DraftDependencyPhase[],
): NotesValidationError | null {
  return validateRoadmapPhaseDependencies([
    ...currentPhases,
    ...draftPhases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      status: "not-started" as const,
      ...(phase.dependsOn === undefined ? {} : { dependsOn: phase.dependsOn }),
    })),
  ]);
}

/** Validates the graph after one phase's links change. An empty list means the links are removed. */
export function validateRoadmapEditDependencies(
  currentPhases: readonly DependencyPhase[],
  phaseId: string,
  dependsOn: readonly string[],
): NotesValidationError | null {
  return validateRoadmapPhaseDependencies(
    currentPhases.map((phase) => {
      if (phase.id !== phaseId) return phase;
      const next: DependencyPhase = { ...phase, dependsOn: [...dependsOn] };
      if (dependsOn.length === 0) delete next.dependsOn;
      return next;
    }),
  );
}

/** Plain warnings when a reorder puts a phase above a prerequisite or below a dependent. */
export function roadmapOrderDependencyWarnings(
  phases: readonly DependencyPhase[],
  orderAfter: readonly string[],
  movedPhaseId: string,
): string[] {
  const position = new Map(orderAfter.map((id, index) => [id, index]));
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const moved = byId.get(movedPhaseId);
  const movedPosition = position.get(movedPhaseId);
  if (moved === undefined || movedPosition === undefined) return [];
  const warnings: string[] = [];
  for (const link of moved.dependsOn ?? []) {
    const prerequisite = byId.get(link);
    const prerequisitePosition = position.get(link);
    if (prerequisite === undefined || prerequisitePosition === undefined) continue;
    if (prerequisitePosition > movedPosition) {
      warnings.push(
        bounded(`${describe(moved)} would sit above its prerequisite ${describe(prerequisite)}.`),
      );
    }
  }
  for (const dependent of phases) {
    const dependentPosition = position.get(dependent.id);
    if (
      dependent.id === movedPhaseId ||
      dependentPosition === undefined ||
      dependent.dependsOn?.includes(movedPhaseId) !== true
    ) {
      continue;
    }
    if (dependentPosition < movedPosition) {
      warnings.push(
        bounded(`${describe(moved)} would sit below ${describe(dependent)}, which depends on it.`),
      );
    }
  }
  return warnings;
}

type OverridePhase = Pick<NotesPhase, "roadmapEvents" | "lifecycleEvents" | "deletion">;

/** The latest dependency override, only while it is a user start from the app that is still current. */
export function findCurrentDependencyOverride(
  phase: OverridePhase,
): NotesRoadmapDependencyOverride | null {
  let index = -1;
  for (let candidate = phase.roadmapEvents.length - 1; candidate >= 0; candidate -= 1) {
    if (phase.roadmapEvents[candidate]!.type === "dependency-override") {
      index = candidate;
      break;
    }
  }
  if (index < 0) return null;
  const override = phase.roadmapEvents[index] as NotesRoadmapDependencyOverride;
  if (override.actor !== "user" || override.origin !== "app") return null;
  // A deletion retires earlier events; recovery counts as a reopen.
  const retiredBoundary = Math.max(
    0,
    ...(phase.deletion?.events ?? []).flatMap((event) =>
      event.action === "delete" ? [event.retired.roadmapEventCount] : [],
    ),
  );
  if (index < retiredBoundary) return null;
  const startedAt = Date.parse(override.timestamp);
  const reopened = phase.lifecycleEvents.some(
    (event) =>
      (event.fromStatus === "done" || event.fromStatus === "cancelled") &&
      Date.parse(event.timestamp) > startedAt,
  );
  if (reopened) return null;
  const rebound = phase.roadmapEvents
    .slice(index + 1)
    .some((event) => event.type === "phase-binding");
  return rebound ? null : override;
}

function sameSession(left: NotesSessionLink | null, right: NotesSessionLink | null): boolean {
  if (left === null || right === null) return left === right;
  return left.sessionId === right.sessionId && left.sessionPath === right.sessionPath;
}

export interface AgentPhaseStartRefusal {
  prerequisites: { id: string; title: string; status: NotesPhase["status"] }[];
  message: string;
}

/** Strict agent gate: unfinished prerequisites refuse unless the user's current app start covers this session. */
export function agentPhaseStartRefusal(
  phases: readonly (DependencyPhase & OverridePhase & Pick<NotesPhase, "session">)[],
  phaseId: string,
  session: NotesSessionLink,
): AgentPhaseStartRefusal | null {
  const unfinished = listUnfinishedPrerequisites(phases, phaseId);
  if (unfinished === null || unfinished.length === 0) return null;
  const phase = phases.find((candidate) => candidate.id === phaseId)!;
  const override = findCurrentDependencyOverride(phase);
  if (
    override !== null &&
    sameSession(override.session, phase.session) &&
    sameSession(override.session, session)
  ) {
    return null;
  }
  return {
    prerequisites: unfinished.map(({ id, title, status }) => ({ id, title, status })),
    message: bounded(
      `Can't start ${describe(phase)}: these prerequisite phases aren't Done: ${describeList(unfinished)}. The user can start it from the app.`,
    ),
  };
}
