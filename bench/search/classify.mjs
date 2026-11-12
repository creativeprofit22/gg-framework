// Outcome classification owner: complete | partial:{...} | error:{kind}.
// Derived only from the tool's own output notices and thrown errors.

const GREP_RESULT_CAP = /\[Truncated at \d+ matches\]/;
const GREP_CANDIDATE_CAP = /\[Stopped after scanning \d+ candidate files\]/;
const GREP_DEADLINE = /\[Stopped after [\d.]+s — /;
const FIND_CAP = /\[Truncated: showing \d+ of \d+ matches\]/;

const EMFILE_CODES = new Set(["EMFILE", "ENFILE", "EAGAIN"]);

/** Classify a thrown error. */
export function classifyError(error, { harnessTimeout = false } = {}) {
  if (harnessTimeout) return "harness-timeout";
  if (!error) return "other";
  const code = error.code ?? error.cause?.code;
  if (EMFILE_CODES.has(code)) return "emfile";
  if (code === "ENOENT" && /spawn/i.test(`${error.syscall ?? ""} ${error.message ?? ""}`))
    return "spawn";
  if (typeof error.message === "string" && error.message.startsWith("Invalid regex pattern"))
    return "invalid-pattern";
  return "other";
}

/**
 * @param {{ tool: "grep"|"find"|"noop", output?: string, error?: unknown, harnessTimeout?: boolean }} call
 * @returns {{ outcome: "complete"|"partial"|"error", partial: string[], error: string|null }}
 */
export function classifyOutcome({ tool, output, error, harnessTimeout = false }) {
  if (harnessTimeout || error !== undefined) {
    return { outcome: "error", partial: [], error: classifyError(error, { harnessTimeout }) };
  }
  if (typeof output !== "string") return { outcome: "error", partial: [], error: "other" };
  const partial = [];
  if (tool === "grep") {
    if (GREP_DEADLINE.test(output)) partial.push("deadline");
    if (GREP_CANDIDATE_CAP.test(output)) partial.push("candidate-cap");
    if (GREP_RESULT_CAP.test(output)) partial.push("result-cap");
  } else if (tool === "find") {
    if (FIND_CAP.test(output)) partial.push("find-cap");
  }
  return { outcome: partial.length ? "partial" : "complete", partial, error: null };
}
