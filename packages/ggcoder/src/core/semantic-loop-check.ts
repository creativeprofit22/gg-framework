import type { Message } from "@kenkaiiii/gg-ai";

/**
 * Semantic (LLM-judged) loop detection — the layer between the deterministic
 * checks that fire and silence. `evaluateLoopBreak` only sees syntactic
 * signals: identical calls, unchanged results, A/B cycles, repeated text. It
 * is blind to the common thrash where every retry differs slightly (new args,
 * swapped tools, edited-then-reverted files) while the run makes no real
 * progress. Gemini CLI ships exactly this hybrid: deterministic heuristics
 * plus a periodic LLM "unproductive state" check (loopDetectionService).
 *
 * Cost control: the judge never runs unless the deterministic evidence is
 * already suspicious (failures accumulating) AND the deterministic breaker has
 * stayed quiet (it handles its own case). It runs on the session's ACTIVE
 * model, in the background between turns, with a bounded per-run budget.
 */

export interface SemanticCallDigest {
  tool: string;
  /** Short arg summary — enough for the judge to see WHAT was attempted. */
  args: string;
  ok: boolean;
  /** Short result tail — enough to see the failure shape. */
  result: string;
}

export interface SemanticLoopVerdict {
  loop: boolean;
  reason: string;
  advice: string;
}

/** Consecutive failed tool results before the judge is worth its tokens. */
export const SEMANTIC_LOOP_MIN_CONSECUTIVE_FAILURES = 2;
/** Judge cooldown in agent turns — one check per burst of failures, not per failure. */
export const SEMANTIC_LOOP_COOLDOWN_TURNS = 4;
/** Total judge calls per run. Two verdicts is enough to steer any thrash. */
export const MAX_SEMANTIC_LOOP_CHECKS = 2;
/** Recent tool calls handed to the judge — bounded context, not the transcript. */
export const MAX_SEMANTIC_LOOP_CALLS = 12;

export interface SemanticLoopTriggerInput {
  consecutiveFailures: number;
  totalFailures: number;
  turns: number;
  lastCheckTurn: number;
  checksUsed: number;
  checkPending: boolean;
  /** The deterministic verdict for the same evidence — when it fires, it owns the correction. */
  deterministicBreak: boolean;
}

export function shouldRunSemanticLoopCheck(input: SemanticLoopTriggerInput): boolean {
  if (input.checksUsed >= MAX_SEMANTIC_LOOP_CHECKS) return false;
  if (input.checkPending) return false;
  if (input.deterministicBreak) return false;
  if (input.consecutiveFailures < SEMANTIC_LOOP_MIN_CONSECUTIVE_FAILURES) return false;
  if (input.totalFailures < SEMANTIC_LOOP_MIN_CONSECUTIVE_FAILURES) return false;
  return input.turns - input.lastCheckTurn >= SEMANTIC_LOOP_COOLDOWN_TURNS;
}

export function buildSemanticLoopJudgePrompt(
  calls: readonly SemanticCallDigest[],
  originalRequest: string,
): string {
  const callLines = calls
    .map(
      (call, index) =>
        `${index + 1}. ${call.tool}(${call.args.slice(0, 200)}) → ` +
        `${call.ok ? "ok" : "FAILED"}: ${call.result.replace(/\s+/g, " ").slice(0, 160)}`,
    )
    .join("\n");
  const request = originalRequest.slice(0, 500);
  return [
    "You are monitoring a coding agent for UNPRODUCTIVE LOOPS. Below is its original task and its",
    "most recent tool calls in order. Decide whether the agent is stuck in an unproductive state.",
    "",
    "Judge UNPRODUCTIVE when the recent calls show:",
    "- Repeated attempts at the same underlying goal that keep failing, even if the arguments differ",
    "- Oscillation between approaches with no accumulating progress toward the task",
    "- Churn: edits that are reverted or rewritten, or diagnostics that never change shape",
    "",
    "Judge PRODUCTIVE when:",
    "- Failures are genuinely different problems being surfaced and worked through",
    "- Arguments evolve because the agent is incorporating what it learned (different files, flags, scope)",
    "- The overall trajectory moves toward the original task",
    "",
    `Original task: ${request}`,
    "",
    "Recent tool calls:",
    callLines,
    "",
    'Respond with ONLY a JSON object: {"loop": boolean, "reason": "one sentence", "advice": "one concrete sentence describing the change of approach"}',
  ].join("\n");
}

/**
 * Parse the judge's reply. Fails CLOSED to "no loop": an unparseable or
 * malformed verdict must never stop a run that may be making progress.
 */
export function parseSemanticLoopVerdict(raw: string): SemanticLoopVerdict | null {
  const jsonText = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed.loop !== "boolean") return null;
    return {
      loop: parsed.loop,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "",
      advice: typeof parsed.advice === "string" ? parsed.advice.slice(0, 300) : "",
    };
  } catch {
    return null;
  }
}

/** Total judge-response deadline. The judge runs mid-turn in the background;
 *  a hung call must not pin memory or budget forever. */
export const SEMANTIC_LOOP_JUDGE_TIMEOUT_MS = 20_000;

export async function withJudgeTimeout<T>(response: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Semantic loop judge timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildSemanticLoopMessage(verdict: SemanticLoopVerdict): Message {
  const reason = verdict.reason ? ` Assessment: ${verdict.reason}.` : "";
  const advice = verdict.advice ? ` ${verdict.advice}` : "";
  return {
    role: "user",
    provenance: { source: "runtime", kind: "steering", visibility: "hidden" },
    content:
      "An independent assessment of your recent tool calls determined you are repeating an " +
      "unproductive pattern: the underlying goal keeps failing while the approach does not " +
      `change in any way that could fix it.${reason}${advice} Stop retrying variations of the ` +
      "same approach. Either try a fundamentally different approach, or stop and report " +
      "honestly: what you tried, why it keeps failing, and what you would need to proceed.",
  };
}
