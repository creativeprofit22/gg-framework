import { describe, expect, it } from "vitest";
import type { DiscoveryChoice } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import {
  IDEA_VERDICTS,
  PAST_IDEA_DECISION_LABELS,
  REVIEW_GROUPS,
  STEP_ACTIONS,
  STEP_COPY,
  STEP_STATE_WORDS,
  ideaVerdict,
  opportunityStatusLine,
  plainLimitation,
  reviewHint,
  reviewLabel,
  seenCount,
} from "./programmatic-presentation";
import { OPPORTUNITY_STEPS } from "./programmatic-opportunity-tabs";
import {
  initialProgrammaticChatState,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";

// Compile-time exhaustive: a new gg-core choice fails typecheck here until it is listed.
const CHOICES = Object.keys({
  "reuse-command": true,
  "extend-command": true,
  "missing-capability": true,
  "needs-more-evidence": true,
  manual: true,
  "generate-from-reference": true,
} satisfies Record<DiscoveryChoice, true>) as DiscoveryChoice[];

describe("programmatic presentation", () => {
  it("gives every discovery choice one plain verdict", () => {
    expect(Object.keys(IDEA_VERDICTS).sort()).toEqual([...CHOICES].sort());
    for (const choice of CHOICES) {
      const verdict = IDEA_VERDICTS[choice];
      expect(verdict.plate.length).toBeLessThanOrEqual(24);
      expect(verdict.yourPart).toMatch(/^(Nothing|Optional|Your call)/);
    }
    expect(IDEA_VERDICTS.manual.plate).toBe("Nothing to do");
    expect(IDEA_VERDICTS["reuse-command"].plate).toBe("Already handled");
  });

  it("does not call an unconfirmed command already handled", () => {
    const missing = { choice: "reuse-command" as const, availability: undefined };
    expect(ideaVerdict(missing).plate).toBe("Check your command");
    expect(ideaVerdict(missing).tone).toBe("warning");
    expect(reviewLabel(missing)).toBe("Check the command again");
    expect(reviewHint(missing)).toBe("AI checks the command again. Nothing is changed or run.");
    expect(ideaVerdict(missing).yourPart).toBe(
      "Check the command again. AI couldn't confirm it still works here.",
    );
    const idea = { choice: "missing-capability" as const, availability: undefined };
    expect(ideaVerdict(idea).plate).toBe("Needs a new command");
    expect(ideaVerdict(idea).yourPart).toBe(
      "Your call. Review the idea if you want this command made.",
    );
    expect(reviewLabel(idea)).toBe("Review this idea");
    expect(reviewHint(idea)).toBe("AI explains the exact change first. Nothing is changed or run.");
  });

  it("names every step in plain words, with a status word for every state", () => {
    expect(OPPORTUNITY_STEPS.map((step) => STEP_COPY[step].label)).toEqual([
      "Quick checks",
      "Find ideas",
      "Review",
    ]);
    for (const step of OPPORTUNITY_STEPS) expect(STEP_COPY[step].intro).toMatch(/^[A-Z].+\.$/);
    expect(STEP_COPY.checks.intro).toBe(
      "Free checks that look for known setup problems. They don't use AI.",
    );
    expect(Object.values(STEP_STATE_WORDS).map(({ word }) => word)).toEqual([
      "Done",
      "Next",
      "Not yet",
    ]);
    expect(STEP_ACTIONS.skip).toBe("Skip for now");
    expect(REVIEW_GROUPS).toEqual({ ready: "Ready to run", ideas: "Ideas" });
  });

  it("words saved checks by configuration status in the header line", () => {
    const base = initialProgrammaticChatState("one");
    const configuration = {
      status: "missing" as const,
      currentFingerprint: "a".repeat(64),
      refreshAvailable: false,
      baselineUnavailable: false,
      diagnostic: null,
      drift: null,
    };
    const line = (patch: Partial<ProgrammaticChatState>) =>
      opportunityStatusLine({ ...base, ...patch });
    expect(line({})).toBe("No search yet · Checks not set up");
    expect(line({ configuration })).toBe("No search yet · Checks not set up");
    expect(line({ configuration: { ...configuration, status: "current" } })).toBe(
      "No search yet · Checks set up",
    );
    expect(
      line({
        configuration: { ...configuration, status: "refresh-required", refreshAvailable: true },
      }),
    ).toBe("No search yet · Checks need updating");
    expect(line({ configuration: { ...configuration, status: "unreadable" } })).toBe(
      "No search yet · Checks can't be read",
    );
  });

  it("explains each past-idea decision in words", () => {
    expect(PAST_IDEA_DECISION_LABELS).toEqual({
      open: "Still open: not acted on yet",
      completed: "Done: you handled this",
      dismissed: "Dismissed: you said no",
    });
  });

  it("counts searches with the right plural", () => {
    expect(seenCount(1)).toBe("Found in 1 search");
    expect(seenCount(3)).toBe("Found in 3 searches");
  });

  it("translates saved tool-failure lines without touching other text", () => {
    expect(plainLimitation("programmatic_advisory_result: tool error.")).toBe(
      "Saving the answer failed, so this search may have missed something.",
    );
    expect(plainLimitation("Some files were skipped. web_fetch: cancelled. Done.")).toBe(
      "Some files were skipped. Opening a web page was stopped, so this search may have missed something. Done.",
    );
    expect(plainLimitation("grep: tool error.")).toBe(
      "Reading project files failed, so this search may have missed something.",
    );
    // Matches backend plainToolLimitation("programmatic_scan", false).
    expect(plainLimitation("programmatic_scan: tool error.")).toBe(
      "Running your project checks failed, so this search may have missed something.",
    );
    expect(plainLimitation("Nothing technical here: really.")).toBe(
      "Nothing technical here: really.",
    );
  });

  it("words every tool exactly like the backend plainToolLimitation()", () => {
    // Copied from packages/ggcoder/src/core/programmatic/advisory.ts TOOL_LABELS
    // and advisory.test.ts ("words host limitations…"); keep both in sync.
    const backendLabels: ReadonlyArray<readonly [string, string]> = [
      ["programmatic_scan", "Running your project checks"],
      ["programmatic_advisory_result", "Saving the answer"],
      ["programmatic_profile", "Reading your check setup"],
      ["command_information", "Reading your commands"],
      ["research_corpus", "Searching code examples"],
      ["web_fetch", "Opening a web page"],
      ["web_search", "Searching the web"],
      ["read", "Reading project files"],
      ["find", "Reading project files"],
      ["grep", "Reading project files"],
      ["ls", "Reading project files"],
      ["code_search", "Reading project files"],
      ["code_nav", "Reading project files"],
    ];
    for (const [tool, label] of backendLabels) {
      expect(plainLimitation(`${tool}: tool error.`)).toBe(
        `${label} failed, so this search may have missed something.`,
      );
      expect(plainLimitation(`${tool}: cancelled.`)).toBe(
        `${label} was stopped, so this search may have missed something.`,
      );
    }
    expect(plainLimitation("programmatic_advisory_result: tool error.")).toBe(
      "Saving the answer failed, so this search may have missed something.",
    );
    expect(plainLimitation("grep: cancelled.")).toBe(
      "Reading project files was stopped, so this search may have missed something.",
    );
    expect(plainLimitation("some_new_tool: tool error.")).toBe(
      "One of AI's checks failed, so this search may have missed something.",
    );
  });
});
