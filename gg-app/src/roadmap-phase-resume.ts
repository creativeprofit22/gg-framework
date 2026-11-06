import type { PaneAgentClient } from "./agent";
import type { NotesSessionLink } from "./notes-types";

export function preferredRoadmapPhaseSession(
  phase:
    | {
        session: NotesSessionLink | null;
        execution?: { lastSession: NotesSessionLink | null } | null;
      }
    | undefined,
  compatibilitySession: NotesSessionLink,
): NotesSessionLink {
  return phase?.execution?.lastSession ?? phase?.session ?? compatibilitySession;
}

export function resolveRoadmapPhaseResume(
  phase:
    | {
        session: NotesSessionLink | null;
        execution?: { state?: string; lastSession: NotesSessionLink | null } | null;
      }
    | undefined,
  compatibilitySession: NotesSessionLink,
): { status: "blocked"; message: string } | { status: "ready"; session: NotesSessionLink } {
  return { status: "ready", session: preferredRoadmapPhaseSession(phase, compatibilitySession) };
}

export async function resolveRoadmapPhaseResumeFromNotes(
  client: Pick<PaneAgentClient, "getNotes">,
  phaseId: string,
  compatibilitySession: NotesSessionLink,
): Promise<ReturnType<typeof resolveRoadmapPhaseResume>> {
  try {
    const opened = await client.getNotes();
    return opened.status === "ok"
      ? resolveRoadmapPhaseResume(
          opened.snapshot.document.phases.find((phase) => phase.id === phaseId),
          compatibilitySession,
        )
      : resolveRoadmapPhaseResume(undefined, compatibilitySession);
  } catch {
    return {
      status: "blocked",
      message:
        "Couldn’t verify whether this phase needs reconciliation. Open Project Notes and retry Resume.",
    };
  }
}
