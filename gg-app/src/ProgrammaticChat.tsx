import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  PROGRAMMATIC_CHAT_PAGE_LIMIT,
  type ProgrammaticChatRequest,
  type ProgrammaticChatSummary,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";
import { GlassLamp } from "./GlassLamp";
import { ProgrammaticAssessment } from "./ProgrammaticAssessment";
import { ProgrammaticIdeas, ProgrammaticPastIdeas } from "./ProgrammaticDiscovery";
import { NotesTabList } from "./NotesTabList";
import { ProgrammaticSetup } from "./ProgrammaticSetup";
import { evidenceBasisLabel } from "./ProgrammaticExecutionEvidence";
import {
  canRunProgrammaticSelection,
  canScanProgrammatic,
  isProgrammaticCurrentReview,
  programmaticConfiguration,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
import {
  opportunityStatusLine,
  useOpportunityTab,
  type OpportunityTab,
} from "./programmatic-opportunity-tabs";

export { ProgrammaticExecutionEvidenceView } from "./ProgrammaticExecutionEvidence";

const stateLabels: Record<ProgrammaticChatSummary["state"], string> = {
  discovered: "New",
  queued: "Waiting to start",
  running: "Running",
  completed: "Done",
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
        ? "This project can't be checked right now. You can still find ideas."
        : configuration.status === "unreadable"
          ? "Your saved setup can't be read, so checks can't run. You can still find ideas."
          : "Set up checks before running them. You don't need setup to find ideas."
      : undefined;
  const groups: { title: string; matches(row: ProgrammaticChatSummary): boolean }[] = [
    {
      title: "Ready to review",
      matches: (row) =>
        row.presence === "present" && !["completed", "dismissed"].includes(row.state),
    },
    {
      title: "Done",
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
  const selectCandidate = (source: "current" | "history", id: string) => {
    focusSelection.current = true;
    onSelectCandidate?.(source, id);
  };
  const ideasStage = (
    <>
      <ProgrammaticIdeas
        state={state}
        locked={locked}
        planMode={planMode}
        onRequest={onAction}
        onSelect={selectCandidate}
      />
    </>
  );
  const resultsStage = (
    <section
      key="results"
      id={`${headingId}-results`}
      className="programmatic-stage inst-module"
      aria-label="Check results"
    >
      <h3 className="opp-section-title">Check results</h3>
      {reportAssessmentSuperseded && (
        <p>These results are older than your latest setup. Refresh results to update them.</p>
      )}
      {report && ["stale", "recovered"].includes(report.status) && <p>{report.reason}</p>}
      {report && !report.scan.available && report.status !== "setup-required" && (
        <p>{setupBlockedReason ?? report.scan.reason}</p>
      )}
      {report?.status !== "setup-required" && (
        <p>Runs the checks you set up. Refresh just reloads the last results.</p>
      )}
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
      {report?.status === "setup-required" && <p>Set up checks first.</p>}
      {report && report.status !== "setup-required" && report.total === 0 && (
        <p>No results yet. Choose Run project checks to run them. This won't start any work.</p>
      )}
      {!!report?.rows.length && (
        <details key={selected?.summary.id ?? "unselected"} open={!selected}>
          <summary>Show all results ({report.total})</summary>
          {groups.map(({ title, matches }) => {
            const rows = report?.rows.filter(matches) ?? [];
            return (
              rows.length > 0 && (
                <div key={title}>
                  <h4>{title}</h4>
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
        <nav className="programmatic-actions" aria-label="Result pages">
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
            Previous page
          </button>
          <span>
            {report.rows.length > 0
              ? `${report.offset + 1}–${report.offset + report.rows.length} of ${report.total}`
              : `No results on this page (${report.total} total).`}
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
            Next page
          </button>
        </nav>
      )}
      {state.missingSelection && (
        <p>The item you picked isn't in these results anymore. Pick another one.</p>
      )}
      {selected && (
        <div className="programmatic-detail inst-module">
          <h3 tabIndex={-1} data-programmatic-selection>
            {selected.summary.expectedOutput}
          </h3>
          <p>
            <Badge>{stateLabels[selected.summary.state]}</Badge>{" "}
            {selected.summary.presence === "disappeared" && "No longer found, so it can't start."}
          </p>
          <p>{selected.summary.route.reason}</p>
          {selected.summary.actions?.run.available === false && (
            <p>{selected.summary.actions.run.reason}</p>
          )}
          {selected.summary.route.machineLocal && (
            <p>This tool is only installed on this computer.</p>
          )}
          <h4>Files it may change</h4>
          {selected.summary.mutationPaths.length ? (
            <ul>
              {selected.summary.mutationPaths.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>No files are listed. Check what it does before you approve it.</p>
          )}
          {!!selected.risks.length && (
            <>
              <h4>Risks</h4>
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
              Review and run
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
            <summary>Why this came up</summary>
            <h4>What was found</h4>
            <p>{selected.trigger}</p>
            <h4>How to tell it worked</h4>
            <p>{selected.verification}</p>
            <h4>Where it was found</h4>
            <ul>
              {selected.evidence.map((item, index) => (
                <li key={index}>
                  <Badge>{evidenceBasisLabel(item.basis)}</Badge> {item.message}
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
            {selected.evidenceTruncated && <p>Showing the first 50.</p>}
          </details>
        </div>
      )}
    </section>
  );
  const setupFirst = showProposal || (!report?.total && configuration?.status !== "current");
  const [tab, setTab] = useOpportunityTab(state, showProposal);
  const ideaCount = state.discovery?.candidates.length ?? 0;
  const tabId = (id: OpportunityTab) => `${headingId}-tab-${id}`;
  const panelId = (id: OpportunityTab) => `${headingId}-panel-${id}`;
  const count = (value: number | undefined) =>
    // The leading space keeps the accessible name "Checks 3", not "Checks3"; flex gap spaces it visually.
    value ? <span className="inst-tab-count"> {value}</span> : undefined;
  const tabs = [
    { id: "ideas" as const, label: "Ideas", adornment: count(ideaCount) },
    { id: "checks" as const, label: "Checks", adornment: count(report?.total) },
    { id: "past" as const, label: "Past ideas", adornment: count(state.historyReport?.total) },
  ];
  const panel = (id: OpportunityTab, children: React.ReactNode) => (
    <div
      key={id}
      id={panelId(id)}
      role="tabpanel"
      aria-labelledby={tabId(id)}
      className="opp-panel"
      hidden={tab !== id}
    >
      {children}
    </div>
  );
  return (
    <section
      className="programmatic-chat instrument"
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
      <header className="opp-head">
        <GlassLamp active={!!state.assessmentPending} />
        <div className="opp-head-text">
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            Opportunities
          </h2>
          <p className="opp-meta">{opportunityStatusLine(state)}</p>
        </div>
        <button
          type="button"
          className="inst-key"
          data-quiet={tab === "ideas" ? undefined : ""}
          disabled={locked || planMode || state.reconcile}
          onClick={() => onAction({ version: 1, action: "discover" })}
        >
          {state.discoveryStale && state.discovery ? "Search again" : "Find ideas"}
        </button>
      </header>
      <p className="opp-status" role="status" aria-live="polite" aria-atomic="true">
        {state.operation
          ? `${state.operation === "report" || state.operation === "detail" ? "Loading" : "Working"}…`
          : busy
            ? "Work is running. Answer the prompts or stop it in this chat."
            : state.notice}
      </p>
      {planMode && (
        <p className="opp-notice" data-tone="warning">
          Turn off plan mode to find ideas, save setup or run checks. You can still look at results.
        </p>
      )}
      {state.error && (
        <>
          <p className="opp-notice" data-tone="error" role="alert">
            {state.reconcile
              ? "We couldn't tell if that was saved. Refresh results before trying again."
              : "That didn't finish. Try again when nothing else is running."}
          </p>
          <div className="programmatic-actions">{reloadResults}</div>
          <details>
            <summary>Error details</summary>
            <p>{state.error}</p>
          </details>
        </>
      )}
      {state.reconcile && !state.error && (
        <p className="opp-notice" data-tone="warning">
          Refresh results to see what was saved. Nothing will retry on its own.
        </p>
      )}
      <NotesTabList<OpportunityTab>
        label="Opportunities sections"
        tabs={tabs}
        activeId={tab}
        onSelect={setTab}
        tabId={tabId}
        panelId={panelId}
        className="inst-tabs"
        scrollClassName="inst-tabs-scroll"
      />
      {panel("ideas", ideasStage)}
      {panel("checks", setupFirst ? [setupStage, resultsStage] : [resultsStage, setupStage])}
      {state.assessment && (
        // Search and check outcomes stay visible beside both Ideas and Checks; never behind a tab.
        <div className="opp-search inst-module" hidden={tab === "past"}>
          <ProgrammaticAssessment
            assessment={state.assessment}
            previous={state.assessmentRetained}
          />
        </div>
      )}
      {panel(
        "past",
        <ProgrammaticPastIdeas
          state={state}
          locked={locked}
          planMode={planMode}
          onRequest={onAction}
          onSelect={selectCandidate}
        />,
      )}
    </section>
  );
}
