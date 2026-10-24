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
    <section id={id} className="programmatic-stage inst-module" aria-label="Check setup">
      <h3>{configuration?.status === "current" ? "Check setup" : "Set up checks"}</h3>
      {configuration?.status === "current" && !showProposal ? (
        <p>Your checks are set up.</p>
      ) : (
        <p>Pick which checks to save. You don't need this to find ideas.</p>
      )}
      {(configuration?.status !== "current" || showProposal) && (
        <>
          {reportAssessmentSuperseded ? (
            <p>These results are older than your latest setup. Refresh results to update them.</p>
          ) : (
            <>
              {report && (!showProposal || report.status !== "setup-required") && (
                <p>{report.reason}</p>
              )}
              {report && !report.scan.available && report.status !== "setup-required" && (
                <p>{report.scan.reason}</p>
              )}
            </>
          )}
          {setupBlockedReason && <p>{setupBlockedReason}</p>}
          {report?.status === "stale" && (
            <p>
              Older results are still below. After saving, choose Run project checks to update them.
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
              <summary>Why setup needs updating</summary>
              {configuration.baselineUnavailable && (
                <p>
                  Your setup is from an older version, so we can't show exactly what changed. Review
                  everything below.
                </p>
              )}
              {configuration.drift && (
                <>
                  <ul>
                    {configuration.drift.files.map((file) => (
                      <li key={file.path}>
                        {file.kind === "added"
                          ? "Added"
                          : file.kind === "removed"
                            ? "Removed"
                            : "Changed"}
                        : <code>{file.path}</code>
                      </li>
                    ))}
                  </ul>
                  {configuration.drift.policy && (
                    <p>
                      Check rules: version {configuration.drift.policy.before} →{" "}
                      {configuration.drift.policy.after}
                    </p>
                  )}
                  {configuration.drift.schema && (
                    <p>
                      Settings format: version {configuration.drift.schema.before} →{" "}
                      {configuration.drift.schema.after}
                    </p>
                  )}
                  {configuration.drift.exclusions && (
                    <>
                      <p>The list of skipped files changed.</p>
                      <p>Before: {configuration.drift.exclusions.before.join(", ") || "None"}</p>
                      <p>Now: {configuration.drift.exclusions.after.join(", ") || "None"}</p>
                    </>
                  )}
                </>
              )}
              <p>Any change to a settings file needs a new review, even a small one.</p>
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
              ? "Review updated setup"
              : "Review setup"}
        </button>
      </div>
      {proposal && showProposal && (
        <div className="programmatic-proposal">
          <h3>
            {proposal.operation === "current"
              ? currentReview
                ? "Setup is up to date"
                : "Older setup review"
              : "Review your checks"}
          </h3>
          {proposal.operation === "current" ? (
            currentReview ? (
              <p>Nothing to save. If you change code, just run the checks again.</p>
            ) : (
              <p>A newer review replaced this one. It's shown for reference only.</p>
            )
          ) : (
            <p>
              Saving writes these check settings to your project. It doesn't start any work; each
              task asks for your approval first.
            </p>
          )}

          {proposal.historyPolicy && (
            <>
              <p>
                Saving past ideas: {proposal.historyPolicy.enabled ? "on" : "off"}.
                {proposal.historyPolicy.enabled &&
                  " Ideas from future searches will be saved. This doesn't approve any work."}
                {proposal.operation === "history-upgrade" &&
                  " You can leave without approving and keep your checks. Going back later needs another approval."}
              </p>
            </>
          )}

          <h4>What each check uses</h4>
          <ul>
            {proposal.routes.map(({ id, route }) => (
              <li key={id}>
                {route.command ?? "Unavailable"}: {route.reason}
                {route.machineLocal && " This tool must be installed on the computer you use."}
              </li>
            ))}
          </ul>
          <details>
            <summary>Technical details</summary>
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
              Settings ID: <code>{proposal.fingerprint}</code>
            </p>
            <h4>Skipped files</h4>
            <ul>
              {proposal.exclusions.map((item, index) => (
                <li key={index}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
            <h4>Files checked</h4>
            <ul>
              {proposal.configurationInputs.map((item) => (
                <li key={item.path}>
                  <code>{item.path}</code>: <code>{item.sha256}</code>
                </li>
              ))}
            </ul>
          </details>
          {!proposalApprovable && proposal.operation !== "current" && (
            <p>This review is out of date. Choose Review setup again.</p>
          )}
          <div className="programmatic-actions">
            {proposal.handle && (
              <button
                className="btn btn-primary btn-sm"
                disabled={approveDisabled}
                onClick={onApprove}
              >
                {proposal.operation === "refresh"
                  ? "Approve and save update"
                  : proposal.operation === "history-upgrade"
                    ? "Turn on saving past ideas"
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
        <p>Nothing is saved until you approve. You can still find ideas.</p>
      )}
    </section>
  );
}
