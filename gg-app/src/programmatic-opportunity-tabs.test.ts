// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  ProgrammaticChatConfiguration,
  ProgrammaticChatProposal,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type { DiscoveryCandidate } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import {
  initialProgrammaticChatState,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
import {
  opportunitySteps,
  stepFor,
  useChecksSkip,
  useOpportunityTab,
  type OpportunityStep,
  type OpportunityStepsInput,
} from "./programmatic-opportunity-tabs";

const hash = "a".repeat(64);
const missing: ProgrammaticChatConfiguration = {
  status: "missing",
  currentFingerprint: hash,
  refreshAvailable: false,
  baselineUnavailable: false,
  diagnostic: null,
  drift: null,
};
const current: ProgrammaticChatConfiguration = { ...missing, status: "current" };
const drift: ProgrammaticChatConfiguration = {
  ...current,
  status: "refresh-required",
  currentFingerprint: "b".repeat(64),
  refreshAvailable: true,
};
const proposal = {
  handle: hash,
  operation: "initial",
  configuration: missing,
  fingerprint: hash,
  profileJson: "exact profile",
  routes: [],
  exclusions: [],
  configurationInputs: [],
} satisfies ProgrammaticChatProposal;
const discovery = {
  assessmentId: "assessment-1",
  candidates: [] as DiscoveryCandidate[],
};

const state = (patch: Partial<ProgrammaticChatState> = {}): ProgrammaticChatState => ({
  ...initialProgrammaticChatState("generation-1"),
  ...patch,
});
const derive = (patch: Partial<OpportunityStepsInput> = {}) =>
  opportunitySteps({
    state: state(),
    showProposal: false,
    checksSkipped: false,
    planMode: false,
    busy: false,
    shown: "checks",
    ...patch,
  });
const words = (result: ReturnType<typeof derive>) =>
  Object.fromEntries(result.steps.map((step) => [step.id, step.state])) as Record<
    OpportunityStep,
    string
  >;

describe("opportunitySteps", () => {
  it("starts a brand-new project on Quick checks with Show suggested checks", () => {
    const result = derive();
    expect(result.steps.map(({ id, number }) => `${number} ${id}`)).toEqual([
      "1 checks",
      "2 ideas",
      "3 review",
    ]);
    expect(words(result)).toEqual({ checks: "next", ideas: "not-yet", review: "not-yet" });
    expect(result.keyAction).toEqual({
      action: "inspect-setup",
      label: "Show suggested checks",
      quiet: false,
      disabled: false,
    });
  });

  it("targets Save checks while an approvable proposal is open", () => {
    const result = derive({
      state: state({ configuration: missing, proposal, proposalApprovable: true }),
      showProposal: true,
    });
    expect(result.next).toBe("checks");
    expect(result.keyAction).toMatchObject({ action: "approve-setup", label: "Save checks" });
    // A closed or stale proposal falls back to showing the checks again.
    expect(
      derive({ state: state({ configuration: missing, proposal, proposalApprovable: false }) })
        .keyAction,
    ).toMatchObject({ action: "inspect-setup", label: "Show suggested checks" });
  });

  it("marks saved checks Done and moves Next to Find ideas", () => {
    const result = derive({ state: state({ configuration: current }) });
    expect(words(result)).toEqual({ checks: "done", ideas: "next", review: "not-yet" });
    expect(result.keyAction).toMatchObject({ action: "discover", label: "Find ideas" });
  });

  it("passes over skipped checks without calling them Done", () => {
    const result = derive({ state: state({ configuration: missing }), checksSkipped: true });
    expect(words(result)).toEqual({ checks: "not-yet", ideas: "next", review: "not-yet" });
    expect(result.keyAction).toMatchObject({ action: "discover", label: "Find ideas" });
  });

  it("moves to Review once fresh ideas are found, then quietly offers Search again", () => {
    const found = state({ configuration: current, discovery });
    const result = derive({ state: found });
    expect(words(result)).toEqual({ checks: "done", ideas: "done", review: "next" });
    expect(result.keyAction).toEqual({
      action: "open-review",
      label: "Open review",
      quiet: false,
      disabled: false,
    });
    expect(derive({ state: found, shown: "review" }).keyAction).toMatchObject({
      action: "discover",
      label: "Search again",
      quiet: true,
    });
    // Ideas after a skip still reach Review.
    expect(derive({ state: state({ discovery }), checksSkipped: true }).next).toBe("review");
  });

  it("returns to Find ideas while searching, uncertain or stale", () => {
    expect(
      derive({ state: state({ configuration: current, discovery, discoveryStale: true }) }),
    ).toMatchObject({ next: "ideas", keyAction: { action: "discover", label: "Search again" } });
    expect(
      derive({ state: state({ configuration: current, discovery, assessmentPending: true }) }).next,
    ).toBe("ideas");
    expect(
      derive({ state: state({ configuration: current, discovery, assessmentUncertain: true }) })
        .next,
    ).toBe("ideas");
  });

  it("lights Quick checks again with Update checks when project files change", () => {
    const result = derive({ state: state({ configuration: drift, discovery }) });
    expect(words(result)).toEqual({ checks: "next", ideas: "done", review: "not-yet" });
    expect(result.keyAction).toMatchObject({ action: "inspect-setup", label: "Update checks" });
    // An unreadable setup is incomplete too.
    expect(
      derive({ state: state({ configuration: { ...current, status: "unreadable" } }) }).next,
    ).toBe("checks");
  });

  it("keeps step states on error and only disables the key during reconcile", () => {
    const base = state({ configuration: current });
    const failed = derive({ state: { ...base, error: "daemon down", reconcile: true } });
    expect(words(failed)).toEqual(words(derive({ state: base })));
    expect(failed.keyAction).toMatchObject({ action: "discover", disabled: true });
    expect(derive({ state: { ...base, error: "daemon down" } }).keyAction.disabled).toBe(false);
  });

  it("keeps step states in plan mode and disables the key", () => {
    const planned = derive({ state: state({ configuration: current }), planMode: true });
    expect(words(planned)).toEqual({ checks: "done", ideas: "next", review: "not-yet" });
    expect(planned.keyAction.disabled).toBe(true);
    expect(derive({ planMode: true }).keyAction).toMatchObject({
      action: "inspect-setup",
      disabled: true,
    });
  });

  it("disables the key while work runs", () => {
    expect(derive({ busy: true }).keyAction.disabled).toBe(true);
    expect(derive({ state: state({ operation: "report" }) }).keyAction.disabled).toBe(true);
  });

  it("names exactly one Next step in every state", () => {
    const inputs: Partial<OpportunityStepsInput>[] = [
      {},
      { state: state({ configuration: current }) },
      { checksSkipped: true },
      { state: state({ configuration: current, discovery }) },
      { state: state({ configuration: drift }) },
      { planMode: true, state: state({ error: "x" }) },
    ];
    for (const input of inputs)
      expect(derive(input).steps.filter((step) => step.state === "next")).toHaveLength(1);
  });
});

describe("useChecksSkip", () => {
  it("lasts for the session and lapses when project files change", () => {
    const { result, rerender } = renderHook(
      ({ configuration }: { configuration: ProgrammaticChatConfiguration | null }) =>
        useChecksSkip(configuration),
      { initialProps: { configuration: missing } },
    );
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    rerender({ configuration: { ...missing } });
    expect(result.current[0]).toBe(true);
    rerender({ configuration: drift });
    expect(result.current[0]).toBe(false);
  });

  it("keeps a skip made before the setup is known until project files change", () => {
    const { result, rerender } = renderHook(
      ({ configuration }: { configuration: ProgrammaticChatConfiguration | null }) =>
        useChecksSkip(configuration),
      { initialProps: { configuration: null as ProgrammaticChatConfiguration | null } },
    );
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    rerender({ configuration: missing });
    expect(result.current[0]).toBe(true);
    rerender({ configuration: { ...missing } });
    expect(result.current[0]).toBe(true);
    rerender({ configuration: drift });
    expect(result.current[0]).toBe(false);
  });
});

describe("useOpportunityTab", () => {
  it("follows Next until the user picks a step, and holds the pick until the selection changes", () => {
    const { result, rerender } = renderHook(
      ({ chat, next }: { chat: ProgrammaticChatState; next: OpportunityStep }) =>
        useOpportunityTab(chat, false, next),
      { initialProps: { chat: state(), next: "checks" as OpportunityStep } },
    );
    expect(result.current[0]).toBe("checks");
    rerender({ chat: state(), next: "ideas" });
    expect(result.current[0]).toBe("ideas");
    act(() => result.current[1]("checks"));
    rerender({ chat: state(), next: "review" });
    expect(result.current[0]).toBe("checks");
    rerender({ chat: state({ selection: { source: "current", id: "idea-1" } }), next: "review" });
    expect(result.current[0]).toBe("review");
  });
});

describe("stepFor", () => {
  it("opens Quick checks for a setup review and Review for a picked result", () => {
    expect(stepFor(state(), true)).toBe("checks");
    expect(stepFor(state({ selectedId: "row-1" }), false)).toBe("review");
    expect(stepFor(state({ selection: { source: "current", id: "idea-1" } }), false)).toBe(
      "review",
    );
    expect(stepFor(state({ selection: { source: "history", id: "idea-1" } }), false)).toBeNull();
    expect(stepFor(state(), false)).toBeNull();
  });
});
