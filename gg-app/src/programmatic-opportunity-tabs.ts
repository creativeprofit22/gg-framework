import { useState } from "react";
import { programmaticConfiguration, type ProgrammaticChatState } from "./programmatic-chat-state";

/** Fixed order: Ideas, Checks, Past ideas. */
export type OpportunityTab = "ideas" | "checks" | "past";

/** The tab a selection or open setup review belongs to; null leaves the user's tab alone. */
export function tabFor(state: ProgrammaticChatState, showProposal: boolean): OpportunityTab | null {
  if (state.selection?.source === "history") return "past";
  // A remembered check selection keeps Checks open, even while its detail is missing.
  if (
    state.selection?.source === "deterministic" ||
    (!state.selection && (state.detail || state.selectedId || state.missingSelection))
  )
    return "checks";
  if (showProposal) return "checks";
  return null;
}

/**
 * The open tab. A user's choice holds until the selection or setup review changes;
 * until then the tab follows the data, so results that load after opening still
 * pick the right tab.
 */
export function useOpportunityTab(
  state: ProgrammaticChatState,
  showProposal: boolean,
): readonly [OpportunityTab, (next: OpportunityTab) => void] {
  const wanted = tabFor(state, showProposal);
  const key = `${wanted}:${state.selection?.source ?? ""}:${state.selection?.id ?? state.selectedId ?? ""}:${showProposal}`;
  const [chosen, setChosen] = useState<{ tab: OpportunityTab; key: string } | null>(null);
  const hasSuggestions = !!state.discovery || !!state.assessment || !!state.candidateDetail;
  const tab: OpportunityTab =
    chosen?.key === key
      ? chosen.tab
      : (wanted ?? (hasSuggestions || !state.report?.total ? "ideas" : "checks"));
  return [tab, (next) => setChosen({ tab: next, key })];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The header's one-line status: idea search, then saved checks. */
export function opportunityStatusLine(state: ProgrammaticChatState): string {
  const total = state.report?.total;
  return [
    state.assessmentPending
      ? "Searching"
      : state.discovery
        ? plural(state.discovery.candidates.length, "idea", "ideas")
        : state.assessment
          ? "Search done"
          : "No search yet",
    programmaticConfiguration(state)?.status === "current"
      ? total
        ? plural(total, "check result", "check results")
        : "Checks set up"
      : "Checks not set up",
  ].join(" · ");
}
