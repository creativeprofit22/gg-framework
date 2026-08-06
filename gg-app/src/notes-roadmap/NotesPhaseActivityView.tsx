import type { ReactElement, ReactNode } from "react";
import { PRODUCT_DISPLAY_NAME } from "../brand";
import type { NotesPhase, NotesRoadmapEvent } from "../notes-types";
import { useNotesPhaseDetail } from "./NotesPhaseDetailState";
import {
  completionGateRecovery,
  completionOutcomeLabel,
  formatDateTime,
  implementationOutcomeLabel,
  roadmapActorLabel,
  roadmapReviewerLabel,
  statusLabel,
  verificationLabel,
} from "./roadmap-presentation";

export function NotesPhaseActivityView(): ReactElement {
  const { phase, latestReport, latestReportHasPendingManualReview } = useNotesPhaseDetail();

  return (
    <section className="notes-roadmap-latest" aria-labelledby={`notes-roadmap-latest-${phase.id}`}>
      <h4 id={`notes-roadmap-latest-${phase.id}`}>Latest report</h4>
      {latestReport ? (
        <div className="notes-roadmap-report">
          <p className="notes-roadmap-report-meta">
            <strong>{roadmapActorLabel(latestReport.actor)}</strong>{" "}
            <time dateTime={latestReport.timestamp}>{formatDateTime(latestReport.timestamp)}</time>
          </p>
          <p>{latestReport.progress}</p>
          {latestReport.blocker && (
            <div className="notes-roadmap-blocker">
              <p>Blocker: {latestReport.blocker}</p>
              <p>Required action: {latestReport.requiredExternalAction}</p>
            </div>
          )}
          {latestReport.evidence.length > 0 && (
            <div>
              <h5>Evidence</h5>
              <ul>
                {latestReport.evidence.map((item, index) => (
                  <li
                    key /* Stable latest-evidence identity. */={`${latestReport.id}-evidence-${index}`}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {latestReport.statusOutcome === "manual-override" && (
            <p className="notes-roadmap-protected">
              Status was protected by the active manual override. The report remains in history.
            </p>
          )}
          {latestReport.statusOutcome === "done-terminal" && (
            <p className="notes-roadmap-protected">
              Done remained terminal, so this report did not change the phase status. The report was
              retained in history.
            </p>
          )}
          {latestReport.proposedReferences.some(
            (proposal) => proposal.policyOutcome === "reference-override-protected",
          ) && (
            <p className="notes-roadmap-protected">
              Suggested references stayed pending because manual reference links were active when
              this report was recorded.
            </p>
          )}
          {latestReportHasPendingManualReview && (
            <p>Suggested references are pending manual review.</p>
          )}
        </div>
      ) : (
        <p className="notes-roadmap-empty-report">No agent reports yet.</p>
      )}
    </section>
  );
}

export function NotesPhaseActivityHistory(): ReactElement {
  const { phase } = useNotesPhaseDetail();
  return (
    <details className="notes-roadmap-history">
      <summary>
        Activity history ({phase.lifecycleEvents.length + phase.roadmapEvents.length})
      </summary>
      {phase.lifecycleEvents.length + phase.roadmapEvents.length === 0 ? (
        <p>No activity recorded.</p>
      ) : (
        <ol>
          {activityHistory(phase).map((item) => (
            <li key /* Stable activity identity. */={`${item.kind}-${item.event.id}`}>
              {renderActivityItem(item)}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

type ActivityItem =
  | { kind: "lifecycle"; event: NotesPhase["lifecycleEvents"][number] }
  | { kind: "roadmap"; event: NotesRoadmapEvent };

function activityHistory(phase: NotesPhase): ActivityItem[] {
  return [
    ...phase.lifecycleEvents.map((event): ActivityItem => ({ kind: "lifecycle", event })),
    ...phase.roadmapEvents.map((event): ActivityItem => ({ kind: "roadmap", event })),
  ].sort((left, right) => Date.parse(right.event.timestamp) - Date.parse(left.event.timestamp));
}

function renderActivityItem(item: ActivityItem): ReactNode {
  const timestamp = (
    <time dateTime={item.event.timestamp}>{formatDateTime(item.event.timestamp)}</time>
  );
  if (item.kind === "lifecycle") {
    return (
      <>
        <strong>{item.event.source === "user" ? "User" : item.event.source}</strong> {timestamp}
        <p>
          {statusLabel(item.event.fromStatus ?? "not-started")} to{" "}
          {statusLabel(item.event.toStatus)}
          {item.event.reason ? `: ${item.event.reason}` : ""}
        </p>
      </>
    );
  }
  const event = item.event;
  if (event.type === "status-update") {
    return (
      <>
        <strong>{roadmapActorLabel(event.actor)}</strong> {timestamp}
        <p>
          {event.progress} Status outcome: {event.statusOutcome}.
        </p>
        {event.blocker && (
          <>
            <p>Blocker: {event.blocker}</p>
            <p>Required action: {event.requiredExternalAction}</p>
          </>
        )}
        {event.verification && (
          <p>
            Verification: {verificationLabel(event.verification)}
            {event.verificationReason ? `: ${event.verificationReason}` : ""}.
          </p>
        )}
        {event.evidence.length > 0 && (
          <ul>
            {event.evidence.map((evidence, index) => (
              <li
                key /* Stable report-evidence identity. */={`${event.id}-history-evidence-${index}`}
              >
                {evidence}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  if (event.type === "implementation-checkpoint") {
    return (
      <>
        <strong>{PRODUCT_DISPLAY_NAME}</strong> {timestamp}
        <p>
          Implementation checkpoint: {event.completedPlanSteps.length} of {event.planStepTotal} plan
          steps, run {implementationOutcomeLabel(event.runOutcome)}.
        </p>
      </>
    );
  }
  if (event.type === "completion-review") {
    return (
      <>
        <strong>{roadmapReviewerLabel(event.reviewer)}</strong> {timestamp}
        <p>
          Final review {event.decision}. Gate outcome: {completionOutcomeLabel(event.gateOutcome)}.
          {event.reason ? ` ${event.reason}` : ""}
        </p>
        {event.evidence.length > 0 && (
          <ul>
            {event.evidence.map((evidence, index) => (
              <li key /* Stable review-evidence identity. */={`${event.id}-evidence-${index}`}>
                {evidence}
              </li>
            ))}
          </ul>
        )}
        {event.unmetGateCodes.length > 0 && (
          <ul>
            {event.unmetGateCodes.map((code) => (
              <li key /* Stable unmet-gate identity. */={code}>{completionGateRecovery(code)}</li>
            ))}
          </ul>
        )}
      </>
    );
  }
  if (event.type === "blocker-resolution") {
    return (
      <>
        <strong>User</strong> {timestamp}
        <p>Blocker marked resolved.</p>
      </>
    );
  }
  if (event.type === "reference-decision") {
    return (
      <>
        <strong>User</strong> {timestamp}
        <p>Reference proposal {event.decision}.</p>
      </>
    );
  }
  return (
    <>
      <strong>User</strong> {timestamp}
      <p>Automatic {event.field} updates resumed.</p>
    </>
  );
}
