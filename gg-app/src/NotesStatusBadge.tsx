import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleHalfIcon,
  EyeIcon,
  FileTextIcon,
  HourglassIcon,
  NotePencilIcon,
  ProhibitIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { NOTES_PHASE_STATUS_PRESENTATION } from "./notes-lifecycle-presentation";
import type { NotesPhaseStatus } from "./notes-types";

/** One icon per stored phase status; the word and tone come from NOTES_PHASE_STATUS_PRESENTATION. */
const NOTES_PHASE_STATUS_ICON = {
  "not-started": CircleDashedIcon,
  planning: NotePencilIcon,
  "waiting-for-approval": HourglassIcon,
  "in-progress": CircleHalfIcon,
  review: EyeIcon,
  done: CheckCircleIcon,
  "needs-attention": WarningCircleIcon,
  cancelled: ProhibitIcon,
} as const satisfies Record<NotesPhaseStatus, Icon>;

/** Only these statuses earn a soft tinted background; every other status is icon + text colour. */
const NOTES_PHASE_STATUS_TINTED = {
  "not-started": false,
  planning: false,
  "waiting-for-approval": false,
  "in-progress": false,
  review: false,
  done: true,
  "needs-attention": true,
  cancelled: false,
} as const satisfies Record<NotesPhaseStatus, boolean>;

export function NotesPhaseStatusBadge({
  status,
}: {
  status: NotesPhaseStatus;
}): React.ReactElement {
  const { label, tone } = NOTES_PHASE_STATUS_PRESENTATION[status];
  const StatusIcon = NOTES_PHASE_STATUS_ICON[status];
  const tinted = NOTES_PHASE_STATUS_TINTED[status];
  return (
    <span className={`notes-phase-status is-tone-${tone}${tinted ? " is-tinted" : ""}`}>
      <StatusIcon size={14} weight={tinted ? "fill" : "bold"} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function NotesSavedPromptIndicator(): React.ReactElement {
  return (
    <span
      className="notes-phase-saved-prompt-marker"
      role="img"
      aria-label="Saved prompt"
      title="Saved prompt"
    >
      <FileTextIcon size={14} aria-hidden="true" />
    </span>
  );
}

interface Props {
  unfinishedCount: number;
  dueReminderCount: number;
  savedPromptCount: number;
  handoffUnread: boolean;
}

export function notesStatusLabel({
  unfinishedCount,
  dueReminderCount,
  savedPromptCount,
  handoffUnread,
}: Props): string {
  const details: string[] = [];
  if (unfinishedCount > 0) {
    details.push(`${unfinishedCount} unfinished ${unfinishedCount === 1 ? "task" : "tasks"}`);
  }
  if (dueReminderCount > 0) {
    details.push(`${dueReminderCount} ${dueReminderCount === 1 ? "reminder" : "reminders"} due`);
  }
  if (savedPromptCount > 0) {
    details.push(`${savedPromptCount} saved ${savedPromptCount === 1 ? "prompt" : "prompts"}`);
  }
  if (handoffUnread) details.push("unread Handoff");
  return details.length === 0 ? "Notes" : `Notes, ${details.join(", ")}`;
}

export function NotesStatusBadge({
  unfinishedCount,
  dueReminderCount,
  savedPromptCount,
  handoffUnread,
}: Props): React.ReactElement {
  const actionCount = unfinishedCount + dueReminderCount;
  return (
    <span className="notes-status-badge" aria-hidden="true">
      <span>Notes{actionCount > 0 ? ` (${actionCount})` : ""}</span>
      {savedPromptCount > 0 && (
        <span className="notes-status-saved-prompt">
          · {savedPromptCount} {savedPromptCount === 1 ? "prompt" : "prompts"}
        </span>
      )}
      {(dueReminderCount > 0 || handoffUnread) && <span className="notes-status-dot" />}
    </span>
  );
}
