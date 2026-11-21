// Local Fork-owned: bounded display snapshots for the per-area search. Pure; no I/O.
import {
  PROGRAMMATIC_AREA_PROGRESS_LIMITS as L,
  type ProgrammaticAreaEarlyFind,
  type ProgrammaticAreaProgress,
  type ProgrammaticAssessmentArea,
} from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { ProgrammaticAreaV1 } from "./area-map.js";
import type {
  AreaPassOutcome,
  AreaPassProgress,
  AreaSkipReason,
  AreaStatusFact,
} from "./area-search.js";

/** Session-memory inputs for a one-area retry; never persisted. */
export interface AreaSearchCache {
  owner: string | null;
  sequence: number;
  areaMapDigest: string;
  passes: { area: ProgrammaticAreaV1; outcome: AreaPassOutcome }[];
  skipped: { area: ProgrammaticAreaV1; reason: AreaSkipReason }[];
  /** Digests of files the kept areas cited; `null` makes retry unavailable. */
  citedFiles: Record<string, string> | null;
}

const RETRYABLE = new Set(["failed", "timed-out", "no-result"]);

/** Clips by UTF-16 length (the contract's measure) without splitting a code point. */
export function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = "";
  for (const char of value) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out}…`;
}

function earlyFinds(area: ProgrammaticAreaV1, outcome: AreaPassOutcome) {
  if (outcome.status === "incomplete") return undefined;
  const finds: ProgrammaticAreaEarlyFind[] = outcome.needs.slice(0, L.finds).map((need) => {
    const scope = need.workflow.affectedSubproject;
    return {
      need: clipText(need.need, L.findText),
      where: clipText(scope.scope === "subproject" ? scope.path : area.label, L.findText),
      unsure: clipText(need.uncertainty, L.findText),
    };
  });
  return finds.length ? finds : undefined;
}

export function settledAreaProgress(
  area: ProgrammaticAreaV1,
  outcome: AreaPassOutcome,
): ProgrammaticAreaProgress {
  const base = { id: area.id, label: clipText(area.label, L.label) };
  if (outcome.status === "incomplete")
    return { ...base, status: outcome.reason === "cancelled" ? "stopped" : "failed" };
  const finds = earlyFinds(area, outcome);
  return {
    ...base,
    status: outcome.status === "partly" ? "partly" : "found",
    ...(finds ? { finds } : {}),
  };
}

/** Ordered snapshot of the selected areas; at most `L.areas` rows are shown. */
export function createAreaProgress(
  areas: readonly ProgrammaticAreaV1[],
  initial: ReadonlyMap<string, ProgrammaticAreaProgress> = new Map(),
) {
  const rows = new Map<string, ProgrammaticAreaProgress>();
  for (const area of areas.slice(0, L.areas))
    rows.set(
      area.id,
      initial.get(area.id) ?? {
        id: area.id,
        label: clipText(area.label, L.label),
        status: "waiting",
      },
    );
  return {
    update(area: ProgrammaticAreaV1, progress: AreaPassProgress): boolean {
      if (!rows.has(area.id)) return false;
      rows.set(
        area.id,
        progress.status === "settled"
          ? settledAreaProgress(area, progress.outcome)
          : { id: area.id, label: clipText(area.label, L.label), status: progress.status },
      );
      return true;
    },
    snapshot(): ProgrammaticAreaProgress[] {
      return structuredClone([...rows.values()]);
    },
  };
}

export function assessmentAreas(statuses: readonly AreaStatusFact[]): ProgrammaticAssessmentArea[] {
  return statuses.slice(0, L.assessmentAreas).map((status) => ({
    id: status.id,
    label: clipText(status.label, L.label),
    status: status.status,
    ...(status.reason ? { reason: status.reason } : {}),
    retryable: status.status === "not-searched" && !!status.reason && RETRYABLE.has(status.reason),
  }));
}

export function withoutFinds(areas: ProgrammaticAreaProgress[]): ProgrammaticAreaProgress[] {
  return areas.map(({ finds: _finds, ...row }) => row);
}
