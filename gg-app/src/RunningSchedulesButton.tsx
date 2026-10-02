import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "./theme";
import { nextRunLabel } from "./schedule-labels";
import { describeSchedule, type ParsedSchedule } from "./scheduleCommand";

/**
 * Footer indicator for active schedules — the schedule-side twin of
 * `BackgroundTasksButton`. Shows a running count; clicking opens an upward
 * popover listing each schedule with its prompt, cadence, next fire time, and a
 * stop button. Hidden by the caller when nothing is scheduled.
 *
 * The popover is portalled to `document.body` and positioned `fixed` for the
 * same reason as the background-tasks one: `.footer-left` both clips with
 * `overflow: hidden` and retains a non-`none` `transform` from its reveal
 * animation, which makes it the containing block for fixed descendants and
 * re-applies the clip. Portaling escapes both. See BackgroundTasksButton.
 */

export interface ActiveSchedule extends ParsedSchedule {
  id: string;
  /** Epoch ms of the next planned run. */
  nextRunAt: number;
  /** Runs completed so far, for the `2/10` progress read. */
  runsCompleted: number;
}

function shortPrompt(prompt: string): string {
  const firstLine = prompt.split("\n")[0] ?? prompt;
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}\u2026` : firstLine;
}

interface Props {
  schedules: readonly ActiveSchedule[];
  onStop: (id: string) => void;
}

export function RunningSchedulesButton({ schedules, onStop }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  // Only tick while the popover is open — a 1s interval behind a closed menu is
  // a pointless wakeup on a desktop app that may sit idle for hours.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Clamp into the viewport. Anchoring naively to the button's left edge
      // pushes the popover off-screen in a narrow window — and with it the stop
      // buttons, which would leave a schedule with no way to cancel it.
      const width = menuRef.current?.offsetWidth ?? 280;
      const margin = 8;
      const maxLeft = window.innerWidth - width - margin;
      const left = Math.max(margin, Math.min(rect.left, maxLeft));
      setPos({ left, bottom: window.innerHeight - rect.top + 8 });
    };
    place();
    // A second pass once the menu has real dimensions: the first runs before the
    // portal has been measured, so `width` is still the fallback.
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  // Close on Escape as well as outside-click, so the popover is dismissable
  // without the pointer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const count = schedules.length;

  return (
    <span className="bgtasks schedules" ref={ref}>
      <button
        ref={buttonRef}
        className="bgtasks-button"
        style={{ color: theme.secondary, borderColor: theme.border }}
        title="Active schedules — run only while this window is open"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {"\u25F7 "}
        {count} schedule{count === 1 ? "" : "s"}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="bgtasks-menu schedules-menu"
            style={{
              background: theme.surface2,
              borderColor: theme.border,
              left: pos?.left ?? 0,
              bottom: pos?.bottom ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {schedules.length === 0 && (
              <div className="bgtasks-empty" style={{ color: theme.textDim }}>
                no active schedules
              </div>
            )}
            {schedules.map((s) => (
              <div key={s.id} className="bgtasks-item schedules-item">
                <span className="bgtasks-dot" style={{ color: theme.secondary }}>
                  {"\u23FA"}
                </span>
                <span className="bgtasks-cmd" style={{ color: theme.text }} title={s.prompt}>
                  {shortPrompt(s.prompt)}
                </span>
                <span className="schedules-cadence" style={{ color: theme.textMuted }}>
                  {describeSchedule(s)}
                  {s.runCount !== null && ` \u00b7 ${s.runsCompleted}/${s.runCount}`}
                </span>
                <span className="bgtasks-status" style={{ color: theme.textDim }}>
                  {nextRunLabel(s.nextRunAt, now)}
                </span>
                <button
                  className="bgtasks-kill"
                  style={{ color: theme.error }}
                  title="Stop this schedule"
                  onClick={() => onStop(s.id)}
                >
                  stop
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
