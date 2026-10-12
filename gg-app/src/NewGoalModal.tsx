import { useId, useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { createGoal, type GoalSummary } from "./agent";
import { GoalContextPicker, type ContextPick } from "./GoalContextPicker";
import { GoalInstructionsField } from "./GoalInstructionsField";

/** Mirrors the sidecar's limits in ggcoder `core/goals-store.ts`. */
const NAME_MAX = 15;
const GOAL_MAX = 2000;

interface Props {
  /** Point this pane at the new goal (pane-scoped; see GoalPicker). */
  openGoal: (cwd: string) => Promise<unknown>;
  onClose: () => void;
  /** Called after the goal exists and this window is pointed at it. */
  onCreated: (goal: GoalSummary) => void;
}

/**
 * Create a Goal: a name, the objective in a sentence or two, and optional
 * folders/files for context and standing instructions. Creating it opens the
 * goal, where the coordinator replies on its own.
 */
export function NewGoalModal({ openGoal, onClose, onCreated }: Props): React.ReactElement {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState<ContextPick[]>([]);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const nameCountId = useId();
  const goalId = useId();
  const canCreate = name.trim().length > 0 && goal.trim().length > 0 && !busy;

  async function create(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createGoal({
        name: name.trim(),
        goal: goal.trim(),
        context: context.map((c) => c.path),
        instructions: instructions.trim(),
      });
      // A goal opens as its own coordinator session in a fresh conversation.
      await openGoal(created.path);
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="New goal" onClose={onClose} className="goal-modal">
      {/* The fields scroll on their own in a short window; the buttons below
          stay put on the modal's glass. */}
      <div className="goal-modal-body">
        <div className="goal-name-head">
          <label className="modal-label" htmlFor={nameId}>
            Name
          </label>
          <span id={nameCountId} className="goal-name-count" style={{ color: theme.textDim }}>
            {`${name.length}/${NAME_MAX}`}
          </span>
        </div>
        <input
          id={nameId}
          className="modal-input"
          style={{ color: theme.text, background: theme.inputBackground }}
          value={name}
          maxLength={NAME_MAX}
          aria-describedby={nameCountId}
          placeholder="Checkout speed"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />

        <label className="modal-label" htmlFor={goalId}>
          Goal
        </label>
        <textarea
          id={goalId}
          className="modal-input goal-textarea"
          style={{ color: theme.text, background: theme.inputBackground }}
          value={goal}
          maxLength={GOAL_MAX}
          rows={3}
          placeholder="Get checkout loading under one second on mobile"
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
          }}
        />

        <GoalContextPicker
          value={context}
          onChange={setContext}
          disabled={busy}
          onError={setError}
        />

        <GoalInstructionsField value={instructions} onChange={setInstructions} disabled={busy} />
      </div>
      {error && (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
        <button className="modal-btn primary" disabled={!canCreate} onClick={() => void create()}>
          {busy ? "Creating\u2026" : "Create goal"}
        </button>
      </div>
    </Modal>
  );
}
