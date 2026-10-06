import type {
  ProgrammaticChatConfiguration,
  ProgrammaticChatProposal,
  ProgrammaticChatReport,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";

interface ProgrammaticSetupProps {
  id: string;
  configuration: ProgrammaticChatConfiguration | null;
  report: ProgrammaticChatReport | null;
  proposal: ProgrammaticChatProposal | null;
  showProposal: boolean;
  currentReview: boolean;
  reportAssessmentSuperseded: boolean;
  setupBlockedReason: string | undefined;
  inspectDisabled: boolean;
  approveDisabled: boolean;
  closeDisabled: boolean;
  proposalApprovable: boolean;
  onInspect(): void;
  onApprove(): void;
  onClose(): void;
}

/** Setup presentation only; the chat retains proposal state and request ownership. */
export function ProgrammaticSetup({
  id,
  configuration,
  report,
  proposal,
  showProposal,
  currentReview,
  reportAssessmentSuperseded,
  setupBlockedReason,
  inspectDisabled,
  approveDisabled,
  closeDisabled,
  proposalApprovable,
  onInspect,
  onApprove,
  onClose,
}: ProgrammaticSetupProps) {
  return (
    <section id={id} className="programmatic-stage" aria-label="Saved checks setup">
      <h3>{configuration?.status === "current" ? "Saved check setup" : "Set up saved checks"}</h3>
      {configuration?.status === "current" && !showProposal ? (
        <p>Saved check settings are up to date.</p>
      ) : (
        <p>
          Choose which project checks to save. Discovery is available separately, without setup.
        </p>
      )}
      {(configuration?.status !== "current" || showProposal) && (
        <>
          {reportAssessmentSuperseded ? (
            <p>
              These results predate the latest setup review. Refresh results to update task
              availability.
            </p>
          ) : (
            <>
              {report && (!showProposal || report.status !== "setup-required") && (
                <p>{report.reason}</p>
              )}
              {report &&
                !report.scan.available &&
                (!showProposal || report.status !== "setup-required") && (
                  <p>{report.scan.reason}</p>
                )}
            </>
          )}
          {setupBlockedReason && <p>{setupBlockedReason}</p>}
          {report?.status === "stale" && (
            <p>
              Older results remain available below. Saving setup does not update these results;
              choose Run project checks afterward.
            </p>
          )}
          {configuration?.diagnostic && (
            <details>
              <summary>Setup error details</summary>
              <p>{configuration.diagnostic}</p>
            </details>
          )}
          {configuration?.status === "refresh-required" && (
            <details>
              <summary>Why setup needs a refresh</summary>
              {configuration.baselineUnavailable && (
                <p>
                  Saved setup needs a schema upgrade. Its prior per-file baseline is unavailable;
                  review all current inputs in the setup below.
                </p>
              )}
              {configuration.drift && (
                <>
                  <ul>
                    {configuration.drift.files.map((file) => (
                      <li key={file.path}>
                        {file.kind}: <code>{file.path}</code>
                      </li>
                    ))}
                  </ul>
                  {configuration.drift.policy && (
                    <p>
                      Configuration policy: {configuration.drift.policy.before} →{" "}
                      {configuration.drift.policy.after}
                    </p>
                  )}
                  {configuration.drift.schema && (
                    <p>
                      Scanner settings schema: {configuration.drift.schema.before} →{" "}
                      {configuration.drift.schema.after}
                    </p>
                  )}
                  {configuration.drift.exclusions && (
                    <>
                      <p>Skipped-item rules changed.</p>
                      <p>
                        Previously: {configuration.drift.exclusions.before.join(", ") || "None"}
                      </p>
                      <p>Now: {configuration.drift.exclusions.after.join(", ") || "None"}</p>
                    </>
                  )}
                </>
              )}
              <p>
                Any byte change in a recognized configuration file needs review, including cosmetic
                manifest edits.
              </p>
            </details>
          )}
        </>
      )}
      <div className="programmatic-actions">
        <button
          className={`btn ${!showProposal && configuration?.status !== "current" ? "btn-primary" : "btn-ghost"} btn-sm`}
          disabled={inspectDisabled}
          onClick={onInspect}
        >
          {configuration?.status === "current"
            ? "Change settings"
            : configuration?.refreshAvailable
              ? "Review setup refresh"
              : "Review setup"}
        </button>
      </div>
      {proposal && showProposal && (
        <div className="programmatic-proposal">
          <h3>
            {proposal.operation === "current"
              ? currentReview
                ? "Saved setup is current"
                : "Previous setup review"
              : "Review what to enable"}
          </h3>
          {proposal.operation === "current" ? (
            currentReview ? (
              <p>No regeneration or approval is needed. Source changes only need a rescan.</p>
            ) : (
              <p>
                This review has been superseded by a newer setup assessment. These older settings
                are shown for reference only.
              </p>
            )
          ) : (
            <p>
              Find repeatable tasks GG can help with. Reviewing setup changes no files. Approve and
              save setup writes the check settings shown below to this project. It does not start
              the work; each task needs a separate approval.
            </p>
          )}

          {proposal.historyPolicy && (
            <>
              <p>
                History: {proposal.historyPolicy.enabled ? "enabled" : "disabled"}.
                {proposal.historyPolicy.enabled &&
                  " Approval saves future configured assessments automatically—not this setup or old chats. No work is approved or verified."}
                {proposal.operation === "history-upgrade" &&
                  " Or leave without approving to keep checks. Restoring prior settings needs separate approval."}
              </p>
            </>
          )}

          <h4>Tasks and the tools that handle them</h4>
          <ul>
            {proposal.routes.map(({ id, route }) => (
              <li key={id}>
                {route.command ?? "Unavailable"}: {route.reason}
                {route.machineLocal && " This task tool must be installed on the computer you use."}
              </li>
            ))}
          </ul>
          <details>
            <summary>Technical details: exact settings, history policy and checked files</summary>
            <pre aria-label="Exact settings to save">{proposal.profileJson}</pre>
            {proposal.historyPolicy && (
              <pre aria-label="Exact history policy to save">
                {JSON.stringify(
                  {
                    historyPolicy: proposal.historyPolicy,
                    expectedRecoveryDigest: proposal.expectedRecoveryDigest,
                  },
                  null,
                  2,
                )}
              </pre>
            )}
            <p>
              Settings version (used to detect changes): <code>{proposal.fingerprint}</code>
            </p>
            <h4>Skipped items</h4>
            <ul>
              {proposal.exclusions.map((item, index) => (
                <li key={index}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
            <h4>Files checked and their versions</h4>
            <ul>
              {proposal.configurationInputs.map((item) => (
                <li key={item.path}>
                  <code>{item.path}</code>: <code>{item.sha256}</code>
                </li>
              ))}
            </ul>
          </details>
          {!proposalApprovable && proposal.operation !== "current" && (
            <p>
              Choose Review setup again before approving. These older settings are shown for
              reference only.
            </p>
          )}
          <div className="programmatic-actions">
            {proposal.handle && (
              <button
                className="btn btn-primary btn-sm"
                disabled={approveDisabled}
                onClick={onApprove}
              >
                {proposal.operation === "refresh"
                  ? "Approve and save refresh"
                  : proposal.operation === "history-upgrade"
                    ? "Approve history saving"
                    : "Approve and save setup"}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={closeDisabled} onClick={onClose}>
              Close review without saving
            </button>
          </div>
        </div>
      )}
      {report?.status === "setup-required" && !showProposal && (
        <p>Nothing is saved until you approve. You can still discover opportunities below.</p>
      )}
    </section>
  );
}
