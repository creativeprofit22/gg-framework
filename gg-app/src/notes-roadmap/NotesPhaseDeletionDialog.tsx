import { Modal } from "../Modal";
import type { PhaseDeletionController } from "./usePhaseDeletion";

export function NotesPhaseDeletionDialog({ controller }: { controller: PhaseDeletionController }) {
  const { target, pending, preparing, error, request, uncertain } = controller;
  if (!target) return null;
  const deleting = target.action === "delete";
  return <Modal title={`${deleting ? "Delete" : "Recover"} “${target.phase.title}”?`}
    className="notes-phase-deletion-dialog" onClose={controller.close} canClose={!pending}>
    <div className="notes-phase-deletion-body">
      <p>{deleting
        ? "This removes the phase from Roadmap and Archive. You can recover it from Deleted phases. Its history stays in Project Notes. Conversations, references and project files are not deleted."
        : "Recovery returns the phase to its original active or archived location. Completed phases keep Done as history. Other phases return as not-started and need fresh execution and plan approval. Past sessions and reminders are not resumed."}</p>
      <p>Deleted phases are kept indefinitely. There is no permanent purge.</p>
      {preparing && <p role="status">Saving pending edits…</p>}
      {pending && <p role="status">{deleting ? "Deleting…" : "Recovering…"} The submitted write cannot be cancelled here.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="notes-phase-deletion-actions">
        <button className="notes-roadmap-new" type="button" data-modal-initial-focus disabled={pending} onClick={controller.close}>
          {uncertain ? "Close" : "Cancel"}
        </button>
        {!request && !preparing && <button className="notes-roadmap-new" type="button" onClick={() => void controller.begin(target.phase, target.action)}>Review latest phase</button>}
        {request && <button className="notes-roadmap-new" type="button" disabled={pending || preparing} onClick={() => void controller.confirm()}>
          {pending ? deleting ? "Deleting…" : "Recovering…" : uncertain ? "Retry same request" : deleting ? "Delete phase" : "Recover phase"}
        </button>}
      </div>
    </div>
  </Modal>;
}
