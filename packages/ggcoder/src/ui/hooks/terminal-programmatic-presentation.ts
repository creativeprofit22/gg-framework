import type { Message } from "@kenkaiiii/gg-ai";
import type { ProgrammaticAssessmentOutcome } from "../../core/programmatic/assessment.js";

/** Display only: never replaces the accepted assessment, receipts or history. */
export function renderTerminalProgrammaticAssessment(
  outcome: ProgrammaticAssessmentOutcome,
  turnMessages: readonly Message[],
): string {
  const { assessment, advice } = outcome;
  let shortened = false;
  const bounded = (value: string, limit = 500) => {
    // Host acceptance is not permission to emit terminal control sequences.
    const clean = value.replace(/\p{Cc}/gu, (character) =>
      character === "\t" || character === "\n" || character === "\r" ? character : "",
    ).trim();
    if (clean.length <= limit) return clean;
    shortened = true;
    return `${clean.slice(0, limit)}…`;
  };
  const lines = ["## Needs assessment", "", bounded(assessment.summary)];
  const scan = assessment.deterministic;
  if (scan.status === "not-run") lines.push("Checks: setup inspection only; no saved checks were run or settings changed.");
  else if (scan.status === "succeeded") lines.push(scan.applicableCount === 0
    ? `Checks: none of the ${scan.enabledCount} enabled checks applied. This is not a passing project check.`
    : `Checks: saved check run finished; ${scan.applicableCount} of ${scan.enabledCount} enabled checks applied. This is not a complete project check.`);
  else lines.push(`Checks: ${bounded(scan.reason)}`);

  const history = assessment.history;
  if (history?.status === "saved") lines.push("History: assessment saved separately from check results.");
  else if (history?.status === "disabled") lines.push("History: saving is disabled; no assessment was saved.");
  else if (history?.status === "setup-not-saved") lines.push("History: setup suggestions are not saved.");
  else if (history?.status === "unsaved" || history?.status === "acknowledgement-unknown") lines.push(`History: ${history.status === "acknowledgement-unknown"
    ? "save could not be confirmed; it may have succeeded."
    : "assessment was not saved."} ${bounded(history.reason)}`);

  const limits = [...new Set([
    ...assessment.limitations,
    ...assessment.coverage.filter((item) => item.status !== "inspected").map((item) => item.summary),
  ])];
  lines.push("Limits: this is a scoped assessment, not a complete project inspection.");
  for (const limit of limits.slice(0, 6)) lines.push(`- ${bounded(limit, 300)}`);
  if (limits.length > 6) {
    shortened = true;
    lines.push(`- ${limits.length - 6} additional inspection limits are not shown here.`);
  }

  // Tool results remain in the transcript, but the terminal normally shows only
  // their first line. Only assistant text counts as an already-delivered report.
  const alreadyRendered = advice && turnMessages.some((message) => message.role === "assistant" &&
    (typeof message.content === "string" ? message.content : message.content
      .filter((part) => part.type === "text").map((part) => part.text).join(""))
      .includes(advice));
  if (advice && assessment.status !== "cancelled" && !alreadyRendered) lines.push("", bounded(advice, 6_000));
  if (assessment.status === "completed") lines.push("", "Next: review the suggestions and their limits before separately approving any work. Nothing recommended has been started.");
  else lines.push("", "Next: resolve the assessment limits before requesting another assessment. No retry or recommended work was started; saved check results remain separate.");
  if (shortened) lines.push("Display shortened: some detail or caveats are omitted. Review the full accepted report in the transcript before acting; this summary is not approval.");
  return lines.join("\n");
}
