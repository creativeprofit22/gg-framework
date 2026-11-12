import { useMemo } from "react";
import { CritterLine } from "./CritterLine";
import { hashKey, pickCritter } from "./critter-sprites";

interface Props {
  status: "running" | "done";
  /** Stable per notice: picks the critter and the wording. */
  variantKey: string;
  originalCount?: number;
  newCount?: number;
}

/**
 * Five ways to say each state, so back-to-back compactions don't repeat
 * themselves. `{from}` / `{to}` are the message counts before and after.
 */
export const COMPACTION_LINES = {
  running: [
    "A critter is munching on the context…",
    "A critter is chewing through old messages…",
    "A critter is stuffing the context into its cheeks…",
    "A critter is sorting through the pile…",
    "A critter is tidying up the context…",
  ],
  done: [
    "A critter ate {from} messages and spat out {to}",
    "A critter chewed {from} messages down to {to}",
    "A critter packed {from} messages into {to}",
    "A critter tidied {from} messages into {to}",
    "A critter squished {from} messages down to {to}",
  ],
  /** Done, but the counts weren't recorded (older resumed sessions). */
  doneNoCounts: [
    "A critter ate the old messages",
    "A critter chewed the context down",
    "A critter packed the context away",
    "A critter tidied up the context",
    "A critter squished the context down",
  ],
} as const satisfies Record<string, readonly string[]>;

/** The notice's wording for its state, picked stably from `variantKey`. */
export function describeCompaction(
  status: Props["status"],
  variantKey: string,
  originalCount?: number,
  newCount?: number,
): string {
  const pick = (lines: readonly string[]): string =>
    lines[hashKey(variantKey) % lines.length] ?? "";
  if (status === "running") return pick(COMPACTION_LINES.running);
  if (originalCount == null || newCount == null) return pick(COMPACTION_LINES.doneNoCounts);
  return pick(COMPACTION_LINES.done)
    .replace("{from}", String(originalCount))
    .replace("{to}", String(newCount));
}

/**
 * Context-compaction notice in the transcript, styled like the sub-agent row
 * (see CritterLine): a critter stands in for the status dot, hopping beside
 * shimmering pink text while it works, then settling into a green line. The
 * critter and wording come from `variantKey`, so a notice keeps the same
 * critter from "working" to "done" while separate compactions vary.
 */
export function CompactionNotice({
  status,
  variantKey,
  originalCount,
  newCount,
}: Props): React.ReactElement {
  const critter = useMemo(() => pickCritter(undefined, variantKey, new Set()), [variantKey]);
  return (
    <CritterLine
      critter={critter}
      tone={status === "running" ? "working" : "done"}
      text={describeCompaction(status, variantKey, originalCount, newCount)}
    />
  );
}
