import { describe, expect, it } from "vitest";
import {
  buildIndependentReviewMessage,
  buildReviewerTask,
  INDEPENDENT_REVIEW_SCORE_THRESHOLD,
  parseReviewerFindings,
  REVIEWER_TOOLS,
  REVIEWER_WAIT_MS,
} from "./ideal-review-subagent.js";

describe("buildReviewerTask", () => {
  it("gives the fresh-context reviewer the request, files, and evidence", () => {
    const task = buildReviewerTask({
      originalRequest: "Add retry logic to the fetch helper",
      changedFiles: ["src/fetch.ts", "src/fetch.test.ts"],
      stats: {
        changedLines: 130,
        toolCalls: 12,
        toolFailures: 1,
        turns: 6,
        writeCalls: 1,
        editCalls: 4,
        bashCalls: 3,
      },
      triggerReasons: ["130 changed lines", "5 file mutation calls"],
    });
    expect(task).toContain("Add retry logic to the fetch helper");
    expect(task).toContain("- src/fetch.ts");
    expect(task).toContain("130 changed lines");
    expect(task).toContain("READ-ONLY");
    expect(task).toContain("BEGIN your reply with EXACTLY this format");
    expect(task.indexOf("VERDICT:")).toBeLessThan(task.indexOf("FINDINGS:"));
  });

  it("is read-only and bounded", () => {
    expect(REVIEWER_TOOLS).not.toContain("edit");
    expect(REVIEWER_TOOLS).not.toContain("write");
    expect(REVIEWER_TOOLS).not.toContain("bash");
    expect(REVIEWER_WAIT_MS).toBeGreaterThan(0);
    expect(INDEPENDENT_REVIEW_SCORE_THRESHOLD).toBeGreaterThanOrEqual(4);
  });
});

describe("parseReviewerFindings", () => {
  it("parses a clean verdict with no findings", () => {
    expect(parseReviewerFindings("VERDICT: CLEAN\nAll good.")).toEqual({
      clean: true,
      findings: [],
    });
  });

  it("parses issues with a findings list", () => {
    const parsed = parseReviewerFindings(
      "VERDICT: ISSUES\nFINDINGS:\n- src/fetch.ts: retry ignores AbortSignal\n- src/fetch.ts: no timeout on retry",
    );
    expect(parsed?.clean).toBe(false);
    expect(parsed?.findings).toEqual([
      "src/fetch.ts: retry ignores AbortSignal",
      "src/fetch.ts: no timeout on retry",
    ]);
  });

  it("demands a self-check when the reviewer flagged issues but listed none", () => {
    const parsed = parseReviewerFindings("VERDICT: ISSUES\nFINDINGS:\nnone");
    expect(parsed?.clean).toBe(false);
    expect(parsed?.findings[0]).toContain("re-examine");
  });

  it("treats a reply without a verdict marker as unusable, never as a pass", () => {
    expect(parseReviewerFindings("looks fine to me")).toBeNull();
    expect(parseReviewerFindings("")).toBeNull();
  });

  it("tolerates markdown emphasis and trailing punctuation around the verdict", () => {
    expect(parseReviewerFindings("**VERDICT: CLEAN** — no issues found.")?.clean).toBe(true);
    expect(parseReviewerFindings("## VERDICT: ISSUES ##\nFINDINGS:\n- src/a.ts: bug")?.clean).toBe(
      false,
    );
    expect(parseReviewerFindings("verdict: clean (all checks done)")?.clean).toBe(true);
  });

  it("caps findings at a sane count", () => {
    const output =
      "VERDICT: ISSUES\nFINDINGS:\n" +
      Array.from({ length: 25 }, (_, i) => `- file${i}.ts: issue ${i}`).join("\n");
    expect(parseReviewerFindings(output)?.findings.length).toBeLessThanOrEqual(10);
  });
});

describe("buildIndependentReviewMessage", () => {
  it("requires each finding to be addressed before the final answer", () => {
    const message = buildIndependentReviewMessage(["src/a.ts: leftover TODO"]);
    expect(message.provenance).toMatchObject({ kind: "review_follow_up", visibility: "hidden" });
    expect(String(message.content)).toContain("independent reviewer");
    expect(String(message.content)).toContain("- src/a.ts: leftover TODO");
    expect(String(message.content)).toContain("final response");
  });
});
