import { ArrowsDownUpIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import type { RoadmapPhaseMoveDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
import { RoadmapPhaseOrderComparison } from "./RoadmapPhaseOrderComparison";

interface RoadmapPhaseMoveReviewProps {
  draft: RoadmapPhaseMoveDraft;
  decision: "idle" | "approving" | "rejecting";
  error: string | null;
  announcement: string;
  onApprove: () => void;
  onReject: () => void;
}

export function RoadmapPhaseMoveReview({
  draft,
  decision,
  error,
  announcement,
  onApprove,
  onReject,
}: RoadmapPhaseMoveReviewProps) {
  const deciding = decision !== "idle";
  const stale = draft.status === "stale";

  return (
    <section
      className="roadmap-draft-review roadmap-edit-review"
      aria-label="Review Roadmap phase move"
      aria-busy={deciding}
    >
      <div
        className="review-content-scroller"
        tabIndex={0}
        role="region"
        aria-label="Roadmap phase move content"
      >
        <div className="review-reading-rail">
          <div className="roadmap-draft-intro">
            <div className="roadmap-draft-kicker">
              <ArrowsDownUpIcon size={14} aria-hidden="true" />
              Move proposed from Project Notes revision {draft.basedOnRevision}
            </div>
            <p>{draft.summary}</p>
            <div className="roadmap-draft-count">
              1 phase moved · Nothing changes until you approve
            </div>
          </div>

          {stale && (
            <div className="roadmap-draft-stale" role="alert">
              <strong>This move is out of date.</strong>
              <span>
                The Roadmap changed or this phase can no longer be moved. Nothing was saved. Ask GG
                Coder for a fresh move.
              </span>
            </div>
          )}

          <article className="roadmap-edit-phase" aria-labelledby={`roadmap-move-${draft.id}`}>
            <h3 id={`roadmap-move-${draft.id}`}>{draft.phaseTitle}</h3>
            <p className="roadmap-order-placement">
              Moves {draft.position} <strong>{draft.targetPhaseTitle}</strong>
            </p>
            <div className="roadmap-edit-changes">
              <RoadmapPhaseOrderComparison
                preview={draft.orderPreview}
                highlightedPhaseIds={new Set([draft.phaseId])}
                highlightLabel="Moved"
              />
            </div>
          </article>

          {error && (
            <div className="roadmap-draft-error" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
      <div className="roadmap-draft-actions review-reading-rail">
        <button
          type="button"
          className="modal-btn roadmap-draft-reject"
          onClick={onReject}
          disabled={deciding}
        >
          <XIcon size={15} aria-hidden="true" />
          {decision === "rejecting" ? "Rejecting…" : "Reject move"}
        </button>
        <button
          type="button"
          className="modal-btn primary roadmap-draft-create"
          onClick={onApprove}
          disabled={deciding || stale}
        >
          <CheckIcon size={15} aria-hidden="true" />
          {decision === "approving" ? "Moving phase…" : "Move phase"}
        </button>
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </section>
  );
}
