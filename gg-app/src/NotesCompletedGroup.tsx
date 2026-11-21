import type { ReactNode } from "react";
import { NotesDisclosure, useSessionDisclosure } from "./NotesDisclosure";

export interface NotesCompletedGroupProps {
  /** DOM id of the collapsible region; the toggle points at it. */
  id: string;
  count: number;
  storageKey: string | null;
  forceOpen?: boolean;
  children: ReactNode;
}

/** Collapsed "Completed (n)" disclosure. Renders nothing when there is nothing completed. */
export function NotesCompletedGroup({
  id,
  count,
  storageKey,
  forceOpen = false,
  children,
}: NotesCompletedGroupProps) {
  const [expanded, toggle] = useSessionDisclosure(storageKey, forceOpen);
  if (count === 0) return null;
  return (
    <NotesDisclosure
      id={id}
      className="notes-completed-group"
      label={`Completed (${count})`}
      expanded={expanded}
      onToggle={toggle}
    >
      {children}
    </NotesDisclosure>
  );
}
