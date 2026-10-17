import type { ProgrammaticAssessment as Assessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";

const historyLabels: Record<NonNullable<Assessment["history"]>["status"], string> = {
  saved: "saved",
  disabled: "saving disabled",
  "setup-not-saved": "setup assessment not saved",
  unsaved: "not saved",
  "acknowledgement-unknown": "save not confirmed",
};

const statusLabels: Record<Assessment["status"], string> = {
  completed: "Finished",
  incomplete: "Incomplete",
  cancelled: "Cancelled",
  unavailable: "Unavailable",
};
const checkLabels: Record<Assessment["deterministic"]["status"], string> = {
  succeeded: "Finished",
  "not-run": "Not run",
  unavailable: "Unavailable",
  denied: "Not allowed",
  cancelled: "Cancelled",
  failed: "Failed",
};
const checkExplanations: Record<
  Exclude<Assessment["deterministic"]["status"], "succeeded" | "not-run">,
  string
> = {
  unavailable: "Saved checks were unavailable. Their results could not be assessed.",
  denied: "Saved checks were not allowed to run. Their results could not be assessed.",
  cancelled: "Saved checks were cancelled. Their results are incomplete.",
  failed: "Saved checks failed. Their results are incomplete; see Details for the recorded reason.",
};
const coverageLabels: Record<Assessment["coverage"][number]["status"], string> = {
  inspected: "Checked",
  uninspected: "Not checked",
  "budget-limited": "Only partly checked",
  unreadable: "Could not be read",
  unsafe: "Not safe to inspect",
  nonmatching: "Did not match",
  "not-applicable": "Did not apply",
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
    <section aria-label="Project assessment">
      <h3>Project assessment: {statusLabels[assessment.status]}</h3>
      {previous && (
        <p>
          Previous assessment, retained for reference. New discovery or inspection is needed before
          review.
        </p>
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
        <p>No saved checks applied. This does not mean there are no useful improvements.</p>
      )}
      {history?.status === "unsaved" && (
        <p role="alert">
          These suggestions were not saved to history. The assessment results remain here.
        </p>
      )}
      {history?.status === "acknowledgement-unknown" && (
        <p role="alert">
          History may already have been saved, but this could not be confirmed. Read current history
          before retrying the save. Do not rerun the assessment or its checks just to save history.
        </p>
      )}
      <details>
        <summary>Details</summary>
        {assessment.coverage.length > 0 && (
          <>
            <h4>What was checked</h4>
            <ul>
              {assessment.coverage.map((item, index) => (
                <li key={index}>
                  {item.scope === "project" ? "Project" : "Available commands"}:{" "}
                  {coverageLabels[item.status]} — {item.summary}
                </li>
              ))}
            </ul>
          </>
        )}
        {history && (
          <section aria-label="Recommendation history">
            <h4>Recommendation history: {historyLabels[history.status]}</h4>
            {history.status === "disabled" && <p>Automatic history saving is not enabled.</p>}
            {history.status === "setup-not-saved" && (
              <p>Setup assessments are read-only and are not saved to recommendation history.</p>
            )}
            {"reason" in history && (
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{history.reason}</p>
            )}
          </section>
        )}
        <h4>Saved checks: {checkLabels[checks.status]}</h4>
        {assessment.deterministic.status === "succeeded" ? (
          <>
            <p>
              {assessment.deterministic.enabledCount} enabled checks;{" "}
              {assessment.deterministic.applicableCount} applicable checks.
            </p>
          </>
        ) : (
          <p>
            {assessment.deterministic.status === "not-run"
              ? "Setup is read-only; saved checks were not run."
              : assessment.deterministic.reason}
          </p>
        )}
      </details>
    </section>
  );
}
