import { useId, useLayoutEffect, useRef } from "react";
import {
  PROGRAMMATIC_CHAT_PAGE_LIMIT,
  type ProgrammaticChatRequest,
  type ProgrammaticChatSummary,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";
import { canRunProgrammaticSelection, type ProgrammaticChatState } from "./programmatic-chat-state";

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
      title: "Actionable",
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
    { title: "Disappeared", matches: (row) => row.presence === "disappeared" },
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
            ? "A run is active. Use the existing approval and cancellation controls below."
            : state.notice}
      </p>
      {planMode && (
        <p>
          Plan mode: inspection only. Leave plan mode before approving, scanning, running or
          dismissing.
        </p>
      )}
      {report && <p>{report.reason}</p>}
      {report && !report.scan.available && <p>{report.scan.reason}</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.reconcile && (
        <p>
          Read the current report before submitting another change. Nothing is retried
          automatically.
        </p>
      )}
      <div className="programmatic-actions">
        <button
          className="btn btn-ghost btn-sm"
          disabled={locked}
          onClick={() => onAction({ version: 1, action: "inspect-setup" })}
        >
          Inspect setup
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={locked}
          onClick={() => onAction({ version: 1, action: "report", offset: report?.offset ?? 0 })}
        >
          {state.error ? "Retry report" : "Refresh report"}
        </button>
        {report && report.status !== "setup-required" && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={mutationLocked || report.scan?.available !== true}
            title={report.scan?.reason}
            onClick={() => onAction({ version: 1, action: "scan" })}
          >
            Rescan
          </button>
        )}
      </div>
      {state.proposal && (
        <div className="programmatic-proposal">
          <h3>Exact setup proposal</h3>
          <p>
            Inspection writes nothing. Approve only this profile; specialist execution requires its
            own approval.
          </p>
          <pre aria-label="Exact proposed profile">{state.proposal.profileJson}</pre>
          <p>
            Configuration fingerprint: <code>{state.proposal.fingerprint}</code>
          </p>
          <h4>Proposed routes</h4>
          <ul>
            {state.proposal.routes.map(({ id, route }) => (
              <li key={id}>
                {route.command ?? "Unavailable"}: {route.reason}
                {route.machineLocal &&
                  " Available only on machines with this specialist installed."}
              </li>
            ))}
          </ul>
          <details>
            <summary>Exclusions and configuration inputs</summary>
            <h4>Exclusions</h4>
            <ul>
              {state.proposal.exclusions.map((item, index) => (
                <li key={index}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
            <h4>Configuration inputs</h4>
            <ul>
              {state.proposal.configurationInputs.map((item) => (
                <li key={item.path}>
                  <code>{item.path}</code>: <code>{item.sha256}</code>
                </li>
              ))}
            </ul>
          </details>
          {!state.proposalApprovable && (
            <p>Inspect setup again before approving. This proposal is retained for reference only.</p>
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
            Approve setup
          </button>
        </div>
      )}
      {report?.status === "setup-required" && (
        <p>Setup required. Inspect the exact profile before approving it.</p>
      )}
      {report && report.status !== "setup-required" && report.total === 0 && (
        <p>No opportunities in this report. Scan to check the approved profile.</p>
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
                      <Badge>{row.state}</Badge>
                      {row.presence === "disappeared" && <Badge>Disappeared</Badge>}
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
          The selected opportunity is missing from the recovered report. No replacement was
          selected.
        </p>
      )}
      {selected && (
        <div className="programmatic-detail">
          <h3>Selected opportunity</h3>
          <p>{selected.summary.expectedOutput}</p>
          <p>
            <Badge>{selected.summary.state}</Badge>{" "}
            {selected.summary.presence === "disappeared" && "Disappeared; cannot run."}
          </p>
          <p>{selected.summary.route.reason}</p>
          {selected.summary.actions?.run.available === false && <p>{selected.summary.actions.run.reason}</p>}
          {selected.summary.route.machineLocal && (
            <p>This specialist is machine-local and may be unavailable elsewhere.</p>
          )}
          <h4>Mutation boundary</h4>
          {selected.summary.mutationPaths.length ? (
            <ul>
              {selected.summary.mutationPaths.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>Read-only; no project changes.</p>
          )}
          <div className="programmatic-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={mutationLocked || !canRunProgrammaticSelection(state)}
              title={selected.summary.actions?.run.reason}
              onClick={onRun}
            >
              Run selected opportunity
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
              Dismiss selected opportunity
            </button>
          </div>
          <details>
            <summary>Evidence and verification</summary>
            <h4>Repeatable trigger</h4>
            <p>{selected.trigger}</p>
            <h4>Verification</h4>
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
                  <Badge>{item.basis}</Badge> {item.message}
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
