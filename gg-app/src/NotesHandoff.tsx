import { useEffect, useRef } from "react";

interface Props {
  value: string;
  updatedAt: string | null;
  unread: boolean;
  onChange(value: string): void;
  onPresented(text: string, updatedAt: string): void;
}

export function NotesHandoff({
  value,
  updatedAt,
  unread,
  onChange,
  onPresented,
}: Props): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const presentedGenerationRef = useRef<{ text: string; updatedAt: string } | null>(null);

  useEffect(() => {
    const alreadyPresented =
      presentedGenerationRef.current?.text === value &&
      presentedGenerationRef.current.updatedAt === updatedAt;
    if (
      unread &&
      updatedAt !== null &&
      value.trim().length > 0 &&
      textareaRef.current?.value === value &&
      !alreadyPresented
    ) {
      onPresented(value, updatedAt);
      presentedGenerationRef.current = { text: value, updatedAt };
    }
  }, [onPresented, unread, updatedAt, value]);

  return (
    <div className="notes-field">
      <label htmlFor="notes-handoff">Handoff notes</label>
      <textarea
        ref={textareaRef}
        id="notes-handoff"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={true}
      />
    </div>
  );
}
