import { useEffect, useRef } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";

/**
 * Free-form notes modal. A single large, scrollable textarea the user can jot
 * anything into — there's no agent involvement. The body is owned here; the
 * caller persists the value (keyed per project) via `onChange`.
 */
interface Props {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

export function NotesModal({ value, onChange, onClose }: Props): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Drop the caret at the end of any existing notes when the modal opens.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <Modal title="Your notes" onClose={onClose} className="notes-modal">
      <textarea
        ref={ref}
        className="notes-input"
        aria-label="Your notes"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={true}
        style={{ background: theme.surface1, color: theme.text, borderColor: theme.border }}
      />
    </Modal>
  );
}
