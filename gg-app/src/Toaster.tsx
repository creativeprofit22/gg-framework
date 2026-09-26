import { useEffect, useRef, useState } from "react";
import { Info, CheckCircle2, AlertTriangle, XCircle, X } from "lucide-react";
import { theme } from "./theme";
import {
  subscribeToasts,
  dismissToast,
  pauseToast,
  resumeToast,
  type Toast,
  type ToastTone,
} from "./toast";

// Must match the .toast-out animation duration in App.css.
const EXIT_MS = 260;

const TONE_COLOR: Record<ToastTone, string> = {
  info: theme.primary,
  success: theme.success,
  warning: theme.warning,
  error: theme.error,
};

const TONE_ICON: Record<ToastTone, React.ComponentType<{ size?: number }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

/**
 * Bottom-right toast stack. Each toast slides up + fades in on enter, and
 * slides down + fades out on exit. The rendered list lags the bus: when a toast
 * leaves the bus it's kept around (marked `leaving`) for the exit animation,
 * then dropped. Mounted once at the app root; driven by the toast bus.
 */
export function Toaster(): React.ReactElement {
  // Rendered list, each tagged with whether it's animating out.
  const [rendered, setRendered] = useState<(Toast & { leaving?: boolean })[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return subscribeToasts((busToasts) => {
      setRendered((prev) => {
        const busIds = new Set(busToasts.map((t) => t.id));
        // Mark any rendered toast no longer on the bus as leaving, and schedule
        // its removal after the exit animation.
        const next = prev.map((r) => {
          if (!busIds.has(r.id) && !r.leaving) {
            if (!timers.current.has(r.id)) {
              timers.current.set(
                r.id,
                setTimeout(() => {
                  timers.current.delete(r.id);
                  setRendered((cur) => cur.filter((c) => c.id !== r.id));
                }, EXIT_MS),
              );
            }
            return { ...r, leaving: true };
          }
          return r;
        });
        // Append toasts new on the bus that aren't rendered yet.
        const renderedIds = new Set(next.map((r) => r.id));
        for (const t of busToasts) {
          if (!renderedIds.has(t.id)) next.push(t);
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const id of map.values()) clearTimeout(id);
      map.clear();
    };
  }, []);

  // Screen-reader announcements live in two regions that are mounted for the
  // app's whole life: a live region only speaks changes made AFTER it exists,
  // so a toast that mounts with its text already inside is often skipped.
  // Errors interrupt (alert); everything else waits its turn (status).
  const live = rendered.filter((t) => !t.leaving);
  const announce = (urgent: boolean): React.ReactNode =>
    live
      .filter((t) => (t.tone === "error") === urgent)
      .map((t) => <div key={t.id}>{t.message}</div>);

  return (
    <div className="toaster">
      <div className="sr-only" role="status">
        {announce(false)}
      </div>
      <div className="sr-only" role="alert">
        {announce(true)}
      </div>
      {rendered.map((t) => {
        const color = TONE_COLOR[t.tone];
        const Icon = TONE_ICON[t.tone];
        return (
          // Hovering or focusing a toast holds its countdown so it can be read.
          <div
            key={t.id}
            className={`toast${t.leaving ? " leaving" : ""}`}
            onMouseEnter={() => pauseToast(t.id)}
            onMouseLeave={(e) => {
              if (!e.currentTarget.contains(document.activeElement)) resumeToast(t.id);
            }}
            onFocus={() => pauseToast(t.id)}
            onBlur={(e) => {
              if (!e.currentTarget.matches(":hover")) resumeToast(t.id);
            }}
          >
            <span
              aria-hidden="true"
              className="toast-icon"
              style={{
                color,
                borderColor: `color-mix(in srgb, ${color} 33.3333%, transparent)`,
                background: `color-mix(in srgb, ${color} 10.1961%, transparent)`,
                display: "inline-flex",
              }}
            >
              <Icon size={14} />
            </span>
            <span className="toast-msg">{t.message}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
