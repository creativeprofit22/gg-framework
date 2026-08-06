import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildIdealReviewMessage,
  buildReviewCoverageEscalationMessage,
  buildReviewCoverageMessage,
  detectTestDrift,
  evaluateIdealReview,
  MAX_REVIEW_COVERAGE_INJECTIONS,
  ReviewCoverageTracker,
  withReviewCoverageRequirements,
} from "./ideal-review.js";

/** These fixtures use virtual paths, so every expected file "exists". */
const allFilesExist = () => true;

describe("ReviewCoverageTracker", () => {
  it("counts only successful read callbacks after review starts", () => {
    const tracker = new ReviewCoverageTracker("/project", allFilesExist);
    tracker.recordChanged("src/a.ts");
    tracker.recordRead("src/a.ts");
    tracker.start();
    expect(tracker.evidence()).toEqual({
      expected: ["src/a.ts"],
      covered: [],
      missing: ["src/a.ts"],
    });
    tracker.recordRead("/project/src/a.ts");
    expect(tracker.evidence().missing).toEqual([]);
  });

  it("expands expected coverage for review-time edits and deduplicates paths", () => {
    const tracker = new ReviewCoverageTracker("/project", allFilesExist);
    tracker.recordChanged("src/a.ts");
    tracker.recordChanged("/project/src/a.ts");
    tracker.start();
    tracker.recordChanged("src/../src/b.ts");
    tracker.recordRead("src/a.ts");
    expect(tracker.evidence()).toEqual({
      expected: ["src/a.ts", "src/b.ts"],
      covered: ["src/a.ts"],
      missing: ["src/b.ts"],
    });
  });

  it("drops changed files that no longer exist on disk", () => {
    // Reproduces the observed loop: the run created a scratch script, deleted
    // it, and then could never satisfy the read requirement for it.
    const deleted = path.resolve("/project", "scripts/probe-many.mjs");
    const tracker = new ReviewCoverageTracker("/project", (p) => p !== deleted);
    tracker.recordChanged("src/a.ts");
    tracker.recordChanged("scripts/probe-many.mjs");
    tracker.start();

    expect(tracker.evidence().missing).toEqual(["src/a.ts"]);

    tracker.recordRead("src/a.ts");
    expect(tracker.evidence()).toEqual({
      expected: ["src/a.ts"],
      covered: ["src/a.ts"],
      missing: [],
    });
  });

  it("keeps gating a changed file that still exists", () => {
    const tracker = new ReviewCoverageTracker("/project", allFilesExist);
    tracker.recordChanged("src/a.ts");
    tracker.start();
    expect(tracker.evidence().missing).toEqual(["src/a.ts"]);
  });

  it("builds a deterministic fail-closed follow-up", () => {
    const message = buildReviewCoverageMessage(["src/a.ts", "src/b.ts"]);
    expect(message.content).toContain("model-authored claims do not count");
    expect(message.content).toContain("- src/a.ts\n- src/b.ts");
  });

  it("puts missing read evidence on the initial review prompt", () => {
    const message = withReviewCoverageRequirements(buildIdealReviewMessage(["120 changed lines"]), [
      "src/a.ts",
      "src/b.ts",
    ]);

    expect(message.content).toContain("Ideal?");
    expect(message.content).toContain("before finalizing");
    expect(message.content).toContain("- src/a.ts\n- src/b.ts");
  });

  it("escalates to a report-what-you-could-not-verify message", () => {
    const message = buildReviewCoverageEscalationMessage(["src/a.ts"]);
    expect(message.content).toContain("Stop trying to read these files");
    expect(message.content).toContain("do not repeat your previous answer");
    expect(message.content).toContain("could not verify");
    expect(message.content).toContain("- src/a.ts");
  });
});

/**
 * The gate as AgentSession and useAgentLoop both drive it: inject the read
 * checklist up to the budget, then escalate exactly once and go quiet.
 */
function runCoverageGate(
  tracker: ReviewCoverageTracker,
  turns: number,
): { messages: string[]; phases: string[] } {
  let phase: "reviewing" | "complete" = "reviewing";
  let injected = 0;
  const messages: string[] = [];
  const phases: string[] = [];

  for (let turn = 0; turn < turns; turn += 1) {
    if (phase === "complete") {
      messages.push("<none>");
      phases.push(phase);
      continue;
    }
    const { missing } = tracker.evidence();
    if (missing.length > 0) {
      if (injected < MAX_REVIEW_COVERAGE_INJECTIONS) {
        injected += 1;
        messages.push(String(buildReviewCoverageMessage(missing).content));
      } else {
        phase = "complete";
        messages.push(String(buildReviewCoverageEscalationMessage(missing).content));
      }
    } else {
      phase = "complete";
      messages.push("<none>");
    }
    phases.push(phase);
  }
  return { messages, phases };
}

describe("ideal review coverage gate budget", () => {
  it("escalates on the third injection and stops looping", () => {
    const tracker = new ReviewCoverageTracker("/project", allFilesExist);
    tracker.recordChanged("src/a.ts");
    tracker.start();

    const { messages, phases } = runCoverageGate(tracker, 6);

    expect(messages[0]).toContain("coverage is incomplete");
    expect(messages[1]).toContain("coverage is incomplete");
    expect(messages[2]).toContain("could not verify");
    // Escalation is terminal: never re-injected, never re-asked.
    expect(messages.slice(3)).toEqual(["<none>", "<none>", "<none>"]);
    expect(messages.filter((m) => m.includes("could not verify"))).toHaveLength(1);
    expect(phases).toEqual([
      "reviewing",
      "reviewing",
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
  });

  it("never escalates when the only missing file was deleted", () => {
    const deleted = path.resolve("/project", "scripts/probe-many.mjs");
    const tracker = new ReviewCoverageTracker("/project", (p) => p !== deleted);
    tracker.recordChanged("scripts/probe-many.mjs");
    tracker.start();

    const { messages, phases } = runCoverageGate(tracker, 3);

    expect(messages).toEqual(["<none>", "<none>", "<none>"]);
    expect(phases[0]).toBe("complete");
  });
});

describe("evaluateIdealReview", () => {
  it("skips tiny text-only changes", () => {
    const decision = evaluateIdealReview({
      changedLines: 2,
      toolCalls: 2,
      toolFailures: 0,
      turns: 1,
      writeCalls: 0,
      editCalls: 1,
      bashCalls: 0,
    });

    expect(decision.shouldReview).toBe(false);
    expect(decision.score).toBeLessThan(4);
  });

  it("triggers for broad file mutation work before final response", () => {
    const decision = evaluateIdealReview({
      changedLines: 135,
      toolCalls: 9,
      toolFailures: 0,
      turns: 3,
      writeCalls: 1,
      editCalls: 3,
      bashCalls: 1,
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reasons).toContain("135 changed lines");
    expect(decision.reasons).toContain("4 file mutation calls");
  });

  it("triggers for failed tool recovery even with smaller diffs", () => {
    const decision = evaluateIdealReview({
      changedLines: 42,
      toolCalls: 8,
      toolFailures: 1,
      turns: 2,
      writeCalls: 0,
      editCalls: 2,
      bashCalls: 1,
    });

    expect(decision.shouldReview).toBe(true);
  });
});

describe("buildIdealReviewMessage", () => {
  it("asks the model to review and fix before the final answer", () => {
    const message = buildIdealReviewMessage(["120 changed lines"]);

    expect(message.role).toBe("user");
    expect(message.content).toContain("Ideal?");
    expect(message.content).toContain("before the final response");
    expect(message.content).toContain("fix it now");
    expect(message.content).toContain("120 changed lines");
  });

  it("defers builds/typechecks/tests to commit time instead of running them now", () => {
    const message = buildIdealReviewMessage([]);

    expect(message.content).toContain("do NOT run builds, typechecks, linters, or test suites now");
    expect(message.content).toContain("/commit");
  });

  it("calls out drifted files and their stale tests", () => {
    const message = buildIdealReviewMessage([], ["src/foo.ts"]);

    expect(message.content).toContain("src/foo.ts");
    expect(message.content).toContain("matching test file was not updated");
  });
});

describe("detectTestDrift", () => {
  const cwd = "/proj";
  // Fixture paths are written POSIX-style for readability, but the code under
  // test builds candidates with path.join/path.resolve — which on Windows
  // yields `D:\proj\src\foo.test.ts`. Resolve BOTH sides so the lookup compares
  // like with like instead of silently never matching.
  const exists = (files: string[]) => {
    const set = new Set(files.map((f) => path.resolve(cwd, f)));
    return (p: string) => set.has(path.resolve(cwd, p));
  };

  it("flags a changed source whose sibling test exists but was not touched", () => {
    const drift = detectTestDrift(["src/foo.ts"], cwd, exists(["/proj/src/foo.test.ts"]));
    expect(drift).toEqual(["src/foo.ts"]);
  });

  it("stays silent when the sibling test was updated in the same run", () => {
    const drift = detectTestDrift(
      ["src/foo.ts", "src/foo.test.ts"],
      cwd,
      exists(["/proj/src/foo.test.ts"]),
    );
    expect(drift).toEqual([]);
  });

  it("stays silent when no sibling test exists on disk", () => {
    const drift = detectTestDrift(["src/foo.ts"], cwd, exists([]));
    expect(drift).toEqual([]);
  });

  it("ignores test files that are themselves the change", () => {
    const drift = detectTestDrift(["src/foo.test.ts"], cwd, exists(["/proj/src/foo.test.ts"]));
    expect(drift).toEqual([]);
  });

  it("ignores non-code files", () => {
    const drift = detectTestDrift(["README.md"], cwd, exists(["/proj/README.test.md"]));
    expect(drift).toEqual([]);
  });

  it("matches .spec siblings and resolves absolute paths", () => {
    const drift = detectTestDrift(["/proj/src/bar.tsx"], cwd, exists(["/proj/src/bar.spec.tsx"]));
    expect(drift).toEqual(["/proj/src/bar.tsx"]);
  });

  it("matches a .test.ts sibling for a .tsx source (test drops the x)", () => {
    const drift = detectTestDrift(["src/Button.tsx"], cwd, exists(["/proj/src/Button.test.ts"]));
    expect(drift).toEqual(["src/Button.tsx"]);
  });
});
