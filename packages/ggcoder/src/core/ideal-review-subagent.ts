import type { Message } from "@kenkaiiii/gg-ai";
import type { IdealReviewStats } from "./ideal-review.js";

/**
 * Independent pre-final review — the Codex Guardian pattern. The in-thread
 * Ideal review asks the acting model to audit its own work, armed with its own
 * justifications for why it is done; a fresh-context reviewer sees only the
 * request, the changed files and the outcome evidence, so it catches what
 * self-review rationalizes away.
 *
 * The reviewer is spawned as a read-only child agent on the session's ACTIVE
 * model (`model` is forced at spawn time, never a "fast" or review model).
 * Findings are injected as a follow-up the acting agent must address; a CLEAN
 * verdict injects nothing, so a passing review costs one bounded wait and no
 * extra turn. On spawn failure or timeout the in-thread review remains the
 * fallback — the feature degrades, never blocks.
 */

/** Read-only toolset — the reviewer examines, it never repairs. */
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls", "code_search", "source_path"] as const;

/** Bounded wait for the reviewer child. Matches the subagent default wait. */
export const REVIEWER_WAIT_MS = 120_000;

/**
 * Ideal review score at which the independent reviewer is worth its latency.
 * Below this the in-thread review alone is proportionate.
 */
export const INDEPENDENT_REVIEW_SCORE_THRESHOLD = 6;

export interface ReviewerTaskInput {
  originalRequest: string;
  changedFiles: readonly string[];
  stats: IdealReviewStats;
  triggerReasons: readonly string[];
}

export function buildReviewerTask(input: ReviewerTaskInput): string {
  const files = input.changedFiles
    .slice(0, 20)
    .map((f) => `- ${f}`)
    .join("\n");
  const reasons = input.triggerReasons.join(", ");
  return [
    "You are an independent code reviewer with fresh context. Another coding agent claims to have " +
      "completed the task below. Examine its work and report whether the claim holds.",
    "",
    `Task given to that agent: ${input.originalRequest.slice(0, 2000)}`,
    "",
    "Files it changed:",
    files,
    "",
    `Harness-observed activity: ${input.stats.changedLines} changed lines, ` +
      `${input.stats.toolCalls} tool calls (${input.stats.toolFailures} failed), ` +
      `${input.stats.turns} turns. Review triggered because: ${reasons}.`,
    "",
    "Read the changed files (and any sibling files needed to judge them). Check the work against " +
      "the task: correctness, completeness, obvious edge cases, over-editing beyond what the task " +
      "asked for, leftover TODOs or dead code, and changes that contradict each other.",
    "Judge the CONTENT of the changed files against the request. Do NOT report the surrounding " +
      "environment (missing package.json, tooling not installed, unrelated files) unless the request " +
      "itself demanded those.",
    "You are READ-ONLY: do not edit, write, or run commands. Judge only what is on disk.",
    "",
    "BEGIN your reply with EXACTLY this format (elaborate only after it):",
    "VERDICT: CLEAN",
    "or",
    "VERDICT: ISSUES",
    "FINDINGS:",
    "- <one line per concrete finding, each naming the file>",
  ].join("\n");
}

export interface ReviewerFindings {
  clean: boolean;
  findings: string[];
}

/**
 * Parse the reviewer's terminal output. Returns null when the reply carries no
 * usable verdict marker — treated as a failed review, never as a pass.
 */
export function parseReviewerFindings(output: string): ReviewerFindings | null {
  const verdict = /VERDICT:\s*(CLEAN|ISSUES)\b/im.exec(output)?.[1]?.toUpperCase();
  if (!verdict) return null;
  const findingsBlock = /FINDINGS:\s*\n([\s\S]*)$/i.exec(output)?.[1] ?? "";
  const findings = findingsBlock
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toUpperCase() !== "NONE")
    .slice(0, 10);
  if (verdict === "CLEAN") return { clean: true, findings: [] };
  if (findings.length === 0)
    return {
      clean: false,
      findings: [
        "The reviewer flagged issues but did not list them — re-examine the changed files yourself.",
      ],
    };
  return { clean: false, findings };
}

export function buildIndependentReviewMessage(findings: readonly string[]): Message {
  return {
    role: "user",
    provenance: { source: "runtime", kind: "review_follow_up", visibility: "hidden" },
    content:
      "An independent reviewer (fresh context, no knowledge of your reasoning) examined the changed " +
      "files against the original request and disagrees that the work is complete:\n" +
      findings.map((finding) => `- ${finding}`).join("\n") +
      "\nAddress each finding now — fix what is real, and if a finding is wrong, verify why before " +
      "dismissing it. Then give your final response.",
  };
}
