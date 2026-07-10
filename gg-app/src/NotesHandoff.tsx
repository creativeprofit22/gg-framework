interface Props {
  value: string;
  onChange(value: string): void;
}

export function NotesHandoff({ value, onChange }: Props): React.ReactElement {
  return (
    <div className="notes-field">
      <label htmlFor="notes-handoff">Handoff notes</label>
      <textarea
        id="notes-handoff"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={true}
      />
    </div>
  );
}
