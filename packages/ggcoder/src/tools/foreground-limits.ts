/**
 * Pure policy for foreground command limits.
 *
 * A foreground command is never killed because the agent guessed too short.
 * Instead, three independent layers apply:
 * - yield: after a soft limit the command is handed off to a background task;
 * - inactivity: a command with no output for a long time is stopped;
 * - hard: a high backstop that stops the command regardless of output.
 *
 * `null` disables a layer. An explicit `timeout` becomes the hard limit and
 * disables yield, for callers that genuinely want a bounded foreground run.
 */

export interface ForegroundLimitSettings {
  /** Seconds before a running foreground command moves to the background; 0 disables. */
  yieldSeconds: number;
  /** Seconds without output before a command is stopped; 0 disables. */
  inactivitySeconds: number;
  /** Minutes before a command is stopped regardless of output; 0 disables. */
  hardLimitMinutes: number;
}

export interface ForegroundLimits {
  yieldMs: number | null;
  inactivityMs: number | null;
  hardMs: number | null;
  /** Grace period between process exit and forcibly closing still-held pipes. */
  exitSettleMs: number;
}

export interface ResolveForegroundLimitsInput {
  explicitTimeoutMs?: number | undefined;
  settings: ForegroundLimitSettings;
  platform: NodeJS.Platform;
  mode: "spawn" | "persistent";
  canHandOff: boolean;
}

export const DEFAULT_FOREGROUND_LIMIT_SETTINGS = {
  yieldSeconds: 120,
  inactivitySeconds: 600,
  hardLimitMinutes: 60,
} as const satisfies ForegroundLimitSettings;

/** Windows process startup is slow enough that very short yields are noise. */
export const WIN32_MIN_YIELD_MS = 10_000;
export const DEFAULT_EXIT_SETTLE_MS = 2_000;

function positiveOrNull(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function resolveForegroundLimits(input: ResolveForegroundLimitsInput): ForegroundLimits {
  const { settings } = input;
  const explicit =
    input.explicitTimeoutMs !== undefined ? positiveOrNull(input.explicitTimeoutMs) : undefined;

  let yieldMs: number | null = null;
  if (explicit === undefined && input.mode === "spawn" && input.canHandOff) {
    yieldMs = positiveOrNull(settings.yieldSeconds * 1000);
    if (yieldMs !== null && input.platform === "win32") {
      yieldMs = Math.max(yieldMs, WIN32_MIN_YIELD_MS);
    }
  }

  return {
    yieldMs,
    inactivityMs: positiveOrNull(settings.inactivitySeconds * 1000),
    hardMs: explicit !== undefined ? explicit : positiveOrNull(settings.hardLimitMinutes * 60_000),
    exitSettleMs: DEFAULT_EXIT_SETTLE_MS,
  };
}
