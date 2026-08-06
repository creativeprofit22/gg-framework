import { useEffect, useMemo, useRef, useState } from "react";
import { notesLifecyclePresentation } from "./notes-lifecycle-presentation";
import { openReferenceUrl, type OpenReferenceUrl } from "./notes-open-source";
import { referenceSourceLabel } from "./notes-reference";
import { NotesPhaseDetail } from "./notes-roadmap/NotesPhaseDetail";
import type { NotesPhaseDetailProps } from "./notes-roadmap/NotesPhaseDetailState";
import {
  activeRoadmapBlocker,
  lines,
  phaseActionLabel,
  primaryAction,
  referenceLinkAnnouncement,
  reminderRowLabel,
  roadmapMutationMessage,
  selectManualRoadmapAdvancement,
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
  PhaseStartResult,
} from "./notes-types";

interface RoadmapProps {
  phases: NotesPhase[];
  references: NotesReference[];
  authorityReady: boolean;
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
  onCancelPhase(phaseId: string): Promise<PhaseRunCancellationResult>;
  onResumePhase(phaseId: string, link: NotesSessionLink): Promise<void>;
  startUnavailableReason: string | null;
  actionDisabled: boolean;
  onActionSuccess(): void;
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
  onCancelPhase,
  onResumePhase,
  startUnavailableReason,
  actionDisabled,
  onActionSuccess,
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
  const manualAdvancement = useMemo(() => selectManualRoadmapAdvancement(phases), [phases]);
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

  const startNextPhase = async (): Promise<void> => {
    if (
      !manualAdvancement ||
      pendingPhaseId !== null ||
      actionDisabled ||
      startUnavailableReason !== null
    ) {
      return;
    }
    const nextPhase = manualAdvancement.nextPhase;
    setPendingPhaseId(nextPhase.id);
    setNextPhaseStatus("Starting the next phase…");
    try {
      const result = await onStartPhase(nextPhase.id);
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
        onResumePhase,
        startUnavailableReason,
        actionDisabled,
        onPendingChange: (pending) => setPendingPhaseId(pending ? selectedPhase.id : null),
        onActionSuccess,
      }
    : null;

  return (
    <div className={`notes-roadmap${selectedPhase ? " has-detail" : ""}`}>
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

      {manualAdvancement && (
        <section className="notes-roadmap-next-phase" aria-labelledby="notes-next-phase-title">
          <div>
            <p className="notes-roadmap-next-phase-kicker">Phase complete</p>
            <h3 id="notes-next-phase-title">Ready for {manualAdvancement.nextPhase.title}</h3>
            <p>
              {manualAdvancement.completedPhase.title} is Done. Start the next Roadmap phase when
              you’re ready.
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
            disabled={pendingPhaseId !== null || actionDisabled || startUnavailableReason !== null}
            title={startUnavailableReason ?? undefined}
            onClick={() => void startNextPhase()}
          >
            {pendingPhaseId === manualAdvancement.nextPhase.id
              ? "Starting next phase…"
              : "Start next phase"}
          </button>
        </section>
      )}

      <div className={`notes-roadmap-workspace${selectedPhase ? " has-detail" : ""}`}>
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
              return (
                <li
                  key={phase.id}
                  className={`notes-roadmap-row${selected ? " is-selected" : ""}${blocker ? " is-blocked" : ""}`}
                >
                  <button
                    ref={(element) => {
                      if (element) phaseTitleRefs.current.set(phase.id, element);
                      else phaseTitleRefs.current.delete(phase.id);
                    }}
                    type="button"
                    className="notes-roadmap-title"
                    aria-label={`Inspect phase: ${phase.title}`}
                    aria-pressed={selected}
                    disabled={pendingPhaseId !== null}
                    onClick={() => selectPhase(phase.id)}
                  >
                    <span className="notes-roadmap-title-text">{phase.title}</span>
                    {phase.sourcePrompt.trim().length > 0 && (
                      <span className="notes-phase-saved-prompt-marker">Saved prompt</span>
                    )}
                  </button>
                  <span className="notes-phase-status">
                    <strong>{lifecycle.state}</strong>
                    <small>{lifecycle.stage}</small>
                  </span>
                  <span className="notes-phase-count">
                    {phase.referenceIds.length} {phase.referenceIds.length === 1 ? "ref" : "refs"}
                  </span>
                  <span className="notes-phase-reminder">
                    {reminderRowLabel(phase, currentTime)}
                  </span>
                  {!selected && (
                    <button
                      type="button"
                      className="notes-roadmap-primary"
                      aria-label={`${actionLabel} phase: ${phase.title}`}
                      disabled={pendingPhaseId !== null}
                      onClick={() => selectPhase(phase.id)}
                    >
                      {actionLabel}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {selectedPhaseDetailProps && (
          <NotesPhaseDetail
            key /* Preserve detail-local state until phase selection changes. */={
              selectedPhaseDetailProps.phase.id
            }
            {...selectedPhaseDetailProps}
          />
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
