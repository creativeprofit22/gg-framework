import type { ProgrammaticAssessmentCoverage } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { AreaMapCollectResult } from "./area-map-collect.js";
import type { ProgrammaticAreaV1 } from "./area-map.js";
import { ADVISORY_LIMITATIONS, type AdvisoryReceipt } from "./advisory.js";
import { ASSESSMENT_EVIDENCE_LIMITS, type DiagnosticCode } from "./assessment-evidence.js";
import type { AreaCandidatesV1 } from "./contracts.js";

export const AREA_SEARCH_LIMITS = Object.freeze({
  maxAreas: 6,
  concurrency: 3,
  deadlineMs: 180_000,
  maxTurns: 8,
  /** Above the single sample's path cap, one pass can no longer list every path. */
  minFiles: ASSESSMENT_EVIDENCE_LIMITS.maxPaths,
  sample: Object.freeze({ maxPaths: 80, maxExcerpts: 6, maxDeliveredBytes: 24 * 1024 }),
  maxCommands: 12,
  history: Object.freeze({ limit: 10, sinceDays: 90 }),
  /** Below the 64-receipt store so merged citations cannot be evicted by the merge turn. */
  maxRetainedReceipts: 32,
});

export type AreaCandidateNeed = AreaCandidatesV1["needs"][number];
export type AreaIncompleteReason = "timed-out" | "failed" | "cancelled" | "no-result";
export type AreaSkipReason = "low-signal" | "limit";
export type AreaPassOutcome =
  | {
      status: "searched" | "partly";
      needs: AreaCandidateNeed[];
      /** Receipts minted by this area's pass; only cited ones survive the merge. */
      receipts: AdvisoryReceipt[];
      sample: { listed: number; excerpted: number };
      /** Sample limits or denials hit while collecting this area's evidence (non-text excluded). */
      diagnostics?: { code: DiagnosticCode; count: number }[];
    }
  | {
      status: "incomplete";
      reason: AreaIncompleteReason;
      sample?: { listed: number; excerpted: number };
    };

/** Reported once at launch, once when settled; unstarted areas report `stopped` on parent abort. */
export type AreaPassProgress =
  { status: "reading" } | { status: "settled"; outcome: AreaPassOutcome } | { status: "stopped" };

export type AreaSearchDecision =
  | { mode: "single" }
  | {
      mode: "areas";
      selected: ProgrammaticAreaV1[];
      skipped: { area: ProgrammaticAreaV1; reason: AreaSkipReason }[];
    };

export function selectAreaSearch(input: {
  mode: "setup" | "configured";
  focus?: string;
  areaMap: AreaMapCollectResult | undefined;
  readAllowed: boolean;
  toolsDisabled: boolean;
}): AreaSearchDecision {
  const result = input.areaMap;
  if (
    input.mode !== "configured" ||
    input.focus ||
    input.toolsDisabled ||
    !input.readAllowed ||
    result?.status !== "ok"
  )
    return { mode: "single" };
  const map = result.areaMap;
  if (map.fileCount <= AREA_SEARCH_LIMITS.minFiles) return { mode: "single" };
  if (map.areas.filter((area) => area.kind !== "cross-area").length < 2) return { mode: "single" };
  const selected: ProgrammaticAreaV1[] = [];
  const skipped: { area: ProgrammaticAreaV1; reason: AreaSkipReason }[] = [];
  for (const area of map.areas) {
    if (area.lowSignal) skipped.push({ area, reason: "low-signal" });
    else if (selected.length >= AREA_SEARCH_LIMITS.maxAreas)
      skipped.push({ area, reason: "limit" });
    else selected.push(area);
  }
  return selected.length ? { mode: "areas", selected, skipped } : { mode: "single" };
}

/**
 * Fixed pool with one deadline per area. A failing area only affects itself; a parent abort
 * stops new launches and rejects once running passes have settled.
 */
export async function runAreaPasses<A extends { id: string }>(
  areas: readonly A[],
  runPass: (area: A, signal: AbortSignal) => Promise<AreaPassOutcome>,
  options: {
    signal: AbortSignal;
    concurrency?: number;
    deadlineMs?: number;
    onProgress?: (area: A, progress: AreaPassProgress) => void;
  },
): Promise<{ area: A; outcome: AreaPassOutcome }[]> {
  const { signal } = options;
  const concurrency = Math.max(1, options.concurrency ?? AREA_SEARCH_LIMITS.concurrency);
  const deadlineMs = options.deadlineMs ?? AREA_SEARCH_LIMITS.deadlineMs;
  signal.throwIfAborted();
  const results = new Array<{ area: A; outcome: AreaPassOutcome } | undefined>(areas.length);
  let next = 0;
  const report = (area: A, progress: AreaPassProgress) => {
    try {
      options.onProgress?.(area, progress);
    } catch {
      // A display callback must never change the search outcome.
    }
  };
  const one = async (index: number, area: A) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Area search deadline reached."));
    }, deadlineMs);
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let outcome: AreaPassOutcome;
    report(area, { status: "reading" });
    try {
      outcome = await runPass(area, controller.signal);
      if (timedOut && outcome.status !== "incomplete")
        outcome = { status: "incomplete", reason: "timed-out", sample: outcome.sample };
    } catch {
      outcome = {
        status: "incomplete",
        reason: timedOut ? "timed-out" : signal.aborted ? "cancelled" : "failed",
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    results[index] = { area, outcome };
    report(area, { status: "settled", outcome });
  };
  const worker = async () => {
    while (!signal.aborted && next < areas.length) {
      const index = next++;
      await one(index, areas[index] as A);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, areas.length) }, worker));
  if (signal.aborted) {
    for (let index = next; index < areas.length; index++)
      report(areas[index] as A, { status: "stopped" });
    signal.throwIfAborted();
  }
  return results.filter((item): item is { area: A; outcome: AreaPassOutcome } => !!item);
}

export interface MergedAreaCandidate extends AreaCandidateNeed {
  areas: string[];
}
export interface AreaStatusFact {
  id: string;
  label: string;
  status: "searched" | "partly" | "not-searched";
  reason?:
    AreaIncompleteReason | AreaSkipReason | "receipt-limit" | "sample-limit" | "permission-denied";
}

const SKIP_WORDS: Record<AreaIncompleteReason | AreaSkipReason, string> = {
  "low-signal": "it has little linking it to the rest of the project",
  limit: "only a limited number of parts are searched each time",
  "timed-out": "searching it took too long",
  failed: "searching it failed",
  cancelled: "searching it was stopped",
  "no-result": "no answer came back for it",
};
const normalized = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const needKey = (need: AreaCandidateNeed) => {
  const scope = need.workflow.affectedSubproject;
  return `${normalized(need.need)}\u0000${scope.scope === "subproject" ? scope.path : "*"}`;
};
const citedReceipts = (need: AreaCandidateNeed) =>
  need.evidence.items.flatMap((item) =>
    "kind" in item || item.basis === "assumed" ? [] : [item.source],
  );

/** Host dedupe and receipt budgeting; outcome choice stays with the merge model turn. */
export function mergeAreaCandidates(
  searched: readonly { area: ProgrammaticAreaV1; outcome: AreaPassOutcome }[],
  skipped: readonly { area: ProgrammaticAreaV1; reason: AreaSkipReason }[],
  maxReceipts: number = AREA_SEARCH_LIMITS.maxRetainedReceipts,
): {
  candidates: MergedAreaCandidate[];
  receipts: AdvisoryReceipt[];
  statuses: AreaStatusFact[];
  coverage: ProgrammaticAssessmentCoverage[];
  limitations: string[];
  sample: { listed: number; excerpted: number };
} {
  const byKey = new Map<string, MergedAreaCandidate>();
  const receiptPool = new Map<string, AdvisoryReceipt>();
  const statuses = new Map<string, AreaStatusFact>();
  const sample = { listed: 0, excerpted: 0 };
  for (const { area, outcome } of searched) {
    sample.listed += outcome.sample?.listed ?? 0;
    sample.excerpted += outcome.sample?.excerpted ?? 0;
    if (outcome.status === "incomplete") {
      statuses.set(area.id, {
        id: area.id,
        label: area.label,
        status: "not-searched",
        reason: outcome.reason,
      });
      continue;
    }
    const diagnostics = (outcome.diagnostics ?? []).filter((item) => item.code !== "non-text");
    const denied = diagnostics.some((item) => item.code === "permission-denied");
    statuses.set(area.id, {
      id: area.id,
      label: area.label,
      status: diagnostics.length ? "partly" : outcome.status,
      ...(denied
        ? { reason: "permission-denied" as const }
        : diagnostics.length
          ? { reason: "sample-limit" as const }
          : {}),
    });
    for (const receipt of outcome.receipts) receiptPool.set(receipt.id, receipt);
    for (const need of outcome.needs) {
      const key = needKey(need);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...structuredClone(need), areas: [area.id] });
        continue;
      }
      if (!existing.areas.includes(area.id)) existing.areas.push(area.id);
      const seen = new Set(existing.evidence.items.map((item) => JSON.stringify(item)));
      for (const item of need.evidence.items) {
        const serialized = JSON.stringify(item);
        if (seen.has(serialized) || existing.evidence.items.length >= 50) continue;
        seen.add(serialized);
        existing.evidence.items.push(structuredClone(item));
      }
    }
  }
  const retained = new Map<string, AdvisoryReceipt>();
  const candidates: MergedAreaCandidate[] = [];
  for (const candidate of byKey.values()) {
    const cited = [...new Set(citedReceipts(candidate))].filter((id) => receiptPool.has(id));
    const added = cited.filter((id) => !retained.has(id));
    if (retained.size + added.length > maxReceipts) {
      for (const id of candidate.areas) {
        const status = statuses.get(id);
        if (status?.status === "searched") {
          status.status = "partly";
          status.reason = "receipt-limit";
        }
      }
      continue;
    }
    for (const id of added) retained.set(id, receiptPool.get(id) as AdvisoryReceipt);
    candidates.push(candidate);
  }
  for (const { area, reason } of skipped)
    statuses.set(area.id, { id: area.id, label: area.label, status: "not-searched", reason });
  const ordered = [...searched.map(({ area }) => area), ...skipped.map(({ area }) => area)]
    .map((area) => statuses.get(area.id))
    .filter((item): item is AreaStatusFact => !!item);
  const coverage = ordered.map((item): ProgrammaticAssessmentCoverage => {
    const label = item.label.slice(0, 120);
    if (item.status === "searched")
      return { scope: "project", status: "inspected", summary: `${label}: searched fully.` };
    if (item.status === "partly" && item.reason === "permission-denied")
      return {
        scope: "project",
        status: "budget-limited",
        summary: `${label}: searched partly, because permission to read some of it was denied.`,
      };
    if (item.status === "partly")
      return {
        scope: "project",
        status: "budget-limited",
        summary: `${label}: searched partly, so something there may have been missed.`,
      };
    const why =
      item.reason && item.reason in SKIP_WORDS
        ? SKIP_WORDS[item.reason as keyof typeof SKIP_WORDS]
        : "it wasn't searched";
    return {
      scope: "project",
      status: "uninspected",
      summary: `${label}: not searched, because ${why}.`,
    };
  });
  const limitations: string[] = [];
  if (searched.some(({ outcome }) => outcome.status === "incomplete"))
    limitations.push(ADVISORY_LIMITATIONS.areasIncomplete);
  if (skipped.length) limitations.push(ADVISORY_LIMITATIONS.areasNotSearched);
  if (ordered.some((item) => item.reason === "permission-denied"))
    limitations.push(ADVISORY_LIMITATIONS.areasPermissionDenied);
  return {
    candidates,
    receipts: [...retained.values()],
    statuses: ordered,
    coverage,
    limitations,
    sample,
  };
}
