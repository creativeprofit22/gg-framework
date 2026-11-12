// @ts-check
// Spend broker for paid candidates. Rules:
//   - nothing paid runs without caps a person approved (the /bench playbook
//     asks; the CLI records who approved and refuses when caps are missing)
//   - the whole planned run must fit the caps at its worst case before the
//     first sample starts: a run cut short by money is not evidence
//   - every paid sample reserves its worst case BEFORE it starts, and the
//     ledger is written before dispatch, so a crash keeps the reservation
//   - a reservation is released only down to a cost that was reported or
//     estimated from a supplied price; unknown or interrupted usage keeps the
//     full reservation (it is never refunded)
//   - a sample that costs more than its reservation stops all further paid
//     work: the worst case was wrong, so the caps no longer protect anyone

import { err, ok } from "./result.mjs";
import { knownCost } from "./cost.mjs";

export const BUDGET_FILE = "budget.json";
const EPSILON = 1e-9;

/**
 * @typedef {{ usd: number, tokens?: number }} Caps
 * @typedef {{ usd: number, tokens?: number, approvedBy: string, reference?: string }} Approval
 * @typedef {{
 *   n: number, candidate: string, item: string, repeat: number, phase: string,
 *   reservedUsd: number, reservedTokens?: number,
 *   state: "in-flight" | "reported" | "estimated" | "unreported" | "interrupted" | "overrun",
 *   usd?: number, tokens?: number,
 * }} Entry
 */

/** @param {unknown} v */
const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Worst-case spend of one planned run.
 * @param {any} study  the study actually run (an A/A study counts the copy too)
 * @param {{ repeats?: number }} [options]
 */
export function planSpend(study, { repeats } = {}) {
  const paid = study.candidates
    .filter((/** @type {any} */ c) => c.paid === true)
    .map((/** @type {any} */ c) => c.id);
  const perCandidate =
    study.workload.items.length * ((repeats ?? study.repeats) + (study.warmupRepeats ?? 0));
  const w = study.budget?.perSampleWorstCase ?? {};
  const samples = paid.length * perCandidate;
  return {
    paid,
    samples,
    perSample: {
      usd: typeof w.usd === "number" ? w.usd : 0,
      ...(typeof w.tokens === "number" ? { tokens: w.tokens } : {}),
    },
    worstCaseUsd: samples * (typeof w.usd === "number" ? w.usd : 0),
    ...(typeof w.tokens === "number" ? { worstCaseTokens: samples * w.tokens } : {}),
  };
}

/** @param {number} usd */
const money = (usd) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`;

/**
 * Check approved caps against the plan. No paid candidates: nothing to approve.
 * @param {ReturnType<typeof planSpend>} plan
 * @param {Partial<Approval> | undefined} approval
 * @returns {import("./result.mjs").Result<Approval | undefined>}
 */
export function checkApproval(plan, approval) {
  if (plan.paid.length === 0) return ok(undefined);
  if (!approval || approval.usd === undefined)
    return err(
      "BUDGET_REQUIRED",
      `paid candidates (${plan.paid.join(", ")}) need spend caps approved by a person before they run; nothing was run. The worst case for this run is ${money(plan.worstCaseUsd)} over ${plan.samples} paid samples`,
      { paid: plan.paid, worstCaseUsd: plan.worstCaseUsd, samples: plan.samples },
    );
  if (!isPositive(approval.usd))
    return err("BUDGET_INVALID", "the approved dollar cap must be a positive number");
  if (typeof approval.approvedBy !== "string" || !approval.approvedBy.trim())
    return err(
      "BUDGET_INVALID",
      "say who approved the caps (--approved-by); caps nobody approved are not caps",
    );
  if (approval.tokens !== undefined) {
    if (!isPositive(approval.tokens))
      return err("BUDGET_INVALID", "the approved token cap must be a positive number");
    if (plan.perSample.tokens === undefined)
      return err(
        "BUDGET_INVALID",
        "a token cap needs budget.perSampleWorstCase.tokens in study.json so tokens can be reserved",
      );
  }
  if (plan.worstCaseUsd > approval.usd * (1 + EPSILON))
    return err(
      "BUDGET_TOO_SMALL",
      `the worst case for ${plan.samples} paid samples is ${money(plan.worstCaseUsd)}, above the approved ${money(approval.usd)}; a run cut short by its budget is not evidence, so nothing was run`,
      { worstCaseUsd: plan.worstCaseUsd, capUsd: approval.usd, samples: plan.samples },
    );
  if (
    approval.tokens !== undefined &&
    plan.worstCaseTokens !== undefined &&
    plan.worstCaseTokens > approval.tokens
  )
    return err(
      "BUDGET_TOO_SMALL",
      `the worst case for ${plan.samples} paid samples is ${plan.worstCaseTokens} tokens, above the approved ${approval.tokens}; nothing was run`,
      { worstCaseTokens: plan.worstCaseTokens, capTokens: approval.tokens },
    );
  return ok({
    usd: approval.usd,
    approvedBy: approval.approvedBy.trim(),
    ...(approval.tokens !== undefined ? { tokens: approval.tokens } : {}),
    ...(approval.reference ? { reference: approval.reference } : {}),
  });
}

/**
 * A spend broker for one run.
 * @param {{ approval: Approval, perSample: { usd: number, tokens?: number }, now?: () => string }} options
 */
export function createBroker({ approval, perSample, now = () => new Date().toISOString() }) {
  /** @type {Entry[]} */
  const entries = [];
  /** @type {string | undefined} */
  let stopped;
  const createdAt = now();

  /** @param {Entry} e */
  const committedUsd = (e) => (e.usd !== undefined ? e.usd : e.reservedUsd);
  /** @param {Entry} e */
  const committedTokens = (e) => (e.tokens !== undefined ? e.tokens : (e.reservedTokens ?? 0));
  const totals = () => {
    const usd = entries.reduce((sum, e) => sum + committedUsd(e), 0);
    const tokens = entries.reduce((sum, e) => sum + committedTokens(e), 0);
    return {
      committedUsd: usd,
      knownUsd: entries.reduce((sum, e) => sum + (e.usd ?? 0), 0),
      ...(approval.tokens !== undefined ? { committedTokens: tokens } : {}),
      unknownSamples: entries.filter((e) => e.usd === undefined && e.state !== "in-flight").length,
      samples: entries.length,
    };
  };

  return {
    /**
     * Reserve the worst case for one paid sample.
     * @param {{ candidate: string, item: string, repeat: number, phase: string }} slot
     * @returns {import("./result.mjs").Result<Entry>}
     */
    reserve(slot) {
      if (stopped) return err("BUDGET_STOPPED", stopped);
      const t = totals();
      if (t.committedUsd + perSample.usd > approval.usd * (1 + EPSILON))
        return err(
          "BUDGET_EXHAUSTED",
          `the next sample could cost up to ${money(perSample.usd)}, but only ${money(Math.max(0, approval.usd - t.committedUsd))} of the approved ${money(approval.usd)} is left`,
        );
      if (
        approval.tokens !== undefined &&
        perSample.tokens !== undefined &&
        (t.committedTokens ?? 0) + perSample.tokens > approval.tokens
      )
        return err(
          "BUDGET_EXHAUSTED",
          `the next sample could use up to ${perSample.tokens} tokens, above what is left of the approved ${approval.tokens}`,
        );
      /** @type {Entry} */
      const entry = {
        n: entries.length + 1,
        candidate: slot.candidate,
        item: slot.item,
        repeat: slot.repeat,
        phase: slot.phase,
        reservedUsd: perSample.usd,
        ...(perSample.tokens !== undefined ? { reservedTokens: perSample.tokens } : {}),
        state: "in-flight",
      };
      entries.push(entry);
      return ok(entry);
    },

    /**
     * Settle a reservation from the sample's outcome.
     * @param {Entry} entry
     * @param {import("./runner.mjs").Outcome} outcome
     * @returns {import("./result.mjs").Result<Entry>}
     */
    settle(entry, outcome) {
      if (!entries.includes(entry) || entry.state !== "in-flight")
        throw new Error(`budget entry ${entry.n} settled twice`);
      if (outcome.status !== "ok") {
        entry.state = "interrupted";
        return ok(entry);
      }
      const cost = knownCost(outcome.metrics);
      const tokens = outcome.metrics.totalTokens;
      if (typeof tokens === "number" && Number.isFinite(tokens)) entry.tokens = tokens;
      if (!cost) {
        entry.state = "unreported";
        return ok(entry);
      }
      entry.usd = cost.usd;
      entry.state = cost.source;
      const overUsd = cost.usd > entry.reservedUsd * (1 + EPSILON);
      const overTokens =
        entry.reservedTokens !== undefined &&
        entry.tokens !== undefined &&
        entry.tokens > entry.reservedTokens;
      if (overUsd || overTokens) {
        entry.state = "overrun";
        stopped = overUsd
          ? `a sample of ${entry.candidate} cost ${money(cost.usd)}, more than its ${money(entry.reservedUsd)} worst case; all paid work stopped`
          : `a sample of ${entry.candidate} used ${entry.tokens} tokens, more than its ${entry.reservedTokens} worst case; all paid work stopped`;
        return err("BUDGET_OVERRUN", stopped);
      }
      return ok(entry);
    },

    /** The ledger as written to budget.json. */
    ledger() {
      return {
        schema: 1,
        caps: {
          usd: approval.usd,
          ...(approval.tokens !== undefined ? { tokens: approval.tokens } : {}),
        },
        approvedBy: approval.approvedBy,
        ...(approval.reference ? { reference: approval.reference } : {}),
        perSampleWorstCase: perSample,
        createdAt,
        ...totals(),
        ...(stopped ? { stopped } : {}),
        entries: entries.map((e) => ({ ...e })),
      };
    },
  };
}
