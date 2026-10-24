import type { ProgrammaticAssessment as Assessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";

const historyLabels: Record<NonNullable<Assessment["history"]>["status"], string> = {
  saved: "saved",
  disabled: "off",
  "setup-not-saved": "not saved during setup",
  unsaved: "not saved",
  "acknowledgement-unknown": "not sure it saved",
};

const statusLabels: Record<Assessment["status"], string> = {
  completed: "Done",
  incomplete: "Not finished",
  cancelled: "Stopped",
  unavailable: "Not available",
};
const checkLabels: Record<Assessment["deterministic"]["status"], string> = {
  succeeded: "Done",
  "not-run": "Not run",
  unavailable: "Not available",
  denied: "Not allowed",
  cancelled: "Stopped",
  failed: "Failed",
};
const checkExplanations: Record<
  Exclude<Assessment["deterministic"]["status"], "succeeded" | "not-run">,
  string
> = {
  unavailable: "Your checks couldn't run.",
  denied: "Your checks weren't allowed to run.",
  cancelled: "Your checks were stopped, so results are incomplete.",
  failed: "Your checks failed. See Details for why.",
};
const coverageLabels: Record<Assessment["coverage"][number]["status"], string> = {
  inspected: "Checked",
  uninspected: "Not checked",
  "budget-limited": "Partly checked",
  unreadable: "Couldn't read",
  unsafe: "Skipped for safety",
  nonmatching: "Didn't match",
  "not-applicable": "Didn't apply",
};

/** Plain-text assessment presentation; actions remain in the parent chat. */
export function ProgrammaticAssessment({
  assessment,
  previous = false,
}: {
  assessment: Assessment;
  previous?: boolean;
}) {
  const history = assessment.history;
  const checks = assessment.deterministic;
  return (
    <section aria-label="Idea search">
      <h3>Idea search: {statusLabels[assessment.status]}</h3>
      {previous && (
        <p>This is an older search, kept for reference. Search again before reviewing an idea.</p>
      )}
      <p>{assessment.summary}</p>

      {assessment.limitations.length > 0 && (
        <ul>
          {assessment.limitations.map((limitation, index) => (
            <li key={index}>{limitation}</li>
          ))}
        </ul>
      )}
      {checks.status !== "succeeded" && checks.status !== "not-run" && (
        <p role="alert">{checkExplanations[checks.status]}</p>
      )}
      {checks.status === "succeeded" && checks.applicableCount === 0 && (
        <p>None of your checks applied. There may still be things to improve.</p>
      )}
      {history?.status === "unsaved" && (
        <p role="alert">These ideas weren't saved to Past ideas. They're still shown here.</p>
      )}
      {history?.status === "acknowledgement-unknown" && (
        <p role="alert">
          We're not sure these ideas were saved. Open Past ideas to check. Don't search again just
          to save them.
        </p>
      )}
      <details>
        <summary>Details</summary>
        {assessment.coverage.length > 0 && (
          <>
            <h4>What AI looked at</h4>
            <ul>
              {assessment.coverage.map((item, index) => (
                <li key={index}>
                  {item.scope === "project" ? "Your project" : "Your commands"}:{" "}
                  {coverageLabels[item.status]} — {item.summary}
                </li>
              ))}
            </ul>
          </>
        )}
        {history && (
          <section aria-label="Past ideas">
            <h4>Past ideas: {historyLabels[history.status]}</h4>
            {history.status === "disabled" && <p>Saving past ideas is off.</p>}
            {history.status === "setup-not-saved" && <p>Ideas found during setup aren't saved.</p>}
            {"reason" in history && (
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{history.reason}</p>
            )}
          </section>
        )}
        <h4>Checks: {checkLabels[checks.status]}</h4>
        {assessment.deterministic.status === "succeeded" ? (
          <>
            <p>
              {assessment.deterministic.enabledCount} checks set up,{" "}
              {assessment.deterministic.applicableCount} applied.
            </p>
          </>
        ) : (
          <p>
            {assessment.deterministic.status === "not-run"
              ? "Setup only looks, so checks didn't run."
              : assessment.deterministic.reason}
          </p>
        )}
      </details>
    </section>
  );
}
