/**
 * Fork-only quiet-budget policy (docs/harness-checks.md, "Quiet commands after
 * a move"). Silence after a move to the background only notifies; the hard
 * limit is the only kill. Pure: bash.ts and process-manager.ts only call it.
 */
import type { VerifyPlan } from "@kenkaiiii/gg-core/verify-plan";

/**
 * The quiet budget a project's verify plan declares for this exact command.
 * Matches only when the trimmed command equals a gate's argv joined by spaces,
 * so a lookalike command never borrows a gate's budget.
 */
export function findGateQuietBudgetSeconds(
  plan: VerifyPlan | null | undefined,
  command: string,
): number | null {
  if (!plan) return null;
  const wanted = command.trim();
  if (!wanted) return null;
  for (const gate of plan.gates) {
    if (gate.quietBudgetSeconds !== null && gate.argv.join(" ") === wanted) {
      return gate.quietBudgetSeconds;
    }
  }
  return null;
}

export interface QuietBudgetInput {
  /** `bashInactivitySeconds`; 0 disables. */
  settingsSeconds: number;
  /** A matching gate's `quietBudgetSeconds`, which wins when present. */
  gateSeconds: number | null;
}

/** Milliseconds of silence before one notice, or null for none. */
export function resolveQuietBudgetMs({
  settingsSeconds,
  gateSeconds,
}: QuietBudgetInput): number | null {
  const seconds = gateSeconds ?? settingsSeconds;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/** Failure that teaches: name options the agent can actually use. */
export function inactiveHint({ persistent }: { persistent: boolean }): string {
  return (
    "[Stopped because it printed nothing for the silence limit. If this step is legitimately " +
    "quiet, rerun it with run_in_background=true and wake.silence_seconds, then wait with " +
    "task_output wait_ms; or pass an explicit timeout (ms) to bound it without the silence limit." +
    (persistent
      ? " persist:true keeps the silence limit; drop persist for long quiet steps."
      : "") +
    "]\n"
  );
}

export interface HandOffNoticeInput {
  id: string;
  /** Formatted run time so far. */
  elapsed: string;
  /** Formatted total hard limit, or null when none applies. */
  hardLimit: string | null;
  /** Whether a silence notice can actually reach the agent. */
  quietNotice: boolean;
}

export function handOffNotice({ id, elapsed, hardLimit, quietNotice }: HandOffNoticeInput): string {
  return (
    `Still running after ${elapsed} — moved to background task ${id} (not killed). ` +
    (quietNotice
      ? `Silence only sends you a notice; it never stops the command. `
      : `Silence never stops the command, but no notice will arrive; wait with task_output wait_ms. `) +
    (hardLimit
      ? `It is stopped at the hard limit (${hardLimit} in total). `
      : "It has no hard limit. ") +
    `Call task_output with id="${id}" and wait_ms; it returns the moment the command exits ` +
    `or prints a failure.`
  );
}
