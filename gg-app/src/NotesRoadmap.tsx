import { useEffect, useMemo, useRef, useState } from "react";
import { notesLifecyclePresentation } from "./notes-lifecycle-presentation";
import { openReferenceUrl, type OpenReferenceUrl } from "./notes-open-source";
import { referenceSourceLabel } from "./notes-reference";
import type { SlashCommand } from "./agent";
import { NotesPhaseDetail } from "./notes-roadmap/NotesPhaseDetail";
import { resolveRoadmapCommandActions } from "./notes-roadmap/roadmap-command-actions";
import type { NotesPhaseDetailProps } from "./notes-roadmap/NotesPhaseDetailState";
import {
  activeRoadmapBlocker,
  lines,
  phaseActionLabel,
  primaryAction,
  referenceLinkAnnouncement,
  reminderRowLabel,
  roadmapMutationMessage,
  selectRoadmapAdvancement,
  isRoadmapPhaseStartProtected,
  isRoadmapTopologyMutationBlocked,
  statusLabel,
} from "./notes-roadmap/roadmap-presentation";
import type { NotesPhaseInput } from "./useProjectNotes";
import type {
  NotesPhase,
  NotesPhaseStatus,
  PhaseRunCancellationResult,
  NotesReference,
  NotesReferenceOperationResult,
  NotesReminderMutationResult,
  NotesRoadmapMutationResult,
  NotesSessionLink,
  PhaseBindingOutcome,
  PhaseBindingRequest,
  PhaseExecutionReconciliationOutcome,
  PhaseExecutionReconciliationRequestV3,
  PhaseLeaseOutcome,
  PhaseLeaseRequestV2,
  PhaseStartResult,
  ProjectNotesStorageDiagnostics,
} from "./notes-types";

interface RoadmapProps {
  phases: NotesPhase[];
  references: NotesReference[];
  authorityReady: boolean;
  expectedRevision: number | null;
  expectedProjectKey: string | null;
  initialSelectedPhaseId?: string | null;
  openSource?: OpenReferenceUrl;
  onCreatePhase(input: NotesPhaseInput): void;
  onEditPhase(id: string, input: NotesPhaseInput): void;
  onMovePhase(id: string, direction: "up" | "down"): void;
  onChangePhaseStatus(id: string, status: NotesPhaseStatus): void;
  onArchivePhase(id: string): void;
  onLinkReferenceToPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
  onUnlinkReferenceFromPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
  onCreateReference(): void;
  onAcceptReferenceProposal(
    phaseId: string,
    proposalId: string,
  ): Promise<NotesRoadmapMutationResult>;
  onRejectReferenceProposal(
    phaseId: string,
    proposalId: string,
  ): Promise<NotesRoadmapMutationResult>;
  onResolveRoadmapBlocker(
    phaseId: string,
    blockerUpdateId: string,
  ): Promise<NotesRoadmapMutationResult>;
  onResumeAutomaticStatus(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onResumeAutomaticReferences(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onScheduleReminder(
    phaseId: string,
    input: { dueAt: string; note: string },
  ): Promise<NotesReminderMutationResult>;
  onSnoozeReminder(
    phaseId: string,
    dueAt: string,
    expectedOccurrenceKey: string,
  ): Promise<NotesReminderMutationResult>;
  onDismissReminder(
    phaseId: string,
    expectedOccurrenceKey: string,
  ): Promise<NotesReminderMutationResult>;
  onStartPhase(phaseId: string): Promise<PhaseStartResult>;
  onGetStorageDiagnostics?(): Promise<ProjectNotesStorageDiagnostics>;
  onRebindPhase?(request: PhaseBindingRequest): Promise<PhaseBindingOutcome>;
  onMutatePhaseLease?(request: PhaseLeaseRequestV2): Promise<PhaseLeaseOutcome>;
  onReconcilePhaseExecution?(
    request: PhaseExecutionReconciliationRequestV3,
  ): Promise<PhaseExecutionReconciliationOutcome>;
  onStartNextPhase(checkpointId: string, nextPhaseId: string): Promise<PhaseStartResult>;
  commands: SlashCommand[];
  onRunCommand(invocation: string): void;
  onCancelPhase(phaseId: string): Promise<PhaseRunCancellationResult>;
  onResumePhase(phaseId: string, link: NotesSessionLink): Promise<void>;
  startUnavailableReason: string | null;
  actionDisabled: boolean;
  onActionSuccess(): void;
  onReconciliationSuccess(): void;
}

interface ArchiveProps {
  phases: NotesPhase[];
  onRestorePhase(id: string): void;
}

const ROADMAP_CLOCK_FALLBACK_MS = 60_000;

export function NotesRoadmap({
  phases,
  references,
  authorityReady,
  expectedRevision,
  expectedProjectKey,
  initialSelectedPhaseId = null,
  openSource = openReferenceUrl,
  onCreatePhase,
  onEditPhase,
  onMovePhase,
  onChangePhaseStatus,
  onArchivePhase,
  onLinkReferenceToPhase,
  onUnlinkReferenceFromPhase,
  onCreateReference,
  onAcceptReferenceProposal,
  onRejectReferenceProposal,
  onResolveRoadmapBlocker,
  onResumeAutomaticStatus,
  onResumeAutomaticReferences,
  onScheduleReminder,
  onSnoozeReminder,
  onDismissReminder,
  onStartPhase,
  onGetStorageDiagnostics = async () => {
    throw new Error("Storage diagnostics are unavailable.");
  },
  onRebindPhase = async () => ({ status: "missing" }),
  onMutatePhaseLease = async () => ({ status: "missing" }),
  onReconcilePhaseExecution = async () => ({ status: "missing" }),
  onStartNextPhase,
  commands,
  onRunCommand,
  onCancelPhase,
  onResumePhase,
  startUnavailableReason,
  actionDisabled,
  onActionSuccess,
  onReconciliationSuccess,
}: RoadmapProps): React.ReactElement {
  const visiblePhases = phases.filter((phase) => phase.archivedAt === null);
  const currentTime = useRoadmapCurrentTime(phases);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedPhaseId);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [pendingPhaseId, setPendingPhaseId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ phaseId: string | null } | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const newPhaseButtonRef = useRef<HTMLButtonElement>(null);
  const phaseTitleRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedPhase = visiblePhases.find((phase) => phase.id === selectedId) ?? null;
  const advancement = useMemo(() => selectRoadmapAdvancement(phases), [phases]);
  const commandActions = useMemo(() => resolveRoadmapCommandActions(commands), [commands]);
  const [nextPhaseStatus, setNextPhaseStatus] = useState("");

  useEffect(() => {
    if (selectedId !== null && !selectedPhase) setSelectedId(null);
  }, [selectedId, selectedPhase]);

  useEffect(() => {
    if (showCreate) titleInputRef.current?.focus();
  }, [showCreate]);

  useEffect(() => {
    if (!focusRequest) return;
    const phaseTitle = focusRequest.phaseId
      ? phaseTitleRefs.current.get(focusRequest.phaseId)
      : undefined;
    if (phaseTitle) {
      phaseTitle.focus();
      return;
    }
    newPhaseButtonRef.current?.focus();
  }, [focusRequest]);

  const focusAfterRender = (phaseId: string | null): void => {
    setFocusRequest({ phaseId });
  };

  const closeCreate = (): void => {
    setShowCreate(false);
    focusAfterRender(null);
  };

  const createPhase = (): void => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    onCreatePhase({ title: trimmedTitle, goal, doneWhen: lines(doneWhen) });
    setAnnouncement(`Created phase: ${trimmedTitle}`);
    setTitle("");
    setGoal("");
    setDoneWhen("");
    closeCreate();
  };

  const selectPhase = (phaseId: string): void => {
    setShowCreate(false);
    setSelectedId(phaseId);
  };

  const closeDetail = (): void => {
    const phaseId = selectedId;
    setSelectedId(null);
    focusAfterRender(phaseId);
  };

  const togglePhase = (phaseId: string): void => {
    if (phaseId === selectedId) {
      closeDetail();
      return;
    }
    selectPhase(phaseId);
  };

  const runCardAction = async (phase: NotesPhase): Promise<void> => {
    const action = primaryAction(phase);
    if (action === "Review") {
      selectPhase(phase.id);
      return;
    }
    if (pendingPhaseId !== null || actionDisabled) {
      return;
    }
    if (
      (action === "Start" || action === "Recover") &&
      (startUnavailableReason !== null || isRoadmapPhaseStartProtected(phases, phase.id))
    ) {
      return;
    }

    setPendingPhaseId(phase.id);
    try {
      if (action === "Start") {
        const result = await onStartPhase(phase.id);
        if (result.status === "accepted") {
          setAnnouncement(`Started phase: ${phase.title}`);
          onActionSuccess();
          return;
        }
        setAnnouncement(
          result.status === "already-bound"
            ? `${phase.title} already started in another window.`
            : result.message,
        );
        return;
      }

      if (!phase.session) {
        setAnnouncement(`${phase.title} has no resumable session.`);
        return;
      }
      await onResumePhase(phase.id, phase.session);
      if (phase.reminder) {
        const result = await onDismissReminder(phase.id, phase.reminder.occurrenceKey);
        if (result.status !== "committed") {
          setAnnouncement(`Resumed ${phase.title}, but its reminder could not be dismissed.`);
          return;
        }
      }
      setAnnouncement(`Resumed phase: ${phase.title}`);
      onActionSuccess();
    } catch (error) {
      setAnnouncement(
        error instanceof Error ? error.message : `Couldn’t run the action for ${phase.title}.`,
      );
    } finally {
      setPendingPhaseId(null);
    }
  };

  const startNextPhase = async (): Promise<void> => {
    if (
      !advancement ||
      !advancement.ready ||
      pendingPhaseId !== null ||
      actionDisabled ||
      startUnavailableReason !== null
    ) {
      return;
    }
    const nextPhase = advancement.nextPhase;
    setPendingPhaseId(nextPhase.id);
    setNextPhaseStatus("Starting the next phase…");
    try {
      const result = await onStartNextPhase(advancement.checkpoint.id, nextPhase.id);
      if (result.status === "accepted") {
        setNextPhaseStatus("Next phase started. Opening its planning session.");
        setAnnouncement(`Started next phase: ${nextPhase.title}`);
        onActionSuccess();
        return;
      }
      setNextPhaseStatus(
        result.status === "already-bound"
          ? "The next phase already started in another window."
          : result.message,
      );
    } catch (error) {
      setNextPhaseStatus(
        error instanceof Error ? error.message : "The next phase could not be started. Try again.",
      );
    } finally {
      setPendingPhaseId(null);
    }
  };

  const selectedPhaseDetailProps: NotesPhaseDetailProps | null = selectedPhase
    ? {
        phase: selectedPhase,
        currentTime,
        expectedRevision,
        expectedProjectKey,
        references,
        authorityReady,
        openSource,
        position: visiblePhases.findIndex((phase) => phase.id === selectedPhase.id),
        phaseCount: visiblePhases.length,
        onClose: closeDetail,
        onEditPhase: (id, input) => {
          onEditPhase(id, input);
          setAnnouncement(`Updated phase: ${input.title.trim()}`);
        },
        onMovePhase: (id, direction) => {
          onMovePhase(id, direction);
          setAnnouncement(`Moved ${selectedPhase.title} ${direction}`);
        },
        onChangePhaseStatus: (status) => {
          const pausingAutomation =
            status === selectedPhase.status && selectedPhase.overrides.status === null;
          onChangePhaseStatus(selectedPhase.id, status);
          setAnnouncement(
            pausingAutomation
              ? `Paused automation for ${selectedPhase.title}`
              : `Changed ${selectedPhase.title} to ${statusLabel(status)}`,
          );
        },
        isTopologyMutationBlocked: (mutation) => isRoadmapTopologyMutationBlocked(phases, mutation),
        onArchivePhase: () => {
          const selectedIndex = visiblePhases.findIndex((phase) => phase.id === selectedPhase.id);
          const focusId =
            visiblePhases[selectedIndex + 1]?.id ?? visiblePhases[selectedIndex - 1]?.id ?? null;
          onArchivePhase(selectedPhase.id);
          setAnnouncement(`Archived phase: ${selectedPhase.title}`);
          setSelectedId(null);
          focusAfterRender(focusId);
        },
        onCancelPhase: async () => {
          const result = await onCancelPhase(selectedPhase.id);
          if (result.status === "cancelled") {
            setAnnouncement(`Cancelled run: ${selectedPhase.title}`);
          }
          return result;
        },
        onLinkReference: (referenceId) => {
          const reference = references.find((item) => item.id === referenceId);
          const referenceLabel = reference ? referenceSourceLabel(reference) : "reference";
          const phaseTitle = selectedPhase.title;
          void onLinkReferenceToPhase(referenceId, selectedPhase.id).then((result) => {
            setAnnouncement(
              referenceLinkAnnouncement(result, "attach", referenceLabel, phaseTitle),
            );
          });
        },
        onUnlinkReference: (referenceId) => {
          const reference = references.find((item) => item.id === referenceId);
          const referenceLabel = reference ? referenceSourceLabel(reference) : "reference";
          const phaseTitle = selectedPhase.title;
          void onUnlinkReferenceFromPhase(referenceId, selectedPhase.id).then((result) => {
            setAnnouncement(
              referenceLinkAnnouncement(result, "detach", referenceLabel, phaseTitle),
            );
          });
        },
        onCreateReference,
        onAcceptReferenceProposal,
        onRejectReferenceProposal,
        onResolveRoadmapBlocker: async (phaseId, blockerUpdateId) => {
          const result = await onResolveRoadmapBlocker(phaseId, blockerUpdateId);
          setAnnouncement(
            result.status === "committed"
              ? `Resolved blocker for ${selectedPhase.title}`
              : roadmapMutationMessage(result),
          );
          return result;
        },
        onResumeAutomaticStatus,
        onResumeAutomaticReferences,
        onScheduleReminder,
        onSnoozeReminder,
        onDismissReminder,
        onStartPhase,
        onGetStorageDiagnostics,
        onRebindPhase,
        onMutatePhaseLease,
        onReconcilePhaseExecution,
        onResumePhase,
        startUnavailableReason: isRoadmapPhaseStartProtected(phases, selectedPhase.id)
          ? "Use Start next phase to confirm the pending Roadmap advancement."
          : startUnavailableReason,
        actionDisabled,
        onPendingChange: (pending) => setPendingPhaseId(pending ? selectedPhase.id : null),
        onActionSuccess,
        onReconciliationSuccess,
      }
    : null;

  return (
    <div className="notes-roadmap">
      <div className="notes-roadmap-toolbar">
        <div>
          <h2 id="notes-roadmap-heading">Roadmap</h2>
          <p>{visiblePhases.length === 1 ? "1 phase" : `${visiblePhases.length} phases`}</p>
        </div>
        <button
          ref={newPhaseButtonRef}
          type="button"
          className="notes-roadmap-new"
          aria-expanded={showCreate}
          aria-controls="notes-roadmap-create"
          disabled={actionDisabled || pendingPhaseId !== null}
          onClick={() => {
            if (showCreate) {
              closeCreate();
              return;
            }
            setShowCreate(true);
          }}
        >
          {showCreate ? "Close" : "New phase"}
        </button>
      </div>

      <form
        id="notes-roadmap-create"
        className="notes-phase-form notes-phase-create"
        hidden={!showCreate}
        onSubmit={(event) => {
          event.preventDefault();
          createPhase();
        }}
      >
        <div className="notes-field">
          <label htmlFor="notes-phase-title">Phase title</label>
          <input
            ref={titleInputRef}
            id="notes-phase-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </div>
        <div className="notes-field">
          <label htmlFor="notes-phase-goal">Goal</label>
          <textarea
            id="notes-phase-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </div>
        <div className="notes-field">
          <label htmlFor="notes-phase-done-when">Done when</label>
          <textarea
            id="notes-phase-done-when"
            value={doneWhen}
            aria-describedby="notes-phase-done-when-help"
            onChange={(event) => setDoneWhen(event.target.value)}
          />
          <p id="notes-phase-done-when-help" className="notes-field-help">
            Add one criterion per line.
          </p>
        </div>
        <div className="notes-phase-form-actions">
          <button type="submit" disabled={!title.trim()}>
            Create phase
          </button>
          <button type="button" onClick={closeCreate}>
            Cancel
          </button>
        </div>
      </form>

      {advancement && (
        <section className="notes-roadmap-next-phase" aria-labelledby="notes-next-phase-title">
          <div>
            <p className="notes-roadmap-next-phase-kicker">
              {advancement.ready ? "Phase complete" : "Roadmap target needs recovery"}
            </p>
            <h3 id="notes-next-phase-title">
              {advancement.ready
                ? `Ready for ${advancement.nextPhase.title}`
                : `Resolve target for ${advancement.nextPhase.title}`}
            </h3>
            <p>
              {advancement.recoveryReason ??
                `${advancement.completedPhase.title} is Done. Start the next Roadmap phase when you’re ready.`}
            </p>
            {nextPhaseStatus && (
              <p className="notes-roadmap-next-phase-status" role="status">
                {nextPhaseStatus}
              </p>
            )}
          </div>
          <button
            type="button"
            className="notes-roadmap-primary"
            disabled={
              !advancement.ready ||
              pendingPhaseId !== null ||
              actionDisabled ||
              startUnavailableReason !== null
            }
            title={advancement.recoveryReason ?? startUnavailableReason ?? undefined}
            onClick={() => void startNextPhase()}
          >
            {pendingPhaseId === advancement.nextPhase.id
              ? "Starting next phase…"
              : "Start next phase"}
          </button>
          {commandActions.length > 0 && (
            <div className="notes-roadmap-next-phase-commands" aria-label="Review commands">
              {commandActions.map((action) => (
                <button
                  key={action.canonicalName}
                  type="button"
                  disabled={
                    pendingPhaseId !== null || actionDisabled || startUnavailableReason !== null
                  }
                  onClick={() => onRunCommand(action.invocation)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="notes-roadmap-workspace">
        {visiblePhases.length === 0 ? (
          <div className="notes-roadmap-empty">
            <strong>No roadmap phases yet</strong>
            <p>Create a phase to capture a goal and its completion criteria.</p>
          </div>
        ) : (
          <ol className="notes-roadmap-list" aria-label="Roadmap phases">
            {visiblePhases.map((phase) => {
              const selected = phase.id === selectedId;
              const action = primaryAction(phase);
              const actionLabel = phaseActionLabel(phase, action);
              const lifecycle = notesLifecyclePresentation(phase);
              const blocker = activeRoadmapBlocker(phase);
              const detailProps =
                selectedPhaseDetailProps?.phase.id === phase.id ? selectedPhaseDetailProps : null;
              return (
                <li
                  key={phase.id}
                  className={`notes-roadmap-row${selected ? " is-selected" : ""}${blocker ? " is-blocked" : ""}`}
                >
                  <div className="notes-roadmap-card-summary">
                    <div className="notes-roadmap-card-heading">
                      <h3 className="notes-roadmap-card-title">
                        <button
                          ref={(element) => {
                            if (element) phaseTitleRefs.current.set(phase.id, element);
                            else phaseTitleRefs.current.delete(phase.id);
                          }}
                          type="button"
                          className="notes-roadmap-title"
                          aria-label={`Inspect phase: ${phase.title}`}
                          aria-expanded={selected}
                          aria-controls={selected ? `notes-phase-panel-${phase.id}` : undefined}
                          disabled={pendingPhaseId !== null}
                          onClick={() => togglePhase(phase.id)}
                        >
                          <span className="notes-roadmap-title-text">{phase.title}</span>
                          {phase.sourcePrompt.trim().length > 0 && (
                            <span className="notes-phase-saved-prompt-marker">Saved prompt</span>
                          )}
                        </button>
                      </h3>
                      <span className={`notes-phase-status is-${phase.status}`}>
                        {lifecycle.state}
                      </span>
                    </div>

                    {phase.goal.trim().length > 0 && (
                      <p className="notes-roadmap-goal">{phase.goal}</p>
                    )}

                    {blocker && (
                      <p className="notes-roadmap-attention">
                        <strong>Needs attention:</strong> {blocker.blocker}
                      </p>
                    )}

                    {phase.doneWhen.length > 0 && (
                      <section
                        className="notes-roadmap-criteria"
                        aria-label={`Done when for ${phase.title}`}
                      >
                        <h4>Done when</h4>
                        <ul>
                          {phase.doneWhen.map((criterion, index) => (
                            <li key={`${phase.id}-criterion-${index}`}>{criterion}</li>
                          ))}
                        </ul>
                      </section>
                    )}

                    <div className="notes-roadmap-card-footer">
                      <div className="notes-roadmap-meta">
                        <span>{lifecycle.stage}</span>
                        <span>
                          {phase.referenceIds.length}{" "}
                          {phase.referenceIds.length === 1 ? "ref" : "refs"}
                        </span>
                        <span>{reminderRowLabel(phase, currentTime)}</span>
                      </div>
                      {!selected && (
                        <button
                          type="button"
                          className="notes-roadmap-primary"
                          aria-label={`${actionLabel} phase: ${phase.title}`}
                          disabled={
                            pendingPhaseId !== null ||
                            actionDisabled ||
                            ((action === "Start" || action === "Recover") &&
                              (startUnavailableReason !== null ||
                                isRoadmapPhaseStartProtected(phases, phase.id)))
                          }
                          onClick={() => void runCardAction(phase)}
                        >
                          {actionLabel}
                        </button>
                      )}
                    </div>
                  </div>

                  {detailProps && (
                    <div id={`notes-phase-panel-${phase.id}`}>
                      <NotesPhaseDetail key={detailProps.phase.id} {...detailProps} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

export function NotesRoadmapArchive({ phases, onRestorePhase }: ArchiveProps): React.ReactElement {
  const archivedPhases = phases.filter((phase) => phase.archivedAt !== null);
  const [announcement, setAnnouncement] = useState("");
  return (
    <div className="notes-phase-archive">
      <h3>Roadmap phases</h3>
      {archivedPhases.length === 0 ? (
        <p className="notes-empty">No archived phases.</p>
      ) : (
        <ul aria-label="Archived roadmap phases">
          {archivedPhases.map((phase) => {
            const lifecycle = notesLifecyclePresentation(phase);
            return (
              <li key={phase.id}>
                <span>
                  <strong>{phase.title}</strong>
                  <small>
                    {lifecycle.state} · {lifecycle.stage}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={`Restore phase: ${phase.title}`}
                  disabled={isRoadmapTopologyMutationBlocked(phases, {
                    type: "restore",
                    phaseId: phase.id,
                  })}
                  title={
                    isRoadmapTopologyMutationBlocked(phases, {
                      type: "restore",
                      phaseId: phase.id,
                    })
                      ? "Restoring this phase would replace the target protected by a pending phase advancement."
                      : undefined
                  }
                  onClick={() => {
                    onRestorePhase(phase.id);
                    setAnnouncement(`Restored phase: ${phase.title}`);
                  }}
                >
                  Restore
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function useRoadmapCurrentTime(phases: NotesPhase[]): Date {
  const reminderDueTimes = useMemo(
    () =>
      phases
        .flatMap((phase) =>
          phase.archivedAt === null && phase.reminder ? [Date.parse(phase.reminder.dueAt)] : [],
        )
        .filter(Number.isFinite)
        .sort((left, right) => left - right),
    [phases],
  );
  const [currentTimeMs, setCurrentTimeMs] = useState(Date.now);

  useEffect(() => {
    const actualNow = Date.now();
    const nextReminderDueAt = reminderDueTimes.find((dueAt) => dueAt > actualNow);
    const delayMs = Math.max(
      1,
      Math.min(
        ROADMAP_CLOCK_FALLBACK_MS,
        nextReminderDueAt === undefined ? ROADMAP_CLOCK_FALLBACK_MS : nextReminderDueAt - actualNow,
      ),
    );
    const timer = window.setTimeout(() => setCurrentTimeMs(Date.now()), delayMs);
    return () => window.clearTimeout(timer);
  }, [currentTimeMs, reminderDueTimes]);

  return useMemo(() => new Date(currentTimeMs), [currentTimeMs]);
}
