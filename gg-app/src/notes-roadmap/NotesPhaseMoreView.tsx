import type { ReactElement } from "react";
import { PRODUCT_DISPLAY_NAME } from "../brand";
import { useNotesPhaseDetail } from "./NotesPhaseDetailState";
import { formatDateTime, formatTime, visibleRoadmapAttentionReason } from "./roadmap-presentation";

export function NotesPhaseReminderView(): ReactElement {
  const {
    phase,
    currentTime,
    authorityReady,
    controlsDisabled,
    reminderDraft,
    reminderPresets,
    customReminderError,
    updateReminderDraft,
    clearCustomReminderError,
    reloadReminderDraft,
    scheduleReminder,
    submitCustomReminder,
    dismissReminder,
    snoozeReminder,
  } = useNotesPhaseDetail();

  return (
    <section className="notes-reminder-section" aria-labelledby={`notes-reminder-${phase.id}`}>
      <div className="notes-reminder-heading">
        <div>
          <h4 id={`notes-reminder-${phase.id}`}>Reminder</h4>
          <p>Future reminders are recovered when {PRODUCT_DISPLAY_NAME} opens.</p>
        </div>
        {phase.reminder && (
          <button type="button" disabled={controlsDisabled} onClick={dismissReminder}>
            Dismiss reminder
          </button>
        )}
      </div>

      {!authorityReady && (
        <p className="notes-reminder-authority">
          Local fallback can save this schedule, but automatic delivery resumes only when project
          storage reconnects.
        </p>
      )}

      {phase.reminder ? (
        <div className="notes-reminder-current">
          <p>
            {Date.parse(phase.reminder.dueAt) <= currentTime.getTime()
              ? "Due now"
              : "Scheduled for"}{" "}
            <time dateTime={phase.reminder.dueAt}>{formatDateTime(phase.reminder.dueAt)}</time>
          </p>
          {phase.reminder.note && <p>{phase.reminder.note}</p>}
          {phase.reminder.lastDelivery?.occurrenceKey === phase.reminder.occurrenceKey && (
            <p>
              {phase.reminder.lastDelivery.permission === "denied"
                ? "Native notification permission was denied. Use the in-app actions here."
                : phase.reminder.lastDelivery.permission === "unavailable"
                  ? "Native notification availability could not be verified. Use the in-app actions here."
                  : phase.reminder.lastDelivery.channel === "native"
                    ? "A private native notification was requested."
                    : `An in-app reminder was requested in ${PRODUCT_DISPLAY_NAME}.`}
            </p>
          )}
          {Date.parse(phase.reminder.dueAt) <= currentTime.getTime() && (
            <button type="button" disabled={controlsDisabled} onClick={snoozeReminder}>
              Snooze 1 hour
            </button>
          )}
        </div>
      ) : (
        <p className="notes-reminder-empty">No reminder scheduled.</p>
      )}

      <div className="notes-field">
        <label htmlFor={`notes-reminder-note-${phase.id}`}>Reminder note (optional)</label>
        <textarea
          id={`notes-reminder-note-${phase.id}`}
          value={reminderDraft.note}
          maxLength={500}
          disabled={controlsDisabled}
          onChange={(event) => updateReminderDraft({ note: event.target.value })}
        />
      </div>

      {reminderDraft.conflict && (
        <div>
          <p className="notes-phase-action-error" role="alert">
            This reminder changed in another window. Reload the latest reminder before scheduling.
          </p>
          <button type="button" disabled={controlsDisabled} onClick={reloadReminderDraft}>
            Reload latest reminder
          </button>
        </div>
      )}

      <div className="notes-reminder-presets" aria-label="Reminder presets">
        {reminderPresets.laterToday && (
          <button
            type="button"
            disabled={controlsDisabled || reminderDraft.conflict}
            onClick={() => scheduleReminder(reminderPresets.laterToday!)}
          >
            Later today, {formatTime(reminderPresets.laterToday.toISOString())}
          </button>
        )}
        <button
          type="button"
          disabled={controlsDisabled || reminderDraft.conflict}
          onClick={() => scheduleReminder(reminderPresets.tomorrow)}
        >
          Tomorrow, {formatTime(reminderPresets.tomorrow.toISOString())}
        </button>
      </div>

      <form
        className="notes-reminder-custom"
        onSubmit={(event) => {
          event.preventDefault();
          submitCustomReminder();
        }}
      >
        <div className="notes-field">
          <label htmlFor={`notes-reminder-custom-${phase.id}`}>Choose local date and time</label>
          <input
            id={`notes-reminder-custom-${phase.id}`}
            type="datetime-local"
            value={reminderDraft.customValue}
            disabled={controlsDisabled}
            aria-invalid={customReminderError ? "true" : undefined}
            aria-describedby={
              customReminderError ? `notes-reminder-custom-error-${phase.id}` : undefined
            }
            onChange={(event) => {
              updateReminderDraft({ customValue: event.target.value });
              clearCustomReminderError();
            }}
          />
          {customReminderError && (
            <p id={`notes-reminder-custom-error-${phase.id}`} className="notes-phase-action-error">
              {customReminderError}
            </p>
          )}
        </div>
        <button type="submit" disabled={controlsDisabled || reminderDraft.conflict}>
          Save custom time
        </button>
      </form>
    </section>
  );
}

export function NotesPhaseMoreControls(): ReactElement {
  const {
    phase,
    position,
    phaseCount,
    startUnavailableReason,
    pending,
    pendingRoadmapAction,
    effectiveAction,
    controlsDisabled,
    cancellationDisabled,
    lifecycle,
    resumedLifecycle,
    canPauseAutomation,
    canCancelRun,
    onChangePhaseStatus,
    onMovePhase,
    onArchivePhase,
    isTopologyMutationBlocked,
    resumeAutomaticStatus,
    runCancellation,
  } = useNotesPhaseDetail();

  return (
    <>
      <section
        className="notes-phase-execution"
        aria-labelledby={`notes-phase-execution-${phase.id}`}
        aria-busy={pending}
      >
        <div>
          <h4 id={`notes-phase-execution-${phase.id}`}>Phase session</h4>
          <p>
            {effectiveAction === "Start"
              ? (startUnavailableReason ??
                "Review the goal, completion criteria, saved prompt, and attached references above before starting.")
              : effectiveAction === "Recover"
                ? (startUnavailableReason ??
                  "Replace the missing session-file binding with a new planning session, unless it is already live in this pane.")
                : effectiveAction === "Resume"
                  ? "Continue the one coding session already bound to this phase."
                  : "This phase is available for scope review only."}
          </p>
          {visibleRoadmapAttentionReason(phase) && (
            <p className="notes-phase-attention">
              Needs attention: {visibleRoadmapAttentionReason(phase)}
            </p>
          )}
        </div>
      </section>

      <div className="notes-phase-controls">
        <section
          className="notes-phase-automation"
          aria-labelledby={`notes-phase-automation-${phase.id}`}
        >
          <div>
            <h4 id={`notes-phase-automation-${phase.id}`}>Automation</h4>
            <p>
              <strong>{lifecycle.state}</strong>
              <span aria-hidden="true"> · </span>
              {lifecycle.stage}
            </p>
            {phase.overrides.status && (
              <p className="notes-phase-status-help">
                Paused. Resume returns to {resumedLifecycle.state},{" "}
                {resumedLifecycle.stage.toLocaleLowerCase()}.
              </p>
            )}
          </div>
          <div className="notes-phase-lifecycle-actions">
            {canPauseAutomation && (
              <button
                type="button"
                disabled={
                  controlsDisabled ||
                  isTopologyMutationBlocked({ type: "pause-status", phaseId: phase.id })
                }
                title={
                  isTopologyMutationBlocked({ type: "pause-status", phaseId: phase.id })
                    ? "Confirm or recover the pending Roadmap advancement before pausing this phase."
                    : undefined
                }
                onClick={() => onChangePhaseStatus(phase.status)}
              >
                Pause automation
              </button>
            )}
            {phase.overrides.status && (
              <button
                type="button"
                disabled={
                  controlsDisabled ||
                  isTopologyMutationBlocked({ type: "resume-status", phaseId: phase.id })
                }
                title={
                  isTopologyMutationBlocked({ type: "resume-status", phaseId: phase.id })
                    ? "Resuming this phase would replace the target protected by a pending advancement review."
                    : undefined
                }
                onClick={resumeAutomaticStatus}
              >
                {pendingRoadmapAction === "resume-status" ? "Resuming…" : "Resume automation"}
              </button>
            )}
            {canCancelRun && (
              <button
                type="button"
                disabled={cancellationDisabled}
                onClick={() => void runCancellation()}
              >
                {pendingRoadmapAction === "cancel-run" ? "Cancelling…" : "Cancel run"}
              </button>
            )}
          </div>
        </section>
        <div className="notes-phase-secondary-actions">
          <button
            type="button"
            disabled={
              controlsDisabled ||
              position === 0 ||
              isTopologyMutationBlocked({ type: "move", phaseId: phase.id, direction: "up" })
            }
            title={
              isTopologyMutationBlocked({ type: "move", phaseId: phase.id, direction: "up" })
                ? "This move would change the target protected by a pending advancement review."
                : undefined
            }
            onClick={() => onMovePhase(phase.id, "up")}
          >
            Move up
          </button>
          <button
            type="button"
            disabled={
              controlsDisabled ||
              position === phaseCount - 1 ||
              isTopologyMutationBlocked({ type: "move", phaseId: phase.id, direction: "down" })
            }
            title={
              isTopologyMutationBlocked({ type: "move", phaseId: phase.id, direction: "down" })
                ? "This move would change the target protected by a pending advancement review."
                : undefined
            }
            onClick={() => onMovePhase(phase.id, "down")}
          >
            Move down
          </button>
          <button
            type="button"
            disabled={
              controlsDisabled || isTopologyMutationBlocked({ type: "archive", phaseId: phase.id })
            }
            title={
              isTopologyMutationBlocked({ type: "archive", phaseId: phase.id })
                ? "Confirm the pending Roadmap advancement before archiving this phase."
                : undefined
            }
            onClick={onArchivePhase}
          >
            Archive phase
          </button>
        </div>
      </div>
    </>
  );
}
