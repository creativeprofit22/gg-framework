import { CheckIcon, PencilSimpleIcon, XIcon } from "./phosphor-icons";
import { RoadmapPhaseEditChanges } from "./RoadmapPhaseEditChanges";
import type { RoadmapPhaseEditDraft } from "@kenkaiiii/gg-core/roadmap-workflow";

interface RoadmapPhaseEditReviewProps {
  draft: RoadmapPhaseEditDraft;
  decision: "idle" | "approving" | "rejecting";
  error: string | null;
  announcement: string;
  onApprove: () => void;
  onReject: () => void;
}

export function RoadmapPhaseEditReview({
  draft,
  decision,
  error,
  announcement,
  onApprove,
  onReject,
}: RoadmapPhaseEditReviewProps) {
  const deciding = decision !== "idle";
  const stale = draft.status === "stale";
  const changed = draft.changes.length;

  return (
    <section
      className="roadmap-draft-review roadmap-edit-review"
      aria-label="Review Roadmap phase edit"
      aria-busy={deciding}
    >
      <div
        className="review-content-scroller"
        tabIndex={0}
        role="region"
        aria-label="Roadmap phase edit content"
      >
        <div className="review-reading-rail">
          <div className="roadmap-draft-intro">
            <div className="roadmap-draft-kicker">
              <PencilSimpleIcon size={14} aria-hidden="true" />
              Edit proposed from Project Notes revision {draft.basedOnRevision}
            </div>
            <p>{draft.summary}</p>
            <div className="roadmap-draft-count">
              1 phase · {changed} changed {changed === 1 ? "field" : "fields"} · Nothing changes
              until you approve
            </div>
          </div>

          {stale && (
            <div className="roadmap-draft-stale" role="alert">
              <strong>This edit is out of date.</strong>
              <span>
                The phase changed or can no longer be edited. Nothing was saved. Ask GG Coder for a
                fresh edit.
              </span>
            </div>
          )}

          <RoadmapPhaseEditChanges
            headingId={`roadmap-edit-${draft.id}`}
            phaseTitle={draft.phaseTitle}
            changes={draft.changes}
            dependencyPhases={draft.dependencyPhases}
            listLabel="Changed fields"
          />

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
          {decision === "rejecting" ? "Rejecting…" : "Reject edit"}
        </button>
        <button
          type="button"
          className="modal-btn primary roadmap-draft-create"
          onClick={onApprove}
          disabled={deciding || stale}
        >
          <CheckIcon size={15} aria-hidden="true" />
          {decision === "approving" ? "Applying edit…" : "Apply edit"}
        </button>
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </section>
  );
}
