import { useMemo } from "react";
import { CritterLine } from "./CritterLine";
import { hashKey, pickCritter } from "./critter-sprites";
import { theme } from "./theme";

/** What the user did with a reviewed plan. */
export type PlanDecision = "accepted" | "feedback" | "rejected";

const COPY: Readonly<Record<PlanDecision, readonly string[]>> = {
  accepted: [
    "Plan accepted. The critters are building it",
    "Plan locked in. A critter took it to the workbench",
    "Plan approved. Building it step by step",
    "Plan accepted. Critters rolling up their sleeves",
  ],
  feedback: [
    "Feedback sent. A critter is redrafting the plan",
    "Back to the drawing board with your notes",
    "Notes delivered. The plan is getting a rewrite",
  ],
  rejected: ["Plan rejected. Nothing was built", "Plan shelved. The critters await new orders"],
};

/** Pick a stable line for this row, so re-renders never reshuffle it. */
export function describePlanDecision(decision: PlanDecision, variantKey: string): string {
  const lines = COPY[decision];
  return lines[hashKey(variantKey) % lines.length] ?? "";
}

/**
 * The transcript row a plan decision leaves behind, in the critter-line style
 * shared with hooks and compaction: a random critter in the assistant-dot
 * gutter beside bold plan-mode amber text. Accepting or revising shimmers
 * (the agent is off doing it); a rejection stands still in muted ink.
 */
export function PlanDecisionNotice({
  decision,
  variantKey,
}: {
  decision: PlanDecision;
  variantKey: string;
}): React.ReactElement {
  const critter = useMemo(
    () => pickCritter(undefined, `plan:${variantKey}`, new Set()),
    [variantKey],
  );
  const rejected = decision === "rejected";
  return (
    <CritterLine
      critter={critter}
      tone={rejected ? "stopped" : "working"}
      color={rejected ? theme.textMuted : theme.warning}
      text={describePlanDecision(decision, variantKey)}
    />
  );
}
