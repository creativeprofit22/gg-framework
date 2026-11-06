// Local Fork-owned: freshness guards for re-searching one area from the session-memory cache.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProgrammaticAreaMapV1 } from "./area-map.js";
import type { AreaPassOutcome } from "./area-search.js";
import type { AreaSearchCache } from "./area-progress.js";

/** Typed fail-closed refusal: thrown before any event, sequence change or provider call. */
export class AreaRetryUnavailableError extends Error {
  override readonly name = "AreaRetryUnavailableError";
  constructor(readonly reason: "no-search" | "not-retryable" | "changed") {
    super("This area cannot be searched again. Search again instead.");
  }
}

const MAX_CITED_FILES = 256;
const RETRYABLE = new Set(["failed", "timed-out", "no-result"]);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** History counts drift with every commit, so only the observed-path structure is compared. */
export function structuralAreaMapDigest(areaMap: ProgrammaticAreaMapV1): string {
  const areas = [...areaMap.areas]
    .map((area) => ({ ...area, signals: { ...area.signals, recentChanges: null } }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return sha256(JSON.stringify({ ...areaMap, areas, history: null }));
}

function citedPaths(passes: readonly { outcome: AreaPassOutcome }[]): string[] | null {
  const paths = new Set<string>();
  for (const { outcome } of passes) {
    if (outcome.status === "incomplete") continue;
    for (const receipt of outcome.receipts) {
      if (receipt.status !== "retrieved" || receipt.external) continue;
      for (const location of receipt.locations ?? []) paths.add(location.path);
      if (receipt.location && !receipt.locations) paths.add(receipt.location);
    }
  }
  return paths.size > MAX_CITED_FILES ? null : [...paths].sort();
}

/** Content digests of every local file the kept areas cited; `null` means unverifiable. */
export async function citedFileDigests(
  root: string,
  passes: readonly { outcome: AreaPassOutcome }[],
  signal: AbortSignal,
): Promise<Record<string, string> | null> {
  const paths = citedPaths(passes);
  if (!paths) return null;
  const digests: Record<string, string> = {};
  for (const path of paths) {
    signal.throwIfAborted();
    const absolute = resolve(root, path);
    const inside = relative(root, absolute);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
    digests[path] = await readFile(absolute, { signal }).then(sha256, (error: unknown) => {
      signal.throwIfAborted();
      return error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "missing"
        : "unreadable";
    });
  }
  return digests;
}

export function retryTarget(cache: AreaSearchCache, areaId: string) {
  const target = cache.passes.find(({ area }) => area.id === areaId);
  if (!target || target.outcome.status !== "incomplete" || !RETRYABLE.has(target.outcome.reason))
    return null;
  return target.area;
}

/** Recomputes freshness; any difference refuses the retry. */
export async function assertAreaRetryFresh(
  root: string,
  cache: AreaSearchCache,
  areaMap: ProgrammaticAreaMapV1,
  signal: AbortSignal,
): Promise<void> {
  if (structuralAreaMapDigest(areaMap) !== cache.areaMapDigest || !cache.citedFiles)
    throw new AreaRetryUnavailableError("changed");
  const kept = cache.passes;
  const now = await citedFileDigests(root, kept, signal);
  if (!now || JSON.stringify(now) !== JSON.stringify(cache.citedFiles))
    throw new AreaRetryUnavailableError("changed");
}
