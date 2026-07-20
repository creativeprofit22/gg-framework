import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "./theme";
import { killTask, type BackgroundTask } from "./agent";

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
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [killResult, setKillResult] = useState<{ ok: boolean; message: string } | null>(null);
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

  const handleKill = async (taskId: string): Promise<void> => {
    if (pendingTaskId !== null) return;
    setPendingTaskId(taskId);
    setKillResult(null);
    try {
      setKillResult(await killTask(taskId));
    } finally {
      setPendingTaskId(null);
    }
  };

  const runningCount = tasks.filter((t) => t.exitCode === null).length;
  // Spinner color while anything runs; muted once all have exited.
  const accent = runningCount > 0 ? theme.warning : theme.textMuted;

  return (
    <span className="bgtasks" ref={ref}>
      <button
        ref={buttonRef}
        className="bgtasks-button"
        style={{ color: accent, borderColor: theme.border }}
        title="Background tasks"
        aria-label="Background tasks"
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
              const running = t.exitCode === null;
              const pending = pendingTaskId === t.id;
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
                    {running ? `pid ${t.pid}` : `exit ${t.exitCode}`}
                  </span>
                  {running && (
                    <button
                      className="bgtasks-kill"
                      style={{ color: theme.error }}
                      aria-label={`${pending ? "Stopping" : "Stop"} task: ${shortCommand(t.command)}`}
                      disabled={pendingTaskId !== null}
                      onClick={() => void handleKill(t.id)}
                    >
                      {pending ? "stopping..." : "kill"}
                    </button>
                  )}
                </div>
              );
            })}
            {killResult && (
              <div
                className="bgtasks-feedback"
                role={killResult.ok ? "status" : "alert"}
                style={{ color: killResult.ok ? theme.success : theme.error }}
              >
                {killResult.message}
              </div>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
