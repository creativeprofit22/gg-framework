import { theme } from "./theme";
import { Modal } from "./Modal";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Centered yes/no confirmation built on the shared Modal. Presentational — the
 * caller owns what "confirm" does. Used for destructive/irreversible actions
 * like starting a new session (which clears the current transcript).
 */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onClose,
}: Props): React.ReactElement {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-hint" style={{ color: theme.textSecondary }}>
        {message}
      </div>
      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          {cancelLabel}
        </button>
        <button className="modal-btn primary" disabled={busy} onClick={onConfirm}>
          {busy ? "\u2026" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
