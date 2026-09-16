import type { ProgrammaticAssessment as Assessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";

/** Plain-text assessment presentation; actions remain in the parent chat. */
export function ProgrammaticAssessment({ assessment }: { assessment: Assessment }) {
  return (
    <section aria-label="Project assessment">
      <h3>Project assessment: {assessment.status}</h3>
      <p>{assessment.summary}</p>
      <p>
        This assessment covers only the evidence inspected, not a clean bill of health.
        Detailed observations and recommendations remain in the chat transcript.
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
