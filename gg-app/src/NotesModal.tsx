import { useRef } from "react";
import { Modal } from "./Modal";
import { NotesHandoff } from "./NotesHandoff";
import { NotesTaskList } from "./NotesTaskList";
import type { NotesTask } from "./notes-types";

interface Props {
  value: string;
  onChange(value: string): void;
  tasks: NotesTask[];
  handoff: string;
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
  tasks,
  handoff,
  onCreateTask,
  onEditTask,
  onToggleTask,
  onArchiveTask,
  onChangeHandoff,
  onClose,
}: Props): React.ReactElement {
  const addInputRef = useRef<HTMLInputElement>(null);

  return (
    <Modal
      title="Your notes"
      onClose={onClose}
      className="notes-modal"
      initialFocusRef={addInputRef}
    >
      <div className="notes-body">
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
