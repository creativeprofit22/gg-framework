import { notesAutomaticStatusAfterOverrideReset } from "@kenkaiiii/gg-core/project-notes";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { notesLifecyclePresentation } from "../notes-lifecycle-presentation";
import type { OpenReferenceUrl } from "../notes-open-source";
import {
  dateToLocalInputValue,
  localDateTimeToIso,
  reminderMutationResultMessage,
  reminderPresetTimes,
  type ReminderPresetTimes,
} from "../roadmap-reminders";
import type { NotesPhaseInput } from "../useProjectNotes";
import type {
  NotesPhase,
  NotesPhaseStatus,
  PhaseRunCancellationResult,
  NotesReference,
  NotesReminderMutationResult,
  NotesRoadmapMutationResult,
  NotesRoadmapReferenceProposal,
  NotesRoadmapStatusUpdate,
  NotesSessionLink,
  PhaseStartResult,
} from "../notes-types";
import type { NotesLifecyclePresentation } from "../notes-lifecycle-presentation";
import type { PhaseView } from "./NotesPhaseViewNavigation";
import {
  latestRoadmapReport,
  lines,
  phaseActionLabel,
  primaryAction,
  roadmapMutationMessage,
  sessionAction,
  unresolvedRoadmapProposals,
  type PhasePrimaryAction,
} from "./roadmap-presentation";

export interface NotesPhaseDetailProps {
  phase: NotesPhase;
  currentTime: Date;
  references: NotesReference[];
  authorityReady: boolean;
  openSource: OpenReferenceUrl;
  position: number;
  phaseCount: number;
  onClose(): void;
  onEditPhase(id: string, input: NotesPhaseInput): void;
  onMovePhase(id: string, direction: "up" | "down"): void;
  onChangePhaseStatus(status: NotesPhaseStatus): void;
  onArchivePhase(): void;
  onCancelPhase(): Promise<PhaseRunCancellationResult>;
  onLinkReference(referenceId: string): void;
  onUnlinkReference(referenceId: string): void;
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
  onResumePhase(phaseId: string, link: NotesSessionLink): Promise<void>;
  startUnavailableReason: string | null;
  actionDisabled: boolean;
  onPendingChange(pending: boolean): void;
  onActionSuccess(): void;
}

export interface PhaseEditDraft {
  baseUpdatedAt: string;
  baseTitle: string;
  baseGoal: string;
  baseDoneWhen: string;
  title: string;
  goal: string;
  doneWhen: string;
  conflict: boolean;
}

export interface ReminderDraft {
  baseUpdatedAt: string;
  baseOccurrenceKey: string | null;
  baseNote: string;
  baseCustomValue: string;
  note: string;
  customValue: string;
  conflict: boolean;
}

interface NotesPhaseDetailContextValue extends NotesPhaseDetailProps {
  editing: boolean;
  activeView: PhaseView;
  setActiveView(view: PhaseView): void;
  phaseDraft: PhaseEditDraft;
  reminderDraft: ReminderDraft;
  reminderPresets: ReminderPresetTimes;
  customReminderError: string;
  pending: boolean;
  pendingRoadmapAction: string | null;
  openingSourceKey: string | null;
  actionError: string;
  actionStatus: string;
  effectiveAction: PhasePrimaryAction;
  effectiveActionLabel: "Start" | "Resume" | "Recover" | "Retry" | "Review";
  controlsDisabled: boolean;
  cancellationDisabled: boolean;
  phaseStartDisabled: boolean;
  latestReport: NotesRoadmapStatusUpdate | null;
  pendingProposals: Array<{
    proposal: NotesRoadmapReferenceProposal;
    report: NotesRoadmapStatusUpdate;
  }>;
  latestReportHasPendingManualReview: boolean;
  lifecycle: NotesLifecyclePresentation;
  resumedLifecycle: NotesLifecyclePresentation;
  canPauseAutomation: boolean;
  canCancelRun: boolean;
  primaryActionRef: RefObject<HTMLButtonElement | null>;
  runPhaseAction(): Promise<void>;
  beginEdit(): void;
  cancelEdit(): void;
  saveEdit(): void;
  reloadPhaseDraft(): void;
  updatePhaseDraft(changes: Partial<Pick<PhaseEditDraft, "title" | "goal" | "doneWhen">>): void;
  updateReminderDraft(changes: Partial<Pick<ReminderDraft, "note" | "customValue">>): void;
  clearCustomReminderError(): void;
  reloadReminderDraft(): void;
  scheduleReminder(dueAt: Date): void;
  submitCustomReminder(): void;
  dismissReminder(): void;
  snoozeReminder(): void;
  openReferenceSource(sourceKey: string, canonicalUrl: string, label: string): void;
  runRoadmapMutation(
    actionKey: string,
    operation: () => Promise<NotesRoadmapMutationResult>,
  ): Promise<void>;
  acceptReferenceProposal(proposalId: string): void;
  rejectReferenceProposal(proposalId: string): void;
  resumeAutomaticStatus(): void;
  resumeAutomaticReferences(): void;
  runCancellation(): Promise<void>;
}

const NotesPhaseDetailContext = createContext<NotesPhaseDetailContextValue | null>(null);

export function NotesPhaseDetailProvider({
  children,
  ...props
}: NotesPhaseDetailProps & { children: ReactNode }): ReactNode {
  const {
    phase,
    currentTime,
    openSource,
    onEditPhase,
    onCancelPhase,
    onAcceptReferenceProposal,
    onRejectReferenceProposal,
    onResumeAutomaticStatus,
    onResumeAutomaticReferences,
    onScheduleReminder,
    onSnoozeReminder,
    onDismissReminder,
    onStartPhase,
    onResumePhase,
    startUnavailableReason,
    actionDisabled,
    onPendingChange,
    onActionSuccess,
  } = props;
  const [editing, setEditing] = useState(false);
  const [activeView, setActiveView] = useState<PhaseView>("overview");
  const [phaseDraft, setPhaseDraft] = useState(() => createPhaseEditDraft(phase));
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [raceLink, setRaceLink] = useState<NotesSessionLink | null>(null);
  const [pendingRoadmapAction, setPendingRoadmapAction] = useState<string | null>(null);
  const [openingSourceKey, setOpeningSourceKey] = useState<string | null>(null);
  const reminderPresets = useMemo(() => reminderPresetTimes(currentTime), [currentTime]);
  const reminderFallbackValue = dateToLocalInputValue(reminderPresets.tomorrow);
  const [reminderDraft, setReminderDraft] = useState(() =>
    createReminderDraft(phase, reminderFallbackValue),
  );
  const [customReminderError, setCustomReminderError] = useState("");
  const effectivePhaseDraft = reconcilePhaseEditDraft(phaseDraft, phase, editing);
  const effectiveReminderDraft = reconcileReminderDraft(
    reminderDraft,
    phase,
    reminderFallbackValue,
  );
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const action = primaryAction(phase);
  const effectiveAction = raceLink ? sessionAction(raceLink) : action;
  const effectiveActionLabel = phaseActionLabel(phase, effectiveAction);
  const resumeLink = raceLink ?? phase.session;
  const controlsDisabled = actionDisabled || pending || pendingRoadmapAction !== null;
  const cancellationDisabled = pending || pendingRoadmapAction !== null;
  const latestReport = latestRoadmapReport(phase);
  const pendingProposals = unresolvedRoadmapProposals(phase);
  const latestReportHasPendingManualReview =
    latestReport !== null &&
    pendingProposals.some(
      ({ proposal, report }) =>
        report.id === latestReport.id && proposal.policyOutcome === "manual-review",
    );
  const resumedStatus = notesAutomaticStatusAfterOverrideReset(phase);
  const lifecycle = notesLifecyclePresentation(phase);
  const resumedLifecycle = notesLifecyclePresentation({ ...phase, status: resumedStatus });
  const canPauseAutomation =
    phase.overrides.status === null && phase.status !== "done" && phase.status !== "cancelled";
  const canCancelRun =
    phase.session !== null &&
    (phase.status === "planning" ||
      phase.status === "waiting-for-approval" ||
      phase.status === "in-progress" ||
      phase.status === "review");
  const phaseStartDisabled =
    (effectiveAction === "Start" || effectiveAction === "Recover") &&
    startUnavailableReason !== null;

  useEffect(() => {
    if (phase.session) setRaceLink(null);
  }, [phase.session]);

  useEffect(() => {
    setPhaseDraft((current) => reconcilePhaseEditDraft(current, phase, editing));
  }, [editing, phase]);

  useEffect(() => {
    setReminderDraft((current) => reconcileReminderDraft(current, phase, reminderFallbackValue));
  }, [phase, reminderFallbackValue]);

  useEffect(() => {
    if (!pending && actionError) primaryActionRef.current?.focus();
  }, [pending, actionError]);

  const runPhaseAction = async (): Promise<void> => {
    if (controlsDisabled || phaseStartDisabled || effectiveAction === "Review") return;
    const reportActionError = (message: string): void => {
      setActionStatus("");
      setActionError(message);
    };
    setPending(true);
    onPendingChange(true);
    setActionError("");
    setActionStatus(
      effectiveAction === "Start"
        ? "Starting phase…"
        : effectiveAction === "Recover"
          ? "Recovering phase…"
          : "Resuming phase…",
    );
    try {
      if (effectiveAction === "Start") {
        const result = await onStartPhase(phase.id);
        if (result.status === "accepted") {
          setActionStatus("Phase started. Opening its planning session.");
          onActionSuccess();
          return;
        }
        if (result.status === "already-bound") {
          setRaceLink(result.session);
          reportActionError(
            "This phase was started in another window. Continue with the bound session instead.",
          );
        } else {
          reportActionError(result.message);
        }
      } else if (resumeLink) {
        try {
          await onResumePhase(phase.id, resumeLink);
        } catch (error) {
          const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
          reportActionError(`Couldn’t resume this phase.${detail}`);
          return;
        }

        if (phase.reminder) {
          try {
            const reminderResult = await onDismissReminder(phase.id, phase.reminder.occurrenceKey);
            if (reminderResult.status !== "committed") {
              reportActionError(reminderMutationResultMessage(reminderResult, "resume-cleanup"));
              return;
            }
          } catch (error) {
            const detail =
              error instanceof Error && error.message ? error.message : "Try dismissing it again.";
            reportActionError(
              `The phase resumed, but reminder cleanup did not complete. ${detail}`,
            );
            return;
          }
        }
        setActionStatus(
          resumeLink.sessionPath === null ? "Phase session recovered." : "Phase session resumed.",
        );
        onActionSuccess();
        return;
      } else {
        reportActionError("This phase has no resumable session. Reopen Notes and retry.");
      }
    } catch (error) {
      reportActionError(
        error instanceof Error ? error.message : "The phase action failed. Try again.",
      );
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  };

  const openReferenceSource = (sourceKey: string, canonicalUrl: string, label: string): void => {
    if (openingSourceKey !== null) return;
    setOpeningSourceKey(sourceKey);
    setActionError("");
    void openSource(canonicalUrl)
      .then(() => setActionStatus(`Opened source: ${label}`))
      .catch(() => {
        setActionError("Couldn’t open this source in the system browser. Try again.");
        setActionStatus("Source opener failed.");
      })
      .finally(() => setOpeningSourceKey(null));
  };

  const runRoadmapMutation = async (
    actionKey: string,
    operation: () => Promise<NotesRoadmapMutationResult>,
  ): Promise<void> => {
    if (controlsDisabled) return;
    setPendingRoadmapAction(actionKey);
    onPendingChange(true);
    setActionError("");
    setActionStatus("Saving Roadmap change…");
    try {
      const result = await operation();
      const message = roadmapMutationMessage(result);
      if (result.status === "failed" || result.status === "decision-conflict") {
        setActionError(message);
        setActionStatus("");
      } else {
        setActionStatus(message);
      }
    } catch (error) {
      setActionStatus("");
      setActionError(
        error instanceof Error ? error.message : "The Roadmap change failed. Try again.",
      );
    } finally {
      setPendingRoadmapAction(null);
      onPendingChange(false);
    }
  };

  const runCancellation = async (): Promise<void> => {
    if (cancellationDisabled) return;
    setPendingRoadmapAction("cancel-run");
    onPendingChange(true);
    setActionError("");
    setActionStatus("Cancelling the bound agent run…");
    try {
      const result = await onCancelPhase();
      if (result.status === "cancelled") {
        setActionStatus("Agent run stopped. Notes marked Cancelled.");
      } else {
        setActionStatus("");
        setActionError(result.message);
      }
    } catch (error) {
      setActionStatus("");
      setActionError(
        error instanceof Error ? error.message : "The agent run could not be cancelled.",
      );
    } finally {
      setPendingRoadmapAction(null);
      onPendingChange(false);
    }
  };

  const runReminderMutation = async (
    actionKey: string,
    operation: () => Promise<NotesReminderMutationResult>,
  ): Promise<void> => {
    if (controlsDisabled) return;
    setPendingRoadmapAction(actionKey);
    onPendingChange(true);
    setActionError("");
    setActionStatus("Saving reminder…");
    try {
      const result = await operation();
      const message = reminderMutationResultMessage(result);
      if (result.status === "committed") {
        setActionStatus(message);
        setCustomReminderError("");
      } else {
        setActionError(message);
        setActionStatus("");
      }
    } catch (error) {
      setActionStatus("");
      setActionError(
        error instanceof Error ? error.message : "The reminder change failed. Try again.",
      );
    } finally {
      setPendingRoadmapAction(null);
      onPendingChange(false);
    }
  };

  const scheduleReminder = (dueAt: Date): void => {
    if (effectiveReminderDraft.conflict) return;
    const note = effectiveReminderDraft.note.trim();
    const customValue = dateToLocalInputValue(dueAt);
    setReminderDraft({ ...effectiveReminderDraft, note, customValue });
    void runReminderMutation("schedule-reminder", () =>
      onScheduleReminder(phase.id, { dueAt: dueAt.toISOString(), note }),
    );
  };

  const submitCustomReminder = (): void => {
    if (effectiveReminderDraft.conflict) return;
    const dueAt = localDateTimeToIso(effectiveReminderDraft.customValue, new Date());
    if (!dueAt) {
      setCustomReminderError("Choose a valid future local date and time.");
      return;
    }
    const note = effectiveReminderDraft.note.trim();
    const customValue = dateToLocalInputValue(new Date(dueAt));
    setReminderDraft({ ...effectiveReminderDraft, note, customValue });
    setCustomReminderError("");
    void runReminderMutation("custom-reminder", () =>
      onScheduleReminder(phase.id, { dueAt, note }),
    );
  };

  const beginEdit = (): void => {
    setPhaseDraft(createPhaseEditDraft(phase));
    setActiveView("overview");
    setEditing(true);
  };

  const cancelEdit = (): void => setEditing(false);

  const saveEdit = (): void => {
    if (!effectivePhaseDraft.title.trim() || effectivePhaseDraft.conflict) return;
    onEditPhase(phase.id, {
      title: effectivePhaseDraft.title,
      goal: effectivePhaseDraft.goal,
      doneWhen: lines(effectivePhaseDraft.doneWhen),
    });
    setEditing(false);
  };

  const value: NotesPhaseDetailContextValue = {
    ...props,
    editing,
    activeView,
    setActiveView,
    phaseDraft: effectivePhaseDraft,
    reminderDraft: effectiveReminderDraft,
    reminderPresets,
    customReminderError,
    pending,
    pendingRoadmapAction,
    openingSourceKey,
    actionError,
    actionStatus,
    effectiveAction,
    effectiveActionLabel,
    controlsDisabled,
    cancellationDisabled,
    phaseStartDisabled,
    latestReport,
    pendingProposals,
    latestReportHasPendingManualReview,
    lifecycle,
    resumedLifecycle,
    canPauseAutomation,
    canCancelRun,
    primaryActionRef,
    runPhaseAction,
    beginEdit,
    cancelEdit,
    saveEdit,
    reloadPhaseDraft: () => setPhaseDraft(createPhaseEditDraft(phase)),
    updatePhaseDraft: (changes) => setPhaseDraft({ ...effectivePhaseDraft, ...changes }),
    updateReminderDraft: (changes) => setReminderDraft({ ...effectiveReminderDraft, ...changes }),
    clearCustomReminderError: () => setCustomReminderError(""),
    reloadReminderDraft: () => {
      setReminderDraft(createReminderDraft(phase, reminderFallbackValue));
      setCustomReminderError("");
    },
    scheduleReminder,
    submitCustomReminder,
    dismissReminder: () => {
      if (!phase.reminder) return;
      void runReminderMutation("dismiss-reminder", () =>
        onDismissReminder(phase.id, phase.reminder!.occurrenceKey),
      );
    },
    snoozeReminder: () => {
      if (!phase.reminder) return;
      void runReminderMutation("snooze-reminder", () =>
        onSnoozeReminder(
          phase.id,
          new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          phase.reminder!.occurrenceKey,
        ),
      );
    },
    openReferenceSource,
    runRoadmapMutation,
    acceptReferenceProposal: (proposalId) => {
      void runRoadmapMutation(`proposal:${proposalId}`, () =>
        onAcceptReferenceProposal(phase.id, proposalId),
      );
    },
    rejectReferenceProposal: (proposalId) => {
      void runRoadmapMutation(`proposal:${proposalId}`, () =>
        onRejectReferenceProposal(phase.id, proposalId),
      );
    },
    resumeAutomaticStatus: () => {
      void runRoadmapMutation("resume-status", () => onResumeAutomaticStatus(phase.id));
    },
    resumeAutomaticReferences: () => {
      void runRoadmapMutation("resume-references", () => onResumeAutomaticReferences(phase.id));
    },
    runCancellation,
  };

  return (
    <NotesPhaseDetailContext.Provider value={value}>{children}</NotesPhaseDetailContext.Provider>
  );
}

export function useNotesPhaseDetail(): NotesPhaseDetailContextValue {
  const context = useContext(NotesPhaseDetailContext);
  if (!context) {
    throw new Error("useNotesPhaseDetail must be used within NotesPhaseDetailProvider");
  }
  return context;
}

function createPhaseEditDraft(phase: NotesPhase): PhaseEditDraft {
  const doneWhen = phase.doneWhen.join("\n");
  return {
    baseUpdatedAt: phase.updatedAt,
    baseTitle: phase.title,
    baseGoal: phase.goal,
    baseDoneWhen: doneWhen,
    title: phase.title,
    goal: phase.goal,
    doneWhen,
    conflict: false,
  };
}

function reconcilePhaseEditDraft(
  current: PhaseEditDraft,
  phase: NotesPhase,
  editing: boolean,
): PhaseEditDraft {
  if (!editing) return createPhaseEditDraft(phase);
  const authoritativeDoneWhen = phase.doneWhen.join("\n");
  if (
    current.baseUpdatedAt === phase.updatedAt &&
    current.baseTitle === phase.title &&
    current.baseGoal === phase.goal &&
    current.baseDoneWhen === authoritativeDoneWhen
  ) {
    return current;
  }

  const titleDirty = current.title !== current.baseTitle;
  const goalDirty = current.goal !== current.baseGoal;
  const doneWhenDirty = current.doneWhen !== current.baseDoneWhen;
  const conflict =
    current.conflict ||
    (titleDirty && current.baseTitle !== phase.title && current.title !== phase.title) ||
    (goalDirty && current.baseGoal !== phase.goal && current.goal !== phase.goal) ||
    (doneWhenDirty &&
      current.baseDoneWhen !== authoritativeDoneWhen &&
      current.doneWhen !== authoritativeDoneWhen);

  return {
    baseUpdatedAt: phase.updatedAt,
    baseTitle: phase.title,
    baseGoal: phase.goal,
    baseDoneWhen: authoritativeDoneWhen,
    title: titleDirty ? current.title : phase.title,
    goal: goalDirty ? current.goal : phase.goal,
    doneWhen: doneWhenDirty ? current.doneWhen : authoritativeDoneWhen,
    conflict,
  };
}

function createReminderDraft(phase: NotesPhase, fallbackValue: string): ReminderDraft {
  const note = phase.reminder?.note ?? "";
  const customValue = phase.reminder
    ? dateToLocalInputValue(new Date(phase.reminder.dueAt))
    : fallbackValue;
  return {
    baseUpdatedAt: phase.updatedAt,
    baseOccurrenceKey: phase.reminder?.occurrenceKey ?? null,
    baseNote: note,
    baseCustomValue: customValue,
    note,
    customValue,
    conflict: false,
  };
}

function reconcileReminderDraft(
  current: ReminderDraft,
  phase: NotesPhase,
  fallbackValue: string,
): ReminderDraft {
  const occurrenceKey = phase.reminder?.occurrenceKey ?? null;
  const note = phase.reminder?.note ?? "";
  const customValue = phase.reminder
    ? dateToLocalInputValue(new Date(phase.reminder.dueAt))
    : current.baseOccurrenceKey === null
      ? current.baseCustomValue
      : fallbackValue;
  if (
    current.baseUpdatedAt === phase.updatedAt &&
    current.baseOccurrenceKey === occurrenceKey &&
    current.baseNote === note &&
    current.baseCustomValue === customValue
  ) {
    return current;
  }

  const noteDirty = current.note !== current.baseNote;
  const customValueDirty = current.customValue !== current.baseCustomValue;
  const occurrenceChanged = current.baseOccurrenceKey !== occurrenceKey;
  const conflict =
    current.conflict ||
    (noteDirty && (occurrenceChanged || current.baseNote !== note) && current.note !== note) ||
    (customValueDirty &&
      (occurrenceChanged || current.baseCustomValue !== customValue) &&
      current.customValue !== customValue);

  return {
    baseUpdatedAt: phase.updatedAt,
    baseOccurrenceKey: occurrenceKey,
    baseNote: note,
    baseCustomValue: customValue,
    note: noteDirty ? current.note : note,
    customValue: customValueDirty ? current.customValue : customValue,
    conflict,
  };
}
