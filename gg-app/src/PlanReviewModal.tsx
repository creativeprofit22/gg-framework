import { PLAN_REVISION_FEEDBACK_MAX_CHARS } from "@kenkaiiii/gg-core";
import { useState } from "react";
import { MENTOR_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";
import { Markdown } from "./Markdown";

interface Props {
  /** Plan markdown awaiting approval. */
  content: string;
  /** True while Autopilot Ken is reviewing this plan himself. */
  kenReviewing?: boolean;
  /** Ken found no issue, but only the human may approve. */
  kenReady?: boolean;
  /** A typed revision request is durable and awaits a replacement generation. */
  revisionPending?: boolean;
  /** The revision provider run is currently active, so retry must wait. */
  revisionRunning?: boolean;
  /** Locks the resolving controls while authority is crossing the IPC boundary. */
  busy?: boolean;
  onAccept: () => void;
  onFeedback: (feedback: string) => void;
  onRetryRevision?: () => void;
}

/**
 * Persistent workflow gate shown inline with the transcript. It stays visible
 * until the user explicitly approves or dismisses the pending plan, so normal
 * prompt actions cannot strand the operation behind an invisible modal.
 */
export function PlanReviewModal({
  content,
  kenReviewing = false,
  kenReady = false,
  revisionPending = false,
  revisionRunning = false,
  busy = false,
  onAccept,
  onFeedback,
  onRetryRevision,
}: Props): React.ReactElement {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState("");
  const normalizedFeedback = feedback.trim();
  const feedbackRemaining = PLAN_REVISION_FEEDBACK_MAX_CHARS - feedback.length;
  const feedbackWithinLimit = feedbackRemaining >= 0;
  const canSubmitFeedback = normalizedFeedback.length > 0 && feedbackWithinLimit;
  const feedbackCount = Math.abs(feedbackRemaining);
  const feedbackLimitStatus = `${feedbackCount.toLocaleString()} ${
    feedbackCount === 1 ? "character" : "characters"
  } ${feedbackWithinLimit ? "remaining" : "over limit"}`;
  const submitFeedback = (): void => {
    if (canSubmitFeedback) onFeedback(normalizedFeedback);
  };

  return (
    <section className="plan-review" aria-label="Plan approval required" aria-busy={busy}>
      <div className="plan-review-message">
        <span className="plan-review-icon" aria-hidden="true">
          {"◆"}
        </span>
        <div>
          <strong>Plan approval required</strong>
          <p>Only you can approve this persisted plan snapshot.</p>
        </div>
      </div>

      <details className="plan-review-details">
        <summary>Review plan</summary>
        <div className="plan-review-body">
          <Markdown>{content || "_(plan is empty)_"}</Markdown>
        </div>
      </details>

      {(kenReviewing || kenReady || revisionPending) && (
        <div className="plan-review-ken" style={{ color: theme.ken }}>
          {revisionPending
            ? "Revision requested. Waiting for the revised plan snapshot…"
            : kenReady
              ? `${MENTOR_DISPLAY_NAME} finished reviewing. Your approval is still required.`
              : `${MENTOR_DISPLAY_NAME} is reviewing this plan… you can still decide now.`}
        </div>
      )}

      <div className="plan-review-actions">
        {revisionPending ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || revisionRunning}
            onClick={onRetryRevision}
          >
            {busy || revisionRunning ? "Revising…" : "Retry revision"}
          </button>
        ) : feedbackMode ? (
          <div className="plan-feedback">
            <textarea
              className="plan-feedback-input"
              value={feedback}
              placeholder="What should change about this plan?"
              aria-describedby="plan-feedback-limit"
              aria-invalid={!feedbackWithinLimit}
              autoFocus
              rows={3}
              maxLength={PLAN_REVISION_FEEDBACK_MAX_CHARS}
              disabled={busy}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submitFeedback();
                } else if (event.key === "Escape") {
                  setFeedbackMode(false);
                }
              }}
            />
            <div className="plan-feedback-row">
              <span className="plan-feedback-hint" style={{ color: theme.textDim }}>
                {"⌘↵ to send · Esc to cancel"}
              </span>
              <span className="plan-feedback-buttons">
                <span
                  id="plan-feedback-limit"
                  className="plan-feedback-limit"
                  style={{ color: theme.textDim }}
                >
                  {feedbackLimitStatus}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => setFeedbackMode(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || !canSubmitFeedback}
                  onClick={submitFeedback}
                >
                  Send feedback
                </button>
              </span>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={onAccept}>
              {busy ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setFeedbackMode(true)}
            >
              Feedback
            </button>
          </>
        )}
      </div>
    </section>
  );
}
