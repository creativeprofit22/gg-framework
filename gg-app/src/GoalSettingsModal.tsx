import { useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { updateGoal, type GoalContextItem } from "./agent";
import { GoalContextPicker, type ContextPick } from "./GoalContextPicker";
import { GoalInstructionsField } from "./GoalInstructionsField";

interface Props {
  /** The goal's current context and instructions, as the sidecar reports them. */
  context: readonly GoalContextItem[];
  instructions: string;
  /** The goal is working: changes wait until it's paused or idle. */
  busy: boolean;
  onClose: () => void;
  /** After a successful save, with what the sidecar stored. */
  onSaved: (next: { context: GoalContextItem[]; instructions: string }) => void;
}

/**
 * Change a goal after creating it: its standing instructions and its attached
 * folders and files. GG Goals picks the change up in the goal's next session.
 */
export function GoalSettingsModal({
  context: initialContext,
  instructions: initialInstructions,
  busy,
  onClose,
  onSaved,
}: Props): React.ReactElement {
  const [context, setContext] = useState<ContextPick[]>(() =>
    initialContext.map((c) => ({ path: c.path, kind: c.kind })),
  );
  const [instructions, setInstructions] = useState(initialInstructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed =
    instructions.trim() !== initialInstructions.trim() ||
    context.length !== initialContext.length ||
    context.some((c, i) => c.path !== initialContext[i]?.path);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const next = await updateGoal({
        context: context.map((c) => c.path),
        instructions: instructions.trim(),
      });
      onSaved(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title="Goal settings" onClose={onClose} className="goal-modal">
      <div className="goal-modal-body">
        <GoalInstructionsField
          placeholder="None yet. Add rules for the whole goal."
          value={instructions}
          onChange={setInstructions}
          disabled={saving || busy}
        />
        <GoalContextPicker
          value={context}
          onChange={setContext}
          disabled={saving || busy}
          onError={setError}
        />
        <div className="modal-hint" style={{ color: theme.textDim }}>
          {busy
            ? "The goal is working. Pause it to change its settings."
            : "GG Goals picks up the change on its next step."}
        </div>
      </div>
      {error && (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
        <button
          className="modal-btn primary"
          disabled={!changed || saving || busy}
          onClick={() => void save()}
        >
          {saving ? "Saving\u2026" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
