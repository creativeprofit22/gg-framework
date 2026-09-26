import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  PROGRAMMATIC_CHAT_PAGE_LIMIT,
  type ProgrammaticChatRequest,
  type ProgrammaticChatSummary,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";
import { ProgrammaticAssessment } from "./ProgrammaticAssessment";
import { ProgrammaticDiscovery } from "./ProgrammaticDiscovery";
import { ProgrammaticSetup } from "./ProgrammaticSetup";
import {
  canRunProgrammaticSelection,
  canScanProgrammatic,
  isProgrammaticCurrentReview,
  programmaticConfiguration,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";

export { ProgrammaticExecutionEvidenceView } from "./ProgrammaticExecutionEvidence";

const stateLabels: Record<ProgrammaticChatSummary["state"], string> = {
  discovered: "Found",
  queued: "Waiting to start",
  running: "In progress",
  completed: "Completed",
  dismissed: "Dismissed",
};

/** One in-thread review section, sharing the transcript rail and existing controls. */
export function ProgrammaticChat({
  state,
  busy,
  planMode,
  onAction,
  onSelect,
  onSelectCandidate,
  onRun,
}: {
  state: ProgrammaticChatState;
  busy: boolean;
  planMode: boolean;
  onAction(request: ProgrammaticChatRequest): void;
  onSelect(id: string): void;
  onSelectCandidate?(source: "current" | "history", id: string): void;
  onRun(): void;
}): React.ReactElement {
  const headingId = useId();
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const focusSelection = useRef(false);
  // Closing a review changes presentation only, never the retained proposal or its authority.
  const [closedProposal, setClosedProposal] = useState<ProgrammaticChatState["proposal"]>(null);
  const showProposal = !!state.proposal && closedProposal !== state.proposal;
  useLayoutEffect(() => {
    if (focusSelection.current && (state.detail || state.candidateDetail)) {
      const target = root.current?.querySelector<HTMLElement>("[data-programmatic-selection]");
      if (target) {
        target.focus();
        focusSelection.current = false;
      }
    }
    if (focused.current && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
    if (focused.current && !focused.current.isConnected) focused.current = null;
  });
  const locked = busy || state.operation !== null;
  const mutationLocked = locked || planMode || state.reconcile;
  const report = state.report;
  const selected =
    state.selection?.source && state.selection.source !== "deterministic" ? null : state.detail;
  const configuration = programmaticConfiguration(state);
  const currentReview = isProgrammaticCurrentReview(state);
  const reportAssessmentSuperseded =
    !!configuration &&
    !!report &&
    (configuration.status !== report.configuration?.status ||
      configuration.currentFingerprint !== report.configuration?.currentFingerprint);
  const setupBlockedReason =
    configuration && configuration.status !== "current"
      ? configuration.status === "unreadable" && configuration.failure === "inventory"
        ? "This project can't be checked yet. Saved checks and their tasks are unavailable; discovery is still available."
        : configuration.status === "unreadable"
        ? "Review setup can inspect this project, but cannot save or repair unreadable settings. Saved checks and their tasks remain unavailable; discovery is still available."
        : "Review and approve setup before running saved checks or starting their tasks. Discovery does not require setup."
      : undefined;
  const groups: { title: string; matches(row: ProgrammaticChatSummary): boolean }[] = [
    {
      title: "Ready to review",
      matches: (row) =>
        row.presence === "present" && !["completed", "dismissed"].includes(row.state),
    },
    {
      title: "Completed",
      matches: (row) => row.presence === "present" && row.state === "completed",
    },
    {
      title: "Dismissed",
      matches: (row) => row.presence === "present" && row.state === "dismissed",
    },
    { title: "No longer found", matches: (row) => row.presence === "disappeared" },
  ];
  const reloadResults = (
    <button
      className="btn btn-ghost btn-sm"
      disabled={locked}
      onClick={() => onAction({ version: 1, action: "report", offset: report?.offset ?? 0 })}
    >
      {state.error ? "Retry loading results" : "Refresh results"}
    </button>
  );
  const setupStage = (
    <ProgrammaticSetup
      key="setup"
      id={`${headingId}-setup`}
      configuration={configuration}
      report={report}
      proposal={state.proposal}
      showProposal={showProposal}
      currentReview={currentReview}
      reportAssessmentSuperseded={reportAssessmentSuperseded}
      setupBlockedReason={setupBlockedReason}
      inspectDisabled={locked || planMode}
      approveDisabled={mutationLocked || !state.proposalApprovable}
      closeDisabled={locked}
      proposalApprovable={state.proposalApprovable}
      onInspect={() => {
        setClosedProposal(null);
        onAction({ version: 1, action: "inspect-setup" });
      }}
      onApprove={() => {
        if (state.proposal?.handle)
          onAction({
            version: 1,
            action: "approve-setup",
            proposalHandle: state.proposal.handle,
          });
      }}
      onClose={() => setClosedProposal(state.proposal)}
    />
  );
  const discoveryStage = (
    <section
      key="discovery"
      id={`${headingId}-discovery`}
      className="programmatic-stage"
      aria-label="Discovery"
    >
      <ProgrammaticDiscovery
        state={state}
        locked={locked}
        planMode={planMode}
        onRequest={onAction}
        onSelect={(source, id) => {
          focusSelection.current = true;
          onSelectCandidate?.(source, id);
        }}
      />
      {state.assessment && (
        <ProgrammaticAssessment assessment={state.assessment} previous={state.assessmentRetained} />
      )}
    </section>
  );
  const resultsStage = (
    <section
      key="results"
      id={`${headingId}-results`}
      className="programmatic-stage"
      aria-label="Saved check results"
    >
      <h3>Saved check results</h3>
      {reportAssessmentSuperseded && (
        <p>
          These results predate the latest setup review. Refresh results to update task
          availability.
        </p>
      )}
      {report && ["stale", "recovered"].includes(report.status) && <p>{report.reason}</p>}
      {report && !report.scan.available && <p>{setupBlockedReason ?? report.scan.reason}</p>}
      <p>Run the checks you approved for this project. Refresh only reloads saved results.</p>
      <div className="programmatic-actions">
        {report && report.status !== "setup-required" && (
          <button
            className="btn btn-primary btn-sm"
            disabled={mutationLocked || !canScanProgrammatic(state)}
            title={setupBlockedReason ?? report.scan?.reason}
            onClick={() => onAction({ version: 1, action: "scan" })}
          >
            Run project checks
          </button>
        )}
        {!state.error && reloadResults}
      </div>
      {report?.status === "setup-required" && <p>Save setup above to enable these checks.</p>}
      {report && report.status !== "setup-required" && report.total === 0 && (
        <p>
          No saved check results yet. Choose Run project checks to run your approved checks and save
          their results. This does not start any task.
        </p>
      )}
      {!!report?.rows.length && (
        <details key={selected?.summary.id ?? "unselected"} open={!selected}>
          <summary>Browse saved check results ({report.total})</summary>
          {groups.map(({ title, matches }) => {
            const rows = report?.rows.filter(matches) ?? [];
            return (
              rows.length > 0 && (
                <div key={title}>
                  <h3>{title}</h3>
                  <ul className="programmatic-list">
                    {rows.map((row) => (
                      <li key={row.id}>
                        <button
                          className="btn btn-ghost programmatic-row"
                          aria-pressed={
                            (!state.selection || state.selection.source === "deterministic") &&
                            state.selectedId === row.id
                          }
                          disabled={locked}
                          onClick={() => {
                            focusSelection.current = true;
                            onSelect(row.id);
                          }}
                        >
                          <span>{row.expectedOutput}</span>
                          <Badge>{stateLabels[row.state]}</Badge>
                          {row.presence === "disappeared" && <Badge>No longer found</Badge>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            );
          })}
        </details>
      )}
      {report && (report.offset > 0 || report.total > PROGRAMMATIC_CHAT_PAGE_LIMIT) && (
        <nav className="programmatic-actions" aria-label="Opportunity pages">
          <button
            className="btn btn-ghost btn-sm"
            disabled={locked || report.offset === 0}
            onClick={() =>
              onAction({
                version: 1,
                action: "report",
                offset: Math.max(0, report.offset - PROGRAMMATIC_CHAT_PAGE_LIMIT),
              })
            }
          >
            Previous opportunities
          </button>
          <span>
            {report.rows.length > 0
              ? `${report.offset + 1}–${report.offset + report.rows.length} of ${report.total}`
              : `No deterministic results on this page (${report.total} total).`}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={locked || report.offset + report.rows.length >= report.total}
            onClick={() =>
              onAction({
                version: 1,
                action: "report",
                offset: report.offset + PROGRAMMATIC_CHAT_PAGE_LIMIT,
              })
            }
          >
            Next opportunities
          </button>
        </nav>
      )}
      {state.missingSelection && (
        <p>
          Your selected opportunity is not in the restored results. Choose another item to review;
          none was selected for you.
        </p>
      )}
      {selected && (
        <div className="programmatic-detail">
          <h3 tabIndex={-1} data-programmatic-selection>
            {selected.summary.expectedOutput}
          </h3>
          <p>
            <Badge>{stateLabels[selected.summary.state]}</Badge>{" "}
            {selected.summary.presence === "disappeared" && "No longer found; cannot start."}
          </p>
          <p>{selected.summary.route.reason}</p>
          {selected.summary.actions?.run.available === false && (
            <p>{selected.summary.actions.run.reason}</p>
          )}
          {selected.summary.route.machineLocal && (
            <p>
              This task tool is installed on this computer. It may not be available on another
              computer.
            </p>
          )}
          <h4>Files this task may change</h4>
          {selected.summary.mutationPaths.length ? (
            <ul>
              {selected.summary.mutationPaths.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>No project file changes are listed. Review the task's scope before approving it.</p>
          )}
          {!!selected.risks.length && (
            <>
              <h4>Risks to consider</h4>
              <ul>
                {selected.risks.map((risk, index) => (
                  <li key={index}>{risk}</li>
                ))}
              </ul>
            </>
          )}
          <div className="programmatic-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={mutationLocked || !canRunProgrammaticSelection(state)}
              title={setupBlockedReason ?? selected.summary.actions?.run.reason}
              onClick={onRun}
            >
              Review task approval
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={
                mutationLocked ||
                !["discovered", "queued"].includes(selected.summary.state) ||
                selected.summary.actions?.dismiss.available !== true ||
                state.detailSnapshot !== report?.snapshot
              }
              title={selected.summary.actions?.dismiss.reason}
              onClick={() =>
                onAction({
                  version: 1,
                  action: "dismiss",
                  id: selected.summary.id,
                  snapshot: state.detailSnapshot!,
                })
              }
            >
              Dismiss this item
            </button>
          </div>

          <details>
            <summary>Why this was suggested and how to check it</summary>
            <h4>What was found</h4>
            <p>{selected.trigger}</p>
            <h4>How success should be checked</h4>
            <p>{selected.verification}</p>
            <h4>Evidence</h4>
            <ul>
              {selected.evidence.map((item, index) => (
                <li key={index}>
                  <Badge>
                    {item.basis === "observed"
                      ? "Checked directly"
                      : item.basis === "inferred"
                        ? "Inferred, not confirmed"
                        : "Assumed, not checked"}
                  </Badge>{" "}
                  {item.message}
                  {item.location && (
                    <>
                      {" "}
                      <code>
                        {item.location.path}
                        {item.location.startLine ? `:${item.location.startLine}` : ""}
                      </code>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {selected.evidenceTruncated && <p>Showing the first 50 evidence items.</p>}
          </details>
        </div>
      )}
    </section>
  );
  const hasSuggestions = !!state.discovery || !!state.assessment || !!state.candidateDetail;
  const resultsFirst = !!selected || (!hasSuggestions && !!report?.total);
  const setupFirst =
    showProposal || (!hasSuggestions && !report?.total && configuration?.status !== "current");
  return (
    <section
      className="programmatic-chat"
      ref={root}
      aria-labelledby={headingId}
      onFocusCapture={(event) => {
        focused.current = event.target as HTMLElement;
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !root.current?.contains(next)) focused.current = null;
      }}
    >
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        Opportunities
      </h2>
      <p role="status" aria-live="polite" aria-atomic="true">
        {state.operation
          ? `${state.operation === "report" || state.operation === "detail" ? "Loading" : "Working"}…`
          : busy
            ? "Work is in progress. Follow the approval prompts or stop the run in this chat."
            : state.notice}
      </p>
      {planMode && (
        <p>
          Leave plan mode before requesting new suggestions, saving settings or running checks. You
          can still browse saved results.
        </p>
      )}
      {state.error && (
        <>
          <p role="alert">
            {state.reconcile
              ? "We couldn't confirm whether this was saved. Check the saved results before trying again."
              : "This request did not finish. You can retry it when the current work has stopped."}
          </p>
          <div className="programmatic-actions">{reloadResults}</div>
          <details>
            <summary>Error details</summary>
            <p>{state.error}</p>
          </details>
        </>
      )}
      {state.reconcile && !state.error && (
        <p>
          Reload the results to check what was saved before trying again. This action will not retry
          automatically.
        </p>
      )}
      {setupFirst
        ? [setupStage, discoveryStage, resultsStage]
        : resultsFirst
          ? [resultsStage, discoveryStage, setupStage]
          : [discoveryStage, resultsStage, setupStage]}
    </section>
  );
}
