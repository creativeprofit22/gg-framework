import type { RefObject } from "react";

interface Props {
  value: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onChange(value: string): void;
}

/**
 * Current focus is one line of text, but it wraps instead of truncating on narrow
 * windows: Enter is swallowed and pasted line breaks become spaces.
 */
export function NotesCurrentFocus({ value, inputRef, onChange }: Props): React.ReactElement {
  return (
    <div className="notes-field notes-current-focus">
      <label htmlFor="notes-current-focus">Current focus</label>
      <textarea
        ref={inputRef}
        id="notes-current-focus"
        rows={2}
        value={value}
        placeholder="What matters right now?"
        onChange={(event) => onChange(event.target.value.replace(/\r?\n/g, " "))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
        }}
        spellCheck={true}
      />
    </div>
  );
}
