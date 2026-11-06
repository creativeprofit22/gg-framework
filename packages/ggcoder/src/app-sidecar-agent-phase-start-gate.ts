import { notesSessionLinksEqual, type NotesSessionLink } from "@kenkaiiii/gg-core/project-notes";
import { agentPhaseStartRefusal } from "@kenkaiiii/gg-core/roadmap-phase-dependencies";
import type { ProjectNotesRepository } from "./project-notes-repository.js";
import type { RoadmapBindPrerequisitesUnfinished } from "./tools/roadmap-bind.js";

/**
 * "attach": roadmap_bind bind/rebind/acquire/takeover.
 * "status": roadmap_status in-progress.
 * Neither counts as a new start when the phase is already active in the caller's session.
 */
export type AgentPhaseStartKind = "attach" | "status";

const ACTIVE_STATUSES = new Set(["planning", "in-progress", "blocked"]);

/** Strict agent start gate over the shared dependency rules; user and app routes never call it. */
export async function checkAgentPhaseStart(
  repository: Pick<ProjectNotesRepository, "load">,
  cwd: string,
  phaseId: string,
  session: NotesSessionLink,
  _kind: AgentPhaseStartKind,
): Promise<RoadmapBindPrerequisitesUnfinished | null> {
  const loaded = await repository.load(cwd);
  // Missing or unreadable Notes are reported by the call this gate guards.
  if (loaded.status !== "ok") return null;
  const phases = loaded.snapshot.document.phases;
  // Compaction moves phase.session without a new override, so the bound session itself is the proof.
  const phase = phases.find((candidate) => candidate.id === phaseId);
  if (
    phase !== undefined &&
    ACTIVE_STATUSES.has(phase.status) &&
    notesSessionLinksEqual(phase.session, session)
  ) {
    return null;
  }
  const refusal = agentPhaseStartRefusal(phases, phaseId, session);
  if (refusal === null) return null;
  return {
    status: "prerequisites-unfinished",
    phaseId,
    prerequisites: refusal.prerequisites,
    message: refusal.message,
  };
}

/** True for roadmap_bind actions that attach this session to a phase. */
export function isAgentPhaseAttachAction(action: string): boolean {
  return (
    action === "bind-current" ||
    action === "rebind-current" ||
    action === "acquire" ||
    action === "takeover"
  );
}
