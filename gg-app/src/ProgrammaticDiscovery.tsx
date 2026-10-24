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
import { evidenceBasisLabel } from "./ProgrammaticExecutionEvidence";
import { DataPlate, SpecList, StatusLamp, type LampTone, type SpecRow } from "./InstrumentParts";

/** Sentence form, used where the kind reads inside a sentence (Other options). */
const labels: Record<DiscoveryChoice, string> = {
  "reuse-command": "You already have a command for this",
  "extend-command": "A command you have could do this with changes",
  "missing-capability": "Needs a new command",
  "needs-more-evidence": "Needs a closer look first",
  manual: "Better done by hand",
  "generate-from-reference": "Make one, then copy it for the rest",
};
/** Plate form: the short kind shown on every idea card. */
const plateLabels: Record<DiscoveryChoice, string> = {
  "reuse-command": "You have this",
  "extend-command": "Change a command",
  "missing-capability": "New command",
  "needs-more-evidence": "Look closer",
  manual: "By hand",
  "generate-from-reference": "Make one, copy the rest",
};
const lampTones: Record<DiscoveryChoice, LampTone> = {
  "reuse-command": "success",
  "extend-command": "primary",
  "missing-capability": "primary",
  "needs-more-evidence": "warning",
  manual: "neutral",
  "generate-from-reference": "primary",
};
const isCommand = (item: DiscoveryCandidate) =>
  item.choice === "reuse-command" || item.choice === "extend-command";
const reviewLabel = (item: DiscoveryCandidate) =>
  isCommand(item) && item.availability?.status !== "available"
    ? "Check the command again"
    : "Review this idea";
const decisionLabels: Record<RecommendationSummary["decision"], string> = {
  open: "Still open",
  dismissed: "Dismissed",
  completed: "Done",
};
const historyLabels: Record<RecommendationHistoryReport["status"], string> = {
  disabled: "Saving past ideas is off",
  missing: "No past ideas yet",
  ready: "Past ideas loaded",
  recovered: "Past ideas loaded, but some may be missing",
  unavailable: "Couldn't load past ideas",
};
const reviewStatusLabels: Record<DiscoveryReview["status"], string> = {
  prepared: "Review ready. Nothing was changed.",
  "reinspection-required": "This command needs another check first.",
  unsupported: "This idea can't be reviewed here.",
};
const availabilityLabel = (
  status: NonNullable<DiscoveryCandidate["availability"]>["status"] | undefined,
) =>
  status === "available"
    ? "Command found"
    : status === "unavailable"
      ? "Command not found"
      : "Command needs another check";

function HistoryStatus({ item }: { item: RecommendationSummary }) {
  return item.canonicalId ? (
    <span>Same as an earlier idea</span>
  ) : (
    <>
      <span>Status: {decisionLabels[item.decision]}</span>
      {item.ambiguity === "exact-workflow-duplicate" && <p>Might be the same as another idea</p>}
    </>
  );
}

interface PanelProps {
  state: ProgrammaticChatState;
  locked: boolean;
  planMode: boolean;
  onRequest(request: ProgrammaticChatRequest): void;
  onSelect(source: "current" | "history", id: string): void;
}

/** The selected idea's explanation, shared by the Ideas and Past ideas tabs. */
function CandidateDetail({
  state,
  candidate,
  locked,
  planMode,
  onRequest,
}: Omit<PanelProps, "onSelect"> & { candidate: DiscoveryCandidate }) {
  const reasonId = useId();
  const reason = state.candidateStale
    ? "This idea is from an earlier search. Search again first."
    : planMode
      ? "Turn off plan mode to review this idea."
      : locked
        ? "Wait for the current work to finish, or stop it."
        : state.reconcile
          ? "Refresh results to see what was saved, then try again."
          : candidate.nextStep.available
            ? "Reviewing doesn't change anything."
            : "This idea isn't ready to review.";
  const risks = candidate.risks.length ? (
    <ul className="inst-spec-items">
      {candidate.risks.map((text, index) => (
        <li key={index}>
          <StatusLamp tone="warning" />
          {text}
        </li>
      ))}
    </ul>
  ) : (
    "None listed. That doesn't mean it's safe."
  );
  const rows: SpecRow[] = [
    { term: "Changes", value: candidate.workflow.mutationBoundary },
    { term: "Where", value: candidate.workflow.scope },
    { term: "Not sure", value: candidate.uncertainty },
    { term: "Risk", value: risks },
    ...(candidate.details.length
      ? [
          {
            term: "Good to know",
            value: (
              <ul className="inst-spec-items">
                {candidate.details.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            ),
          },
        ]
      : []),
  ];
  return (
    <div className="opp-detail">
      <p className="opp-lede">{candidate.rationale}</p>
      {isCommand(candidate) && candidate.availability?.status !== "available" && (
        <p className="opp-notice">
          <strong>{availabilityLabel(candidate.availability?.status)}.</strong>{" "}
          {candidate.availability?.reason ??
            "We don't know if this command still exists. Check it again."}
        </p>
      )}
      <SpecList rows={rows} label="About this idea" />
      {!candidate.nextStep.available && (
        <p className="opp-notice">Why you can't review it: {candidate.nextStep.reason}</p>
      )}
      <div className="opp-detail-foot">
        <details className="opp-more">
          <summary>More details</summary>
          {isCommand(candidate) && candidate.availability?.status === "available" && (
            <p>{candidate.availability.reason}</p>
          )}
          <p>Result: {candidate.workflow.output}</p>
          <p>How to tell it worked: {candidate.workflow.successCheck}</p>
          {candidate.nextStep.available && <p>Next step: {candidate.nextStep.reason}</p>}
          {state.candidateReview && <p>{state.candidateReview.summary}</p>}
          <p>When it comes up: {candidate.workflow.trigger}</p>
          <p>Example: {candidate.workflow.representativeCase}</p>
          <p>
            How often ({evidenceBasisLabel(candidate.workflow.repeatability.basis).toLowerCase()}):{" "}
            {candidate.workflow.repeatability.explanation}
          </p>
          <h5>What it uses and how it's done now</h5>
          <ul>
            {[...candidate.workflow.inputs, ...candidate.workflow.currentProcess].map(
              (text, index) => (
                <li key={index}>{text}</li>
              ),
            )}
          </ul>
          <h5>What AI found</h5>
          <ul>
            {candidate.evidence.map((item, index) => (
              <li key={index}>
                {evidenceBasisLabel(item.basis)}: {item.message} ({item.source})
              </li>
            ))}
          </ul>
          <h5>Other options</h5>
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
        <div className="opp-detail-action">
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
          <p id={reasonId} className="opp-caption">
            {reason}
          </p>
        </div>
      </div>
      {state.candidateReview && (
        <p className="opp-notice" role="status">
          {reviewStatusLabels[state.candidateReview.status]}
        </p>
      )}
    </div>
  );
}

/** Ideas tab: search notices, then one card per idea; the selected card opens in place. */
export function ProgrammaticIdeas({ state, locked, planMode, onRequest, onSelect }: PanelProps) {
  const candidate = state.selection?.source === "current" ? state.candidateDetail : null;
  const current = state.discovery;
  return (
    <>
      {state.assessmentPending && (
        <p className="opp-notice" data-tone="primary">
          Looking for ideas… Older results below are only for reference.
        </p>
      )}
      {state.assessmentUncertain && (
        <p className="opp-notice" data-tone="warning">
          We couldn't tell if the search finished. Nothing was retried. When the chat is free, you
          can search again.
        </p>
      )}
      {state.discoveryStale && current && (
        <p className="opp-notice" data-tone="warning">
          These ideas are from an earlier search. Search again before reviewing one.
        </p>
      )}
      {!current && !state.assessment && (
        <div className="opp-empty inst-module">
          <p>
            AI reads your project and suggests work you could automate. It uses your AI provider and
            doesn't change anything.
          </p>
        </div>
      )}
      {current && !current.candidates.length && !state.discoveryStale && (
        <div className="opp-empty inst-module">
          <p>No ideas this time. AI only looked at part of your project; see what it read below.</p>
        </div>
      )}
      {!current && state.assessment && (
        <p className="opp-notice">
          Ideas from this search can't be shown. That doesn't mean there's nothing to improve.
        </p>
      )}
      {!!current?.candidates.length && (
        <section aria-label="Idea list">
          {!state.discoveryStale &&
            !state.assessmentPending &&
            !state.assessmentUncertain &&
            current.candidates.every(
              (item) =>
                item.choice === "reuse-command" && item.availability?.status === "available",
            ) && <p className="opp-caption">You already have commands for everything found.</p>}
          <ul className="opp-cards">
            {current.candidates.map((item) => {
              const open = candidate?.candidateId === item.candidateId ? candidate : null;
              const body = (
                <>
                  <div className="opp-card-head">
                    <div className="opp-card-kind">
                      <StatusLamp tone={lampTones[item.choice]} />
                      <DataPlate>{plateLabels[item.choice]}</DataPlate>
                      {isCommand(item) && (
                        <span className="opp-card-meta">
                          {availabilityLabel(item.availability?.status)}
                        </span>
                      )}
                    </div>
                    <h3 className="opp-card-title">
                      <button
                        type="button"
                        className="opp-card-toggle"
                        aria-pressed={!!open}
                        data-programmatic-selection={open ? "" : undefined}
                        onClick={() => onSelect("current", item.candidateId)}
                      >
                        {item.outcome}
                      </button>
                    </h3>
                    {!open && (
                      <span className="opp-card-chevron" aria-hidden="true">
                        ›
                      </span>
                    )}
                  </div>
                  {open && (
                    <CandidateDetail
                      state={state}
                      candidate={open}
                      locked={locked}
                      planMode={planMode}
                      onRequest={onRequest}
                    />
                  )}
                </>
              );
              return (
                <li
                  key={item.candidateId}
                  className="opp-card inst-module"
                  data-open={open ? "" : undefined}
                >
                  {open ? <section aria-label="Selected idea">{body}</section> : body}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}

/** Past ideas tab: the saved record, read on request, plus the selected past idea. */
export function ProgrammaticPastIdeas({
  state,
  locked,
  planMode,
  onRequest,
  onSelect,
}: PanelProps) {
  const candidate = state.selection?.source === "history" ? state.candidateDetail : null;
  const history = state.historyReport;
  const historical =
    state.selection?.source === "history" &&
    state.historyDetail?.candidate.id === state.selection.id
      ? state.historyDetail.candidate
      : null;
  return (
    <>
      <div className="opp-toolbar">
        <p className="opp-caption">Past ideas are a record only. They don't approve anything.</p>
        <button
          className="btn btn-ghost btn-sm"
          disabled={locked}
          onClick={() =>
            onRequest({ version: 1, action: "history-report", offset: history?.offset ?? 0 })
          }
        >
          {state.historyReportStale ? "Reload past ideas" : "Show past ideas"}
        </button>
      </div>
      {state.historyReportStale && (
        <p className="opp-notice" role="status">
          This list may be out of date. Reloading only reads it again.
        </p>
      )}
      {history && (
        <>
          <p className="opp-caption">
            {historyLabels[history.status]}. {history.total} saved. {history.warning}
          </p>
          <ul className="opp-rows">
            {history.candidates.map((item) => (
              <li key={item.id} className="opp-row inst-module">
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
              Previous page
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
              Next page
            </button>
          </div>
        </>
      )}
      {historical && (
        <section aria-label="Selected past idea" className="opp-card inst-module" data-open="">
          <h3>Past idea</h3>
          {state.historyDetailStale && (
            <>
              <p role="status">This past idea may be out of date.</p>
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
                Reload this idea
              </button>
            </>
          )}
          <HistoryStatus item={historical} />
          {historical.canonicalId && (
            <>
              <p>This is a copy of an earlier idea. Open the earlier one to see its status.</p>
              <button
                className="btn btn-ghost btn-sm"
                disabled={locked}
                onClick={() => onSelect("history", historical.canonicalId!)}
              >
                Open the earlier idea
              </button>
            </>
          )}
          <p>
            Seen {historical.observationCount}{" "}
            {historical.observationCount === 1 ? "time" : "times"}. This is a record, not an
            approval.
          </p>
        </section>
      )}
      {candidate && (
        <section aria-label="Selected idea" className="opp-card inst-module" data-open="">
          <div className="opp-card-head">
            <div className="opp-card-kind">
              <StatusLamp tone={lampTones[candidate.choice]} />
              <DataPlate>{plateLabels[candidate.choice]}</DataPlate>
              <span className="opp-card-meta">Past idea</span>
            </div>
            <h3 className="opp-card-title" tabIndex={-1} data-programmatic-selection>
              {candidate.outcome}
            </h3>
          </div>
          <CandidateDetail
            state={state}
            candidate={candidate}
            locked={locked}
            planMode={planMode}
            onRequest={onRequest}
          />
        </section>
      )}
      {state.selection?.source === "history" && !candidate && (
        <p className="opp-notice">
          Details for this past idea aren't loaded yet. Reload it or search for ideas again.
        </p>
      )}
    </>
  );
}
