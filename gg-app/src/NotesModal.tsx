import { useRef, useState } from "react";
import { Modal } from "./Modal";
import { NotesCurrentFocus } from "./NotesCurrentFocus";
import { NotesHandoff } from "./NotesHandoff";
import { NotesTaskList } from "./NotesTaskList";
import type { NotesTask } from "./notes-types";

interface Props {
  value: string;
  onChange(value: string): void;
  currentFocus: string;
  tasks: NotesTask[];
  handoff: string;
  handoffUpdatedAt: string | null;
  handoffUnread: boolean;
  onChangeCurrentFocus(value: string): void;
  onCreateTask(text: string): void;
  onEditTask(id: string, text: string): void;
  onToggleTask(id: string): void;
  onMoveTask(id: string, direction: "up" | "down"): void;
  onArchiveTask(id: string): void;
  onRestoreTask(id: string): void;
  onChangeHandoff(text: string): void;
  onHandoffPresented(text: string, updatedAt: string): void;
  onClose(): void;
}

export function NotesModal({
  value,
  onChange,
  currentFocus,
  tasks,
  handoff,
  handoffUpdatedAt,
  handoffUnread,
  onChangeCurrentFocus,
  onCreateTask,
  onEditTask,
  onToggleTask,
  onMoveTask,
  onArchiveTask,
  onRestoreTask,
  onChangeHandoff,
  onHandoffPresented,
  onClose,
}: Props): React.ReactElement {
  const currentFocusInputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [showArchived, setShowArchived] = useState(false);
  const archivedTasks = tasks.filter((task) => task.archivedAt !== null);

  return (
    <Modal
      title="Your notes"
      onClose={onClose}
      className="notes-modal"
      initialFocusRef={currentFocusInputRef}
    >
      <div className="notes-body">
        <section className="notes-section" aria-labelledby="notes-now-heading">
          <h2 id="notes-now-heading">Now</h2>
          <NotesCurrentFocus
            value={currentFocus}
            inputRef={currentFocusInputRef}
            onChange={onChangeCurrentFocus}
          />
        </section>

        <section className="notes-section" aria-labelledby="notes-next-heading">
          <h2 id="notes-next-heading">Next</h2>
          <NotesTaskList
            tasks={tasks}
            addInputRef={addInputRef}
            onCreateTask={onCreateTask}
            onEditTask={onEditTask}
            onToggleTask={onToggleTask}
            onMoveTask={onMoveTask}
            onArchiveTask={onArchiveTask}
          />
        </section>

        <section className="notes-section" aria-labelledby="notes-handoff-heading">
          <h2 id="notes-handoff-heading">Handoff</h2>
          <NotesHandoff
            value={handoff}
            updatedAt={handoffUpdatedAt}
            unread={handoffUnread}
            onChange={onChangeHandoff}
            onPresented={onHandoffPresented}
          />
        </section>

        <section
          className="notes-section notes-reference-section"
          aria-labelledby="notes-reference-heading"
        >
          <h2 id="notes-reference-heading">Reference</h2>
          <div className="notes-field">
            <label htmlFor="notes-reference">Reference notes</label>
            <textarea
              id="notes-reference"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              spellCheck={true}
            />
          </div>
        </section>

        <section className="notes-section notes-archive" aria-labelledby="notes-archive-heading">
          <h2 id="notes-archive-heading">Done / Archive</h2>
          <button
            type="button"
            className="notes-archive-toggle"
            aria-expanded={showArchived}
            aria-controls="notes-archive-list"
            onClick={() => setShowArchived((visible) => !visible)}
          >
            {showArchived ? "Hide" : "Show"} archived tasks ({archivedTasks.length})
          </button>
          <div id="notes-archive-list" className="notes-task-list" hidden={!showArchived}>
            {showArchived && (
              <>
                {archivedTasks.length === 0 && <p className="notes-empty">No archived tasks.</p>}
                {archivedTasks.map((task) => (
                  <div className="notes-task-row notes-archived-task" key={task.id}>
                    <span>{task.text}</span>
                    <div className="notes-task-actions">
                      <button
                        type="button"
                        aria-label={`Restore task: ${task.text}`}
                        onClick={() => onRestoreTask(task.id)}
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}
