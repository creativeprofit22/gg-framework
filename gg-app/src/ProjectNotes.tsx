import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, Database, HardDrive } from "lucide-react";
import { NotesModal } from "./NotesModal";
import type { OpenReferenceUrl } from "./notes-open-source";
import { NotesStatusBadge, notesStatusLabel } from "./NotesStatusBadge";
import {
  getActiveNotesPhaseCount,
  getActiveNotesReminderCount,
  getUnfinishedNotesTaskCount,
  isNotesHandoffUnread,
} from "./notes-status";
import { canonicalProjectKey } from "./notes-storage";
import { useProjectNotes, type UseProjectNotesResult } from "./useProjectNotes";
import type { NotesClient, NotesPromptSaveInput, NotesPromptSaveResult } from "./notes-types";
import type { KenPromptSaveDestination } from "./ken-prompt-actions";

interface Props {
  cwd: string | null;
  client: NotesClient;
  openSource?: OpenReferenceUrl;
}

interface NotesPersistenceStatus {
  tone: "project" | "local" | "warning" | "error";
  title: string;
  detail: string;
}

export interface ProjectNotesPromptActions {
  listDestinations(): KenPromptSaveDestination[];
  savePrompt(input: NotesPromptSaveInput): Promise<NotesPromptSaveResult>;
}

export const ProjectNotes = forwardRef<ProjectNotesPromptActions, Props>(function ProjectNotes(
  { cwd, client, openSource },
  ref,
): React.ReactElement {
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
    createPhase,
    editPhase,
    movePhase,
    changePhaseStatus,
    archivePhase,
    restorePhase,
    savePrompt,
    createReference,
    editReference,
    deleteReference,
    linkReferenceToPhase,
    unlinkReferenceFromPhase,
    changeHandoff,
    markHandoffPresented,
    diagnostics,
  } = useProjectNotes(cwd, { client });
  const status = {
    unfinishedCount: getUnfinishedNotesTaskCount(notesDocument),
    handoffUnread: isNotesHandoffUnread(notesDocument),
  };
  const activePhaseCount = getActiveNotesPhaseCount(notesDocument);
  const activeReminderCount = getActiveNotesReminderCount(notesDocument);

  useEffect(() => {
    setShowNotes(false);
  }, [activeProjectIdentity]);

  useImperativeHandle(
    ref,
    () => ({
      listDestinations: () =>
        notesDocument.phases
          .filter((phase) => phase.archivedAt === null)
          .sort((left, right) => left.order - right.order)
          .map((phase) => ({
            phaseId: phase.id,
            title: phase.title,
            sourcePrompt: phase.sourcePrompt,
          })),
      savePrompt,
    }),
    [notesDocument.phases, savePrompt],
  );

  return (
    <>
      <button
        className="btn btn-sm btn-ghost"
        title={notesStatusLabel(status)}
        aria-label={notesStatusLabel(status)}
        disabled={cwd === null}
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
            phases={notesDocument.phases}
            references={notesDocument.references}
            handoff={notesDocument.handoff.text}
            handoffUpdatedAt={notesDocument.handoff.updatedAt}
            handoffUnread={status.handoffUnread}
            activePhaseCount={activePhaseCount}
            activeReminderCount={activeReminderCount}
            persistenceStatus={<NotesPersistenceStatus {...notesPersistenceStatus(diagnostics)} />}
            onChangeCurrentFocus={changeCurrentFocus}
            onCreateTask={createTask}
            onEditTask={editTask}
            onToggleTask={toggleTask}
            onMoveTask={moveTask}
            onArchiveTask={archiveTask}
            onRestoreTask={restoreTask}
            onCreatePhase={createPhase}
            onEditPhase={editPhase}
            onMovePhase={movePhase}
            onChangePhaseStatus={changePhaseStatus}
            onArchivePhase={archivePhase}
            onRestorePhase={restorePhase}
            onCreateReference={createReference}
            onEditReference={editReference}
            onDeleteReference={deleteReference}
            onLinkReferenceToPhase={linkReferenceToPhase}
            onUnlinkReferenceFromPhase={unlinkReferenceFromPhase}
            openSource={openSource}
            onChangeHandoff={changeHandoff}
            onHandoffPresented={markHandoffPresented}
            onClose={() => setShowNotes(false)}
          />,
          document.body,
        )}
    </>
  );
});

function notesPersistenceStatus(
  diagnostics: UseProjectNotesResult["diagnostics"],
): NotesPersistenceStatus {
  const authority = diagnostics.authority;
  const fallback = authority.some((item) => item.kind === "fallback-storage");
  const browserWriteFailed =
    diagnostics.save?.v3.ok === false ||
    diagnostics.load?.diagnostics.some((item) => item.kind === "storage-write") === true;
  const browserMirrorFailed = diagnostics.save?.legacy.ok === false;

  if (browserWriteFailed) {
    return {
      tone: "error",
      title: "Local save failed",
      detail:
        "Your latest edits are still visible but may be lost when this app closes. Free space, then edit again to retry.",
    };
  }
  if (authority.some((item) => item.kind === "save-failed")) {
    return {
      tone: "error",
      title: "Changes aren’t saved",
      detail:
        "Your latest edits are still visible. Edit again to retry, and copy important Notes before closing this app.",
    };
  }
  if (browserMirrorFailed) {
    return {
      tone: "warning",
      title: "Local backup is out of date",
      detail: "Notes are saved in this app, but the compatibility copy could not be updated.",
    };
  }
  if (authority.some((item) => item.kind === "sidecar-corrupt")) {
    return {
      tone: "error",
      title: "Project Notes are unreadable",
      detail: fallback
        ? "Editing is using a local fallback. Copy important Notes, then repair or restore project storage before reopening this project."
        : "Copy important Notes before reopening this project or repairing project storage.",
    };
  }
  if (authority.some((item) => item.kind === "migration-refused")) {
    return {
      tone: "warning",
      title: "Local Notes need recovery",
      detail:
        "They could not be safely moved to project storage. Copy important Notes before resetting local app data or retrying.",
    };
  }
  if (authority.some((item) => item.kind === "migration-failed")) {
    return {
      tone: "warning",
      title: "Couldn’t move Notes to project storage",
      detail:
        "Editing is using a local fallback. Keep this app’s data, then reopen the project to retry.",
    };
  }
  if (fallback) {
    return {
      tone: "local",
      title: "Local fallback",
      detail:
        "Editing is available, but Notes are stored only in this app on this device. Reopen the project to retry project storage.",
    };
  }
  return {
    tone: "project",
    title: "Project storage",
    detail: "This project is the authoritative Notes store.",
  };
}

export function NotesPersistenceStatus({
  tone,
  title,
  detail,
}: NotesPersistenceStatus): React.ReactElement {
  const Icon =
    tone === "project"
      ? Database
      : tone === "local"
        ? HardDrive
        : tone === "warning"
          ? AlertTriangle
          : AlertCircle;
  const urgent = tone === "error";

  return (
    <div
      className={`notes-persistence notes-persistence-${tone}`}
      role={urgent ? "alert" : "status"}
      aria-label="Notes storage status"
      aria-live={urgent ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <Icon className="notes-persistence-icon" size={16} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}
