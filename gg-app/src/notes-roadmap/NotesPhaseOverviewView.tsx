import type { ReactElement } from "react";
import { notesLifecyclePresentation } from "../notes-lifecycle-presentation";
import { notesCompletionGateOverview } from "../NotesPhaseCompletionGates";
import type { NotesPhase, NotesRoadmapStatusUpdate } from "../notes-types";
import { useNotesPhaseDetail } from "./NotesPhaseDetailState";
import {
  activeRoadmapBlocker,
  formatDate,
  formatDateTime,
  phaseNextAction,
  roadmapActorLabel,
  savedPromptPreview,
  visibleRoadmapAttentionReason,
} from "./roadmap-presentation";

export function NotesPhaseOverviewView(): ReactElement {
  const {
    phase,
    currentTime,
    editing,
    phaseDraft,
    controlsDisabled,
    effectiveActionLabel,
    latestReport,
    pendingProposals,
    lifecycle,
    onResolveRoadmapBlocker,
    runRoadmapMutation,
    updatePhaseDraft,
    reloadPhaseDraft,
    cancelEdit,
    saveEdit,
  } = useNotesPhaseDetail();
  const activeBlocker = activeRoadmapBlocker(phase);

  if (editing) {
    return (
      <form
        className="notes-phase-form notes-phase-edit"
        onSubmit={(event) => {
          event.preventDefault();
          saveEdit();
        }}
      >
        <div className="notes-field">
          <label htmlFor={`notes-phase-edit-title-${phase.id}`}>Edit phase title</label>
          <input
            id={`notes-phase-edit-title-${phase.id}`}
            value={phaseDraft.title}
            autoFocus
            required
            disabled={controlsDisabled}
            onChange={(event) => updatePhaseDraft({ title: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              cancelEdit();
            }}
          />
        </div>
        <div className="notes-field">
          <label htmlFor={`notes-phase-edit-goal-${phase.id}`}>Edit goal</label>
          <textarea
            id={`notes-phase-edit-goal-${phase.id}`}
            value={phaseDraft.goal}
            disabled={controlsDisabled}
            onChange={(event) => updatePhaseDraft({ goal: event.target.value })}
          />
        </div>
        <div className="notes-field">
          <label htmlFor={`notes-phase-edit-done-${phase.id}`}>Edit Done when</label>
          <textarea
            id={`notes-phase-edit-done-${phase.id}`}
            value={phaseDraft.doneWhen}
            disabled={controlsDisabled}
            onChange={(event) => updatePhaseDraft({ doneWhen: event.target.value })}
          />
        </div>
        {phaseDraft.conflict && (
          <p className="notes-phase-action-error" role="alert">
            This phase changed in another window. Reload the latest values before saving.
          </p>
        )}
        <div className="notes-phase-form-actions">
          <button
            type="submit"
            disabled={!phaseDraft.title.trim() || controlsDisabled || phaseDraft.conflict}
          >
            Save changes
          </button>
          {phaseDraft.conflict && (
            <button type="button" disabled={controlsDisabled} onClick={reloadPhaseDraft}>
              Reload latest values
            </button>
          )}
          <button type="button" disabled={controlsDisabled} onClick={cancelEdit}>
            Cancel edit
          </button>
        </div>
      </form>
    );
  }

  return (
    <>
      <PhaseOverview
        phase={phase}
        currentTime={currentTime}
        actionLabel={effectiveActionLabel}
        latestReport={latestReport}
        pendingProposalCount={pendingProposals.length}
      />
      {activeBlocker && (
        <section
          className="notes-phase-blocker-alert"
          role="alert"
          aria-labelledby={`notes-phase-blocker-title-${phase.id}`}
        >
          <div className="notes-phase-blocker-copy">
            <strong id={`notes-phase-blocker-title-${phase.id}`}>Blocked</strong>
            <p>Reason: {activeBlocker.blocker}</p>
            <p>Required action: {activeBlocker.requiredExternalAction}</p>
          </div>
          <button
            type="button"
            className="notes-phase-blocker-resolve"
            disabled={controlsDisabled}
            onClick={() => {
              void runRoadmapMutation(`resolve-blocker:${activeBlocker.id}`, () =>
                onResolveRoadmapBlocker(phase.id, activeBlocker.id),
              );
            }}
          >
            Mark resolved
          </button>
        </section>
      )}
      <div className="notes-phase-content">
        <div>
          <h4>Goal</h4>
          <p>{phase.goal || "No goal added."}</p>
        </div>
        <div>
          <h4>Done when</h4>
          {phase.doneWhen.length > 0 ? (
            <ul>
              {phase.doneWhen.map((criterion, index) => (
                <li key /* Stable criterion identity. */={`${phase.id}-criterion-${index}`}>
                  {criterion}
                </li>
              ))}
            </ul>
          ) : (
            <p>No completion criteria added.</p>
          )}
        </div>
      </div>

      {phase.sourcePrompt.trim().length > 0 && (
        <details className="notes-phase-saved-prompt">
          <summary>
            <span>Saved prompt</span>
            <span className="notes-phase-saved-prompt-preview">
              Preview: {savedPromptPreview(phase.sourcePrompt)}
            </span>
          </summary>
          <pre>{phase.sourcePrompt}</pre>
        </details>
      )}

      <dl className="notes-phase-metadata">
        <div>
          <dt>State</dt>
          <dd>{lifecycle.state}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{lifecycle.stage}</dd>
        </div>
        <div>
          <dt>References</dt>
          <dd>{phase.referenceIds.length}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{phase.session ? "Linked" : "Not linked"}</dd>
        </div>
        <div>
          <dt>Reminder</dt>
          <dd>{phase.reminder ? formatDate(phase.reminder.dueAt) : "None"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={phase.createdAt}>{formatDate(phase.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={phase.updatedAt}>{formatDate(phase.updatedAt)}</time>
          </dd>
        </div>
      </dl>
    </>
  );
}

function PhaseOverview({
  phase,
  currentTime,
  actionLabel,
  latestReport,
  pendingProposalCount,
}: {
  phase: NotesPhase;
  currentTime: Date;
  actionLabel: string;
  latestReport: NotesRoadmapStatusUpdate | null;
  pendingProposalCount: number;
}): ReactElement {
  const lifecycle = notesLifecyclePresentation(phase);
  const completion = notesCompletionGateOverview(phase);
  const isManualOverride = phase.overrides.status !== null;
  const dueAt = phase.reminder ? Date.parse(phase.reminder.dueAt) : null;
  const reminderState = phase.reminder
    ? `${dueAt !== null && dueAt <= currentTime.getTime() ? "Due now" : "Scheduled"} · ${formatDateTime(
        phase.reminder.dueAt,
      )}`
    : "None scheduled";
  const nextAction = phaseNextAction(phase, actionLabel);
  const reportMeta = latestReport
    ? `${roadmapActorLabel(latestReport.actor)} · ${formatDateTime(latestReport.timestamp)}`
    : "No report recorded";

  return (
    <section
      className={`notes-phase-overview notes-phase-overview-${completion.tone}`}
      aria-labelledby={`notes-phase-overview-${phase.id}`}
    >
      <div className="notes-phase-overview-heading">
        <div>
          <p className="notes-phase-overview-eyebrow">Phase overview</p>
          <h4 id={`notes-phase-overview-${phase.id}`}>{lifecycle.state}</h4>
          <p>{lifecycle.stage}</p>
        </div>
        <div className="notes-phase-overview-next">
          <span>Next action</span>
          <strong>{nextAction}</strong>
        </div>
      </div>

      {isManualOverride && (
        <p className="notes-phase-overview-authority">
          <span>Manual override</span> User-selected state remains authoritative.
        </p>
      )}
      {visibleRoadmapAttentionReason(phase) && !activeRoadmapBlocker(phase) && (
        <p className="notes-phase-overview-blocker">
          Needs attention: {visibleRoadmapAttentionReason(phase)}
        </p>
      )}

      <div className="notes-phase-overview-completion">
        <div className="notes-phase-overview-completion-heading">
          <span>Completion gates</span>
          <strong className={`notes-phase-overview-tone-${completion.tone}`}>
            {completion.outcome}
          </strong>
        </div>
        <dl>
          <div>
            <dt>Implementation</dt>
            <dd className={`notes-phase-overview-tone-${completion.implementation.tone}`}>
              <strong>{completion.implementation.label}</strong>
              <span title={completion.implementation.detail}>
                {completion.implementation.detail}
              </span>
            </dd>
          </div>
          <div>
            <dt>Verification</dt>
            <dd className={`notes-phase-overview-tone-${completion.verification.tone}`}>
              <strong>{completion.verification.label}</strong>
              {completion.verification.detail && (
                <span title={completion.verification.detail}>{completion.verification.detail}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Final review</dt>
            <dd className={`notes-phase-overview-tone-${completion.review.tone}`}>
              <strong>{completion.review.label}</strong>
              {completion.review.detail && (
                <span title={completion.review.detail}>{completion.review.detail}</span>
              )}
            </dd>
          </div>
        </dl>
        {completion.blocker && (
          <p className="notes-phase-overview-blocker">Blocked: {completion.blocker}</p>
        )}
      </div>

      <dl className="notes-phase-overview-summary">
        <div>
          <dt>Latest report</dt>
          <dd>
            <strong>{reportMeta}</strong>
            {latestReport && <span>{latestReport.progress}</span>}
          </dd>
        </div>
        <div>
          <dt>Reminder</dt>
          <dd>
            <strong>{reminderState}</strong>
            {phase.reminder?.note && <span>{phase.reminder.note}</span>}
          </dd>
        </div>
        <div>
          <dt>References</dt>
          <dd>
            <strong>
              {phase.referenceIds.length} attached
              {pendingProposalCount > 0 ? ` · ${pendingProposalCount} pending` : ""}
            </strong>
          </dd>
        </div>
      </dl>
    </section>
  );
}
