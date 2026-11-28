import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

/**
 * Holds a Settings page back until its first load lands, so the page arrives
 * once, already right, instead of painting its loading state for a frame or two
 * (an empty folder field, a missing Permissions card, "checking providers…",
 * an "Off" that flips to "Live") and then snapping to the real thing.
 *
 * Pages call `useSettingsPageReady(loaded)`. While any part of the open page
 * is still loading, the screen keeps the page hidden and its entrance waiting;
 * when the last part is ready the page's usual entrance plays. A slow load
 * stops being waited for after `SETTINGS_PAGE_WAIT_MS`, and the page shows its
 * own skeleton instead. Only the first load is waited for: once a page has
 * shown, a later reload never hides it again.
 *
 * Outside the Settings screen (the same panels opened as dialogs) there is no
 * gate and the hook does nothing.
 */
export const SETTINGS_PAGE_WAIT_MS = 300;

/** Starts holding the page; the returned function lets go. */
type Hold = () => () => void;

interface PageGate {
  readonly page: string;
  holds: number;
  shown: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const SettingsReadyContext = createContext<Hold | null>(null);

export function SettingsReadyProvider({
  hold,
  children,
}: {
  hold: Hold;
  children: React.ReactNode;
}): React.ReactElement {
  return <SettingsReadyContext.Provider value={hold}>{children}</SettingsReadyContext.Provider>;
}

/**
 * The gate for one open page, keyed by `page`. Holds are taken in layout
 * effects, so the update that hides the page lands before the first paint.
 */
export function useSettingsPageGate(page: string): { waiting: boolean; hold: Hold } {
  // Which page is being waited for, so a stale page's late release (or its
  // timer) can never reveal, or keep hiding, the page that replaced it.
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  // The open page's gate: how many parts still hold it, whether it has shown,
  // and the give-up timer. A fresh one per page, so a stale page's releases
  // only ever touch its own.
  const gateRef = useRef<PageGate | null>(null);
  const hold = useCallback((): (() => void) => {
    let gate = gateRef.current;
    if (!gate || gate.page !== page) {
      if (gate) clearTimeout(gate.timer);
      gate = { page, holds: 0, shown: false, timer: undefined };
      gateRef.current = gate;
    }
    const own = gate;
    const show = (): void => {
      if (own.shown) return;
      own.shown = true;
      clearTimeout(own.timer);
      setWaitingFor((current) => (current === own.page ? null : current));
    };
    if (own.shown) return () => {};
    own.holds += 1;
    if (own.holds === 1) {
      setWaitingFor(own.page);
      own.timer = setTimeout(show, SETTINGS_PAGE_WAIT_MS);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      own.holds -= 1;
      if (own.holds === 0) show();
    };
  }, [page]);
  return { waiting: waitingFor === page, hold };
}

/** Keep the open Settings page hidden until `ready` (its first load) is true. */
export function useSettingsPageReady(ready: boolean): void {
  const hold = useContext(SettingsReadyContext);
  useLayoutEffect(() => {
    if (ready || !hold) return;
    return hold();
  }, [ready, hold]);
}
