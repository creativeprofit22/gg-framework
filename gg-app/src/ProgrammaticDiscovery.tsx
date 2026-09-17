import { useId } from "react";
import type { ProgrammaticChatRequest } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { RECOMMENDATION_HISTORY_PAGE_SIZE, type DiscoveryChoice, type DiscoveryCandidate, type RecommendationSummary } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { canReviewProgrammaticCandidate, type ProgrammaticChatState } from "./programmatic-chat-state";

const labels: Record<DiscoveryChoice, string> = { "reuse-command": "Review existing automation", "extend-command": "Review an extension",
  "missing-capability": "Review a new capability", "needs-more-evidence": "Inspect missing evidence", manual: "Keep this manual" };
const isCommand = (item: DiscoveryCandidate) => item.choice === "reuse-command" || item.choice === "extend-command";
const reviewLabel = (item: DiscoveryCandidate) => isCommand(item) && item.availability?.status !== "available"
  ? "Reinspect command (read-only)" : labels[item.choice];
const availabilityLabel = (status: string | undefined) => status === "available" ? "Available at assessment"
  : status === "unavailable" ? "Command unavailable" : "Command needs reinspection";
function HistoryStatus({ item }: { item: RecommendationSummary }) {
  return item.canonicalId
    ? <span>Linked to an earlier candidate · Not a separate outstanding need</span>
    : <><span>Recorded decision: {item.decision}</span>{item.ambiguity === "exact-workflow-duplicate" &&
      <p>Possible duplicate · Same workflow; relationship not confirmed</p>}</>;
}
export function ProgrammaticDiscovery({ state, locked, planMode, onRequest, onSelect }: {
  state: ProgrammaticChatState; locked: boolean; planMode: boolean;
  onRequest(request: ProgrammaticChatRequest): void;
  onSelect(source: "current" | "history", id: string): void;
}) {
  const reasonId = useId();
  const candidate = state.selection?.source !== "deterministic" ? state.candidateDetail : null;
  const current = state.discovery;
  const history = state.historyReport;
  const historical = state.selection?.source === "history" && state.historyDetail?.candidate.id === state.selection.id
    ? state.historyDetail.candidate : null;
  const reason = state.candidateStale ? "Previous or historical evidence. Discover opportunities again before preparing an actionable review."
    : planMode ? "Leave plan mode before requesting provider-backed review."
      : locked ? "Wait for current work to finish or stop it in this chat."
        : state.reconcile ? "Refresh results to reconcile the previous response before requesting another review."
          : candidate?.nextStep.reason;
  return <>
    <div className="programmatic-actions">
      <button className="btn btn-ghost btn-sm" disabled={locked || planMode || state.reconcile}
        onClick={() => onRequest({ version: 1, action: "discover" })}>Discover opportunities</button>
    </div>
    <p>Inspect repeatable project needs without configuring checks first. Proposals are not approvals; discovery does not create or run a command.</p>
    {state.assessmentPending && <p>Discovery is in progress. Previous evidence remains below for reference only.</p>}
    {state.assessmentUncertain && <p>Discovery completion could not be confirmed. Previous evidence is for reference only. No work was retried. Once this chat is idle, you can explicitly discover again.</p>}
    {state.discoveryStale && current && <p>Previous discovery results. They are not current review authority.</p>}
    {current && !current.candidates.length && !state.discoveryStale && <p>No worthwhile need was identified within the inspected scope. This is not a project-wide health check.</p>}
    {!current && state.assessment && <p>Candidate detail is unavailable for this assessment. This does not mean no useful needs exist.</p>}
    {!!current?.candidates.length && <section aria-label="Discovered candidates">
      <h3>Discovered candidates</h3>
      {!state.discoveryStale && !state.assessmentPending && !state.assessmentUncertain && current.candidates.every((item) => item.choice === "reuse-command" && item.availability?.status === "available") && <p>The identified needs have existing automation to review.</p>}
      <ul className="programmatic-list">{current.candidates.map((item) => <li key={item.candidateId}>
        <button className="btn btn-ghost btn-sm" aria-pressed={state.selection?.source === "current" && state.selection.id === item.candidateId}
          onClick={() => onSelect("current", item.candidateId)}>{item.outcome}</button>
        <span>{reviewLabel(item)} · Proposal{isCommand(item) ? ` · ${availabilityLabel(item.availability?.status)}` : ""}</span>
      </li>)}</ul>
    </section>}
    {historical && <section aria-label="Selected history record">
      <h3>Saved recommendation</h3>
      <HistoryStatus item={historical} />
      {historical.canonicalId && <><p>This record is retained for its history. View the earlier candidate for its recorded decision; decisions are not copied between records.</p>
        <button className="btn btn-ghost btn-sm" disabled={locked}
          onClick={() => onSelect("history", historical.canonicalId!)}>View earlier candidate</button></>}
      <p>{historical.observationCount} saved {historical.observationCount === 1 ? "observation" : "observations"}. Historical evidence only; not current approval.</p>
    </section>}
    {candidate && <section aria-label="Selected opportunity">
      <h3>{candidate.outcome}</h3>
      <p>{reviewLabel(candidate)} · {state.selection?.source === "history" ? "Historical proposal" : "Proposal"}</p>
      {isCommand(candidate) && <><p>{availabilityLabel(candidate.availability?.status)}</p>
        <p>{candidate.availability?.reason ?? "Command availability was not recorded. Fresh read-only inspection is required."}</p></>}
      <p>{candidate.rationale}</p><p>Uncertainty: {candidate.uncertainty}</p>
      <p>Scope: {candidate.workflow.scope}</p><p>Expected output: {candidate.workflow.output}</p>
      <p>Success check: {candidate.workflow.successCheck}</p><p>Changes allowed: {candidate.workflow.mutationBoundary}</p>
      <details><summary>Workflow, evidence, risks and alternatives</summary>
        <p>Trigger: {candidate.workflow.trigger}</p><p>Example: {candidate.workflow.representativeCase}</p>
        <p>Repeatability ({candidate.workflow.repeatability.basis}): {candidate.workflow.repeatability.explanation}</p>
        <h4>Inputs and current process</h4><ul>{[...candidate.workflow.inputs, ...candidate.workflow.currentProcess].map((text, index) => <li key={index}>{text}</li>)}</ul>
        <h4>Evidence</h4><ul>{candidate.evidence.map((item, index) => <li key={index}>{item.basis}: {item.message} ({item.source})</li>)}</ul>
        <h4>Risks</h4>{candidate.risks.length ? <ul>{candidate.risks.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>No risks listed by this proposal; this is not a guarantee.</p>}
        <h4>Proposal detail</h4><ul>{candidate.details.map((text, index) => <li key={index}>{text}</li>)}</ul>
        <h4>Alternatives</h4><ul>{candidate.alternatives.map((item) => <li key={item.kind}>{labels[item.kind]}: {item.reasonNotSelected}{item.availability && <><p>{availabilityLabel(item.availability.status)}</p><p>{item.availability.reason}</p></>}</li>)}</ul>
      </details>
      <p id={reasonId}>{reason}</p>
      {candidate.choice !== "manual" && <button className="btn btn-ghost btn-sm" aria-describedby={reasonId}
        disabled={locked || planMode || !canReviewProgrammaticCandidate(state)} onClick={() => onRequest({ version: 1,
          action: "review-candidate", intent: "review-only", source: "current", assessmentId: candidate.assessmentId,
          candidateId: candidate.candidateId, expectedRevision: candidate.revision })}>{reviewLabel(candidate)}</button>}
      {state.candidateReview && <p>{state.candidateReview.summary}</p>}
    </section>}
    <details><summary>Browse recommendation history</summary>
      <p>Saved proposals are historical evidence, not permission to create, edit or execute.</p>
      <button className="btn btn-ghost btn-sm" disabled={locked} onClick={() => onRequest({ version: 1, action: "history-report", offset: 0 })}>Load history</button>
      {history && <><p>History: {history.status}. {history.total} saved candidates. {history.warning}</p>
        <ul>{history.candidates.map((item) => <li key={item.id}><button className="btn btn-ghost btn-sm" disabled={locked}
          aria-pressed={state.selection?.source === "history" && state.selection.id === item.id}
          onClick={() => onSelect("history", item.id)}>{item.outcome}</button> <HistoryStatus item={item} /></li>)}</ul>
        <div className="programmatic-actions">
          <button className="btn btn-ghost btn-sm" disabled={locked || history.offset === 0}
            onClick={() => onRequest({ version: 1, action: "history-report", offset: Math.max(0, history.offset - RECOMMENDATION_HISTORY_PAGE_SIZE) })}>Previous history</button>
          <button className="btn btn-ghost btn-sm" disabled={locked || history.offset + RECOMMENDATION_HISTORY_PAGE_SIZE >= history.total}
            onClick={() => onRequest({ version: 1, action: "history-report", offset: history.offset + RECOMMENDATION_HISTORY_PAGE_SIZE })}>Next history</button>
        </div></>}
      {state.selection?.source === "history" && !candidate && <p>Typed historical detail is not available yet. Load the selected record or discover again; raw history is never interpreted as an action.</p>}
    </details>
  </>;
}
