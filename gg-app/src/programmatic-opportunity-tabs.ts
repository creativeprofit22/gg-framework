import { useState } from "react";
import type { ProgrammaticChatConfiguration } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { programmaticConfiguration, type ProgrammaticChatState } from "./programmatic-chat-state";
import { CHECKS_ACTIONS, STEP_ACTIONS, checksReviewLabel } from "./programmatic-presentation";

/** Fixed order: 1 Quick checks, 2 Find ideas, 3 Review. Every step stays selectable. */
export const OPPORTUNITY_STEPS = ["checks", "ideas", "review"] as const;
export type OpportunityStep = (typeof OPPORTUNITY_STEPS)[number];
export type OpportunityStepState = "done" | "next" | "not-yet";

/** What the header's alloy key does. `quiet` dims it when the shown step owns its own actions. */
export interface OpportunityKeyAction {
  action: "approve-setup" | "inspect-setup" | "discover" | "open-review";
  label: string;
  quiet: boolean;
  disabled: boolean;
}

export interface OpportunityStepsInput {
  state: ProgrammaticChatState;
  showProposal: boolean;
  /** Session-only Skip for now on step 1; see useChecksSkip. */
  checksSkipped: boolean;
  planMode: boolean;
  /** Chat work is running; with an in-flight operation this disables the key. */
  busy: boolean;
  /** The step on screen, so the key does not reopen Review while it is shown. */
  shown: OpportunityStep;
}

export interface OpportunitySteps {
  steps: readonly { id: OpportunityStep; number: number; state: OpportunityStepState }[];
  next: OpportunityStep;
  keyAction: OpportunityKeyAction;
  /** Step 2's search, so Find ideas works from step 2 even before checks are saved. */
  search: OpportunityKeyAction;
}

/** Saved checks match the project. Missing, out of date, unreadable or unknown are incomplete. */
function checksDone(configuration: ProgrammaticChatConfiguration | null): boolean {
  return configuration?.status === "current" && !configuration.refreshAvailable;
}

/** A finished, fresh search. Searching, stale, uncertain or no search are incomplete. */
function ideasDone(state: ProgrammaticChatState): boolean {
  return (
    !!state.discovery &&
    !state.discoveryStale &&
    !state.assessmentPending &&
    !state.assessmentUncertain
  );
}

/** The step to do next: unsaved checks (unless skipped), then a fresh search, then Review. */
export function nextOpportunityStep(
  state: ProgrammaticChatState,
  checksSkipped: boolean,
): OpportunityStep {
  if (!checksDone(programmaticConfiguration(state)) && !checksSkipped) return "checks";
  return ideasDone(state) ? "review" : "ideas";
}

/**
 * The single owner of step order and state. Exactly one step is Next; Review is
 * never Done. Errors and plan mode never change step states, only the key.
 */
export function opportunitySteps({
  state,
  showProposal,
  checksSkipped,
  planMode,
  busy,
  shown,
}: OpportunityStepsInput): OpportunitySteps {
  const configuration = programmaticConfiguration(state);
  const checks = checksDone(configuration);
  const ideas = ideasDone(state);
  const next = nextOpportunityStep(state, checksSkipped);
  const done: Record<OpportunityStep, boolean> = { checks, ideas, review: false };
  const steps = OPPORTUNITY_STEPS.map((id, index) => {
    const stepState: OpportunityStepState = id === next ? "next" : done[id] ? "done" : "not-yet";
    return { id, number: index + 1, state: stepState };
  });

  const locked = busy || state.operation !== null;
  const searchLocked = locked || planMode || state.reconcile;
  const search = (quiet: boolean): OpportunityKeyAction => ({
    action: "discover",
    label:
      state.discoveryStale && state.discovery ? STEP_ACTIONS.searchAgain : STEP_ACTIONS.findIdeas,
    quiet,
    disabled: searchLocked,
  });
  let keyAction: OpportunityKeyAction;
  if (next === "checks") {
    keyAction =
      showProposal && state.proposalApprovable && state.proposal?.handle
        ? {
            action: "approve-setup",
            label: CHECKS_ACTIONS.save,
            quiet: false,
            disabled: searchLocked,
          }
        : {
            action: "inspect-setup",
            label: checksReviewLabel(configuration),
            quiet: false,
            disabled: locked || planMode,
          };
  } else if (next === "ideas") {
    keyAction = search(false);
  } else if (shown !== "review") {
    keyAction = {
      action: "open-review",
      label: STEP_ACTIONS.openReview,
      quiet: false,
      disabled: false,
    };
  } else {
    // Review's actions are per item, so the key falls back to a quiet search.
    keyAction = { ...search(true), label: STEP_ACTIONS.searchAgain };
  }
  return { steps, next, keyAction, search: search(true) };
}

/**
 * The step a selection or open setup review belongs to; null lets the step follow
 * Next. Past-idea selections open the Past ideas region instead of a step.
 */
export function stepFor(
  state: ProgrammaticChatState,
  showProposal: boolean,
): OpportunityStep | null {
  if (showProposal) return "checks";
  // A remembered check selection keeps Review open, even while its detail is missing.
  if (
    state.selection?.source === "deterministic" ||
    state.selection?.source === "current" ||
    (!state.selection && (state.detail || state.selectedId || state.missingSelection))
  )
    return "review";
  return null;
}

/**
 * The shown step. A user's choice holds until the selection or setup review
 * changes; until then the step follows the data, so results that load after
 * opening still pick the right step.
 */
export function useOpportunityTab(
  state: ProgrammaticChatState,
  showProposal: boolean,
  next: OpportunityStep,
): readonly [OpportunityStep, (step: OpportunityStep) => void] {
  const wanted = stepFor(state, showProposal);
  const key = `${wanted}:${state.selection?.source ?? ""}:${state.selection?.id ?? state.selectedId ?? ""}:${showProposal}`;
  const [chosen, setChosen] = useState<{ step: OpportunityStep; key: string } | null>(null);
  const step: OpportunityStep = chosen?.key === key ? chosen.step : (wanted ?? next);
  return [step, (picked) => setChosen({ step: picked, key })];
}

const skipKey = (configuration: ProgrammaticChatConfiguration | null): string =>
  `${configuration?.status ?? "none"}:${configuration?.currentFingerprint ?? ""}`;

/**
 * Skip for now on step 1: component state only, never saved or shared. It lapses
 * when the setup status or fingerprint changes, so changed project files light
 * step 1 again. A skip made before the setup is known (first report still
 * loading) adopts the first known status and fingerprint, so the report arriving
 * does not undo it; only a later change lapses it.
 */
export function useChecksSkip(
  configuration: ProgrammaticChatConfiguration | null,
): readonly [boolean, () => void] {
  // `unknown` = skipped before any setup was known; it binds to the first known key.
  const [skipped, setSkipped] = useState<{ key: string } | { unknown: true } | null>(null);
  const key = configuration ? skipKey(configuration) : null;
  if (skipped && "unknown" in skipped && key !== null) {
    // Adjust state during render (React's derived-state pattern); runs once per adoption.
    setSkipped({ key });
    return [true, () => setSkipped({ key })];
  }
  const active = skipped !== null && ("unknown" in skipped ? key === null : skipped.key === key);
  return [active, () => setSkipped(key === null ? { unknown: true } : { key })];
}
