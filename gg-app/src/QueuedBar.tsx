import { useEffect, useRef, useState } from "react";
import { theme } from "./theme";
import type { QueuedMessage } from "./agent";

/**
 * Strip above the composer showing user messages waiting to be injected into the
 * running turn, each cancellable.
 *
 * Two shapes, because the affordance should match the cost of getting it wrong:
 *  - ONE pending message: show its text with an `x` right there. Cancelling is
 *    unambiguous, so it takes a single click and no disclosure.
 *  - SEVERAL: show the count with a toggle. An `x` on a collapsed multi-item bar
 *    would be a guess about WHICH message it cancels, so the list has to be
 *    visible before any individual cancel is offered.
 *
 * Wording note: queued messages land at the next TURN boundary (the agent's
 * mid-loop steering hook), not after the run finishes. The copy says "next turn"
 * because "after this run" implies a wait until the final response, which is
 * wrong and makes users cancel and re-send needlessly.
 */

/** Exit-transition duration. Must match `.queued-bar.leaving` in App.css. */
const EXIT_MS = 220;

interface Props {
  messages: readonly QueuedMessage[];
  onCancel: (id: string) => void;
}

function preview(text: string): string {
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > 64 ? `${firstLine.slice(0, 63)}\u2026` : firstLine;
}

export function QueuedBar({ messages, onCancel }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const wasMultiple = useRef(false);
  // Messages held one beat past the real queue emptying, so the bar can play
  // its exit animation instead of vanishing the instant the agent consumes the
  // last item. Without this the element unmounts immediately and there is
  // nothing left on screen to animate.
  const [visible, setVisible] = useState<readonly QueuedMessage[]>(messages);
  const [leaving, setLeaving] = useState(false);

  // Collapse once the queue is no longer multi-item, so an expanded list does
  // not linger as an empty or single-row panel after messages drain.
  useEffect(() => {
    if (messages.length <= 1 && wasMultiple.current) setOpen(false);
    wasMultiple.current = messages.length > 1;
  }, [messages.length]);

  useEffect(() => {
    if (messages.length > 0) {
      setVisible(messages);
      setLeaving(false);
      return;
    }
    // Queue emptied: keep the last snapshot on screen, mark it leaving, and
    // unmount only after the exit transition has had time to run.
    setLeaving(true);
    const timer = setTimeout(() => {
      setVisible([]);
      setLeaving(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [messages]);

  if (visible.length === 0) return null;

  const single = visible.length === 1 ? visible[0]! : null;

  return (
    <div
      className={`queued-bar${leaving ? " leaving" : ""}`}
      style={{ borderColor: theme.border, color: theme.textMuted }}
    >
      <div className="queued-bar-row">
        <span className="queued-dot" style={{ background: theme.secondary }} />
        {single ? (
          <>
            <span className="queued-bar-text" title={single.text}>
              {preview(single.text)}
            </span>
            <span className="queued-bar-when">queued for the next turn</span>
            <button
              className="queued-cancel"
              style={{ color: theme.textDim }}
              title="Cancel this queued message"
              aria-label="Cancel queued message"
              onClick={() => onCancel(single.id)}
            >
              {"\u00d7"}
            </button>
          </>
        ) : (
          <>
            <span className="queued-bar-text">
              {visible.length} messages queued for the next turn
            </span>
            <button
              className="queued-toggle"
              style={{ color: theme.textDim }}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "hide" : "cancel\u2026"}
            </button>
          </>
        )}
      </div>

      {open && visible.length > 1 && (
        <div className="queued-list">
          {visible.map((m, i) => (
            <div key={m.id} className="queued-list-item">
              <span className="queued-index" style={{ color: theme.textDim }}>
                {i + 1}
              </span>
              <span className="queued-list-text" title={m.text}>
                {preview(m.text)}
              </span>
              <button
                className="queued-cancel"
                style={{ color: theme.textDim }}
                title="Cancel this queued message"
                aria-label={`Cancel queued message ${i + 1}`}
                onClick={() => onCancel(m.id)}
              >
                {"\u00d7"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
