import { ArrowsDownUpIcon, CheckIcon, XIcon } from "./phosphor-icons";
import type { RoadmapPhaseMoveBatchDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
import { RoadmapPhaseOrderComparison } from "./RoadmapPhaseOrderComparison";

interface RoadmapPhaseMoveBatchReviewProps {
  draft: RoadmapPhaseMoveBatchDraft;
  decision: "idle" | "approving" | "rejecting";
  error: string | null;
  announcement: string;
  onApprove: () => void;
  onReject: () => void;
}

export function RoadmapPhaseMoveBatchReview({
  draft,
  decision,
  error,
  announcement,
  onApprove,
  onReject,
}: RoadmapPhaseMoveBatchReviewProps) {
  const deciding = decision !== "idle";
  const stale = draft.status === "stale";
  const moved = draft.moves.length;
  const headingId = `roadmap-move-${draft.id}`;

  return (
    <section
      className="roadmap-draft-review roadmap-edit-review"
      aria-label="Review Roadmap phase moves"
      aria-busy={deciding}
    >
      <div
        className="review-content-scroller"
        tabIndex={0}
        role="region"
        aria-label="Roadmap phase moves content"
      >
        <div className="review-reading-rail">
          <div className="roadmap-draft-intro">
            <div className="roadmap-draft-kicker">
              <ArrowsDownUpIcon size={14} aria-hidden="true" />
              Moves proposed from Project Notes revision {draft.basedOnRevision}
            </div>
            <p>{draft.summary}</p>
            <div className="roadmap-draft-count">
              {moved} phases moved · Applied together or not at all · Nothing changes until you
              approve
            </div>
          </div>

          {stale && (
            <div className="roadmap-draft-stale" role="alert">
              <strong>These moves are out of date.</strong>
              <span>
                The Roadmap changed or a phase can no longer be moved. Nothing was saved. Ask GG
                Coder for fresh moves.
              </span>
            </div>
          )}

          <article className="roadmap-edit-phase" aria-labelledby={headingId}>
            <h3 id={headingId}>Moves, in order</h3>
            <ol className="roadmap-move-steps">
              {draft.moves.map((move) => (
                <li key={move.phaseId}>
                  <strong>{move.phaseTitle}</strong> moves {move.position}{" "}
                  <strong>{move.targetPhaseTitle}</strong>
                </li>
              ))}
            </ol>
            <div className="roadmap-edit-changes">
              <RoadmapPhaseOrderComparison
                preview={draft.orderPreview}
                highlightedPhaseIds={new Set(draft.moves.map((move) => move.phaseId))}
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
          {decision === "rejecting" ? "Rejecting…" : "Reject moves"}
        </button>
        <button
          type="button"
          className="modal-btn primary roadmap-draft-create"
          onClick={onApprove}
          disabled={deciding || stale}
        >
          <CheckIcon size={15} aria-hidden="true" />
          {decision === "approving" ? "Moving phases…" : `Move ${moved} phases`}
        </button>
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </section>
  );
}
