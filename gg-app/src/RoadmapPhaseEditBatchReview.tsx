import { CheckIcon, PencilSimpleIcon, XIcon } from "./phosphor-icons";
import { RoadmapPhaseEditChanges } from "./RoadmapPhaseEditChanges";
import type { RoadmapPhaseEditBatchDraft } from "@kenkaiiii/gg-core/roadmap-workflow";

interface RoadmapPhaseEditBatchReviewProps {
  draft: RoadmapPhaseEditBatchDraft;
  decision: "idle" | "approving" | "rejecting";
  error: string | null;
  announcement: string;
  onApprove: () => void;
  onReject: () => void;
}

export function RoadmapPhaseEditBatchReview({
  draft,
  decision,
  error,
  announcement,
  onApprove,
  onReject,
}: RoadmapPhaseEditBatchReviewProps) {
  const deciding = decision !== "idle";
  const stale = draft.status === "stale";
  const phases = draft.edits.length;
  const changed = draft.edits.reduce((total, edit) => total + edit.changes.length, 0);

  return (
    <section
      className="roadmap-draft-review roadmap-edit-review"
      aria-label="Review Roadmap phase edits"
      aria-busy={deciding}
    >
      <div
        className="review-content-scroller"
        tabIndex={0}
        role="region"
        aria-label="Roadmap phase edits content"
      >
        <div className="review-reading-rail">
          <div className="roadmap-draft-intro">
            <div className="roadmap-draft-kicker">
              <PencilSimpleIcon size={14} aria-hidden="true" />
              Edits proposed from Project Notes revision {draft.basedOnRevision}
            </div>
            <p>{draft.summary}</p>
            <div className="roadmap-draft-count">
              {phases} phases · {changed} changed {changed === 1 ? "field" : "fields"} · Applied
              together or not at all · Nothing changes until you approve
            </div>
          </div>

          {stale && (
            <div className="roadmap-draft-stale" role="alert">
              <strong>These edits are out of date.</strong>
              <span>
                A phase changed or can no longer be edited. Nothing was saved. Ask GG Coder for
                fresh edits.
              </span>
            </div>
          )}

          {draft.edits.map((edit, index) => (
            <RoadmapPhaseEditChanges
              key={edit.phaseId}
              headingId={`roadmap-edit-${draft.id}-${index}`}
              phaseTitle={edit.phaseTitle}
              changes={edit.changes}
              dependencyPhases={draft.dependencyPhases}
              listLabel={`Changed fields in ${edit.phaseTitle}`}
            />
          ))}

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
          {decision === "rejecting" ? "Rejecting…" : "Reject edits"}
        </button>
        <button
          type="button"
          className="modal-btn primary roadmap-draft-create"
          onClick={onApprove}
          disabled={deciding || stale}
        >
          <CheckIcon size={15} aria-hidden="true" />
          {decision === "approving" ? "Applying edits…" : `Apply ${phases} edits`}
        </button>
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </section>
  );
}
