import crypto from "node:crypto";
import type { ToolOperations } from "./operations.js";

/** A 1-based, inclusive range of line numbers. */
export type LineRange = readonly [start: number, end: number];

export interface ReadEntry {
  mtimeMs: number;
  hash: string;
  /** Lines in the content `hash` covers (a trailing newline does not add one). */
  lineCount: number;
  /**
   * How much of that content the model has been shown: `"all"`, or the merged,
   * sorted line ranges seen so far. A full-file `write` requires `"all"`.
   */
  seen: "all" | readonly LineRange[];
}

export type ReadTracker = Map<string, ReadEntry>;

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Line count as the read tool numbers lines, not counting the empty "line" after a final newline. */
export function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Clamp `ranges` to the file and collapse them to `"all"` once they cover every line. */
function toSeen(ranges: readonly LineRange[], lineCount: number): ReadEntry["seen"] {
  if (lineCount === 0) return "all";
  const merged = mergeRanges(
    ranges
      .map(([start, end]): LineRange => [Math.max(1, start), Math.min(lineCount, end)])
      .filter(([start, end]) => start <= end),
  );
  const only = merged.length === 1 ? merged[0] : undefined;
  return only && only[0] === 1 && only[1] === lineCount ? "all" : merged;
}

/**
 * Record that the model was shown `shown` (default: every line) of `content`.
 * Reads of unchanged content accumulate, so paging through a long file with
 * offset/limit eventually counts as having seen all of it.
 */
export function recordRead(
  tracker: ReadTracker | undefined,
  resolvedPath: string,
  content: string,
  mtimeMs: number,
  shown?: LineRange,
): void {
  if (!tracker) return;
  const hash = hashContent(content);
  const lineCount = countLines(content);
  const previous = tracker.get(resolvedPath);
  let seen: ReadEntry["seen"];
  if (!shown) {
    seen = "all";
  } else if (previous?.hash === hash) {
    seen = previous.seen === "all" ? "all" : toSeen([...previous.seen, shown], lineCount);
  } else {
    seen = toSeen([shown], lineCount);
  }
  tracker.set(resolvedPath, { mtimeMs, hash, lineCount, seen });
}

/**
 * Record the model's own change to a file. `write` supplies every line itself,
 * so the model knows the whole result. `edit` changes only part of a file, so
 * it knows the whole result only if it had already seen all of the original.
 */
export async function recordWrite(
  tracker: ReadTracker | undefined,
  resolvedPath: string,
  content: string,
  ops: ToolOperations,
  scope: "whole" | "edit" = "whole",
): Promise<void> {
  if (!tracker) return;
  const stat = await ops.stat(resolvedPath);
  const knewAll = scope === "whole" || tracker.get(resolvedPath)?.seen === "all";
  tracker.set(resolvedPath, {
    mtimeMs: stat.mtimeMs,
    hash: hashContent(content),
    lineCount: countLines(content),
    // An edit shifts line numbers, so ranges seen before it no longer line up.
    seen: knewAll ? "all" : [],
  });
}

/**
 * Verify the file hasn't been modified since it was last read.
 * Throws if unread, or if mtime AND hash differ from the recorded value.
 * mtime alone is not sufficient — some filesystems have low resolution and
 * formatters can rewrite a file with the same mtime; we re-hash on mtime miss.
 */
export async function assertFresh(
  tracker: ReadTracker | undefined,
  resolvedPath: string,
  ops: ToolOperations,
): Promise<void> {
  if (!tracker) return;
  if (!tracker.has(resolvedPath)) {
    throw new Error("File must be read first before editing. Use the read tool first.");
  }
  if (await isFresh(tracker, resolvedPath, ops)) return;
  throw new Error(
    "File has been modified since it was read (likely by a formatter, linter, or external tool). " +
      "Re-read the file before editing.",
  );
}

/**
 * True when the recorded read still matches disk (mtime, else content hash).
 * A hash match after an mtime-only change refreshes the recorded mtime.
 */
export async function isFresh(
  tracker: ReadTracker,
  resolvedPath: string,
  ops: ToolOperations,
): Promise<boolean> {
  const entry = tracker.get(resolvedPath);
  if (!entry) return false;
  const stat = await ops.stat(resolvedPath);
  if (stat.mtimeMs === entry.mtimeMs) return true;
  const current = await ops.readFile(resolvedPath);
  if (hashContent(current) !== entry.hash) return false;
  tracker.set(resolvedPath, { ...entry, mtimeMs: stat.mtimeMs });
  return true;
}

/**
 * Throw unless the model has been shown every line of the file as it is now.
 * `write` replaces the whole file, so after a read cut short by offset/limit or
 * the read tool's size cap it would silently drop the lines the model never
 * saw. Call after {@link assertFresh}, which guarantees the entry matches disk.
 */
export function assertFullySeen(tracker: ReadTracker | undefined, resolvedPath: string): void {
  const entry = tracker?.get(resolvedPath);
  if (!entry || entry.seen === "all") return;
  const consequence =
    "write replaces the whole file, so it would drop the lines you have not seen. " +
    "Read the whole file first";
  const first = entry.seen[0];
  if (!first) {
    throw new Error(
      `You have not seen this file's current ${entry.lineCount} lines in full. ` +
        `${consequence}, or use edit for a targeted change.`,
    );
  }
  const ranges = entry.seen
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(", ");
  const nextUnread = first[0] > 1 ? 1 : first[1] + 1;
  throw new Error(
    `You have only seen lines ${ranges} of ${entry.lineCount} in this file. ` +
      `${consequence} (next unread line: offset=${nextUnread}), or use edit for a targeted change.`,
  );
}
