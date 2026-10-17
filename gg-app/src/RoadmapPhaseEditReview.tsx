import { CheckIcon, PencilSimpleIcon, XIcon } from "@phosphor-icons/react";
import type {
  RoadmapPhaseEditDraft,
  RoadmapPhaseFieldChange,
} from "@kenkaiiii/gg-core/roadmap-workflow";

interface RoadmapPhaseEditReviewProps {
  draft: RoadmapPhaseEditDraft;
  decision: "idle" | "approving" | "rejecting";
  error: string | null;
  announcement: string;
  onApprove: () => void;
  onReject: () => void;
}

const FIELD_LABELS: Record<RoadmapPhaseFieldChange["field"], string> = {
  title: "Title",
  goal: "Goal",
  doneWhen: "Done when",
  sourcePrompt: "Saved phase prompt",
};

function EmptyValue() {
  return <span className="roadmap-edit-empty">Empty</span>;
}

function TextValue({ value, prompt }: { value: string; prompt: boolean }) {
  if (value.length === 0) return <EmptyValue />;
  return <p className={prompt ? "roadmap-edit-text is-prompt" : "roadmap-edit-text"}>{value}</p>;
}

function CriteriaValue({
  items,
  other,
  tag,
}: {
  items: readonly string[];
  other: readonly string[];
  tag: "Added" | "Removed";
}) {
  if (items.length === 0) return <EmptyValue />;
  const otherItems = new Set(other);
  return (
    <ul className="roadmap-edit-criteria">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>
          <span>{item}</span>
          {!otherItems.has(item) && <span className="roadmap-edit-tag">{tag}</span>}
        </li>
      ))}
    </ul>
  );
}

function ChangeValues({
  change,
  side,
}: {
  change: RoadmapPhaseFieldChange;
  side: "before" | "after";
}) {
  if (change.field === "doneWhen") {
    return side === "before" ? (
      <CriteriaValue items={change.before} other={change.after} tag="Removed" />
    ) : (
      <CriteriaValue items={change.after} other={change.before} tag="Added" />
    );
  }
  return <TextValue value={change[side]} prompt={change.field === "sourcePrompt"} />;
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

          <article className="roadmap-edit-phase" aria-labelledby={`roadmap-edit-${draft.id}`}>
            <h3 id={`roadmap-edit-${draft.id}`}>{draft.phaseTitle}</h3>
            <ul className="roadmap-edit-changes" aria-label="Changed fields">
              {draft.changes.map((change) => (
                <li className="roadmap-edit-field" key={change.field}>
                  <h4>{FIELD_LABELS[change.field]}</h4>
                  <div className="roadmap-edit-value is-before">
                    <span className="roadmap-edit-value-label">Before</span>
                    <ChangeValues change={change} side="before" />
                  </div>
                  <div className="roadmap-edit-value is-after">
                    <span className="roadmap-edit-value-label">After</span>
                    <ChangeValues change={change} side="after" />
                  </div>
                </li>
              ))}
            </ul>
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
