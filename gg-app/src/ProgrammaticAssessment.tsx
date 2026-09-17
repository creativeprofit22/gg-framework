import type { ProgrammaticAssessment as Assessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";

const historyLabels: Record<NonNullable<Assessment["history"]>["status"], string> = {
  saved: "saved",
  disabled: "saving disabled",
  "setup-not-saved": "setup assessment not saved",
  unsaved: "not saved",
  "acknowledgement-unknown": "save acknowledgement unknown",
};

/** Plain-text assessment presentation; actions remain in the parent chat. */
export function ProgrammaticAssessment({ assessment, previous = false }: { assessment: Assessment; previous?: boolean }) {
  const history = assessment.history;
  return (
    <section aria-label="Project assessment">
      <h3>Project assessment: {assessment.status}</h3>
      {previous && <p>Previous assessment, retained for reference. New discovery or inspection is needed before review.</p>}
      <p>{assessment.summary}</p>
      <p>
        This assessment covers only the evidence inspected, not a clean bill of health.
        Detailed observations remain in the chat transcript. Candidate proposals are shown above when available.
      </p>
      {assessment.limitations.length > 0 && (
        <ul>
          {assessment.limitations.map((limitation, index) => (
            <li key={index}>{limitation}</li>
          ))}
        </ul>
      )}
      {assessment.coverage.length > 0 && (
        <details>
          <summary>Assessment coverage and limits</summary>
          <ul>
            {assessment.coverage.map((item, index) => (
              <li key={index}>{item.scope}: {item.status} — {item.summary}</li>
            ))}
          </ul>
        </details>
      )}
      {history && (
        <section aria-label="Recommendation history">
          <h4>Recommendation history: {historyLabels[history.status]}</h4>
          {history.status === "disabled" && <p>Automatic history saving is not enabled.</p>}
          {history.status === "setup-not-saved" && (
            <p>Setup assessments are read-only and are not saved to recommendation history.</p>
          )}
          {"reason" in history && (
            <p role="alert" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{history.reason}</p>
          )}
          {history.status === "acknowledgement-unknown" && (
            <p>History may already have been saved. Read current history before retrying the save. Do not rerun the assessment or its provider or scanner to retry saving.</p>
          )}
        </section>
      )}
      <h4>Deterministic checks: {assessment.deterministic.status}</h4>
      {assessment.deterministic.status === "succeeded" ? (
        <>
          <p>
            {assessment.deterministic.enabledCount} enabled checks;{" "}
            {assessment.deterministic.applicableCount} applicable checks.
          </p>
          {assessment.deterministic.applicableCount === 0 && (
            <p>No deterministic checks applied. This does not mean there are no useful improvements.</p>
          )}
        </>
      ) : (
        <p>{assessment.deterministic.status === "not-run"
          ? "Setup is read-only; deterministic checks were not run."
          : assessment.deterministic.reason}</p>
      )}
    </section>
  );
}
