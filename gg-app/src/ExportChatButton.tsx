import { theme } from "./theme";

interface Props {
  /** True while the transcript area is hovered — drives the fade/slide in. */
  visible: boolean;
  /** True while the save dialog / write is in flight. */
  busy: boolean;
  onExport: () => void;
}

/**
 * "Export chat" pill, floated in the bottom-right of the transcript viewport.
 *
 * Hover-revealed rather than always-on: a permanent control in the corner of
 * the reading surface competes with the conversation for attention every
 * second the user is just reading. It fades + lifts in on hover of the chat
 * area and back out on leave.
 *
 * Always mounted (never conditionally rendered) so the exit animation can
 * actually play — unmounting on `visible: false` would make it vanish instantly.
 * `pointer-events: none` while hidden keeps it from swallowing clicks meant for
 * the transcript underneath.
 */
export function ExportChatButton({ visible, busy, onExport }: Props): React.ReactElement {
  return (
    <button
      className={`export-chat${visible ? " visible" : ""}`}
      onClick={onExport}
      disabled={busy}
      // Hidden from the a11y tree while faded out — a screen reader shouldn't
      // find a control the pointer can't reach either.
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      title="Save this conversation as a Markdown file"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ display: "block", color: theme.textMuted }}
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span>{busy ? "Exporting\u2026" : "Export chat"}</span>
    </button>
  );
}
