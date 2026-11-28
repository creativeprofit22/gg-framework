import type { ReactElement } from "react";
import { NotesPhaseStatusBadge } from "../NotesStatusBadge";
import type { NotesPhase } from "../notes-types";
import { dependencyEntries } from "./roadmap-dependency-presentation";

/** Read-only "Depends on" list in the phase overview; hidden when the phase has no links. */
export function NotesPhaseDependencies({
  phases,
  phase,
}: {
  phases: readonly NotesPhase[];
  phase: NotesPhase;
}): ReactElement | null {
  const entries = dependencyEntries(phases, phase.dependsOn ?? []);
  if (entries.length === 0) return null;
  return (
    <section
      className="notes-phase-dependencies"
      aria-labelledby={`notes-phase-dependencies-${phase.id}`}
    >
      <h4 id={`notes-phase-dependencies-${phase.id}`}>Depends on</h4>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="notes-phase-dependency-title">
              {entry.title}
              {entry.archived && !entry.deleted && " (archived)"}
            </span>
            {entry.deleted ? (
              <span className="roadmap-edit-tag">Deleted</span>
            ) : (
              entry.status && <NotesPhaseStatusBadge status={entry.status} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
