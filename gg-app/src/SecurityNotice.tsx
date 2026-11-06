import { useMemo } from "react";
import { CritterLine } from "./CritterLine";
import { pickCritter } from "./critter-sprites";
import { theme } from "./theme";
import { safetyRuleReason } from "./tool-format";

/** The row's wording: what happened, in plain words, then what it was about. */
export function describeSecurityBlock(rule: string, target: string, count = 1): string {
  const lead =
    rule === "installed-malware"
      ? "Infected package in this project, replacing it"
      : `Blocked for safety: ${safetyRuleReason(rule)}`;
  const text = target ? `${lead} \u00b7 ${target}` : lead;
  return count > 1 ? `${text} \u00d7${count}` : text;
}

/**
 * The chat row a safety block leaves behind, in the critter-line style shared
 * with hooks, compaction and plan decisions: a standing critter beside amber
 * text. It never asks anything; it's the lasting record of what was stopped.
 */
export function SecurityNotice({
  rule,
  target,
  count,
  variantKey,
}: {
  rule: string;
  target: string;
  count?: number;
  variantKey: string;
}): React.ReactElement {
  const critter = useMemo(
    () => pickCritter(undefined, `security:${variantKey}`, new Set()),
    [variantKey],
  );
  return (
    <CritterLine
      critter={critter}
      tone="stopped"
      color={theme.warning}
      text={describeSecurityBlock(rule, target, count)}
    />
  );
}
