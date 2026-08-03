import { useState } from "react";
import { MENTOR_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";
import { Markdown } from "./Markdown";

interface Props {
  /** Plan markdown awaiting approval. */
  content: string;
  /** True while Autopilot Ken is reviewing this plan himself. */
  kenReviewing?: boolean;
  /** Locks the resolving controls while approval is crossing the IPC boundary. */
  busy?: boolean;
  onAccept: () => void;
  onFeedback: (feedback: string) => void;
  onReject: () => void;
}

/**
 * Persistent workflow gate shown inline with the transcript. It stays visible
 * until the user explicitly approves or dismisses the pending plan, so normal
 * prompt actions cannot strand the operation behind an invisible modal.
 */
export function PlanReviewModal({
  content,
  kenReviewing = false,
  busy = false,
  onAccept,
  onFeedback,
  onReject,
}: Props): React.ReactElement {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <section className="plan-review" aria-label="Plan approval required" aria-busy={busy}>
      <div className="plan-review-message">
        <span className="plan-review-icon" aria-hidden="true">
          {"◆"}
        </span>
        <div>
          <strong>Plan approval required</strong>
          <p>Approve this plan to resume the operation, or dismiss it to stop here.</p>
        </div>
      </div>

      <details className="plan-review-details">
        <summary>Review plan</summary>
        <div className="plan-review-body">
          <Markdown>{content || "_(plan is empty)_"}</Markdown>
        </div>
      </details>

      {kenReviewing && (
        <div className="plan-review-ken" style={{ color: theme.ken }}>
          {MENTOR_DISPLAY_NAME} is reviewing this plan… you can still decide now.
        </div>
      )}

      <div className="plan-review-actions">
        {feedbackMode ? (
          <div className="plan-feedback">
            <textarea
              className="plan-feedback-input"
              value={feedback}
              placeholder="What should change about this plan?"
              autoFocus
              rows={3}
              disabled={busy}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (feedback.trim()) onFeedback(feedback.trim());
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
                  disabled={busy || !feedback.trim()}
                  onClick={() => onFeedback(feedback.trim())}
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
            <button
              type="button"
              className="btn btn-ghost plan-reject"
              disabled={busy}
              onClick={onReject}
            >
              Dismiss
            </button>
          </>
        )}
      </div>
    </section>
  );
}
