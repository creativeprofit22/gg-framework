import type { VerificationEvidence } from "./verification-evidence.js";

/** Per-run evidence never inherits an earlier turn's green or red checks. */
export function describeTurnVerification(
  activity: { changed: boolean; checked?: boolean; evidence: readonly VerificationEvidence[] },
  problem: string | null,
) {
  const currentProblem =
    activity.changed ||
    (activity.checked && activity.evidence.length === 0) ||
    activity.evidence.some((entry) => entry.status === "rejected")
      ? problem
      : null;
  return {
    changed: activity.changed,
    ...describeRunVerification(activity.evidence, currentProblem),
    reason: currentProblem ?? "",
  };
}

/** Host-observed verification for the desktop, never inferred from assistant text. */
export function describeRunVerification(
  evidence: readonly VerificationEvidence[],
  problem: string | null,
): {
  verification: "passed" | "failed" | "incomplete" | "not_recorded";
  verifiedChecks: number;
} {
  const verifiedChecks = evidence.filter((entry) => entry.status === "passed").length;
  return {
    verification: evidence.some((entry) => entry.status === "failed")
      ? "failed"
      : problem
        ? "incomplete"
        : verifiedChecks > 0
          ? "passed"
          : "not_recorded",
    verifiedChecks,
  };
}
