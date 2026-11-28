import {
  PROGRAMMATIC_CHAT_PAGE_LIMIT,
  type ProgrammaticChatDetail,
  type ProgrammaticChatReport,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { Badge } from "./Badge";
import {
  CHECKS_ACTIONS,
  CHECK_RESULT_STATE_LABELS as stateLabels,
  evidenceBasisLabel,
} from "./programmatic-presentation";

interface ProgrammaticCheckDetailProps {
  selected: ProgrammaticChatDetail;
  runDisabled: boolean;
  runTitle: string | undefined;
  dismissDisabled: boolean;
  onRun(): void;
  onDismiss(): void;
}

/** One selected check result; the chat keeps the request and lock ownership. */
export function ProgrammaticCheckDetail({
  selected,
  runDisabled,
  runTitle,
  dismissDisabled,
  onRun,
  onDismiss,
}: ProgrammaticCheckDetailProps): React.ReactElement {
  return (
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
      {selected.summary.route.machineLocal && <p>This tool is only installed on this computer.</p>}
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
          disabled={runDisabled}
          title={runTitle}
          onClick={onRun}
        >
          Review and run
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={dismissDisabled}
          title={selected.summary.actions?.dismiss.reason}
          onClick={onDismiss}
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
  );
}

/** Previous/next result pages; the chat sends the report request. */
export function ProgrammaticResultPages({
  report,
  locked,
  onPage,
}: {
  report: ProgrammaticChatReport;
  locked: boolean;
  onPage(offset: number): void;
}): React.ReactElement | null {
  if (report.offset === 0 && report.total <= PROGRAMMATIC_CHAT_PAGE_LIMIT) return null;
  return (
    <nav className="programmatic-actions" aria-label="Result pages">
      <button
        className="btn btn-ghost btn-sm"
        disabled={locked || report.offset === 0}
        onClick={() => onPage(Math.max(0, report.offset - PROGRAMMATIC_CHAT_PAGE_LIMIT))}
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
        onClick={() => onPage(report.offset + PROGRAMMATIC_CHAT_PAGE_LIMIT)}
      >
        Next page
      </button>
    </nav>
  );
}
