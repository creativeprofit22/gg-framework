/**
 * Autopilot cycle — the review→prompt→review loop as pure orchestration logic.
 *
 * The sidecar wires the real dependencies (kenAuto session, runAgent, SSE
 * broadcast); this module owns the loop's control flow so every exit path is
 * unit-testable without booting the sidecar.
 *
 * Two branches share one loop:
 *  - PLAN branch (planPending): GG Coder submitted a plan via exit_plan. Ken
 *    reviews the PLAN itself — mark it ready for explicit human approval, send
 *    revision feedback through the durable plan gate, or hand a genuine
 *    user-level decision to the human. Ken never has approval authority.
 *  - WORK branch: the classic review of a finished turn (ALL_CLEAR / IGNORE /
 *    HUMAN / PROMPT), unchanged.
 *
 * A mid-cycle enter_plan WITHOUT exit_plan (isPlanMode() true, no pending
 * plan) still halts as HUMAN — Ken must never prompt into a read-only
 * plan-mode session.
 */
import type { AutopilotVerdict } from "./autopilot-verdict.js";

/** Reason shown in the Ken bubble when the build session is still INSIDE plan
 *  mode (enter_plan without exit_plan) when the cycle checks in — there is no
 *  submitted plan to review and the session is read-only, so the loop halts
 *  and hands control to the user. */
export const AUTOPILOT_PLAN_DRAFTING_REASON =
  "GG Coder is still drafting a plan (plan mode is active with nothing submitted). Finish or cancel the plan yourself; autopilot can't prompt a read-only session.";

/** Situational-awareness preamble prepended to EVERY build-session run that
 *  Autopilot Ken injects (fix prompts, plan-revision prompts, the post-approval
 *  "implement it now" run). GG Coder otherwise can't tell an autopilot-injected
 *  prompt from a human one — it lands as a plain user message — so it behaves as
 *  if someone is watching: it may stop to ask permission for safe, already-
 *  implied work (which only burns a review round, since no human is there) and
 *  it may end a turn on "should work" instead of proving it. This tells it the
 *  turn came from the automated reviewer, that no human is watching, so it must
 *  self-verify and only surface genuine user-level decisions. NEVER prepended to
 *  human-typed prompts — the sidecar applies it only at the autopilot cycle's
 *  injection sites. */
export const AUTOPILOT_INJECTION_PREAMBLE =
  "[Autopilot] This turn was triggered by Ken, GG Coder's automated reviewer — " +
  "not by a human, and no human is watching it land. So:\n" +
  "- Prove your work before finishing: run the tests/build or screenshot the UI. " +
  'Don\'t end on "should work" — nobody is here to catch a mistake, so verify it ' +
  "yourself.\n" +
  "- Don't stop to ask permission for work that's already implied by the original " +
  "request and safe to do. Just do it and keep going.\n" +
  "- Only surface a question when it needs a real human decision (a product/taste " +
  "call, a destructive or irreversible action, a missing secret or external " +
  "access). State it plainly and stop; Ken routes it to the user.\n\n" +
  "Your instruction:";

/** Prepend {@link AUTOPILOT_INJECTION_PREAMBLE} to a body destined for the build
 *  session during an autopilot cycle. Deterministic so the sidecar can compute
 *  the same framed string both when it runs the prompt AND when it records the
 *  match-string Ken's digest uses to label the message as injected. */
export function frameAutopilotInjection(body: string): string {
  return `${AUTOPILOT_INJECTION_PREAMBLE}\n\n${body}`;
}

/** Prompt injected into the build session when Ken rejects a plan with
 *  feedback. Mirrors the webview's manual "Feedback" wording in spirit: the
 *  plan was not approved, revise it, resubmit via exit_plan. */
export function buildPlanRevisionPrompt(feedback: string): string {
  return (
    `The plan was not approved. Feedback from Ken (automated reviewer):\n\n` +
    `${feedback}\n\n` +
    `Revise the plan based on this feedback, then call exit_plan again for review.`
  );
}

/** Identity of the exact persisted plan generation reviewed by Ken. */
export interface AutopilotPlanReviewIdentity {
  checkpointId: string;
  generation: number;
}

/** SSE frame types the cycle can emit (matched by the webview). */
export type AutopilotCycleEmit =
  | { type: "autopilot_done"; data: Record<string, never> }
  | { type: "autopilot_ignored"; data: Record<string, never> }
  | { type: "autopilot_human"; data: { reason: string } }
  | { type: "autopilot_capped"; data: { rounds: number } }
  | { type: "autopilot_plan_ready"; data: AutopilotPlanReviewIdentity };

export interface AutopilotCycleDeps {
  /** Hard cap on review→prompt rounds per user turn (loop safety). */
  maxRounds: number;
  /** True once /cancel fires — checked between every step. */
  isCancelled: () => boolean;
  /** Live plan-mode state of the BUILD session. */
  isPlanMode: () => boolean;
  /** True while a submitted plan (exit_plan) awaits a verdict. */
  planPending: () => boolean;
  /** Wipe the reviewer's history so each user turn starts cheap (within one
   *  cycle the review messages persist so Ken remembers what he asked). */
  resetReviewer: () => Promise<void>;
  /** Run one work review; resolves to the parsed verdict or null on failure
   *  (failure is already surfaced by the sidecar as autopilot_error). */
  review: () => Promise<AutopilotVerdict | null>;
  /** Run one PLAN review (plan digest, not work digest); null on failure OR
   *  when the review went stale because a human acted mid-review. */
  reviewPlan: () => Promise<AutopilotVerdict | null>;
  /** Persist Ken's all-clear as readiness and return the committed identity. */
  markPlanReady: () => Promise<AutopilotPlanReviewIdentity | null>;
  /** Compare-and-swap the reviewed generation into revision-requested. */
  requestPlanRevision: (feedback: string) => Promise<boolean>;
  /** Feed a PROMPT verdict's body to GG Coder as an injected run. */
  runPrompt: (body: string) => Promise<void>;
  /** Called BEFORE runPrompt: record the injected body (digest labeling) and
   *  broadcast the autopilot_prompted marker. */
  onInjected: (body: string, round: number) => void;
  /** Broadcast one of the cycle's terminal SSE frames. */
  emit: (event: AutopilotCycleEmit) => void;
}

/**
 * Drive one full autopilot cycle for a finished user turn. Every exit is
 * explicit:
 *  - cancelled                 → silent stop (the /cancel path already broadcast)
 *  - plan mode, no submission  → autopilot_human with the drafting reason
 *  - review failed (null)       → silent stop (autopilot_error already broadcast)
 *  - stale plan transition      → silent stop (a newer gate or human action won)
 *  - ALL_CLEAR                 → autopilot_done
 *  - IGNORE (work)             → autopilot_ignored (renders nothing)
 *  - HUMAN                     → autopilot_human
 *  - rounds exhausted          → autopilot_capped
 */
export async function driveAutopilotCycle(deps: AutopilotCycleDeps): Promise<void> {
  if (deps.isCancelled()) return;
  await deps.resetReviewer();
  let remediationRounds = 0;
  for (;;) {
    if (deps.isCancelled()) return;
    if (deps.planPending()) {
      const verdict = await deps.reviewPlan();
      if (!verdict || deps.isCancelled()) return;
      if (verdict.kind === "human") {
        deps.emit({ type: "autopilot_human", data: { reason: verdict.reason } });
        return;
      }
      if (verdict.kind === "prompt") {
        if (remediationRounds >= deps.maxRounds) {
          deps.emit({ type: "autopilot_capped", data: { rounds: deps.maxRounds } });
          return;
        }
        const revisionRequested = await deps.requestPlanRevision(verdict.body);
        if (!revisionRequested) return;
        remediationRounds += 1;
        const body = buildPlanRevisionPrompt(verdict.body);
        deps.onInjected(body, remediationRounds);
        await deps.runPrompt(body);
        continue;
      }
      // ALL_CLEAR and IGNORE mean Ken found no objection. Persist readiness,
      // keep the human gate pending, and stop without implementation.
      const readyIdentity = await deps.markPlanReady();
      if (!readyIdentity) return;
      deps.emit({ type: "autopilot_plan_ready", data: readyIdentity });
      return;
    }
    // The gate blocks a still-in-plan-mode turn up front, so hitting this
    // means an injected run entered plan mode mid-cycle WITHOUT submitting a
    // plan: halt — Ken can't prompt a read-only session.
    if (deps.isPlanMode()) {
      deps.emit({ type: "autopilot_human", data: { reason: AUTOPILOT_PLAN_DRAFTING_REASON } });
      return;
    }
    const verdict = await deps.review();
    if (!verdict || deps.isCancelled()) return;
    if (verdict.kind === "all_clear") {
      deps.emit({ type: "autopilot_done", data: {} });
      return;
    }
    if (verdict.kind === "ignore") {
      deps.emit({ type: "autopilot_ignored", data: {} });
      return;
    }
    if (verdict.kind === "human") {
      deps.emit({ type: "autopilot_human", data: { reason: verdict.reason } });
      return;
    }
    if (remediationRounds >= deps.maxRounds) {
      deps.emit({ type: "autopilot_capped", data: { rounds: deps.maxRounds } });
      return;
    }
    remediationRounds += 1;
    deps.onInjected(verdict.body, remediationRounds);
    await deps.runPrompt(verdict.body);
    if (deps.isCancelled()) return;
  }
}
