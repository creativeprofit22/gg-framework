import { useId } from "react";
import type { ProgrammaticChatRequest } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import {
  RECOMMENDATION_HISTORY_PAGE_SIZE,
  type DiscoveryCandidate,
  type RecommendationSummary,
} from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import {
  canReviewProgrammaticCandidate,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
import {
  IDEA_DETAIL_TERMS as terms,
  NO_RISKS_LISTED,
  PAST_IDEAS_RECORD_NOTE,
  PAST_IDEAS_STATUS_LABELS as historyLabels,
  PAST_IDEA_COPY_NOTE,
  PAST_IDEA_DECISION_LABELS as decisionLabels,
  PAST_IDEA_POSSIBLE_REPEAT,
  REVIEW_EMPTY,
  REVIEW_STATUS_LABELS as reviewStatusLabels,
  TECHNICAL_DETAILS,
  availabilityLabel,
  evidenceBasisLabel,
  ideaKindSentence,
  ideaVerdict,
  isCommandIdea as isCommand,
  reviewHint,
  reviewLabel,
  seenCount,
  AREA_PROGRESS,
  areaCoverageLine,
} from "./programmatic-presentation";
import { DataPlate, SpecList, StatusLamp, type SpecRow } from "./InstrumentParts";
import { ProgrammaticAreaProgress } from "./ProgrammaticAreaProgress";

function HistoryStatus({ item }: { item: RecommendationSummary }) {
  return item.canonicalId ? (
    <span>{PAST_IDEA_COPY_NOTE}</span>
  ) : (
    <>
      <span>{decisionLabels[item.decision]}</span>
      {item.ambiguity === "exact-workflow-duplicate" && <p>{PAST_IDEA_POSSIBLE_REPEAT}</p>}
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

/** The selected idea's explanation, shared by Review's Ideas group and the Past ideas region. */
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
            ? reviewHint(candidate)
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
    NO_RISKS_LISTED
  );
  const rows: SpecRow[] = [
    { term: terms.yourPart, value: ideaVerdict(candidate).yourPart },
    { term: terms.change, value: candidate.workflow.mutationBoundary },
    { term: terms.where, value: candidate.workflow.scope },
    { term: terms.unsure, value: candidate.uncertainty },
    { term: terms.risk, value: risks },
    ...(candidate.details.length
      ? [
          {
            term: terms.notes,
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
            How often this comes up (
            {evidenceBasisLabel(candidate.workflow.repeatability.basis).toLowerCase()}):{" "}
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
                {evidenceBasisLabel(item.basis)}: {item.message}
              </li>
            ))}
          </ul>
          <h5>Other options</h5>
          <ul>
            {candidate.alternatives.map((item) => (
              <li key={item.kind}>
                {ideaKindSentence(item.kind)}: {item.reasonNotSelected}
                {item.availability && (
                  <>
                    <p>{availabilityLabel(item.availability.status)}</p>
                    <p>{item.availability.reason}</p>
                  </>
                )}
              </li>
            ))}
          </ul>
          {candidate.evidence.length > 0 && (
            <details>
              <summary>{TECHNICAL_DETAILS.summary}</summary>
              <p>{TECHNICAL_DETAILS.intro}</p>
              <ol>
                {candidate.evidence.map((item, index) => (
                  <li key={index}>
                    <code>{item.source}</code>
                  </li>
                ))}
              </ol>
            </details>
          )}
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

/** Step 2, Find ideas: how the search went. The header key starts it; the cards live in Review. */
export function ProgrammaticIdeaSearch({
  state,
  locked,
  planMode,
  onRequest,
  onStop,
}: Omit<PanelProps, "onSelect"> & { onStop?(): void }) {
  const current = state.discovery;
  return (
    <>
      {state.assessmentPending && (
        <p className="opp-notice" data-tone="primary">
          Looking for ideas… Older ideas in Review are only for reference.
        </p>
      )}
      {state.assessmentUncertain && (
        <p className="opp-notice" data-tone="warning">
          We couldn't tell if the search finished. Nothing was retried. When the chat is free, you
          can search again.
        </p>
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
      <ProgrammaticAreaProgress
        state={state}
        locked={locked}
        planMode={planMode}
        onRequest={onRequest}
        onStop={onStop}
      />
    </>
  );
}

/** Review's Ideas group: one card per idea; the selected card opens in place. */
export function ProgrammaticIdeas({ state, locked, planMode, onRequest, onSelect }: PanelProps) {
  const candidate = state.selection?.source === "current" ? state.candidateDetail : null;
  const current = state.discovery;
  const areas = state.assessmentPending ? undefined : state.assessment?.areas;
  return (
    <>
      {!!areas?.length && <p className="opp-caption opp-coverage">{areaCoverageLine(areas)}</p>}
      {state.discoveryStale && current && (
        <p className="opp-notice" data-tone="warning">
          These ideas are from an earlier search. Search again before reviewing one.
        </p>
      )}
      <EarlyFinds state={state} />
      {!current?.candidates.length && <p className="opp-caption">{REVIEW_EMPTY.ideas}</p>}
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
                      <StatusLamp tone={ideaVerdict(item).tone} />
                      <DataPlate>{ideaVerdict(item).plate}</DataPlate>
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

/** Display-only needs from finished areas; never reviewable, replaced by the final ideas. */
function EarlyFinds({ state }: Pick<PanelProps, "state">) {
  const progress = state.areaProgress;
  const current = state.discovery;
  if (!progress || progress.sequence !== state.assessmentSequence) return null;
  const ended = !state.assessmentPending;
  // A completed search shows its merged ideas; early finds stay only after a stop or a cut-short end.
  const completed =
    state.assessment?.lifecycle?.sequence === progress.sequence &&
    state.assessment.status === "completed";
  // Older, stale ideas don't count as this search's final ideas.
  if (ended && ((current?.candidates.length && !state.discoveryStale) || completed)) return null;
  const finds = progress.areas.flatMap((area) =>
    (area.finds ?? []).map((find, index) => ({ ...find, key: `${area.id}:${index}` })),
  );
  if (!finds.length) return null;
  return (
    <section className="opp-early" aria-label={AREA_PROGRESS.earlyHeading}>
      <h3 className="opp-early-heading">{AREA_PROGRESS.earlyHeading}</h3>
      <p className="opp-caption">
        {ended ? AREA_PROGRESS.earlyStopped : AREA_PROGRESS.earlyRunning}
      </p>
      <ul className="opp-cards">
        {finds.map((find) => (
          <li key={find.key} className="opp-card opp-early-card inst-module">
            <div className="opp-card-kind">
              <StatusLamp tone="neutral" />
              <DataPlate>{AREA_PROGRESS.earlyPlate}</DataPlate>
            </div>
            <p className="opp-early-need">{find.need}</p>
            <SpecList
              label={AREA_PROGRESS.earlyPlate}
              rows={[
                { term: terms.where, value: find.where },
                { term: terms.unsure, value: find.unsure },
              ]}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Past ideas region: the saved record, loaded when opened, plus the selected past idea. */
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
        <p className="opp-caption">{PAST_IDEAS_RECORD_NOTE}</p>
        {/* Opening Past ideas loads the list; only a list that may be out of date offers a reload. */}
        {state.historyReportStale && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={locked}
            onClick={() =>
              onRequest({ version: 1, action: "history-report", offset: history?.offset ?? 0 })
            }
          >
            Reload past ideas
          </button>
        )}
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
            <button
              className="btn btn-ghost btn-sm"
              disabled={locked}
              onClick={() => onSelect("history", historical.canonicalId!)}
            >
              Open the earlier idea
            </button>
          )}
          <p>{seenCount(historical.observationCount)}</p>
        </section>
      )}
      {candidate && (
        <section aria-label="Selected idea" className="opp-card inst-module" data-open="">
          <div className="opp-card-head">
            <div className="opp-card-kind">
              <StatusLamp tone={ideaVerdict(candidate).tone} />
              <DataPlate>{ideaVerdict(candidate).plate}</DataPlate>
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
