/**
 * Timer-only watchdog for a running command. It knows nothing about processes:
 * the owner reports output through `noteActivity()` and reacts to `onFire`.
 *
 * Exactly one of "yield" | "inactive" | "hardTimeout" fires, at most once;
 * the watchdog then disposes itself. A `null` limit disables that layer.
 * Only the inactivity timer re-arms on activity.
 */

export type CommandWatchdogFire = "yield" | "inactive" | "hardTimeout";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface CommandWatchdogOptions {
  yieldMs: number | null;
  inactivityMs: number | null;
  hardMs: number | null;
  /**
   * First inactivity delay when some of the silence budget was already used
   * (for example before a hand-off). Later re-arms use `inactivityMs`.
   */
  initialInactivityMs?: number | undefined;
  onFire: (fire: CommandWatchdogFire) => void;
  setTimer?: ((callback: () => void, ms: number) => TimerHandle) | undefined;
  clearTimer?: ((handle: TimerHandle) => void) | undefined;
}

export interface CommandWatchdog {
  noteActivity(): void;
  dispose(): void;
}

export function createCommandWatchdog(options: CommandWatchdogOptions): CommandWatchdog {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let disposed = false;
  let yieldTimer: TimerHandle | undefined;
  let inactivityTimer: TimerHandle | undefined;
  let hardTimer: TimerHandle | undefined;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const timer of [yieldTimer, inactivityTimer, hardTimer]) {
      if (timer !== undefined) clearTimer(timer);
    }
    yieldTimer = inactivityTimer = hardTimer = undefined;
  };

  const fire = (kind: CommandWatchdogFire): void => {
    if (disposed) return;
    dispose();
    options.onFire(kind);
  };

  const armInactivity = (ms: number): void => {
    if (inactivityTimer !== undefined) clearTimer(inactivityTimer);
    inactivityTimer = setTimer(() => fire("inactive"), Math.max(0, ms));
  };

  if (options.yieldMs !== null) {
    yieldTimer = setTimer(() => fire("yield"), Math.max(0, options.yieldMs));
  }
  if (options.hardMs !== null) {
    hardTimer = setTimer(() => fire("hardTimeout"), Math.max(0, options.hardMs));
  }
  if (options.inactivityMs !== null) {
    armInactivity(options.initialInactivityMs ?? options.inactivityMs);
  }

  return {
    noteActivity(): void {
      if (disposed || options.inactivityMs === null) return;
      armInactivity(options.inactivityMs);
    },
    dispose,
  };
}
