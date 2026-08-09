/**
 * Bounded process shutdown.
 *
 * Teardown reaches third-party code we do not control — MCP servers over stdio,
 * LSP servers, extension `deactivate()` hooks, Telegram long-polls. Any one of
 * them can hang forever, and an `await`-everything shutdown then never reaches
 * `process.exit`: the app appears to quit but the daemon keeps its port, or the
 * CLI keeps polling with nobody attached. Every long-running entry point arms a
 * deadline instead, so a wedged dependency costs a few seconds, not the process.
 *
 * `SIGHUP` matters as much as `SIGINT`: closing a terminal delivers exactly one
 * hangup and never a second key press, so a process that only force-exits on the
 * *second* Ctrl+C survives as an orphan.
 */

import { log } from "./logger.js";

/** Signals that must terminate a long-running GG process. */
export const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];

/** POSIX signal numbers, for the conventional `128 + n` exit code. */
const SIGNAL_NUMBERS: Record<TerminationSignal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

/** How long teardown gets before the process exits anyway. */
export const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

/** Env override, in seconds. `0` disables the deadline (debugging teardown). */
export const EXIT_TIMEOUT_ENV = "GG_EXIT_TIMEOUT_SECS";

/** Upper bound on the override — a deadline nobody will wait for is no deadline. */
const MAX_EXIT_TIMEOUT_MS = 120_000;

/**
 * Resolve the teardown deadline from the environment.
 *
 * Anything unparseable, negative or absurd falls back to the default rather
 * than disabling the guard, because a typo in a launcher script must not be
 * able to reintroduce an unbounded hang.
 */
export function resolveExitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[EXIT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_EXIT_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_EXIT_TIMEOUT_MS;
  if (seconds === 0) return 0;
  return Math.min(Math.round(seconds * 1000), MAX_EXIT_TIMEOUT_MS);
}

/** Conventional exit code for a signal-initiated exit (`128 + signal number`). */
export function exitCodeForSignal(signal: TerminationSignal): number {
  return 128 + SIGNAL_NUMBERS[signal];
}

export interface ShutdownOptions {
  /** Releases resources. May hang — that is the entire point of the deadline. */
  teardown: () => Promise<void> | void;
  /** Deadline override, mainly for tests. Defaults to {@link resolveExitTimeoutMs}. */
  timeoutMs?: number;
  /** Logging/reporting scope, e.g. `"app-sidecar"`. */
  scope?: string;
  /** Runs when teardown misses the deadline, just before the forced exit. */
  onTimeout?: (timeoutMs: number) => void;
  /** Runs when teardown throws. Shutdown continues regardless. */
  onError?: (error: unknown) => void;
  /** Terminates the process. Injectable so tests do not exit the runner. */
  exit?: (code: number) => never;
}

/**
 * Run `teardown`, then exit — but exit on the deadline even if teardown never
 * settles.
 *
 * The timer is deliberately **not** unref'd: an unref'd timer lets Node exit on
 * its own the moment the loop empties, which would race teardown and produce a
 * nondeterministic exit code. Held ref + explicit exit on both paths means the
 * code is always the one we chose.
 */
export async function shutdownWithDeadline(code: number, options: ShutdownOptions): Promise<never> {
  const exit = options.exit ?? ((c: number) => process.exit(c));
  const scope = options.scope ?? "shutdown";
  const timeoutMs = options.timeoutMs ?? resolveExitTimeoutMs();

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          // Teardown is wedged; anything here must be best-effort and never
          // able to stop the exit itself.
          try {
            options.onTimeout?.(timeoutMs);
          } catch {
            // ignored — we are leaving either way
          }
          try {
            log("WARN", scope, "teardown exceeded the exit deadline; forcing exit", {
              timeoutMs: String(timeoutMs),
              code: String(code),
            });
          } catch {
            // ignored — the logger may already be closed
          }
          exit(code);
        }, timeoutMs)
      : undefined;

  try {
    await options.teardown();
  } catch (error) {
    try {
      options.onError?.(error);
    } catch {
      // ignored — a reporting failure must not block the exit
    }
  }
  if (timer) clearTimeout(timer);
  return exit(code);
}

export interface TerminationHandlerOptions extends ShutdownOptions {
  /** Runs once per shutdown request, before teardown (e.g. print a banner). */
  onShutdownStart?: (signal: TerminationSignal | null) => void;
}

/**
 * Wire `SIGINT`/`SIGTERM`/`SIGHUP` to a bounded shutdown.
 *
 * A second signal while teardown is still running exits immediately rather than
 * waiting out the deadline — a user hitting Ctrl+C twice is telling us they are
 * done being patient.
 *
 * @returns `requestShutdown`, for non-signal exits (a dead parent process, a
 *   quit menu item) so they share the same guard and re-entrancy rules.
 */
export function installTerminationHandlers(
  options: TerminationHandlerOptions,
): (code?: number) => void {
  const exit = options.exit ?? ((c: number) => process.exit(c));
  let shuttingDown = false;

  const requestShutdown = (code = 0, signal: TerminationSignal | null = null): void => {
    if (shuttingDown) {
      // Impatient second signal: skip the remaining deadline.
      if (signal) exit(code);
      return;
    }
    shuttingDown = true;
    try {
      options.onShutdownStart?.(signal);
    } catch {
      // ignored — a banner must not block teardown
    }
    // `exit` never returns in production, so this promise normally never
    // settles. It only rejects when an injected exit throws (tests), and an
    // unhandled rejection there would crash the runner.
    void shutdownWithDeadline(code, options).catch(() => {});
  };

  for (const signal of TERMINATION_SIGNALS) {
    try {
      process.on(signal, () => requestShutdown(exitCodeForSignal(signal), signal));
    } catch {
      // Windows does not deliver every POSIX signal; the others still install.
    }
  }

  return (code = 0) => requestShutdown(code, null);
}
