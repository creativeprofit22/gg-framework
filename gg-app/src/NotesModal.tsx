import { useRef } from "react";
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
  onChangeCurrentFocus(value: string): void;
  onCreateTask(text: string): void;
  onEditTask(id: string, text: string): void;
  onToggleTask(id: string): void;
  onArchiveTask(id: string): void;
  onChangeHandoff(text: string): void;
  onClose(): void;
}

export function NotesModal({
  value,
  onChange,
  currentFocus,
  tasks,
  handoff,
  onChangeCurrentFocus,
  onCreateTask,
  onEditTask,
  onToggleTask,
  onArchiveTask,
  onChangeHandoff,
  onClose,
}: Props): React.ReactElement {
  const currentFocusInputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

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
            onArchiveTask={onArchiveTask}
          />
        </section>

        <section className="notes-section" aria-labelledby="notes-handoff-heading">
          <h2 id="notes-handoff-heading">Handoff</h2>
          <NotesHandoff value={handoff} onChange={onChangeHandoff} />
        </section>

        <section className="notes-section" aria-labelledby="notes-reference-heading">
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
      </div>
    </Modal>
  );
}
