import { isNotesPhaseDeleted, type NotesPhase } from "@kenkaiiii/gg-core/project-notes";

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
  return (
    <details className="notes-deleted-phases">
      <summary data-phase-focus-fallback>Deleted phases ({deleted.length})</summary>
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
    </details>
  );
}
