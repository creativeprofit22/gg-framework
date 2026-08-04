import type { ReactElement } from "react";
import { NotesPhaseCompletionGates } from "../NotesPhaseCompletionGates";
import { NotesPhaseActivityHistory, NotesPhaseActivityView } from "./NotesPhaseActivityView";
import {
  NotesPhaseDetailProvider,
  useNotesPhaseDetail,
  type NotesPhaseDetailProps,
} from "./NotesPhaseDetailState";
import { NotesPhaseMoreControls, NotesPhaseReminderView } from "./NotesPhaseMoreView";
import { NotesPhaseOverviewView } from "./NotesPhaseOverviewView";
import { NotesPhaseReferencesView } from "./NotesPhaseReferencesView";
import { NotesPhaseViewNavigation } from "./NotesPhaseViewNavigation";

export function NotesPhaseDetail(props: NotesPhaseDetailProps): ReactElement {
  return (
    <NotesPhaseDetailProvider {...props}>
      <NotesPhaseDetailBody />
    </NotesPhaseDetailProvider>
  );
}

function NotesPhaseDetailBody(): ReactElement {
  const {
    phase,
    editing,
    activeView,
    setActiveView,
    pending,
    actionStatus,
    actionError,
    effectiveAction,
    effectiveActionLabel,
    controlsDisabled,
    phaseStartDisabled,
    startUnavailableReason,
    primaryActionRef,
    runPhaseAction,
    beginEdit,
    cancelEdit,
    onClose,
  } = useNotesPhaseDetail();

  return (
    <section className="notes-phase-detail" aria-labelledby={`notes-phase-detail-${phase.id}`}>
      <div className="notes-phase-detail-heading">
        <div>
          <p>Selected phase</p>
          <h3 id={`notes-phase-detail-${phase.id}`}>{phase.title}</h3>
        </div>
        <div className="notes-phase-detail-actions">
          {effectiveAction !== "Review" && (
            <button
              ref={primaryActionRef}
              type="button"
              className="notes-roadmap-primary"
              disabled={controlsDisabled || phaseStartDisabled}
              title={phaseStartDisabled ? (startUnavailableReason ?? undefined) : undefined}
              onClick={() => void runPhaseAction()}
            >
              {pending
                ? effectiveActionLabel === "Retry"
                  ? "Retrying…"
                  : effectiveAction === "Start"
                    ? "Starting…"
                    : effectiveAction === "Recover"
                      ? "Recovering…"
                      : "Resuming…"
                : `${effectiveActionLabel} phase`}
            </button>
          )}
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => {
              if (editing) {
                cancelEdit();
                return;
              }
              beginEdit();
            }}
          >
            {editing ? "Close edit" : "Edit"}
          </button>
          <button type="button" disabled={controlsDisabled} onClick={onClose}>
            Back to roadmap
          </button>
        </div>
      </div>

      <NotesPhaseViewNavigation
        phaseId={phase.id}
        phaseTitle={phase.title}
        activeView={activeView}
        setActiveView={setActiveView}
      />
      <div className="notes-phase-action-feedback">
        <div
          className="notes-phase-action-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {actionStatus}
        </div>
        {actionError && (
          <div className="notes-phase-action-error" role="alert">
            {actionError}
          </div>
        )}
      </div>

      <div
        id={`notes-phase-view-panel-${phase.id}-overview`}
        className="notes-phase-view-panel"
        role="tabpanel"
        aria-labelledby={`notes-phase-view-tab-${phase.id}-overview`}
        hidden={activeView !== "overview"}
      >
        <NotesPhaseOverviewView />
      </div>

      <div
        id={`notes-phase-view-panel-${phase.id}-more`}
        className="notes-phase-view-panel"
        role="tabpanel"
        aria-labelledby={`notes-phase-view-tab-${phase.id}-more`}
        hidden={activeView !== "more"}
      >
        <NotesPhaseReminderView />
      </div>

      <div
        id={`notes-phase-view-panel-${phase.id}-completion`}
        className="notes-phase-view-panel"
        role="tabpanel"
        aria-labelledby={`notes-phase-view-tab-${phase.id}-completion`}
        hidden={activeView !== "completion"}
      >
        <NotesPhaseCompletionGates phase={phase} />
      </div>

      <div
        id={`notes-phase-view-panel-${phase.id}-activity`}
        className="notes-phase-view-panel"
        role="tabpanel"
        aria-labelledby={`notes-phase-view-tab-${phase.id}-activity`}
        hidden={activeView !== "activity"}
      >
        <NotesPhaseActivityView />
      </div>

      <div
        id={`notes-phase-view-panel-${phase.id}-references`}
        className="notes-phase-view-panel"
        role="tabpanel"
        aria-labelledby={`notes-phase-view-tab-${phase.id}-references`}
        hidden={activeView !== "references"}
      >
        <NotesPhaseReferencesView />
      </div>

      <div className="notes-phase-view-supplement" hidden={activeView !== "activity"}>
        <NotesPhaseActivityHistory />
      </div>

      <div className="notes-phase-view-supplement" hidden={activeView !== "more"}>
        <NotesPhaseMoreControls />
      </div>
    </section>
  );
}
