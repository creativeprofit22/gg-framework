import { useEffect, useMemo, useRef, useState } from "react";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { isNotesPhasePresent } from "@kenkaiiii/gg-core/project-notes";
import {
  planRoadmapPhaseMove,
  type RoadmapPhaseOrderRefusal,
  type RoadmapPhasePlacement,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { notesLifecyclePresentation, notesPhaseStatusLabel } from "./notes-lifecycle-presentation";
import { openReferenceUrl, type OpenReferenceUrl } from "./notes-open-source";
import { referenceSourceLabel } from "./notes-reference";
import {
  activePhaseCountLabel,
  groupNotesPhases,
  isActiveNotesPhase,
  isCompletedNotesPhase,
  roadmapProgressLabel,
  selectNotesRoadmapProgress,
} from "./notes-status";
import { NotesCompletedGroup } from "./NotesCompletedGroup";
import { NotesPhaseStatusBadge, NotesSavedPromptIndicator } from "./NotesStatusBadge";
import type { SlashCommand } from "./agent";
import { NotesPhaseDetail } from "./notes-roadmap/NotesPhaseDetail";
import { useRoadmapPhaseNavigation } from "./notes-roadmap/useRoadmapPhaseNavigation";
import { resolveRoadmapCommandActions } from "./notes-roadmap/roadmap-command-actions";
import type { NotesPhaseDetailProps } from "./notes-roadmap/NotesPhaseDetailState";
import {
  lines,
  phaseActionLabel,
  primaryAction,
  referenceLinkAnnouncement,
  reminderRowLabel,
  roadmapMutationMessage,
  selectRoadmapAdvancement,
  isRoadmapPhaseStartProtected,
  isRoadmapTopologyMutationBlocked,
  visibleRoadmapAttentionReason,
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
  /** Increments when a new navigation request targets `initialSelectedPhaseId`. */
  selectedPhaseRequest?: number;
  openSource?: OpenReferenceUrl;
  onCreatePhase(input: NotesPhaseInput): void;
  onEditPhase(id: string, input: NotesPhaseInput): void;
  onMovePhase(id: string, direction: "up" | "down"): void;
  /** Drag (or arrow-key) reorder of open phases; absent hides the reorder handles. */
  onReorderPhase?(id: string, placement: RoadmapPhasePlacement): void;
  onChangePhaseStatus(id: string, status: NotesPhaseStatus): void;
  onSetPhaseStatusOverride(
    id: string,
    status: NotesPhaseStatus,
  ): Promise<NotesRoadmapMutationResult>;
  onArchivePhase(id: string): void;
  /** `onDeleted` runs when that deletion commits, so the caller can retire a selection. */
  onDeletePhase?(id: string, onDeleted?: () => void): void;
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
  onDeletePhase?(id: string): void;
  phases: NotesPhase[];
  onRestorePhase(id: string): void;
}

const ROADMAP_CLOCK_FALLBACK_MS = 60_000;

const DONE_PHASE_MOVE_REFUSAL = "Done phases can’t be moved.";

/** User-facing copy for a refused reorder, shared by drag, arrow keys and Move up/down. */
function describeReorderRefusal(refusal: RoadmapPhaseOrderRefusal): string {
  if (refusal.reason === "ahead-of-done") return "A phase can’t move ahead of a Done phase.";
  if (refusal.reason === "no-change") return "The phase is already there.";
  if (refusal.reason === "phase-not-movable" && refusal.notMovable === "done") {
    return DONE_PHASE_MOVE_REFUSAL;
  }
  return "This phase can’t be moved there.";
}

export function NotesRoadmap({
  phases,
  references,
  authorityReady,
  expectedRevision,
  expectedProjectKey,
  initialSelectedPhaseId = null,
  selectedPhaseRequest = 0,
  openSource = openReferenceUrl,
  onCreatePhase,
  onEditPhase,
  onMovePhase,
  onReorderPhase,
  onChangePhaseStatus,
  onSetPhaseStatusOverride,
  onArchivePhase,
  onDeletePhase,
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
  const phaseGroups = useMemo(() => groupNotesPhases(phases), [phases]);
  // Display order: open phases, then the Completed group.
  const visiblePhases = useMemo(
    () => [...phaseGroups.open, ...phaseGroups.completed],
    [phaseGroups],
  );
  const progress = useMemo(() => selectNotesRoadmapProgress(phases), [phases]);
  const progressLabel = roadmapProgressLabel(progress);
  const currentTime = useRoadmapCurrentTime(phases);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [pendingPhaseId, setPendingPhaseId] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const navigation = useRoadmapPhaseNavigation({
    phases: visiblePhases,
    initialSelectedPhaseId,
    selectionRequest: selectedPhaseRequest,
    onSelectionMissing: () =>
      setAnnouncement("That phase is no longer in the roadmap. Returned to the phase list."),
  });
  const {
    selectedId,
    selectedPhase,
    rootRef,
    fallbackRef: newPhaseButtonRef,
    registerPhaseTitle,
    focusAfterDetail,
    selectPhase,
    closeDetail,
    togglePhase,
    clearSelection,
  } = navigation;
  const advancement = useMemo(() => selectRoadmapAdvancement(phases), [phases]);
  const commandActions = useMemo(() => resolveRoadmapCommandActions(commands), [commands]);
  const [nextPhaseStatus, setNextPhaseStatus] = useState("");
  const [dragPhaseId, setDragPhaseId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<RoadmapPhasePlacement | null>(null);
  const reorderHandles = useRef(new Map<string, HTMLButtonElement>());
  const [refocusHandleId, setRefocusHandleId] = useState<string | null>(null);

  useEffect(() => {
    if (showCreate) titleInputRef.current?.focus();
  }, [showCreate]);

  // Moving a row can drop focus from its handle; keep keyboard reorder on the same phase.
  useEffect(() => {
    if (refocusHandleId === null) return;
    const handle = reorderHandles.current.get(refocusHandleId);
    if (handle && document.activeElement !== handle) handle.focus();
    setRefocusHandleId(null);
  }, [phases, refocusHandleId]);

  const reorderEnabled =
    onReorderPhase !== undefined &&
    !actionDisabled &&
    pendingPhaseId === null &&
    phaseGroups.open.length > 1;

  /** Null when allowed; otherwise why this placement is refused. */
  const reorderRefusal = (phaseId: string, placement: RoadmapPhasePlacement): string | null => {
    const planned = planRoadmapPhaseMove(phases, phaseId, placement);
    if (!planned.ok) return describeReorderRefusal(planned.refusal);
    return isRoadmapTopologyMutationBlocked(phases, { type: "reorder", phaseId, placement })
      ? "This move would change the target protected by a pending phase advancement."
      : null;
  };

  /** Null when Move up/down is allowed; otherwise why. Neighbours come from the phase's group. */
  const moveRefusal = (
    phase: NotesPhase,
    group: readonly NotesPhase[],
    direction: "up" | "down",
  ): string | null => {
    if (phase.status === "done") return DONE_PHASE_MOVE_REFUSAL;
    const index = group.findIndex((candidate) => candidate.id === phase.id);
    const neighbour = group[index + (direction === "up" ? -1 : 1)];
    // First/last bounds are handled by the position-based disabled state.
    if (index < 0 || !neighbour) return null;
    const planned = planRoadmapPhaseMove(phases, phase.id, {
      position: direction === "up" ? "before" : "after",
      targetPhaseId: neighbour.id,
    });
    return planned.ok ? null : describeReorderRefusal(planned.refusal);
  };

  const titleOf = (phaseId: string): string =>
    phases.find((phase) => phase.id === phaseId)?.title ?? "phase";

  const commitReorder = (phase: NotesPhase, placement: RoadmapPhasePlacement): void => {
    if (!onReorderPhase || !reorderEnabled) return;
    const refusal = reorderRefusal(phase.id, placement);
    if (refusal) {
      setAnnouncement(refusal);
      return;
    }
    onReorderPhase(phase.id, placement);
    setAnnouncement(
      `Moved ${phase.title} ${placement.position} ${titleOf(placement.targetPhaseId)}`,
    );
  };

  const reorderWithKeyboard = (phase: NotesPhase, direction: "up" | "down"): void => {
    const index = phaseGroups.open.findIndex((candidate) => candidate.id === phase.id);
    const neighbour = phaseGroups.open[index + (direction === "up" ? -1 : 1)];
    if (index < 0 || !neighbour) {
      setAnnouncement(`${phase.title} is already ${direction === "up" ? "first" : "last"}.`);
      return;
    }
    setRefocusHandleId(phase.id);
    commitReorder(phase, {
      position: direction === "up" ? "before" : "after",
      targetPhaseId: neighbour.id,
    });
  };

  const endDrag = (): void => {
    setDragPhaseId(null);
    setDropTarget(null);
  };

  const closeCreate = (): void => {
    setShowCreate(false);
    focusAfterDetail(null);
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

  const runCardAction = async (phase: NotesPhase): Promise<void> => {
    const action = primaryAction(phase);
    if (action === "Review") {
      setShowCreate(false);
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

  // Position, Move and archive-focus neighbours stay within the selected phase's own group.
  const selectedGroup =
    selectedPhase && isCompletedNotesPhase(selectedPhase)
      ? phaseGroups.completed
      : phaseGroups.open;

  const selectedPhaseDetailProps: NotesPhaseDetailProps | null = selectedPhase
    ? {
        phase: selectedPhase,
        currentTime,
        expectedRevision,
        expectedProjectKey,
        references,
        authorityReady,
        openSource,
        position: selectedGroup.findIndex((phase) => phase.id === selectedPhase.id),
        phaseCount: selectedGroup.length,
        primaryEmphasis: !advancement,
        onClose: closeDetail,
        onEditPhase: (id, input) => {
          onEditPhase(id, input);
          setAnnouncement(`Updated phase: ${input.title.trim()}`);
        },
        moveRefusal: (direction) => moveRefusal(selectedPhase, selectedGroup, direction),
        onMovePhase: (id, direction) => {
          const refusal = moveRefusal(selectedPhase, selectedGroup, direction);
          if (refusal) {
            setAnnouncement(refusal);
            return;
          }
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
              : `Changed ${selectedPhase.title} to ${notesPhaseStatusLabel(status)}`,
          );
        },
        onSetPhaseStatusOverride: async (status) => {
          const title = selectedPhase.title;
          const result = await onSetPhaseStatusOverride(selectedPhase.id, status);
          if (result.status === "committed") {
            setAnnouncement(`Changed ${title} to ${notesPhaseStatusLabel(status)}`);
          }
          return result;
        },
        isTopologyMutationBlocked: (mutation) => isRoadmapTopologyMutationBlocked(phases, mutation),
        // A deliberate delete leaves the list the way Archive does: selection is cleared
        // here, so the missing-selection recovery line stays for genuine disappearances.
        // Focus is left to the deletion controller, which picks a surviving phase title.
        onDeletePhase: onDeletePhase
          ? () => onDeletePhase(selectedPhase.id, () => clearSelection(null))
          : undefined,
        onArchivePhase: () => {
          const selectedIndex = selectedGroup.findIndex((phase) => phase.id === selectedPhase.id);
          const focusId =
            selectedGroup[selectedIndex + 1]?.id ?? selectedGroup[selectedIndex - 1]?.id ?? null;
          onArchivePhase(selectedPhase.id);
          setAnnouncement(`Archived phase: ${selectedPhase.title}`);
          clearSelection(focusId);
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

  const renderPhaseRow = (phase: NotesPhase, reorderable: boolean): React.ReactElement => {
    const selected = phase.id === selectedId;
    const action = primaryAction(phase);
    const actionLabel = phaseActionLabel(phase, action);
    const lifecycle = notesLifecyclePresentation(phase);
    const attentionReason = visibleRoadmapAttentionReason(phase);
    const showHandle = reorderable && onReorderPhase !== undefined && phaseGroups.open.length > 1;
    const dropPosition =
      dropTarget?.targetPhaseId === phase.id && dragPhaseId !== phase.id
        ? dropTarget.position
        : null;
    return (
      <li
        key={phase.id}
        className={`notes-roadmap-row${selected ? " is-selected" : ""}${attentionReason ? " is-blocked" : ""}${dragPhaseId === phase.id ? " is-dragging" : ""}${dropPosition ? ` is-drop-${dropPosition}` : ""}`}
        onDragOver={
          reorderable && dragPhaseId !== null
            ? (event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const placement: RoadmapPhasePlacement = {
                  position: event.clientY < rect.top + rect.height / 2 ? "before" : "after",
                  targetPhaseId: phase.id,
                };
                if (dragPhaseId === phase.id || reorderRefusal(dragPhaseId, placement)) {
                  if (dropTarget !== null) setDropTarget(null);
                  return;
                }
                // Accepting dragover is what marks this row as a valid drop target.
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (
                  dropTarget?.targetPhaseId !== placement.targetPhaseId ||
                  dropTarget.position !== placement.position
                ) {
                  setDropTarget(placement);
                }
              }
            : undefined
        }
        onDrop={
          reorderable && dragPhaseId !== null
            ? (event) => {
                event.preventDefault();
                const dragged = phases.find((candidate) => candidate.id === dragPhaseId);
                if (dragged && dropTarget?.targetPhaseId === phase.id) {
                  commitReorder(dragged, dropTarget);
                }
                endDrag();
              }
            : undefined
        }
      >
        <div className="notes-roadmap-card-summary">
          <div className={`notes-roadmap-card-heading${showHandle ? " has-reorder-handle" : ""}`}>
            {showHandle && (
              <button
                ref={(element) => {
                  if (element) reorderHandles.current.set(phase.id, element);
                  else reorderHandles.current.delete(phase.id);
                }}
                type="button"
                className="notes-roadmap-reorder-handle notes-btn-quiet"
                draggable={reorderEnabled}
                aria-label={`Reorder phase: ${phase.title}`}
                aria-describedby="notes-roadmap-reorder-help"
                title="Drag to reorder"
                disabled={!reorderEnabled}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", phase.id);
                  event.dataTransfer.effectAllowed = "move";
                  setDragPhaseId(phase.id);
                }}
                onDragEnd={endDrag}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  reorderWithKeyboard(phase, event.key === "ArrowUp" ? "up" : "down");
                }}
              >
                <DotsSixVerticalIcon size={16} aria-hidden="true" />
              </button>
            )}
            <h3 className="notes-roadmap-card-title">
              <button
                ref={(element) => registerPhaseTitle(phase.id, element)}
                type="button"
                className="notes-roadmap-title"
                data-phase-focus={phase.id}
                aria-label={`Inspect phase: ${phase.title}`}
                aria-expanded={selected}
                aria-controls={selected ? `notes-phase-panel-${phase.id}` : undefined}
                disabled={pendingPhaseId !== null}
                onClick={() => togglePhase(phase.id)}
              >
                <span className="notes-roadmap-title-text">{phase.title}</span>
              </button>
              {phase.sourcePrompt.trim().length > 0 && <NotesSavedPromptIndicator />}
            </h3>
            <NotesPhaseStatusBadge status={phase.status} />
          </div>

          {attentionReason && (
            <p className="notes-roadmap-attention">
              <strong>Needs attention:</strong> {attentionReason}
            </p>
          )}

          <div className="notes-roadmap-card-footer">
            <div className="notes-roadmap-meta">
              <span>{lifecycle.stage}</span>
              <span>
                {phase.referenceIds.length} {phase.referenceIds.length === 1 ? "ref" : "refs"}
              </span>
              <span>{reminderRowLabel(phase, currentTime)}</span>
            </div>
            {!selected && (
              <button
                type="button"
                className="notes-roadmap-card-action notes-btn-quiet"
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
      </li>
    );
  };

  return (
    <div className="notes-roadmap" ref={rootRef}>
      <div className="notes-roadmap-toolbar">
        <div>
          <h2 id="notes-roadmap-heading" tabIndex={-1} data-roadmap-focus-last-resort>
            Roadmap
          </h2>
          <p>{activePhaseCountLabel(visiblePhases.filter(isActiveNotesPhase).length)}</p>
          {progressLabel !== null && (
            <p className="notes-roadmap-progress">
              <span>{progressLabel}</span>
              <progress value={progress.done} max={progress.total} aria-label="Roadmap progress" />
            </p>
          )}
        </div>
        <button
          ref={newPhaseButtonRef}
          type="button"
          data-phase-focus-fallback
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
            className="notes-roadmap-primary notes-btn-primary"
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

      <div className={`notes-roadmap-workspace${selectedPhaseDetailProps ? " has-detail" : ""}`}>
        {visiblePhases.length === 0 ? (
          <div className="notes-roadmap-empty">
            <strong>No roadmap phases yet</strong>
            <p>Create a phase to capture a goal and its completion criteria.</p>
          </div>
        ) : (
          <div className="notes-roadmap-groups">
            {phaseGroups.open.length === 0 ? (
              <div className="notes-roadmap-empty">
                <strong>All phases are done</strong>
                <p>
                  Create a phase when there’s more to plan. Finished phases are under Completed.
                </p>
              </div>
            ) : (
              <ol className="notes-roadmap-list" aria-label="Roadmap phases">
                {phaseGroups.open.map((phase) => renderPhaseRow(phase, true))}
              </ol>
            )}
            {onReorderPhase && (
              <p id="notes-roadmap-reorder-help" className="visually-hidden">
                Drag to reorder, or press the Up or Down arrow key to move this phase.
              </p>
            )}
            <NotesCompletedGroup
              id="notes-completed-phases"
              count={phaseGroups.completed.length}
              storageKey={expectedProjectKey ? `${expectedProjectKey}:completed-phases` : null}
              forceOpen={selectedPhase !== null && isCompletedNotesPhase(selectedPhase)}
            >
              <ol className="notes-roadmap-list" aria-label="Completed phases">
                {phaseGroups.completed.map((phase) => renderPhaseRow(phase, false))}
              </ol>
            </NotesCompletedGroup>
          </div>
        )}

        {selectedPhaseDetailProps && (
          <div id={`notes-phase-panel-${selectedPhaseDetailProps.phase.id}`}>
            <NotesPhaseDetail
              key={selectedPhaseDetailProps.phase.id}
              {...selectedPhaseDetailProps}
            />
          </div>
        )}
      </div>

      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

export function NotesRoadmapArchive({
  phases,
  onRestorePhase,
  onDeletePhase,
}: ArchiveProps): React.ReactElement {
  const archivedPhases = phases.filter(
    (phase) => isNotesPhasePresent(phase) && phase.archivedAt !== null,
  );
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
                  data-phase-focus={phase.id}
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
                {onDeletePhase && (
                  <button
                    type="button"
                    className="notes-btn-quiet notes-btn-danger"
                    onClick={() => onDeletePhase(phase.id)}
                    aria-label={`Delete phase: ${phase.title}`}
                  >
                    Delete phase
                  </button>
                )}
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
          isNotesPhasePresent(phase) && phase.archivedAt === null && phase.reminder
            ? [Date.parse(phase.reminder.dueAt)]
            : [],
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
