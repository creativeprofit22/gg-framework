import { useState, type ReactElement } from "react";
import { notesLifecyclePresentation } from "../notes-lifecycle-presentation";
import { notesCompletionGateOverview } from "../NotesPhaseCompletionGates";
import type {
  ManualCompletionApprovalCommitOutcome,
  ManualCompletionApprovalPreviewOutcome,
  NotesPhase,
  NotesRoadmapStatusUpdate,
  PhaseBindingOutcome,
  PhaseBindingRequest,
  ProjectNotesStorageDiagnostics,
} from "../notes-types";
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
    expectedRevision,
    onGetStorageDiagnostics,
    onRebindPhase,
    onPreviewManualCompletionApproval,
    onCommitManualCompletionApproval,
    onActionSuccess,
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
      <ManualCompletionApprovalControl
        phase={phase}
        expectedRevision={expectedRevision}
        onPreview={onPreviewManualCompletionApproval}
        onCommit={onCommitManualCompletionApproval}
        onSuccess={onActionSuccess}
      />
      <PhaseRebindControl
        phase={phase}
        expectedRevision={expectedRevision}
        onInspect={onGetStorageDiagnostics}
        onRebind={onRebindPhase}
        onSuccess={onActionSuccess}
      />
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

export function ManualCompletionApprovalControl({
  phase,
  expectedRevision,
  onPreview,
  onCommit,
  onSuccess,
}: {
  phase: NotesPhase;
  expectedRevision: number | null;
  onPreview(
    phaseId: string,
    expectedRevision: number,
  ): Promise<ManualCompletionApprovalPreviewOutcome>;
  onCommit(nonce: string): Promise<ManualCompletionApprovalCommitOutcome>;
  onSuccess(): void;
}): ReactElement | null {
  const [preview, setPreview] = useState<
    Extract<ManualCompletionApprovalPreviewOutcome, { status: "ready" }> | undefined
  >();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  if (phase.status !== "review" || phase.archivedAt !== null) return null;

  const loadPreview = async (): Promise<void> => {
    if (expectedRevision === null) {
      setMessage("Notes are still loading. Refresh before approving completion.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const outcome = await onPreview(phase.id, expectedRevision);
      if (outcome.status === "ready") setPreview(outcome);
      else {
        setMessage(manualApprovalOutcomeMessage(outcome));
        if (outcome.status === "stale-revision") onSuccess();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Completion evidence is unavailable.");
    } finally {
      setPending(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (!preview) return;
    setPending(true);
    setMessage("");
    try {
      const outcome = await onCommit(preview.checkpoint.nonce);
      if (outcome.status === "committed" || outcome.status === "duplicate") {
        setMessage("Completion approved from current evidence.");
        onSuccess();
        return;
      }
      setPreview(undefined);
      setMessage(manualApprovalOutcomeMessage(outcome));
      if (outcome.status === "stale-revision") onSuccess();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Completion could not be approved.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="notes-manual-completion" aria-labelledby={`manual-completion-${phase.id}`}>
      <div>
        <h4 id={`manual-completion-${phase.id}`}>Manual completion</h4>
        <p>Requires current passed verification after the latest successful implementation.</p>
      </div>
      {preview ? (
        <div className="notes-manual-completion-confirm" role="group" aria-label="Confirm manual completion">
          <dl>
            <div>
              <dt>Implementation</dt>
              <dd>{preview.checkpoint.implementationCheckpointId}</dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>{preview.checkpoint.verificationStatusUpdateId}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{preview.checkpoint.session.sessionId}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>{preview.checkpoint.revision}</dd>
            </div>
          </dl>
          <p>Confirming marks this phase Done. Any Notes change requires a fresh preview.</p>
          <button type="button" disabled={pending} onClick={() => void commit()}>
            {pending ? "Approving…" : "Confirm completion"}
          </button>
          <button type="button" disabled={pending} onClick={() => setPreview(undefined)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" disabled={pending} onClick={() => void loadPreview()}>
          {pending ? "Checking evidence…" : "Review completion evidence"}
        </button>
      )}
      {message && (
        <p className="notes-phase-action-feedback" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function manualApprovalOutcomeMessage(
  outcome: ManualCompletionApprovalPreviewOutcome | ManualCompletionApprovalCommitOutcome,
): string {
  if (outcome.status === "stale-revision") {
    return "Notes changed. Refresh and review the current evidence again.";
  }
  if (outcome.status === "unmet-gate") {
    const labels: Record<string, string> = {
      "inactive-phase": "The phase must be in Review before completion can be approved.",
      "missing-implementation": "No successful implementation checkpoint is available.",
      "run-not-successful": "The latest implementation run did not succeed.",
      "incomplete-plan": "The latest implementation checkpoint is incomplete.",
      "missing-verification": "No current verification result is available.",
      "stale-verification": "Verification predates the latest implementation checkpoint.",
      "failed-verification": "The latest verification failed.",
      "verification-exception": "Manual approval cannot accept a verification exception.",
      "stale-session": "The evidence belongs to another session.",
      "unresolved-approval": "Resolve the pending approval before completion.",
      "unresolved-attention": "Resolve the phase attention item before completion.",
    };
    return labels[outcome.code] ?? "Current evidence does not satisfy completion gates.";
  }
  if (outcome.status === "nonce-expired" || outcome.status === "nonce-not-found") {
    return "The approval preview expired. Review the current evidence again.";
  }
  return "Completion approval is unavailable for this phase.";
}

export function PhaseRebindControl({
  phase,
  expectedRevision,
  onInspect,
  onRebind,
  onSuccess,
  idFactory = () => crypto.randomUUID(),
}: {
  phase: NotesPhase;
  expectedRevision: number | null;
  onInspect(): Promise<ProjectNotesStorageDiagnostics>;
  onRebind(request: PhaseBindingRequest): Promise<PhaseBindingOutcome>;
  onSuccess(): void;
  idFactory?(): string;
}): ReactElement | null {
  const [preview, setPreview] = useState<ProjectNotesStorageDiagnostics | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  if (!phase.session) return null;

  const inspect = async (): Promise<void> => {
    if (expectedRevision === null) {
      setMessage("Notes are still loading. Refresh before rebinding.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const diagnostics = await onInspect();
      const persisted = diagnostics.persistedPhaseBinding;
      if (
        persisted?.phaseId !== phase.id ||
        persisted.session.sessionId !== phase.session?.sessionId ||
        persisted.session.sessionPath !== phase.session?.sessionPath
      ) {
        setMessage("The phase binding changed. Refresh Notes before rebinding.");
        return;
      }
      setPreview(diagnostics);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Binding diagnostics are unavailable.");
    } finally {
      setPending(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!preview || expectedRevision === null || !phase.session) return;
    setPending(true);
    setMessage("");
    try {
      const outcome = await onRebind({
        version: 1,
        action: "rebind-current",
        phaseId: phase.id,
        expectedProjectKey: preview.projectKey,
        expectedRevision,
        expectedPreviousSession: phase.session,
        operationId: idFactory(),
        confirmRebind: true,
      });
      if (
        outcome.status === "committed" ||
        outcome.status === "duplicate" ||
        outcome.status === "already-bound"
      ) {
        setMessage("Phase authority moved to this session.");
        onSuccess();
        return;
      }
      setPreview(null);
      setMessage(phaseBindingOutcomeMessage(outcome));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The phase could not be rebound.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="notes-phase-rebind" aria-labelledby={`phase-rebind-${phase.id}`}>
      <div>
        <h4 id={`phase-rebind-${phase.id}`}>Session authority</h4>
        <p>Resume the linked session by default. Transfer only when that session is unavailable.</p>
      </div>
      {preview ? (
        <div className="notes-phase-rebind-confirm" role="group" aria-label="Confirm phase rebind">
          <dl>
            <div>
              <dt>From</dt>
              <dd>{phase.session.sessionId}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>{preview.currentSession.sessionId}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>{expectedRevision}</dd>
            </div>
          </dl>
          <button type="button" disabled={pending} onClick={() => void confirm()}>
            {pending ? "Rebinding…" : "Confirm rebind"}
          </button>
          <button type="button" disabled={pending} onClick={() => setPreview(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" disabled={pending} onClick={() => void inspect()}>
          {pending ? "Checking binding…" : "Rebind to this session"}
        </button>
      )}
      {message && (
        <p className="notes-phase-action-feedback" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function phaseBindingOutcomeMessage(outcome: PhaseBindingOutcome): string {
  switch (outcome.status) {
    case "stale-revision":
      return "Notes changed. Refresh diagnostics and confirm the current revision again.";
    case "stale-previous-session":
      return "The linked session changed. Resume the new session or refresh before rebinding.";
    case "duplicate-id-conflict":
      return "This rebind operation identifier was already used. Retry from refreshed Notes.";
    case "project-mismatch":
      return "This pane is using a different project store. Reopen the correct project.";
    case "phase-archived":
    case "phase-terminal":
      return "This phase can no longer be rebound.";
    case "missing-session-path":
      return "Save this session before rebinding the phase.";
    default:
      return "The phase binding changed. Refresh Notes and try again.";
  }
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
