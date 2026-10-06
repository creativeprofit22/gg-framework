import { useEffect, useState, type ComponentProps } from "react";
import { Modal } from "./Modal";
import type { NotesModal } from "./NotesModal";
import { loadedNotesModalContent, loadNotesModalContent } from "./notes-modal-loader";

/** Mount only at the Notes open boundary, never around the workspace or composer. */
export function DeferredNotesModal(props: ComponentProps<typeof NotesModal>): React.ReactElement {
  const [Content, setContent] = useState(loadedNotesModalContent);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (Content) return;
    let current = true;
    void loadNotesModalContent().then(
      (loaded) => {
        if (current) setContent(() => loaded);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    // Closing or switching projects must not reopen the dialog or apply stale props.
    return () => {
      current = false;
    };
  }, [Content, attempt]);

  return (
    <Modal title="Your notes" onClose={props.onClose} className="notes-modal">
      {Content ? (
        <Content {...props} />
      ) : (
        <div className="notes-shell">
          <div className="notes-shell-status">{props.persistenceStatus}</div>
          <div className="notes-panel-rail">
            {failed ? (
              <>
                <p role="alert">
                  Couldn’t load Notes. Try again, or close and reopen the app if it keeps failing.
                </p>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={(event) => {
                    event.currentTarget.closest<HTMLElement>("[role='dialog']")?.focus();
                    setFailed(false);
                    setAttempt((value) => value + 1);
                  }}
                >
                  Try again
                </button>
              </>
            ) : (
              <p role="status">Loading Notes…</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
