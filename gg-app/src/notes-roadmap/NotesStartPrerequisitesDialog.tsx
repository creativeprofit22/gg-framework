import type { ReactElement } from "react";
import { Modal } from "../Modal";
import { notesPhaseStatusLabel } from "../notes-lifecycle-presentation";
import type { StartPrerequisiteRequest } from "./useStartPrerequisiteGate";

export function NotesStartPrerequisitesDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: StartPrerequisiteRequest | null;
  onCancel(): void;
  onConfirm(): void;
}): ReactElement | null {
  if (!request) return null;
  return (
    <Modal
      title={`Start “${request.phaseTitle}” before its prerequisites are Done?`}
      className="notes-start-prerequisites-dialog"
      onClose={onCancel}
    >
      <div className="notes-start-prerequisites-body">
        {request.stale && (
          <p role="status">These prerequisites changed since you confirmed. Review them again.</p>
        )}
        <ul aria-label="Unfinished prerequisites">
          {request.prerequisites.map((prerequisite) => (
            <li key={prerequisite.id}>
              “{prerequisite.title}” is {notesPhaseStatusLabel(prerequisite.status)}.
            </li>
          ))}
        </ul>
        <p>You won’t be asked again while this run of the phase continues.</p>
        <div className="notes-start-prerequisites-actions">
          <button
            className="notes-roadmap-new"
            type="button"
            data-modal-initial-focus
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="notes-roadmap-new notes-btn-primary" type="button" onClick={onConfirm}>
            Start anyway
          </button>
        </div>
      </div>
    </Modal>
  );
}
