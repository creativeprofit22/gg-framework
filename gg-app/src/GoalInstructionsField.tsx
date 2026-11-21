import { useId } from "react";
import { theme } from "./theme";

/** Mirrors the sidecar's limit in ggcoder `core/goals-store.ts`. */
export const GOAL_INSTRUCTIONS_MAX = 4000;

interface Props {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /**
   * Grey text shown while the field is empty. New goal gives an example;
   * Goal settings says plainly there are none yet, so an example is never
   * mistaken for instructions already saved.
   */
  placeholder?: string;
}

/**
 * A goal's standing instructions: rules GG Goals and its workers follow for
 * the whole goal ("Keep old URLs working", "Use British spelling"). Shared by New
 * goal and Goal settings.
 */
export function GoalInstructionsField({
  value,
  onChange,
  disabled = false,
  placeholder = "Keep the current design. Ask before adding dependencies.",
}: Props): React.ReactElement {
  const id = useId();
  const hintId = useId();
  return (
    <>
      <label className="modal-label" htmlFor={id}>
        Instructions{" "}
        <span className="goal-optional" style={{ color: theme.textDim }}>
          (optional)
        </span>
      </label>
      <textarea
        id={id}
        className="modal-input goal-textarea"
        style={{ color: theme.text, background: theme.inputBackground }}
        value={value}
        maxLength={GOAL_INSTRUCTIONS_MAX}
        rows={3}
        disabled={disabled}
        aria-describedby={hintId}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <div id={hintId} className="modal-hint" style={{ color: theme.textDim }}>
        Rules for the whole goal. GG Goals and its workers follow them throughout.
      </div>
    </>
  );
}
