import type { ProgrammaticAssessment as Assessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import {
  CHECK_RUN_EXPLANATIONS as checkExplanations,
  CHECK_RUN_LABELS as checkLabels,
  COVERAGE_LABELS as coverageLabels,
  SEARCH_HISTORY_LABELS as historyLabels,
  SEARCH_STATUS_LABELS as statusLabels,
  plainLimitation,
} from "./programmatic-presentation";

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
            <li key={index}>{plainLimitation(limitation)}</li>
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
                  {coverageLabels[item.status]} — {plainLimitation(item.summary)}
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
