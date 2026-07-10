import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NotesModal } from "./NotesModal";
import { NotesStatusBadge, notesStatusLabel } from "./NotesStatusBadge";
import { getUnfinishedNotesTaskCount, isNotesHandoffUnread } from "./notes-status";
import { canonicalProjectKey } from "./notes-storage";
import { useProjectNotes } from "./useProjectNotes";

interface Props {
  cwd: string | null;
}

export function ProjectNotes({ cwd }: Props): React.ReactElement {
  const [showNotes, setShowNotes] = useState(false);
  const [modalProjectIdentity, setModalProjectIdentity] = useState<string | null>(null);
  const activeProjectIdentity = cwd ? canonicalProjectKey(cwd) : null;
  const {
    value,
    onChange,
    document: notesDocument,
    changeCurrentFocus,
    createTask,
    editTask,
    toggleTask,
    moveTask,
    archiveTask,
    restoreTask,
    changeHandoff,
    markHandoffPresented,
  } = useProjectNotes(cwd);
  const status = {
    unfinishedCount: getUnfinishedNotesTaskCount(notesDocument),
    handoffUnread: isNotesHandoffUnread(notesDocument),
  };

  useEffect(() => {
    setShowNotes(false);
  }, [activeProjectIdentity]);

  return (
    <>
      <button
        className="btn btn-sm btn-ghost"
        title={notesStatusLabel(status)}
        aria-label={notesStatusLabel(status)}
        onClick={() => {
          setModalProjectIdentity(activeProjectIdentity);
          setShowNotes(true);
        }}
      >
        <NotesStatusBadge {...status} />
      </button>
      {showNotes &&
        modalProjectIdentity === activeProjectIdentity &&
        createPortal(
          <NotesModal
            value={value}
            onChange={onChange}
            currentFocus={notesDocument.currentFocus}
            tasks={notesDocument.tasks}
            handoff={notesDocument.handoff.text}
            handoffUpdatedAt={notesDocument.handoff.updatedAt}
            handoffUnread={status.handoffUnread}
            onChangeCurrentFocus={changeCurrentFocus}
            onCreateTask={createTask}
            onEditTask={editTask}
            onToggleTask={toggleTask}
            onMoveTask={moveTask}
            onArchiveTask={archiveTask}
            onRestoreTask={restoreTask}
            onChangeHandoff={changeHandoff}
            onHandoffPresented={markHandoffPresented}
            onClose={() => setShowNotes(false)}
          />,
          document.body,
        )}
    </>
  );
}
