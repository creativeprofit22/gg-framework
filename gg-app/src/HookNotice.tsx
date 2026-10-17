import { useMemo } from "react";
import { CritterLine } from "./CritterLine";
import { hashKey, pickCritter } from "./critter-sprites";

/** Hook kinds the sidecar announces; mirrors the TUI's app-items.ts. */
export const HOOK_KINDS = ["ideal", "verification", "loop_break", "regrounding"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

export function isHookKind(value: string): value is HookKind {
  return (HOOK_KINDS as readonly string[]).includes(value);
}

/** Why a verification hook fired, when it isn't the plain pre-final run. */
export type VerificationReason = "recheck" | "check_review";

/**
 * Five critter-themed ways to say what each hook is doing, so repeated hooks
 * don't read the same. Each still says plainly what is happening: the theme is
 * the critter, not a riddle. A hook row always shows work in progress, so
 * every line is present tense ("A critter is …").
 */
export const HOOK_LINES = {
  /** Pre-final review of the answer. */
  ideal: [
    "A critter is giving the answer one more look…",
    "A critter is reviewing the work before it ships…",
    "A critter is double-checking the answer…",
    "A critter is sniffing out anything missed…",
    "A critter is inspecting the work before handing it over…",
  ],
  /** Pre-final run of the project's own checks. */
  verification: [
    "A critter is running the project's checks…",
    "A critter is testing the work before finishing…",
    "A critter is putting the changes through the checks…",
    "A critter is making sure the checks pass…",
    "A critter is kicking the tires before finishing…",
  ],
  /** Code changed after it was verified, so the checks run again. */
  recheck: [
    "A critter is re-checking the latest changes…",
    "A critter is checking the new edits again…",
    "A critter is re-running the checks on the fresh edits…",
    "A critter is double-checking what changed since the last check…",
    "A critter is giving the new edits another test…",
  ],
  /** Tests or check config were edited, so they get reviewed. */
  check_review: [
    "A critter is reviewing the changes to the tests…",
    "A critter is making sure the tests weren't weakened…",
    "A critter is inspecting the edited checks…",
    "A critter is sniffing the test changes for shortcuts…",
    "A critter is looking over the changed tests and checks…",
  ],
  loop_break: [
    "A critter is breaking up a stuck loop…",
    "A critter is pulling the agent out of a circle…",
    "A critter is steering out of a rut…",
    "A critter is stopping the loop and rethinking…",
    "A critter is trying a new path out of the loop…",
  ],
  /** After compaction, back to the original request. */
  regrounding: [
    "A critter is re-reading the original request…",
    "A critter is getting its bearings after the cleanup…",
    "A critter is checking the plan after compaction…",
    "A critter is retracing the original request…",
    "A critter is finding its place again after compaction…",
  ],
} as const satisfies Record<HookKind | VerificationReason, readonly string[]>;

/** The hook's line, picked stably from `variantKey`. */
export function describeHook(
  hook: HookKind,
  variantKey: string,
  verificationReason?: VerificationReason,
): string {
  const lines =
    HOOK_LINES[hook === "verification" && verificationReason ? verificationReason : hook];
  return lines[hashKey(variantKey) % lines.length] ?? "";
}

/**
 * A hook announcement in the transcript (the agent sending itself back to
 * review, verify, break a loop or re-ground). Rendered as a working critter
 * row (see CritterLine): a hopping critter in the dot's gutter beside
 * shimmering pink text. The critter and wording come from `variantKey`, so a
 * row keeps them across renders while separate hooks vary.
 */
export function HookNotice({
  hook,
  variantKey,
  verificationReason,
}: {
  hook: HookKind;
  variantKey: string;
  verificationReason?: VerificationReason | undefined;
}): React.ReactElement {
  const critter = useMemo(() => pickCritter(undefined, variantKey, new Set()), [variantKey]);
  return (
    <CritterLine
      critter={critter}
      tone="working"
      text={describeHook(hook, variantKey, verificationReason)}
    />
  );
}
