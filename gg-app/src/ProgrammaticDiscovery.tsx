import { useId } from "react";
import type { ProgrammaticChatRequest } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import {
  RECOMMENDATION_HISTORY_PAGE_SIZE,
  type DiscoveryChoice,
  type DiscoveryCandidate,
  type RecommendationSummary,
  type RecommendationHistoryReport,
  type DiscoveryReview,
} from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import {
  canReviewProgrammaticCandidate,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";

const labels: Record<DiscoveryChoice, string> = {
  "reuse-command": "An existing command may handle this task",
  "extend-command": "An existing command would need changes",
  "missing-capability": "New automation would need to be built",
  "needs-more-evidence": "More information is needed before choosing automation",
  manual: "Keep this manual",
};
const isCommand = (item: DiscoveryCandidate) =>
  item.choice === "reuse-command" || item.choice === "extend-command";
const reviewLabel = (item: DiscoveryCandidate) =>
  isCommand(item) && item.availability?.status !== "available"
    ? "Reinspect command (read-only)"
    : "Review this task";
const decisionLabels: Record<RecommendationSummary["decision"], string> = {
  open: "Still open",
  dismissed: "Dismissed",
  completed: "Marked complete",
};
const historyLabels: Record<RecommendationHistoryReport["status"], string> = {
  disabled: "History saving is off",
  missing: "No saved history found",
  ready: "Saved history loaded",
  recovered: "History recovered; some records may be missing",
  unavailable: "Saved history could not be loaded",
};
const reviewStatusLabels: Record<DiscoveryReview["status"], string> = {
  prepared: "Review prepared. Nothing has been created, changed or run.",
  "reinspection-required": "The command needs a fresh inspection before review can continue.",
  unsupported: "A review cannot be prepared for this suggestion.",
};
const availabilityLabel = (
  status: NonNullable<DiscoveryCandidate["availability"]>["status"] | undefined,
) =>
  status === "available"
    ? "Available at assessment"
    : status === "unavailable"
      ? "Command unavailable"
      : "Command needs reinspection";
function HistoryStatus({ item }: { item: RecommendationSummary }) {
  return item.canonicalId ? (
    <span>Linked to an earlier candidate · Not a separate outstanding need</span>
  ) : (
    <>
      <span>Recorded decision: {decisionLabels[item.decision]}</span>
      {item.ambiguity === "exact-workflow-duplicate" && (
        <p>Possible duplicate · Same workflow; relationship not confirmed</p>
      )}
    </>
  );
}
export function ProgrammaticDiscovery({
  state,
  locked,
  planMode,
  onRequest,
  onSelect,
}: {
  state: ProgrammaticChatState;
  locked: boolean;
  planMode: boolean;
  onRequest(request: ProgrammaticChatRequest): void;
  onSelect(source: "current" | "history", id: string): void;
}) {
  const reasonId = useId();
  const candidate = state.selection?.source !== "deterministic" ? state.candidateDetail : null;
  const current = state.discovery;
  const history = state.historyReport;
  const historical =
    state.selection?.source === "history" &&
    state.historyDetail?.candidate.id === state.selection.id
      ? state.historyDetail.candidate
      : null;
  const reason = state.candidateStale
    ? "This suggestion is from an earlier check. Check again before reviewing it as a current task."
    : planMode
      ? "Leave plan mode before asking AI to review this task."
      : locked
        ? "Wait for current work to finish or stop it in this chat."
        : state.reconcile
          ? "Refresh results to confirm the previous response before requesting another review."
          : candidate?.nextStep.available
            ? "Review only: this does not create, change or run automation."
            : "This suggestion is not ready for review.";
  return (
    <>
      <details
        open={
          !current?.candidates.length ||
          state.discoveryStale ||
          state.assessmentPending ||
          state.assessmentUncertain
        }
      >
        <summary>
          {current?.candidates.length ? "Find more tasks" : "Find tasks to automate"}
        </summary>
        <div className="programmatic-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={locked || planMode || state.reconcile}
            onClick={() => onRequest({ version: 1, action: "discover" })}
          >
            {state.discoveryStale && current ? "Check again" : "Find tasks to automate"}
          </button>
        </div>
        <p>
          Ask AI to find repeatable project work and suggest automation. This uses your selected
          provider, needs no saved checks, and does not create or run a command.
        </p>
      </details>
      {state.assessmentPending && (
        <p>Discovery is in progress. Previous evidence remains below for reference only.</p>
      )}
      {state.assessmentUncertain && (
        <p>
          Discovery completion could not be confirmed. Previous evidence is for reference only. No
          work was retried. Once this chat is idle, you can explicitly discover again.
        </p>
      )}
      {state.discoveryStale && current && (
        <p>These suggestions are from an earlier check. Check again before reviewing a task.</p>
      )}
      {current && !current.candidates.length && !state.discoveryStale && (
        <p>
          No tasks were suggested from the information checked. This was not a complete project
          check; review the limits below.
        </p>
      )}
      {!current && state.assessment && (
        <p>
          Candidate detail is unavailable for this assessment. This does not mean no useful needs
          exist.
        </p>
      )}
      {!!current?.candidates.length && (
        <section aria-label="Discovered candidates">
          <h3>Suggested tasks</h3>
          <details key={candidate?.candidateId ?? "unselected"} open={!candidate}>
            <summary>Browse suggested tasks ({current.candidates.length})</summary>
            {!state.discoveryStale &&
              !state.assessmentPending &&
              !state.assessmentUncertain &&
              current.candidates.every(
                (item) =>
                  item.choice === "reuse-command" && item.availability?.status === "available",
              ) && <p>The identified needs have existing automation to review.</p>}
            <ul className="programmatic-list">
              {current.candidates.map((item) => (
                <li key={item.candidateId}>
                  <button
                    className="btn btn-ghost btn-sm"
                    aria-pressed={
                      state.selection?.source === "current" &&
                      state.selection.id === item.candidateId
                    }
                    onClick={() => onSelect("current", item.candidateId)}
                  >
                    {item.outcome}
                  </button>
                  {candidate?.candidateId !== item.candidateId && (
                    <span>
                      {labels[item.choice]} · Proposal
                      {isCommand(item) ? ` · ${availabilityLabel(item.availability?.status)}` : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {historical && (
        <section aria-label="Selected history record">
          <h3>Saved recommendation</h3>
          {state.historyDetailStale && (
            <>
              <p role="status">
                This saved recommendation may be out of date. Its recorded decision and observation
                count are from an earlier read.
              </p>
              <button
                className="btn btn-ghost btn-sm"
                disabled={locked}
                onClick={() =>
                  onRequest({
                    version: 1,
                    action: "history-detail",
                    candidateId: historical.id,
                    offset: state.historyDetail?.offset ?? 0,
                  })
                }
              >
                Reload selected history (read-only)
              </button>
            </>
          )}
          <HistoryStatus item={historical} />
          {historical.canonicalId && (
            <>
              <p>
                This record is retained for its history. View the earlier candidate for its recorded
                decision; decisions are not copied between records.
              </p>
              <button
                className="btn btn-ghost btn-sm"
                disabled={locked}
                onClick={() => onSelect("history", historical.canonicalId!)}
              >
                View earlier candidate
              </button>
            </>
          )}
          <p>
            {historical.observationCount} saved{" "}
            {historical.observationCount === 1 ? "observation" : "observations"}. Historical
            evidence only; not current approval.
          </p>
        </section>
      )}
      {candidate && (
        <section aria-label="Selected opportunity">
          <h3 tabIndex={-1} data-programmatic-selection>
            {candidate.outcome}
          </h3>
          <p>
            {labels[candidate.choice]}
            {state.selection?.source === "history" && " (saved suggestion)"}
          </p>
          {isCommand(candidate) && candidate.availability?.status !== "available" && (
            <>
              <p>{availabilityLabel(candidate.availability?.status)}</p>
              <p>
                {candidate.availability?.reason ??
                  "Command availability was not recorded. Fresh read-only inspection is required."}
              </p>
            </>
          )}
          <p>{candidate.rationale}</p>
          <p>Uncertainty: {candidate.uncertainty}</p>
          <p>Scope: {candidate.workflow.scope}</p>
          <p>Proposed changes, not permission: {candidate.workflow.mutationBoundary}</p>
          {!candidate.nextStep.available && <p>Review limitation: {candidate.nextStep.reason}</p>}
          <h4>Risks</h4>
          {candidate.risks.length ? (
            <ul>
              {candidate.risks.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          ) : (
            <p>No risks were listed. This does not establish that the task is safe.</p>
          )}
          {!!candidate.details.length && (
            <>
              <h4>Requirements and considerations</h4>
              <ul>
                {candidate.details.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary>Details</summary>
            {isCommand(candidate) && candidate.availability?.status === "available" && (
              <p>{candidate.availability.reason}</p>
            )}
            <p>Expected output: {candidate.workflow.output}</p>
            <p>Success check: {candidate.workflow.successCheck}</p>
            {candidate.nextStep.available && (
              <p>Recorded review reason: {candidate.nextStep.reason}</p>
            )}
            {state.candidateReview && <p>{state.candidateReview.summary}</p>}
            <p>Trigger: {candidate.workflow.trigger}</p>
            <p>Example: {candidate.workflow.representativeCase}</p>
            <p>
              Repeatability ({candidate.workflow.repeatability.basis}):{" "}
              {candidate.workflow.repeatability.explanation}
            </p>
            <h4>Inputs and current process</h4>
            <ul>
              {[...candidate.workflow.inputs, ...candidate.workflow.currentProcess].map(
                (text, index) => (
                  <li key={index}>{text}</li>
                ),
              )}
            </ul>
            <h4>Evidence</h4>
            <ul>
              {candidate.evidence.map((item, index) => (
                <li key={index}>
                  {item.basis}: {item.message} ({item.source})
                </li>
              ))}
            </ul>
            <h4>Alternatives</h4>
            <ul>
              {candidate.alternatives.map((item) => (
                <li key={item.kind}>
                  {labels[item.kind]}: {item.reasonNotSelected}
                  {item.availability && (
                    <>
                      <p>{availabilityLabel(item.availability.status)}</p>
                      <p>{item.availability.reason}</p>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </details>
          <p id={reasonId}>{reason}</p>
          {candidate.choice !== "manual" && (
            <button
              className="btn btn-ghost btn-sm"
              aria-describedby={reasonId}
              disabled={locked || planMode || !canReviewProgrammaticCandidate(state)}
              onClick={() =>
                onRequest({
                  version: 1,
                  action: "review-candidate",
                  intent: "review-only",
                  source: "current",
                  assessmentId: candidate.assessmentId,
                  candidateId: candidate.candidateId,
                  expectedRevision: candidate.revision,
                })
              }
            >
              {reviewLabel(candidate)}
            </button>
          )}

          {state.candidateReview && <p>{reviewStatusLabels[state.candidateReview.status]}</p>}
        </section>
      )}
      <details>
        <summary>Browse recommendation history</summary>
        <p>Saved proposals are historical evidence, not permission to create, edit or execute.</p>
        {state.historyReportStale && (
          <p role="status">
            This history list may be out of date. Candidate counts and recorded decisions are from
            an earlier read. Reloading only reads saved history; it does not rerun discovery or
            retry a save.
          </p>
        )}
        <button
          className="btn btn-ghost btn-sm"
          disabled={locked}
          onClick={() =>
            onRequest({ version: 1, action: "history-report", offset: history?.offset ?? 0 })
          }
        >
          {state.historyReportStale ? "Reload history (read-only)" : "Load history"}
        </button>
        {history && (
          <>
            <p>
              {historyLabels[history.status]}. {history.total} saved suggestions. {history.warning}
            </p>
            <ul>
              {history.candidates.map((item) => (
                <li key={item.id}>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={locked}
                    aria-pressed={
                      state.selection?.source === "history" && state.selection.id === item.id
                    }
                    onClick={() => onSelect("history", item.id)}
                  >
                    {item.outcome}
                  </button>{" "}
                  <HistoryStatus item={item} />
                </li>
              ))}
            </ul>
            <div className="programmatic-actions">
              <button
                className="btn btn-ghost btn-sm"
                disabled={locked || history.offset === 0}
                onClick={() =>
                  onRequest({
                    version: 1,
                    action: "history-report",
                    offset: Math.max(0, history.offset - RECOMMENDATION_HISTORY_PAGE_SIZE),
                  })
                }
              >
                Previous history
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={
                  locked || history.offset + RECOMMENDATION_HISTORY_PAGE_SIZE >= history.total
                }
                onClick={() =>
                  onRequest({
                    version: 1,
                    action: "history-report",
                    offset: history.offset + RECOMMENDATION_HISTORY_PAGE_SIZE,
                  })
                }
              >
                Next history
              </button>
            </div>
          </>
        )}
        {state.selection?.source === "history" && !candidate && (
          <p>
            Typed historical detail is not available yet. Load the selected record or discover
            again; raw history is never interpreted as an action.
          </p>
        )}
      </details>
    </>
  );
}
