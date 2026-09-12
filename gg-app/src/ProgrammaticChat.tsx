import { useId, useLayoutEffect, useRef } from "react";
import {
  PROGRAMMATIC_CHAT_PAGE_LIMIT,
  type ProgrammaticChatRequest,
  type ProgrammaticChatSummary,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";
import { canRunProgrammaticSelection, type ProgrammaticChatState } from "./programmatic-chat-state";

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
  onRun,
}: {
  state: ProgrammaticChatState;
  busy: boolean;
  planMode: boolean;
  onAction(request: ProgrammaticChatRequest): void;
  onSelect(id: string): void;
  onRun(): void;
}): React.ReactElement {
  const headingId = useId();
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (focused.current && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
    if (focused.current && !focused.current.isConnected) focused.current = null;
  });
  const locked = busy || state.operation !== null;
  const mutationLocked = locked || planMode || state.reconcile;
  const report = state.report;
  const selected = state.detail;
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
          Plan mode lets you review without making changes. Turn it off before saving setup,
          checking for opportunities, starting work or dismissing an item.
        </p>
      )}
      {report && <p>{report.reason}</p>}
      {report && !report.scan.available && <p>{report.scan.reason}</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.reconcile && (
        <p>
          Reload the results to check what was saved before trying again. This action
          will not retry automatically.
        </p>
      )}
      <div className="programmatic-actions">
        <button
          className="btn btn-ghost btn-sm"
          disabled={locked}
          onClick={() => onAction({ version: 1, action: "inspect-setup" })}
        >
          Review setup
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={locked}
          onClick={() => onAction({ version: 1, action: "report", offset: report?.offset ?? 0 })}
        >
          {state.error ? "Retry loading results" : "Refresh results"}
        </button>
        {report && report.status !== "setup-required" && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={mutationLocked || report.scan?.available !== true}
            title={report.scan?.reason}
            onClick={() => onAction({ version: 1, action: "scan" })}
          >
            Check for opportunities
          </button>
        )}
      </div>
      {state.proposal && (
        <div className="programmatic-proposal">
          <h3>Review what to enable</h3>
          <p>
            Find repeatable tasks GG can help with. Reviewing setup changes no files.
            Approve and save setup writes the check settings shown below to this project.
            It does not start the work; each task needs a separate approval.
          </p>
          <pre aria-label="Exact settings to save">{state.proposal.profileJson}</pre>
          <p>
            Settings version (used to detect changes): <code>{state.proposal.fingerprint}</code>
          </p>
          <h4>Tasks and the tools that handle them</h4>
          <ul>
            {state.proposal.routes.map(({ id, route }) => (
              <li key={id}>
                {route.command ?? "Unavailable"}: {route.reason}
                {route.machineLocal &&
                  " This task tool must be installed on the computer you use."}
              </li>
            ))}
          </ul>
          <details>
            <summary>What is skipped and which files were checked</summary>
            <h4>Skipped items</h4>
            <ul>
              {state.proposal.exclusions.map((item, index) => (
                <li key={index}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
            <h4>Files checked and their versions</h4>
            <ul>
              {state.proposal.configurationInputs.map((item) => (
                <li key={item.path}>
                  <code>{item.path}</code>: <code>{item.sha256}</code>
                </li>
              ))}
            </ul>
          </details>
          {!state.proposalApprovable && (
            <p>Choose Review setup again before approving. These older settings are shown for reference only.</p>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={mutationLocked || !state.proposalApprovable}
            onClick={() =>
              onAction({
                version: 1,
                action: "approve-setup",
                proposalHandle: state.proposal!.handle,
              })
            }
          >
            Approve and save setup
          </button>
        </div>
      )}
      {report?.status === "setup-required" && (
        <p>Start with Review setup to see which repeatable tasks GG can help with. Nothing is saved until you approve.</p>
      )}
      {report && report.status !== "setup-required" && report.total === 0 && (
        <p>No opportunities to show. Choose Check for opportunities to run the saved checks and save their results. This does not start any task.</p>
      )}
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
                      aria-pressed={state.selectedId === row.id}
                      disabled={locked}
                      onClick={() => onSelect(row.id)}
                    >
                      <span>{row.expectedOutput}</span>
                      <Badge>{stateLabels[row.state]}</Badge>
                      {row.presence === "disappeared" && <Badge>No longer found</Badge>}
                    </button>
                    <p>{row.route.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )
        );
      })}
      {report && (report.offset > 0 || report.total > PROGRAMMATIC_CHAT_PAGE_LIMIT) && (
        <nav className="programmatic-actions" aria-label="Opportunity pages">
          <button
            className="btn btn-ghost btn-sm"
            disabled={locked || report.offset === 0}
            onClick={() =>
              onAction({ version: 1, action: "report", offset: Math.max(0, report.offset - PROGRAMMATIC_CHAT_PAGE_LIMIT) })
            }
          >
            Previous opportunities
          </button>
          <span>
            {report.rows.length > 0
              ? `${report.offset + 1}–${report.offset + report.rows.length} of ${report.total}`
              : `No opportunities on this page (${report.total} total).`}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={locked || report.offset + report.rows.length >= report.total}
            onClick={() => onAction({ version: 1, action: "report", offset: report.offset + PROGRAMMATIC_CHAT_PAGE_LIMIT })}
          >
            Next opportunities
          </button>
        </nav>
      )}
      {state.missingSelection && (
        <p>
          Your selected opportunity is not in the restored results. Choose another item to
          review; none was selected for you.
        </p>
      )}
      {selected && (
        <div className="programmatic-detail">
          <h3>Selected opportunity</h3>
          <p>{selected.summary.expectedOutput}</p>
          <p>
            <Badge>{stateLabels[selected.summary.state]}</Badge>{" "}
            {selected.summary.presence === "disappeared" && "No longer found; cannot start."}
          </p>
          <p>{selected.summary.route.reason}</p>
          {selected.summary.actions?.run.available === false && <p>{selected.summary.actions.run.reason}</p>}
          {selected.summary.route.machineLocal && (
            <p>This task tool is installed on this computer. It may not be available on another computer.</p>
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
            <p>This task only reads information; it does not change project files.</p>
          )}
          <div className="programmatic-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={mutationLocked || !canRunProgrammaticSelection(state)}
              title={selected.summary.actions?.run.reason}
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
            <h4>Risks</h4>
            <ul>
              {selected.risks.map((risk, index) => (
                <li key={index}>{risk}</li>
              ))}
            </ul>
            <h4>Evidence</h4>
            <ul>
              {selected.evidence.map((item, index) => (
                <li key={index}>
                  <Badge>{item.basis === "observed" ? "Checked directly" : item.basis === "inferred" ? "Inferred, not confirmed" : "Assumed, not checked"}</Badge> {item.message}
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
}
