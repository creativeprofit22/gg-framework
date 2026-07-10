interface Props {
  unfinishedCount: number;
  handoffUnread: boolean;
}

export function notesStatusLabel({ unfinishedCount, handoffUnread }: Props): string {
  const details: string[] = [];
  if (unfinishedCount > 0) {
    details.push(`${unfinishedCount} unfinished ${unfinishedCount === 1 ? "task" : "tasks"}`);
  }
  if (handoffUnread) details.push("unread Handoff");
  return details.length === 0 ? "Notes" : `Notes, ${details.join(", ")}`;
}

export function NotesStatusBadge({ unfinishedCount, handoffUnread }: Props): React.ReactElement {
  return (
    <span className="notes-status-badge" aria-hidden="true">
      <span>Notes{unfinishedCount > 0 ? ` (${unfinishedCount})` : ""}</span>
      {handoffUnread && <span className="notes-status-dot" />}
    </span>
  );
}
