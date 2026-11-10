import type { ReactElement } from "react";
import type { NotesPhase } from "../notes-types";
import { unfinishedPrerequisitesFor, waitingOnLabel } from "./roadmap-dependency-presentation";

export function NotesPhaseWaitingOn({
  phases,
  phase,
}: {
  phases: readonly NotesPhase[];
  phase: NotesPhase;
}): ReactElement | null {
  const unfinished = unfinishedPrerequisitesFor(phases, phase);
  if (unfinished.length === 0) return null;
  return <p className="notes-phase-waiting-on">{waitingOnLabel(unfinished)}</p>;
}
