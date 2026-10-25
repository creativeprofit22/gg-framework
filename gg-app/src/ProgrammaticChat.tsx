import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  PROGRAMMATIC_CHAT_PAGE_LIMIT,
  type ProgrammaticChatRequest,
  type ProgrammaticChatSummary,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";
import { GlassLamp } from "./GlassLamp";
import { ProgrammaticAssessment } from "./ProgrammaticAssessment";
import {
  ProgrammaticIdeaSearch,
  ProgrammaticIdeas,
  ProgrammaticPastIdeas,
} from "./ProgrammaticDiscovery";
import { NotesTabList } from "./NotesTabList";
import { ProgrammaticSetup } from "./ProgrammaticSetup";
import {
  canRunProgrammaticSelection,
  canScanProgrammatic,
  isProgrammaticCurrentReview,
  programmaticConfiguration,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
import {
  nextOpportunityStep,
  opportunitySteps,
  useChecksSkip,
  useOpportunityTab,
  type OpportunityStep,
} from "./programmatic-opportunity-tabs";
import {
  CHECKS_ACTIONS,
  CHECKS_COPY,
  CHECK_RESULT_STATE_LABELS as stateLabels,
  REVIEW_EMPTY,
  REVIEW_GROUPS,
  STEP_ACTIONS,
  STEP_COPY,
  STEP_STATE_WORDS,
  evidenceBasisLabel,
  opportunityStatusLine,
} from "./programmatic-presentation";

export { ProgrammaticExecutionEvidenceView } from "./ProgrammaticExecutionEvidence";

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
  const focusReview = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const pastLink = useRef<HTMLButtonElement>(null);
  const stepRefs = useRef<Partial<Record<OpportunityStep, HTMLButtonElement | null>>>({});
  // Closing a review changes presentation only, never the retained proposal or its authority.
  const [closedProposal, setClosedProposal] = useState<ProgrammaticChatState["proposal"]>(null);
  const showProposal = !!state.proposal && closedProposal !== state.proposal;
  useLayoutEffect(() => {
    if (focusReview.current) {
      focusReview.current = false;
      reviewHeading.current?.focus();
    }
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
        ? CHECKS_COPY.blockedInventory
        : configuration.status === "unreadable"
          ? CHECKS_COPY.blockedUnreadable
          : CHECKS_COPY.blockedSetup
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
  const [checksSkipped, skipChecks] = useChecksSkip(configuration);
  const [tab, setTab] = useOpportunityTab(
    state,
    showProposal,
    nextOpportunityStep(state, checksSkipped),
  );
  const { steps, keyAction, search } = opportunitySteps({
    state,
    showProposal,
    checksSkipped,
    planMode,
    busy,
    shown: tab,
  });
  // When the header key is on another step's action, search stays one quiet click away.
  const searchButton = keyAction.action !== "discover" && (
    <div className="programmatic-actions">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={search.disabled}
        onClick={() => onAction({ version: 1, action: "discover" })}
      >
        {search.label}
      </button>
    </div>
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
    <section
      key="ideas"
      id={`${headingId}-ideas`}
      className="programmatic-stage inst-module"
      aria-label={REVIEW_GROUPS.ideas}
    >
      <h3 className="opp-section-title">{REVIEW_GROUPS.ideas}</h3>
      <ProgrammaticIdeas
        state={state}
        locked={locked}
        planMode={planMode}
        onRequest={onAction}
        onSelect={selectCandidate}
      />
      {searchButton}
    </section>
  );
  const resultsStage = (
    <section
      key="results"
      id={`${headingId}-results`}
      className="programmatic-stage inst-module"
      aria-label={REVIEW_GROUPS.ready}
    >
      <h3 className="opp-section-title" ref={reviewHeading} tabIndex={-1}>
        {REVIEW_GROUPS.ready}
      </h3>
      {!report && <p className="opp-caption">{REVIEW_EMPTY.ready}</p>}
      {reportAssessmentSuperseded && <p>{CHECKS_COPY.superseded}</p>}
      {report && ["stale", "recovered"].includes(report.status) && <p>{report.reason}</p>}
      {report && !report.scan.available && report.status !== "setup-required" && (
        <p>{setupBlockedReason ?? report.scan.reason}</p>
      )}
      {report && report.status !== "setup-required" && (
        <div className="programmatic-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={mutationLocked || !canScanProgrammatic(state)}
            title={setupBlockedReason ?? report.scan?.reason}
            onClick={() => onAction({ version: 1, action: "scan" })}
          >
            {CHECKS_ACTIONS.checkAgain}
          </button>
        </div>
      )}
      {report?.status === "setup-required" && <p>{CHECKS_COPY.setupFirst}</p>}
      {report && report.status !== "setup-required" && report.total === 0 && (
        <p>{CHECKS_COPY.noResults}</p>
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
              {CHECKS_ACTIONS.dismiss}
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
  const checksIncomplete = steps[0]?.state !== "done";
  const tabId = (id: OpportunityStep) => `${headingId}-tab-${id}`;
  const panelId = (id: OpportunityStep) => `${headingId}-panel-${id}`;
  const tabs = steps.map(({ id, number, state: stepState }) => {
    const word = STEP_STATE_WORDS[stepState];
    return {
      id,
      label: STEP_COPY[id].label,
      labelPrefix: <span className="opp-step-num">{number}</span>,
      // The leading space keeps the accessible name "1 Quick checks Done"; the icon is decoration.
      adornment: (
        <span className="opp-step-state">
          {" "}
          <span aria-hidden="true">{word.icon}</span>{" "}
          <span className="opp-step-word">{word.word}</span>
        </span>
      ),
      current: stepState === "next",
      state: stepState,
    };
  });
  // Results or detail are being read: the panels are about to change.
  const loading = state.operation === "report" || state.operation === "detail";
  const panel = (id: OpportunityStep, children: React.ReactNode) => (
    <div
      key={id}
      id={panelId(id)}
      role="tabpanel"
      aria-labelledby={tabId(id)}
      aria-busy={loading || undefined}
      className="opp-panel"
      hidden={tab !== id}
    >
      <p className="opp-step-intro">{STEP_COPY[id].intro}</p>
      {children}
    </div>
  );
  const runKey = () => {
    switch (keyAction.action) {
      case "approve-setup":
        if (state.proposal?.handle)
          onAction({ version: 1, action: "approve-setup", proposalHandle: state.proposal.handle });
        return;
      case "inspect-setup":
        setClosedProposal(null);
        onAction({ version: 1, action: "inspect-setup" });
        return;
      case "discover":
        onAction({ version: 1, action: "discover" });
        return;
      case "open-review":
        focusReview.current = true;
        setTab("review");
        return;
    }
  };
  const skip = () => {
    // Session-only: nothing is saved, and changed project files bring step 1 back.
    skipChecks();
    setTab("ideas");
    stepRefs.current.ideas?.focus();
  };
  // Past ideas follows a past-idea selection until the user opens or closes it.
  const pastKey = state.selection?.source === "history" ? state.selection.id : "";
  const [pastToggle, setPastToggle] = useState<{ open: boolean; key: string } | null>(null);
  const pastOpen = pastToggle?.key === pastKey ? pastToggle.open : pastKey !== "";
  const pastId = `${headingId}-past`;
  const togglePast = () => setPastToggle({ open: !pastOpen, key: pastKey });
  // Read-only load once per opening from the link, only when nothing is loaded yet or the list
  // may be out of date. It follows the open state, so opening while busy loads once the lock
  // clears. An in-flight request sets state.operation, which keeps `locked` true until it
  // answers. Openings that follow a past-idea selection stay inert (explicit reload only).
  const pastOpenedByLink = pastToggle?.key === pastKey && pastToggle.open;
  const pastRequested = useRef(false);
  const pastNeedsLoad = !state.historyReport || state.historyReportStale;
  useEffect(() => {
    if (!pastOpenedByLink) {
      pastRequested.current = false;
      return;
    }
    if (locked || !pastNeedsLoad || pastRequested.current) return;
    pastRequested.current = true;
    onAction({ version: 1, action: "history-report", offset: 0 });
  }, [pastOpenedByLink, locked, pastNeedsLoad, onAction]);
  const closePast = () => {
    setPastToggle({ open: false, key: pastKey });
    pastLink.current?.focus();
  };
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
          ref={pastLink}
          className="btn btn-ghost btn-sm opp-past-link"
          aria-expanded={pastOpen}
          aria-controls={pastId}
          onClick={togglePast}
        >
          {STEP_ACTIONS.pastIdeas}
        </button>
        <button
          type="button"
          className="inst-key"
          data-quiet={keyAction.quiet ? "" : undefined}
          disabled={keyAction.disabled}
          onClick={runKey}
        >
          {keyAction.label}
        </button>
      </header>
      <section
        id={pastId}
        className="opp-past inst-module"
        aria-label={STEP_ACTIONS.pastIdeas}
        hidden={!pastOpen}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          closePast();
        }}
      >
        <div className="opp-past-head">
          <button type="button" className="btn btn-ghost btn-sm" onClick={closePast}>
            {STEP_ACTIONS.close}
          </button>
        </div>
        <ProgrammaticPastIdeas
          state={state}
          locked={locked}
          planMode={planMode}
          onRequest={onAction}
          onSelect={selectCandidate}
        />
      </section>
      <p className="opp-status" role="status" aria-live="polite" aria-atomic="true">
        {state.operation
          ? `${loading ? "Loading" : "Working"}…`
          : busy
            ? "Work is running. Answer the prompts or stop it in this chat."
            : state.notice}
      </p>
      {planMode && (
        <p className="opp-notice" data-tone="warning">
          {CHECKS_COPY.planMode}
        </p>
      )}
      {state.error && (
        <>
          <p className="opp-notice" data-tone="error" role="alert">
            {state.reconcile ? CHECKS_COPY.reconcileFailed : CHECKS_COPY.failed}
          </p>
          <div className="programmatic-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={locked}
              onClick={() =>
                onAction({ version: 1, action: "report", offset: report?.offset ?? 0 })
              }
            >
              {CHECKS_ACTIONS.tryAgain}
            </button>
          </div>
          <details>
            <summary>Error details</summary>
            <p>{state.error}</p>
          </details>
        </>
      )}
      {state.reconcile && !state.error && (
        <p className="opp-notice" data-tone="warning">
          {CHECKS_COPY.reconciling}
        </p>
      )}
      <NotesTabList<OpportunityStep>
        label="Opportunities steps"
        tabs={tabs}
        activeId={tab}
        onSelect={setTab}
        tabId={tabId}
        panelId={panelId}
        className="inst-tabs"
        scrollClassName="inst-tabs-scroll"
        tabRefs={stepRefs}
      />
      {panel(
        "checks",
        <>
          {setupStage}
          {checksIncomplete && !checksSkipped && (
            <div className="programmatic-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={skip}>
                {STEP_ACTIONS.skip}
              </button>
            </div>
          )}
        </>,
      )}
      {panel(
        "ideas",
        <>
          <ProgrammaticIdeaSearch state={state} />
          {searchButton}
        </>,
      )}
      {panel("review", [resultsStage, ideasStage])}
      {state.assessment && (
        // Search and check outcomes stay visible on every step, beside both Review groups.
        <div className="opp-search inst-module">
          <ProgrammaticAssessment
            assessment={state.assessment}
            previous={state.assessmentRetained}
          />
        </div>
      )}
    </section>
  );
}
