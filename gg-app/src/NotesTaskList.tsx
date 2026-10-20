import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { NotesCompletedGroup } from "./NotesCompletedGroup";
import { NotesTaskRowActions } from "./NotesTaskRowActions";
import { groupNotesTasks, isCompletedNotesTask } from "./notes-status";
import type { NotesTask } from "./notes-types";

interface Props {
  tasks: NotesTask[];
  addInputRef: RefObject<HTMLInputElement | null>;
  onCreateTask(text: string): void;
  onEditTask(id: string, text: string): void;
  onToggleTask(id: string): void;
  onMoveTask(id: string, direction: "up" | "down"): void;
  onArchiveTask(id: string): void;
  /** Session key for the Completed disclosure; null keeps it in memory only. */
  disclosureKey: string | null;
}

type Direction = "up" | "down";
type FocusTarget = "check" | "actions";

/** Where focus goes after an action reorders, regroups, or re-renders a row. */
type FocusRequest = { taskId: string; target: FocusTarget } | { addInput: true };

export function NotesTaskList({
  tasks,
  addInputRef,
  onCreateTask,
  onEditTask,
  onToggleTask,
  onMoveTask,
  onArchiveTask,
  disclosureKey,
}: Props): React.ReactElement {
  const groups = useMemo(() => groupNotesTasks(tasks), [tasks]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const checkboxRefs = useRef(new Map<string, HTMLElement>());
  const triggerRefs = useRef(new Map<string, HTMLElement>());

  // Re-runs when the groups change, so a moved or reopened row is focused once it lands
  // in its new place. A target that is not shown yet keeps the request waiting.
  useEffect(() => {
    if (focusRequest === null) return;
    if ("addInput" in focusRequest) {
      addInputRef.current?.focus();
      setFocusRequest(null);
      return;
    }
    const refs = focusRequest.target === "check" ? checkboxRefs : triggerRefs;
    const element = refs.current.get(focusRequest.taskId);
    if (!element || !element.isConnected || element.closest("[hidden]") !== null) return;
    element.focus();
    setFocusRequest(null);
  }, [addInputRef, focusRequest, groups]);

  const registerElement = (target: FocusTarget, id: string, element: HTMLElement | null): void => {
    const refs = target === "check" ? checkboxRefs.current : triggerRefs.current;
    if (element) refs.set(id, element);
    else refs.delete(id);
  };

  const addTask = (): void => {
    const text = draft.trim();
    if (!text) return;
    onCreateTask(text);
    setDraft("");
    setAnnouncement(`Created task: ${text}`);
    addInputRef.current?.focus();
  };

  const startEdit = (task: NotesTask): void => {
    setEditingId(task.id);
    setEditText(task.text);
  };

  const finishEdit = (task: NotesTask, save: boolean): void => {
    const text = editText.trim();
    if (save && text) {
      onEditTask(task.id, text);
      if (text !== task.text) setAnnouncement(`Edited task: ${text}`);
    }
    setEditingId(null);
    setFocusRequest({ taskId: task.id, target: "actions" });
  };

  const archiveTask = (task: NotesTask): void => {
    onArchiveTask(task.id);
    setAnnouncement(`Archived task: ${task.text}`);
    setFocusRequest({ addInput: true });
  };

  /** The one reorder path for the menu and the Alt+Arrow shortcut; only open rows move. */
  const moveTask = (task: NotesTask, direction: Direction, focusTarget: FocusTarget): void => {
    const index = groups.open.findIndex((item) => item.id === task.id);
    if (index < 0) return;
    const atBound = direction === "up" ? index === 0 : index === groups.open.length - 1;
    if (atBound) {
      setAnnouncement(`Already ${direction === "up" ? "first" : "last"}: ${task.text}`);
      return;
    }
    onMoveTask(task.id, direction);
    setAnnouncement(`Moved task ${direction}: ${task.text}`);
    setFocusRequest({ taskId: task.id, target: focusTarget });
  };

  const moveShortcut =
    (task: NotesTask, focusTarget: FocusTarget) =>
    (event: React.KeyboardEvent<HTMLElement>): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      moveTask(task, event.key === "ArrowUp" ? "up" : "down", focusTarget);
    };

  const toggleTask = (task: NotesTask): void => {
    const completed = isCompletedNotesTask(task);
    onToggleTask(task.id);
    setAnnouncement(`${completed ? "Reopened" : "Completed"} task: ${task.text}`);
    if (completed) {
      setFocusRequest({ taskId: task.id, target: "check" });
      return;
    }
    // The completed row leaves the open list; keep focus on an open neighbour.
    const index = groups.open.findIndex((item) => item.id === task.id);
    const neighbour = groups.open[index + 1] ?? groups.open[index - 1];
    setFocusRequest(neighbour ? { taskId: neighbour.id, target: "check" } : { addInput: true });
  };

  /** `index` is the row's position in the open list; completed rows (null) have no Move. */
  const renderTaskRow = (task: NotesTask, index: number | null): React.ReactElement => {
    const completed = isCompletedNotesTask(task);
    const movable = index !== null;
    return (
      <div className={`notes-task-row${completed ? " is-done" : ""}`} key={task.id}>
        {editingId === task.id ? (
          <form
            className="notes-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              finishEdit(task, true);
            }}
          >
            <label htmlFor={`notes-edit-${task.id}`}>Edit task: {task.text}</label>
            <input
              id={`notes-edit-${task.id}`}
              value={editText}
              autoFocus
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                finishEdit(task, false);
              }}
            />
            <div className="notes-task-actions">
              <button type="submit" disabled={!editText.trim()}>
                Save
              </button>
              <button type="button" onClick={() => finishEdit(task, false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <label className="notes-task-check">
              <input
                ref={(element) => registerElement("check", task.id, element)}
                type="checkbox"
                checked={completed}
                aria-label={`${completed ? "Reopen" : "Complete"} task: ${task.text}`}
                aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onKeyDown={movable ? moveShortcut(task, "check") : undefined}
                onChange={() => toggleTask(task)}
              />
              <span>{task.text}</span>
            </label>
            <NotesTaskRowActions
              taskText={task.text}
              move={
                movable
                  ? { canMoveUp: index > 0, canMoveDown: index < groups.open.length - 1 }
                  : null
              }
              triggerRef={(element) => registerElement("actions", task.id, element)}
              onTriggerKeyDown={movable ? moveShortcut(task, "actions") : undefined}
              onMove={(direction) => moveTask(task, direction, "actions")}
              onEdit={() => startEdit(task)}
              onArchive={() => archiveTask(task)}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <form
        className="notes-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          addTask();
        }}
      >
        <label htmlFor="notes-add-task">New task</label>
        <div className="notes-add-controls">
          <input
            ref={addInputRef}
            id="notes-add-task"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Escape first clears a typed task; only an empty field lets it close Notes.
              if (event.key !== "Escape" || !draft) return;
              event.preventDefault();
              event.stopPropagation();
              setDraft("");
            }}
          />
          <button
            type="submit"
            className="notes-btn-quiet notes-add-submit"
            title="Add task"
            aria-label="Add task"
            disabled={!draft.trim()}
          >
            <PlusIcon size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </form>

      <div className="notes-task-list">
        {groups.open.length === 0 && (
          <p className="notes-empty">
            {groups.completed.length === 0 ? "No active tasks." : "All tasks are done."}
          </p>
        )}
        {groups.open.map((task, index) => renderTaskRow(task, index))}
      </div>
      <NotesCompletedGroup
        id="notes-completed-tasks"
        count={groups.completed.length}
        storageKey={disclosureKey ? `${disclosureKey}:completed-tasks` : null}
      >
        <div className="notes-task-list">
          {groups.completed.map((task) => renderTaskRow(task, null))}
        </div>
      </NotesCompletedGroup>
      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  );
}
