import { useId, useState } from "react";
import { isNotesPhaseDeleted, type NotesPhase } from "@kenkaiiii/gg-core/project-notes";
import { NotesDisclosure } from "../NotesDisclosure";

export function NotesDeletedPhases({
  phases,
  onRecover,
  disabled = false,
}: {
  phases: NotesPhase[];
  onRecover(phase: NotesPhase): void;
  disabled?: boolean;
}) {
  const deleted = phases.filter(isNotesPhaseDeleted);
  const regionId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <NotesDisclosure
      id={regionId}
      className="notes-deleted-phases"
      label={`Deleted phases (${deleted.length})`}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      focusFallback
    >
      <p>
        Deleted phases stay in Project Notes indefinitely. Recover them here, including after
        restarting the app.
      </p>
      {deleted.length === 0 ? (
        <p>No deleted phases. Phases you delete from Roadmap or Archive will appear here.</p>
      ) : (
        <ul>
          {deleted.map((phase) => {
            const event = phase.deletion!.events.find(
              (event) => event.request.operationId === phase.deletion!.currentDeletionId,
            )!;
            return (
              <li key={phase.id}>
                <div>
                  <strong>{phase.title}</strong>
                  <p>
                    Deleted {new Date(event.timestamp).toLocaleString()} · Originally{" "}
                    {phase.archivedAt ? "archived" : "active"}
                  </p>
                </div>
                <button
                  className="notes-roadmap-new"
                  type="button"
                  disabled={disabled}
                  onClick={() => onRecover(phase)}
                  aria-label={`Recover phase: ${phase.title}`}
                >
                  Recover
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </NotesDisclosure>
  );
}
