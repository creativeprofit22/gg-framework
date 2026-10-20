import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RoadmapPhasePlacement } from "@kenkaiiii/gg-core/roadmap-workflow";
import { Modal } from "./Modal";
import { NotesDisclosure } from "./NotesDisclosure";
import { notesModalDescription } from "./NotesModalHeader";
import { NotesTabList } from "./NotesTabList";
import { usePhaseDeletion, type PhaseDeletionBridge } from "./notes-roadmap/usePhaseDeletion";
import { NotesPhaseDeletionDialog } from "./notes-roadmap/NotesPhaseDeletionDialog";
import { NotesDeletedPhases } from "./notes-roadmap/NotesDeletedPhases";
import { NotesCurrentFocus } from "./NotesCurrentFocus";
import { NotesHandoff } from "./NotesHandoff";
import { NotesReferences } from "./NotesReferences";
import type { SlashCommand } from "./agent";
import { NotesRoadmap, NotesRoadmapArchive } from "./NotesRoadmap";
import { NotesTaskList } from "./NotesTaskList";
import type { NotesReferenceInput } from "./notes-reference";
import { activePhaseCountLabel } from "./notes-status";
import type { OpenReferenceUrl } from "./notes-open-source";
import type { NotesPhaseInput } from "./useProjectNotes";
import type {
  NotesPhase,
  NotesPhaseStatus,
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
  ProjectNotesStorageDiagnostics,
  PhaseRunCancellationResult,
  NotesTask,
  PhaseStartResult,
} from "./notes-types";

type NotesTab = "overview" | "roadmap" | "reference" | "archive";

const NOTES_TABS: ReadonlyArray<{ id: NotesTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "roadmap", label: "Roadmap" },
  { id: "reference", label: "Reference" },
  { id: "archive", label: "Archive" },
];

interface Props {
  phaseDeletionBridge?: PhaseDeletionBridge;
  /** Project folder shown in the modal header; null when no project is open. */
  projectPath: string | null;
  value: string;
  onChange(value: string): void;
  currentFocus: string;
  tasks: NotesTask[];
  phases: NotesPhase[];
  references: NotesReference[];
  handoff: string;
  handoffUpdatedAt: string | null;
  handoffUnread: boolean;
  activePhaseCount: number;
  activeReminderCount: number;
  authorityReady: boolean;
  expectedRevision: number | null;
  expectedProjectKey: string | null;
  initialRoadmapPhaseId?: string | null;
  /** Increments when a new navigation request targets `initialRoadmapPhaseId`. */
  roadmapPhaseRequest?: number;
  persistenceStatus: React.ReactNode;
  onChangeCurrentFocus(value: string): void;
  onCreateTask(text: string): void;
  onEditTask(id: string, text: string): void;
  onToggleTask(id: string): void;
  onMoveTask(id: string, direction: "up" | "down"): void;
  onArchiveTask(id: string): void;
  onRestoreTask(id: string): void;
  onCreatePhase(input: NotesPhaseInput): void;
  onEditPhase(id: string, input: NotesPhaseInput): void;
  onMovePhase(id: string, direction: "up" | "down"): void;
  onReorderPhase?(id: string, placement: RoadmapPhasePlacement): void;
  onChangePhaseStatus(id: string, status: NotesPhaseStatus): void;
  onSetPhaseStatusOverride(
    id: string,
    status: NotesPhaseStatus,
  ): Promise<NotesRoadmapMutationResult>;
  onArchivePhase(id: string): void;
  onRestorePhase(id: string): void;
  onCreateReference(
    input: NotesReferenceInput,
    phaseIds: readonly string[],
  ): Promise<NotesReferenceOperationResult>;
  onEditReference(id: string, input: NotesReferenceInput): Promise<NotesReferenceOperationResult>;
  onDeleteReference(id: string): Promise<NotesReferenceOperationResult>;
  onLinkReferenceToPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
  onUnlinkReferenceFromPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
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
  openSource?: OpenReferenceUrl;
  onStartPhase(phaseId: string): Promise<PhaseStartResult>;
  onGetStorageDiagnostics(): Promise<ProjectNotesStorageDiagnostics>;
  onRebindPhase(request: PhaseBindingRequest): Promise<PhaseBindingOutcome>;
  onMutatePhaseLease(request: PhaseLeaseRequestV2): Promise<PhaseLeaseOutcome>;
  onReconcilePhaseExecution(
    request: PhaseExecutionReconciliationRequestV3,
  ): Promise<PhaseExecutionReconciliationOutcome>;
  onStartNextPhase(checkpointId: string, nextPhaseId: string): Promise<PhaseStartResult>;
  commands: SlashCommand[];
  onRunCommand(invocation: string): void;
  onCancelPhase(phaseId: string): Promise<PhaseRunCancellationResult>;
  onResumePhase(phaseId: string, link: NotesSessionLink): Promise<void>;
  phaseStartUnavailableReason: string | null;
  phaseActionDisabled: boolean;
  onPhaseActionSuccess(): void;
  onReconciliationSuccess(): void;
  onChangeHandoff(text: string): void;
  onHandoffPresented(text: string, updatedAt: string): void;
  onClose(): void;
}

function activeCountLabel(count: number, noun: string): string {
  return `active ${noun}${count === 1 ? "" : "s"}`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${activeCountLabel(count, noun)}`;
}

export function NotesModal(props: Props): React.ReactElement {
  return (
    <Modal
      title="Your notes"
      description={notesModalDescription(props.projectPath, props.phases)}
      onClose={props.onClose}
      className="notes-modal"
    >
      <NotesModalContent {...props} />
    </Modal>
  );
}

/** The editor is deferred; its modal shell and focus containment stay synchronous. */
export function NotesModalContent({
  phaseDeletionBridge,
  value,
  onChange,
  currentFocus,
  tasks,
  phases,
  references,
  handoff,
  handoffUpdatedAt,
  handoffUnread,
  activePhaseCount,
  activeReminderCount,
  authorityReady,
  expectedRevision,
  expectedProjectKey,
  initialRoadmapPhaseId = null,
  roadmapPhaseRequest = 0,
  persistenceStatus,
  onChangeCurrentFocus,
  onCreateTask,
  onEditTask,
  onToggleTask,
  onMoveTask,
  onArchiveTask,
  onRestoreTask,
  onCreatePhase,
  onEditPhase,
  onMovePhase,
  onReorderPhase,
  onChangePhaseStatus,
  onSetPhaseStatusOverride,
  onArchivePhase,
  onRestorePhase,
  onCreateReference,
  onEditReference,
  onDeleteReference,
  onLinkReferenceToPhase,
  onUnlinkReferenceFromPhase,
  onAcceptReferenceProposal,
  onRejectReferenceProposal,
  onResolveRoadmapBlocker,
  onResumeAutomaticStatus,
  onResumeAutomaticReferences,
  onScheduleReminder,
  onSnoozeReminder,
  onDismissReminder,
  openSource,
  onStartPhase,
  onGetStorageDiagnostics,
  onRebindPhase,
  onMutatePhaseLease,
  onReconcilePhaseExecution,
  onStartNextPhase,
  commands,
  onRunCommand,
  onCancelPhase,
  onResumePhase,
  phaseStartUnavailableReason,
  phaseActionDisabled,
  onPhaseActionSuccess,
  onReconciliationSuccess,
  onChangeHandoff,
  onHandoffPresented,
}: Props): React.ReactElement {
  // Set by whichever surface asked for this deletion, so an intentional delete can retire
  // its own selection instead of being reported as an unexplained disappearance. Every
  // request replaces it, and a commit consumes it.
  const deletionCommitted = useRef<(() => void) | null>(null);
  const deletion = usePhaseDeletion(expectedProjectKey, phaseDeletionBridge, () => {
    const handler = deletionCommitted.current;
    deletionCommitted.current = null;
    handler?.();
  });
  const deletePhase = (id: string, onDeleted?: () => void) => {
    const phase = phases.find((p) => p.id === id);
    if (!phase) return;
    deletionCommitted.current = onDeleted ?? null;
    void deletion.begin(phase, "delete");
  };
  const currentFocusInputRef = useRef<HTMLTextAreaElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Record<NotesTab, HTMLButtonElement | null>>({
    overview: null,
    roadmap: null,
    reference: null,
    archive: null,
  });
  const [activeTab, setActiveTab] = useState<NotesTab>(
    initialRoadmapPhaseId ? "roadmap" : "overview",
  );
  const handledRoadmapRequest = useRef(roadmapPhaseRequest);
  useLayoutEffect(() => {
    // A request that arrives while the modal is already open is navigation, not a
    // mount-time default, so the Roadmap tab has to become active here too.
    if (roadmapPhaseRequest !== handledRoadmapRequest.current) {
      handledRoadmapRequest.current = roadmapPhaseRequest;
      if (initialRoadmapPhaseId) setActiveTab("roadmap");
    }
    const tab = tabRefs.current[initialRoadmapPhaseId ? "roadmap" : "overview"];
    const dialog = tab?.closest("[role='dialog']");
    // Restore the existing initial-tab focus after loading, without stealing it
    // from another dialog that may have opened in the meantime.
    if (dialog?.contains(document.activeElement)) tab?.focus();
  }, [initialRoadmapPhaseId, roadmapPhaseRequest]);

  const [showArchived, setShowArchived] = useState(false);
  const [referenceCreateRequest, setReferenceCreateRequest] = useState(0);
  const archivedTasks = tasks.filter((task) => task.archivedAt !== null);
  const hasRoadmapSummary = activePhaseCount > 0 || activeReminderCount > 0;

  const selectTab = useCallback((tab: NotesTab, focus = false): void => {
    setActiveTab(tab);
    if (focus) tabRefs.current[tab]?.focus();
  }, []);

  const notesTabs = NOTES_TABS.map((tab) =>
    tab.id === "roadmap" && activePhaseCount > 0
      ? {
          ...tab,
          adornment: (
            <span
              className="notes-tab-count"
              aria-hidden="true"
              title={activePhaseCountLabel(activePhaseCount)}
            >
              {activePhaseCount}
            </span>
          ),
        }
      : tab,
  );

  return (
    <div className="notes-shell">
      <NotesPhaseDeletionDialog controller={deletion} />
      {deletion.success && (
        <div className="notes-phase-deletion-feedback">
          <p role="status">{deletion.success.message}</p>
          {deletion.success.deletionId && (
            <button
              type="button"
              className="notes-roadmap-new"
              onClick={() => void deletion.undo()}
            >
              Undo
            </button>
          )}
          <button type="button" className="notes-roadmap-new" onClick={deletion.clearSuccess}>
            Dismiss message
          </button>
        </div>
      )}
      <div className="notes-shell-status">{persistenceStatus}</div>
      <NotesTabList<NotesTab>
        label="Notes sections"
        tabs={notesTabs}
        activeId={activeTab}
        onSelect={setActiveTab}
        tabId={(id) => `notes-tab-${id}`}
        panelId={(id) => `notes-panel-${id}`}
        className="notes-tabs"
        scrollClassName="notes-tabs-scroll"
        tabRefs={tabRefs}
      />

      <div className="notes-panels">
        <div
          id="notes-panel-overview"
          className="notes-panel"
          role="tabpanel"
          aria-labelledby="notes-tab-overview"
          hidden={activeTab !== "overview"}
        >
          <div className="notes-panel-rail">
            {hasRoadmapSummary && (
              <aside className="notes-roadmap-summary" aria-label="Roadmap summary">
                <strong>Roadmap</strong>
                {activePhaseCount > 0 && <span>{activePhaseCountLabel(activePhaseCount)}</span>}
                {activeReminderCount > 0 && (
                  <span>{countLabel(activeReminderCount, "reminder")}</span>
                )}
              </aside>
            )}

            <section className="notes-section" aria-labelledby="notes-now-heading">
              <h2 id="notes-now-heading">Now</h2>
              <NotesCurrentFocus
                value={currentFocus}
                inputRef={currentFocusInputRef}
                onChange={onChangeCurrentFocus}
              />
            </section>

            <section className="notes-section" aria-labelledby="notes-next-heading">
              <h2 id="notes-next-heading">Next</h2>
              <NotesTaskList
                tasks={tasks}
                addInputRef={addInputRef}
                onCreateTask={onCreateTask}
                onEditTask={onEditTask}
                onToggleTask={onToggleTask}
                onMoveTask={onMoveTask}
                onArchiveTask={onArchiveTask}
                disclosureKey={expectedProjectKey}
              />
            </section>

            <section className="notes-section" aria-labelledby="notes-handoff-heading">
              <h2 id="notes-handoff-heading">Handoff</h2>
              <NotesHandoff
                value={handoff}
                updatedAt={handoffUpdatedAt}
                unread={handoffUnread}
                visible={activeTab === "overview"}
                onChange={onChangeHandoff}
                onPresented={onHandoffPresented}
              />
            </section>
          </div>
        </div>

        <div
          id="notes-panel-roadmap"
          className="notes-panel"
          role="tabpanel"
          aria-labelledby="notes-tab-roadmap"
          hidden={activeTab !== "roadmap"}
        >
          <div className="notes-panel-rail notes-roadmap-rail">
            <section
              className="notes-section notes-roadmap-section"
              aria-labelledby="notes-roadmap-heading"
            >
              <NotesRoadmap
                phases={phases}
                references={references}
                authorityReady={authorityReady}
                expectedRevision={expectedRevision}
                expectedProjectKey={expectedProjectKey}
                initialSelectedPhaseId={initialRoadmapPhaseId}
                selectedPhaseRequest={roadmapPhaseRequest}
                openSource={openSource}
                onCreatePhase={onCreatePhase}
                onEditPhase={onEditPhase}
                onMovePhase={onMovePhase}
                onReorderPhase={onReorderPhase}
                onChangePhaseStatus={onChangePhaseStatus}
                onSetPhaseStatusOverride={onSetPhaseStatusOverride}
                onArchivePhase={onArchivePhase}
                onDeletePhase={deletePhase}
                onLinkReferenceToPhase={onLinkReferenceToPhase}
                onUnlinkReferenceFromPhase={onUnlinkReferenceFromPhase}
                onAcceptReferenceProposal={onAcceptReferenceProposal}
                onRejectReferenceProposal={onRejectReferenceProposal}
                onResolveRoadmapBlocker={onResolveRoadmapBlocker}
                onResumeAutomaticStatus={onResumeAutomaticStatus}
                onResumeAutomaticReferences={onResumeAutomaticReferences}
                onScheduleReminder={onScheduleReminder}
                onSnoozeReminder={onSnoozeReminder}
                onDismissReminder={onDismissReminder}
                onStartPhase={onStartPhase}
                onGetStorageDiagnostics={onGetStorageDiagnostics}
                onRebindPhase={onRebindPhase}
                onMutatePhaseLease={onMutatePhaseLease}
                onReconcilePhaseExecution={onReconcilePhaseExecution}
                onStartNextPhase={onStartNextPhase}
                commands={commands}
                onRunCommand={onRunCommand}
                onCancelPhase={onCancelPhase}
                onResumePhase={onResumePhase}
                startUnavailableReason={phaseStartUnavailableReason}
                actionDisabled={phaseActionDisabled}
                onActionSuccess={onPhaseActionSuccess}
                onReconciliationSuccess={onReconciliationSuccess}
                onCreateReference={() => {
                  selectTab("reference");
                  setReferenceCreateRequest((request) => request + 1);
                }}
              />
            </section>
          </div>
        </div>

        <div
          id="notes-panel-reference"
          className="notes-panel"
          role="tabpanel"
          aria-labelledby="notes-tab-reference"
          hidden={activeTab !== "reference"}
        >
          <div className="notes-panel-rail">
            <section
              className="notes-section notes-reference-section"
              aria-labelledby="notes-reference-heading"
            >
              <h2 id="notes-reference-heading">Reference</h2>
              <div className="notes-field">
                <label htmlFor="notes-reference">Reference notes</label>
                <textarea
                  id="notes-reference"
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  spellCheck={true}
                />
              </div>
              <NotesReferences
                references={references}
                phases={phases}
                onCreateReference={onCreateReference}
                onEditReference={onEditReference}
                onDeleteReference={onDeleteReference}
                onLinkReferenceToPhase={onLinkReferenceToPhase}
                onUnlinkReferenceFromPhase={onUnlinkReferenceFromPhase}
                openSource={openSource}
                createRequest={referenceCreateRequest}
              />
            </section>
          </div>
        </div>

        <div
          id="notes-panel-archive"
          className="notes-panel"
          role="tabpanel"
          aria-labelledby="notes-tab-archive"
          hidden={activeTab !== "archive"}
        >
          <div className="notes-panel-rail">
            <section
              className="notes-section notes-archive"
              aria-labelledby="notes-archive-heading"
            >
              <h2 id="notes-archive-heading">Archive</h2>
              <p className="notes-archive-intro">
                Archive holds phases and tasks you put away by hand. Finished work stays under
                Completed in Roadmap and Overview until you archive it.
              </p>
              <NotesRoadmapArchive
                phases={phases}
                onRestorePhase={onRestorePhase}
                onDeletePhase={deletePhase}
              />
              <NotesDeletedPhases
                phases={phases}
                onRecover={(phase) => void deletion.begin(phase, "recover")}
                disabled={deletion.pending}
              />
              <h3 className="notes-archive-task-heading">Notes tasks</h3>
              {archivedTasks.length === 0 ? (
                <p className="notes-empty">No archived tasks.</p>
              ) : (
                <NotesDisclosure
                  id="notes-archive-list"
                  regionClassName="notes-task-list"
                  label={`${showArchived ? "Hide" : "Show"} archived tasks (${archivedTasks.length})`}
                  expanded={showArchived}
                  onToggle={() => setShowArchived((visible) => !visible)}
                >
                  {showArchived && (
                    <>
                      {archivedTasks.map((task) => (
                        <div className="notes-task-row notes-archived-task" key={task.id}>
                          <span>{task.text}</span>
                          <div className="notes-task-actions">
                            <button
                              type="button"
                              className="notes-btn-quiet"
                              aria-label={`Restore task: ${task.text}`}
                              onClick={() => onRestoreTask(task.id)}
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </NotesDisclosure>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
