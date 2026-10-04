import { useEffect, useRef, useState } from "react";

interface Props {
  /**
   * Keep the pill shown regardless of hover — e.g. while a save is in flight, so
   * it doesn't vanish mid-click when the native dialog steals the pointer.
   */
  visible: boolean;
  /** True while the save dialog / write is in flight. */
  busy: boolean;
  onExport: () => void;
}

/**
 * "Export chat" pill, floated in the top-right of the transcript viewport
 * (the bottom edge belongs to the scroll-to-bottom controls).
 *
 * Hover-revealed rather than always-on: a permanent control in the corner of
 * the reading surface competes with the conversation for attention every
 * second the user is just reading. It fades + drops in on hover of the chat
 * area and back out on leave.
 *
 * The button tracks hover of its parent (the chat area) itself, so the reveal
 * re-renders only this pill — not the whole pane and its transcript.
 *
 * Always mounted (never conditionally rendered) so the exit animation can
 * actually play — unmounting on `visible: false` would make it vanish instantly.
 * `pointer-events: none` while hidden keeps it from swallowing clicks meant for
 * the transcript underneath.
 */
export function ExportChatButton({ visible: pinned, busy, onExport }: Props): React.ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    const area = buttonRef.current?.parentElement;
    if (!area) return;
    const enter = (): void => setHovered(true);
    const leave = (): void => setHovered(false);
    area.addEventListener("mouseenter", enter);
    area.addEventListener("mouseleave", leave);
    return () => {
      area.removeEventListener("mouseenter", enter);
      area.removeEventListener("mouseleave", leave);
    };
  }, []);
  const visible = pinned || hovered;

  return (
    <button
      ref={buttonRef}
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
        style={{ display: "block" }}
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span>{busy ? "Exporting\u2026" : "Export chat"}</span>
    </button>
  );
}
