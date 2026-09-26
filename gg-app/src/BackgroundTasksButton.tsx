import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "./theme";
import { killTask, type BackgroundTask } from "./agent";
import { formatBackgroundTaskStatus, isBackgroundTaskRunning } from "./background-task-status";

/**
 * Footer indicator for background tasks (bash run_in_background) — mirrors the
 * ggcoder TUI's BackgroundTasksBar. Shows a running count; clicking opens an
 * upward popover listing each task with its command, status, and a kill button.
 * Hidden by the caller when nothing is running.
 *
 * The popover is rendered through a portal to `document.body` and positioned
 * `fixed` (anchored to the button's rect). This is required because the footer's
 * `.footer-left` both clips with `overflow: hidden` AND retains a non-`none`
 * `transform` from its reveal animation (fill-mode `both`) — a transformed
 * ancestor becomes the containing block for fixed descendants and re-applies its
 * overflow clipping, so an in-tree popover (absolute OR fixed) gets swallowed.
 * Portaling out of the footer escapes both.
 */
function shortCommand(cmd: string): string {
  const firstLine = cmd.split("\n")[0] ?? cmd;
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}\u2026` : firstLine;
}

export function BackgroundTasksButton({ tasks }: { tasks: BackgroundTask[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Fixed-position coordinates for the popover, computed from the button rect so
  // it escapes the footer's `overflow: hidden`.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
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

  const runningCount = tasks.filter(isBackgroundTaskRunning).length;
  // Spinner color while anything runs; muted once all have exited.
  const accent = runningCount > 0 ? theme.warning : theme.textMuted;

  return (
    <span className="bgtasks" ref={ref}>
      <button
        ref={buttonRef}
        className="bgtasks-button"
        style={{ color: accent, borderColor: theme.border }}
        title="Background tasks"
        onClick={() => setOpen((o) => !o)}
      >
        {"\u2699 "}
        {runningCount} background task{runningCount === 1 ? "" : "s"}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="bgtasks-menu"
            style={{
              background: theme.surface2,
              borderColor: theme.border,
              left: pos?.left ?? 0,
              bottom: pos?.bottom ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {tasks.length === 0 && (
              <div className="bgtasks-empty" style={{ color: theme.textDim }}>
                no background tasks
              </div>
            )}
            {tasks.map((t) => {
              const running = isBackgroundTaskRunning(t);
              return (
                <div key={t.id} className="bgtasks-item">
                  <span
                    className="bgtasks-dot"
                    style={{ color: running ? theme.warning : theme.textDim }}
                  >
                    {"\u23FA"}
                  </span>
                  <span className="bgtasks-cmd" style={{ color: theme.text }} title={t.command}>
                    {shortCommand(t.command)}
                  </span>
                  <span className="bgtasks-status" style={{ color: theme.textDim }}>
                    {formatBackgroundTaskStatus(t)}
                  </span>
                  {running && (
                    <button
                      className="bgtasks-kill"
                      style={{ color: theme.error }}
                      title="Stop task"
                      onClick={() => void killTask(t.id)}
                    >
                      kill
                    </button>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}
