import { useEffect, useRef, useState } from "react";
import { referenceRepositoryLabel, referenceSourceLabel } from "./notes-reference";
import type { NotesPhaseInput } from "./useProjectNotes";
import type {
  NotesPhase,
  NotesPhaseStatus,
  NotesReference,
  NotesReferenceOperationResult,
  NotesRoadmapEvent,
  NotesRoadmapMutationResult,
  NotesRoadmapReferenceProposal,
  NotesRoadmapStatusUpdate,
  NotesSessionLink,
  PhaseStartResult,
} from "./notes-types";

interface RoadmapProps {
  phases: NotesPhase[];
  references: NotesReference[];
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
  onResumeAutomaticStatus(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onResumeAutomaticReferences(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onStartPhase(phaseId: string): Promise<PhaseStartResult>;
  onResumePhase(phaseId: string, link: NotesSessionLink): Promise<void>;
  startUnavailableReason: string | null;
  actionDisabled: boolean;
  onActionSuccess(): void;
}

interface ArchiveProps {
  phases: NotesPhase[];
  onRestorePhase(id: string): void;
}

const STATUS_OPTIONS: ReadonlyArray<{ value: NotesPhaseStatus; label: string }> = [
  { value: "not-started", label: "Not started" },
  { value: "planning", label: "Planning" },
  { value: "waiting-for-approval", label: "Waiting for approval" },
  { value: "in-progress", label: "In progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
  { value: "needs-attention", label: "Needs attention" },
  { value: "cancelled", label: "Cancelled" },
];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function NotesRoadmap({
  phases,
  references,
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
  onResumeAutomaticStatus,
  onResumeAutomaticReferences,
  onStartPhase,
  onResumePhase,
  startUnavailableReason,
  actionDisabled,
  onActionSuccess,
}: RoadmapProps): React.ReactElement {
  const visiblePhases = phases.filter((phase) => phase.archivedAt === null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [pendingPhaseId, setPendingPhaseId] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const newPhaseButtonRef = useRef<HTMLButtonElement>(null);
  const phaseTitleRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedPhase = visiblePhases.find((phase) => phase.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId !== null && !selectedPhase) setSelectedId(null);
  }, [selectedId, selectedPhase]);

  useEffect(() => {
    if (showCreate) titleInputRef.current?.focus();
  }, [showCreate]);

  const focusAfterRender = (phaseId: string | null): void => {
    queueMicrotask(() => {
      const phaseTitle = phaseId ? phaseTitleRefs.current.get(phaseId) : undefined;
      if (phaseTitle) {
        phaseTitle.focus();
        return;
      }
      newPhaseButtonRef.current?.focus();
    });
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
              return (
                <li key={phase.id} className={`notes-roadmap-row${selected ? " is-selected" : ""}`}>
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
                    {phase.title}
                  </button>
                  <span className="notes-phase-status">{statusLabel(phase.status)}</span>
                  <span className="notes-phase-count">
                    {phase.referenceIds.length} {phase.referenceIds.length === 1 ? "ref" : "refs"}
                  </span>
                  <span className="notes-phase-reminder">
                    {phase.reminder
                      ? `Reminder ${formatDate(phase.reminder.dueAt)}`
                      : "No reminder"}
                  </span>
                  <button
                    type="button"
                    className="notes-roadmap-primary"
                    aria-label={`${action} phase: ${phase.title}`}
                    disabled={pendingPhaseId !== null}
                    onClick={() => selectPhase(phase.id)}
                  >
                    {action}
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        {selectedPhase && (
          <PhaseDetail
            key={selectedPhase.id}
            phase={selectedPhase}
            references={references}
            position={visiblePhases.findIndex((phase) => phase.id === selectedPhase.id)}
            phaseCount={visiblePhases.length}
            onClose={closeDetail}
            onEditPhase={(id, input) => {
              onEditPhase(id, input);
              setAnnouncement(`Updated phase: ${input.title.trim()}`);
            }}
            onMovePhase={(id, direction) => {
              onMovePhase(id, direction);
              setAnnouncement(`Moved ${selectedPhase.title} ${direction}`);
            }}
            onChangePhaseStatus={(status) => {
              onChangePhaseStatus(selectedPhase.id, status);
              setAnnouncement(`Changed ${selectedPhase.title} to ${statusLabel(status)}`);
            }}
            onArchivePhase={() => {
              const selectedIndex = visiblePhases.findIndex(
                (phase) => phase.id === selectedPhase.id,
              );
              const focusId =
                visiblePhases[selectedIndex + 1]?.id ??
                visiblePhases[selectedIndex - 1]?.id ??
                null;
              onArchivePhase(selectedPhase.id);
              setAnnouncement(`Archived phase: ${selectedPhase.title}`);
              setSelectedId(null);
              focusAfterRender(focusId);
            }}
            onCancelPhase={() => {
              onChangePhaseStatus(selectedPhase.id, "cancelled");
              setAnnouncement(`Cancelled phase: ${selectedPhase.title}`);
            }}
            onLinkReference={(referenceId) => {
              const reference = references.find((item) => item.id === referenceId);
              const referenceLabel = reference ? referenceSourceLabel(reference) : "reference";
              const phaseTitle = selectedPhase.title;
              void onLinkReferenceToPhase(referenceId, selectedPhase.id).then((result) => {
                setAnnouncement(
                  referenceLinkAnnouncement(result, "attach", referenceLabel, phaseTitle),
                );
              });
            }}
            onUnlinkReference={(referenceId) => {
              const reference = references.find((item) => item.id === referenceId);
              const referenceLabel = reference ? referenceSourceLabel(reference) : "reference";
              const phaseTitle = selectedPhase.title;
              void onUnlinkReferenceFromPhase(referenceId, selectedPhase.id).then((result) => {
                setAnnouncement(
                  referenceLinkAnnouncement(result, "detach", referenceLabel, phaseTitle),
                );
              });
            }}
            onCreateReference={onCreateReference}
            onAcceptReferenceProposal={onAcceptReferenceProposal}
            onRejectReferenceProposal={onRejectReferenceProposal}
            onResumeAutomaticStatus={onResumeAutomaticStatus}
            onResumeAutomaticReferences={onResumeAutomaticReferences}
            onStartPhase={onStartPhase}
            onResumePhase={onResumePhase}
            startUnavailableReason={startUnavailableReason}
            actionDisabled={actionDisabled}
            onPendingChange={(pending) => setPendingPhaseId(pending ? selectedPhase.id : null)}
            onActionSuccess={onActionSuccess}
          />
        )}
      </div>

      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function PhaseDetail({
  phase,
  references,
  position,
  phaseCount,
  onClose,
  onEditPhase,
  onMovePhase,
  onChangePhaseStatus,
  onArchivePhase,
  onCancelPhase,
  onLinkReference,
  onUnlinkReference,
  onCreateReference,
  onAcceptReferenceProposal,
  onRejectReferenceProposal,
  onResumeAutomaticStatus,
  onResumeAutomaticReferences,
  onStartPhase,
  onResumePhase,
  startUnavailableReason,
  actionDisabled,
  onPendingChange,
  onActionSuccess,
}: {
  phase: NotesPhase;
  references: NotesReference[];
  position: number;
  phaseCount: number;
  onClose(): void;
  onEditPhase(id: string, input: NotesPhaseInput): void;
  onMovePhase(id: string, direction: "up" | "down"): void;
  onChangePhaseStatus(status: NotesPhaseStatus): void;
  onArchivePhase(): void;
  onCancelPhase(): void;
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
  onResumeAutomaticStatus(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onResumeAutomaticReferences(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onStartPhase(phaseId: string): Promise<PhaseStartResult>;
  onResumePhase(phaseId: string, link: NotesSessionLink): Promise<void>;
  startUnavailableReason: string | null;
  actionDisabled: boolean;
  onPendingChange(pending: boolean): void;
  onActionSuccess(): void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(phase.title);
  const [goal, setGoal] = useState(phase.goal);
  const [doneWhen, setDoneWhen] = useState(phase.doneWhen.join("\n"));
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [raceLink, setRaceLink] = useState<NotesSessionLink | null>(null);
  const [pendingRoadmapAction, setPendingRoadmapAction] = useState<string | null>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const action = primaryAction(phase);
  const effectiveAction = raceLink ? sessionAction(raceLink) : action;
  const resumeLink = raceLink ?? phase.session;
  const controlsDisabled = actionDisabled || pending || pendingRoadmapAction !== null;
  const latestReport = latestRoadmapReport(phase);
  const pendingProposals = unresolvedRoadmapProposals(phase);
  const latestReportHasPendingManualReview =
    latestReport !== null &&
    pendingProposals.some(
      ({ proposal, report }) =>
        report.id === latestReport.id && proposal.policyOutcome === "manual-review",
    );
  const resumedStatus = latestProtectedStatus(phase);
  const phaseStartDisabled =
    (effectiveAction === "Start" || effectiveAction === "Recover") &&
    startUnavailableReason !== null;

  useEffect(() => {
    if (phase.session) setRaceLink(null);
  }, [phase.session]);

  useEffect(() => {
    if (!pending && actionError) actionButtonRef.current?.focus();
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
        await onResumePhase(phase.id, resumeLink);
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

  const finishEdit = (save: boolean): void => {
    if (save && title.trim()) onEditPhase(phase.id, { title, goal, doneWhen: lines(doneWhen) });
    setEditing(false);
  };

  return (
    <section className="notes-phase-detail" aria-labelledby={`notes-phase-detail-${phase.id}`}>
      <div className="notes-phase-detail-heading">
        <div>
          <p>Selected phase</p>
          <h3 id={`notes-phase-detail-${phase.id}`}>{phase.title}</h3>
        </div>
        <div className="notes-phase-detail-actions">
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => {
              if (editing) {
                finishEdit(false);
                return;
              }
              setTitle(phase.title);
              setGoal(phase.goal);
              setDoneWhen(phase.doneWhen.join("\n"));
              setEditing(true);
            }}
          >
            {editing ? "Close edit" : "Edit"}
          </button>
          <button type="button" disabled={controlsDisabled} onClick={onClose}>
            Back to roadmap
          </button>
        </div>
      </div>

      {editing ? (
        <form
          className="notes-phase-form notes-phase-edit"
          onSubmit={(event) => {
            event.preventDefault();
            finishEdit(true);
          }}
        >
          <div className="notes-field">
            <label htmlFor={`notes-phase-edit-title-${phase.id}`}>Edit phase title</label>
            <input
              id={`notes-phase-edit-title-${phase.id}`}
              value={title}
              autoFocus
              required
              disabled={controlsDisabled}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                finishEdit(false);
              }}
            />
          </div>
          <div className="notes-field">
            <label htmlFor={`notes-phase-edit-goal-${phase.id}`}>Edit goal</label>
            <textarea
              id={`notes-phase-edit-goal-${phase.id}`}
              value={goal}
              disabled={controlsDisabled}
              onChange={(event) => setGoal(event.target.value)}
            />
          </div>
          <div className="notes-field">
            <label htmlFor={`notes-phase-edit-done-${phase.id}`}>Edit Done when</label>
            <textarea
              id={`notes-phase-edit-done-${phase.id}`}
              value={doneWhen}
              disabled={controlsDisabled}
              onChange={(event) => setDoneWhen(event.target.value)}
            />
          </div>
          <div className="notes-phase-form-actions">
            <button type="submit" disabled={!title.trim() || controlsDisabled}>
              Save changes
            </button>
            <button type="button" disabled={controlsDisabled} onClick={() => finishEdit(false)}>
              Cancel edit
            </button>
          </div>
        </form>
      ) : (
        <>
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
                    <li key={`${phase.id}-criterion-${index}`}>{criterion}</li>
                  ))}
                </ul>
              ) : (
                <p>No completion criteria added.</p>
              )}
            </div>
          </div>

          {phase.sourcePrompt && (
            <section
              className="notes-phase-saved-prompt"
              aria-labelledby={`notes-phase-saved-prompt-${phase.id}`}
            >
              <h4 id={`notes-phase-saved-prompt-${phase.id}`}>Saved prompt</h4>
              <pre>{phase.sourcePrompt}</pre>
            </section>
          )}

          <dl className="notes-phase-metadata">
            <div>
              <dt>Status</dt>
              <dd>{statusLabel(phase.status)}</dd>
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
      )}

      <section
        className="notes-roadmap-latest"
        aria-labelledby={`notes-roadmap-latest-${phase.id}`}
      >
        <h4 id={`notes-roadmap-latest-${phase.id}`}>Latest report</h4>
        {latestReport ? (
          <div className="notes-roadmap-report">
            <p className="notes-roadmap-report-meta">
              <strong>{roadmapActorLabel(latestReport.actor)}</strong>{" "}
              <time dateTime={latestReport.timestamp}>
                {formatDateTime(latestReport.timestamp)}
              </time>
            </p>
            <p>{latestReport.progress}</p>
            {latestReport.blocker && (
              <p className="notes-roadmap-blocker">Blocker: {latestReport.blocker}</p>
            )}
            {latestReport.evidence.length > 0 && (
              <div>
                <h5>Evidence</h5>
                <ul>
                  {latestReport.evidence.map((item, index) => (
                    <li key={`${latestReport.id}-evidence-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {latestReport.statusOutcome === "manual-override" && (
              <p className="notes-roadmap-protected">
                Status was protected by the active manual override. The report remains in history.
              </p>
            )}
            {latestReport.statusOutcome === "done-terminal" && (
              <p className="notes-roadmap-protected">
                Done remained terminal, so this report did not change the phase status. The report
                was retained in history.
              </p>
            )}
            {latestReport.proposedReferences.some(
              (proposal) => proposal.policyOutcome === "reference-override-protected",
            ) && (
              <p className="notes-roadmap-protected">
                Suggested references stayed pending because manual reference links were active when
                this report was recorded.
              </p>
            )}
            {latestReportHasPendingManualReview && (
              <p>Suggested references are pending manual review.</p>
            )}
          </div>
        ) : (
          <p className="notes-roadmap-empty-report">No agent reports yet.</p>
        )}
      </section>

      {pendingProposals.length > 0 && (
        <section
          className="notes-roadmap-proposals"
          aria-labelledby={`notes-roadmap-proposals-${phase.id}`}
        >
          <h4 id={`notes-roadmap-proposals-${phase.id}`}>Suggested references</h4>
          <ul>
            {pendingProposals.map(({ proposal, report }) => {
              const proposalPending = pendingRoadmapAction === `proposal:${proposal.id}`;
              return (
                <li key={proposal.id}>
                  <div>
                    <strong>{roadmapProposalLabel(proposal)}</strong>
                    <small>
                      {proposal.owner}/{proposal.repo} · {roadmapActorLabel(report.actor)} ·{" "}
                      <time dateTime={report.timestamp}>{formatDateTime(report.timestamp)}</time>
                    </small>
                    <span>{proposal.canonicalUrl}</span>
                    <p>{proposal.relevance || "No relevance note."}</p>
                  </div>
                  <div className="notes-roadmap-proposal-actions">
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() =>
                        void runRoadmapMutation(`proposal:${proposal.id}`, () =>
                          onAcceptReferenceProposal(phase.id, proposal.id),
                        )
                      }
                    >
                      {proposalPending ? "Saving…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() =>
                        void runRoadmapMutation(`proposal:${proposal.id}`, () =>
                          onRejectReferenceProposal(phase.id, proposal.id),
                        )
                      }
                    >
                      Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section
        className="notes-phase-references"
        aria-labelledby={`notes-phase-references-${phase.id}`}
      >
        <div className="notes-phase-references-heading">
          <div>
            <h4 id={`notes-phase-references-${phase.id}`}>Attached references</h4>
            <p>
              {phase.referenceIds.length === 1
                ? "1 source attached"
                : `${phase.referenceIds.length} sources attached`}
            </p>
          </div>
          {phase.overrides.referenceIds && (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() =>
                void runRoadmapMutation("resume-references", () =>
                  onResumeAutomaticReferences(phase.id),
                )
              }
            >
              {pendingRoadmapAction === "resume-references"
                ? "Resuming…"
                : "Resume automatic references"}
            </button>
          )}
        </div>
        {references.length === 0 ? (
          <div className="notes-phase-references-empty">
            <p>Create a structured reference before attaching source context.</p>
            <button type="button" disabled={controlsDisabled} onClick={onCreateReference}>
              Create a reference
            </button>
          </div>
        ) : (
          <ul className="notes-phase-reference-options">
            {references.map((reference) => {
              const checked = phase.referenceIds.includes(reference.id);
              return (
                <li key={reference.id} className={checked ? "is-attached" : undefined}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={controlsDisabled}
                      onChange={(event) => {
                        if (event.target.checked) onLinkReference(reference.id);
                        else onUnlinkReference(reference.id);
                      }}
                    />
                    <span>
                      <strong>{referenceSourceLabel(reference)}</strong>
                      <small>{referenceRepositoryLabel(reference)}</small>
                      <span>{reference.relevance || "No relevance note."}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <details className="notes-roadmap-history">
        <summary>
          Activity history ({phase.lifecycleEvents.length + phase.roadmapEvents.length})
        </summary>
        {phase.lifecycleEvents.length + phase.roadmapEvents.length === 0 ? (
          <p>No activity recorded.</p>
        ) : (
          <ol>
            {activityHistory(phase).map((item) => (
              <li key={`${item.kind}-${item.event.id}`}>{renderActivityItem(item)}</li>
            ))}
          </ol>
        )}
      </details>

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
          {phase.status === "needs-attention" && phase.attentionReason && (
            <p className="notes-phase-attention">Needs attention: {phase.attentionReason}</p>
          )}
        </div>
        {effectiveAction !== "Review" && (
          <button
            ref={actionButtonRef}
            type="button"
            className="notes-roadmap-primary"
            disabled={controlsDisabled || phaseStartDisabled}
            title={phaseStartDisabled ? startUnavailableReason : undefined}
            onClick={() => void runPhaseAction()}
          >
            {pending
              ? effectiveAction === "Start"
                ? "Starting…"
                : effectiveAction === "Recover"
                  ? "Recovering…"
                  : "Resuming…"
              : effectiveAction === "Start"
                ? "Start phase"
                : effectiveAction === "Recover"
                  ? "Recover phase"
                  : "Resume phase"}
          </button>
        )}
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
      </section>

      <div className="notes-phase-controls">
        <div className="notes-field notes-phase-status-control">
          <label htmlFor={`notes-phase-status-${phase.id}`}>Status override</label>
          <select
            id={`notes-phase-status-${phase.id}`}
            value={phase.status}
            aria-describedby={`notes-phase-status-help-${phase.id}`}
            disabled={controlsDisabled}
            onChange={(event) => onChangePhaseStatus(event.target.value as NotesPhaseStatus)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p
            id={`notes-phase-status-help-${phase.id}`}
            className="notes-field-help notes-phase-status-help"
          >
            {phase.overrides.status
              ? `Automatic lifecycle updates are paused. Resuming will set status to ${statusLabel(resumedStatus)}.`
              : "Choosing a status pauses automatic lifecycle updates for this phase."}
          </p>
          {phase.overrides.status && (
            <button
              type="button"
              disabled={controlsDisabled}
              aria-describedby={`notes-phase-status-help-${phase.id}`}
              onClick={() =>
                void runRoadmapMutation("resume-status", () => onResumeAutomaticStatus(phase.id))
              }
            >
              {pendingRoadmapAction === "resume-status"
                ? "Resuming…"
                : `Resume automatic status: ${statusLabel(resumedStatus)}`}
            </button>
          )}
        </div>
        <div className="notes-phase-secondary-actions">
          <button
            type="button"
            disabled={controlsDisabled || position === 0}
            onClick={() => onMovePhase(phase.id, "up")}
          >
            Move up
          </button>
          <button
            type="button"
            disabled={controlsDisabled || position === phaseCount - 1}
            onClick={() => onMovePhase(phase.id, "down")}
          >
            Move down
          </button>
          {phase.status !== "cancelled" && (
            <button type="button" disabled={controlsDisabled} onClick={onCancelPhase}>
              Cancel phase
            </button>
          )}
          <button type="button" disabled={controlsDisabled} onClick={onArchivePhase}>
            Archive phase
          </button>
        </div>
      </div>
    </section>
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
          {archivedPhases.map((phase) => (
            <li key={phase.id}>
              <span>
                <strong>{phase.title}</strong>
                <small>{statusLabel(phase.status)}</small>
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
          ))}
        </ul>
      )}
      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function statusLabel(status: NotesPhaseStatus): string {
  return STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

function referenceLinkAnnouncement(
  result: NotesReferenceOperationResult,
  action: "attach" | "detach",
  referenceLabel: string,
  phaseTitle: string,
): string {
  if (result.status === "committed" || result.status === "reused") {
    return action === "attach"
      ? `Attached ${referenceLabel} to ${phaseTitle}`
      : `Detached ${referenceLabel} from ${phaseTitle}`;
  }
  if (result.status === "missing-reference") {
    return `Couldn’t ${action}: the reference was removed in another window.`;
  }
  if (result.status === "missing-phase") {
    return `Couldn’t ${action}: the phase was removed in another window.`;
  }
  if (result.status === "failed" && result.reason === "invalid") {
    return `Couldn’t ${action}: Project Notes rejected the change. Review the reference and try again.`;
  }
  if (result.status === "failed" && result.reason === "corrupt") {
    return `Couldn’t ${action}: Project Notes are unreadable. Repair or restore project storage first.`;
  }
  if (result.status === "failed" && result.reason === "missing") {
    return `Couldn’t ${action}: project Notes storage is missing. Reopen the project and try again.`;
  }
  return `Couldn’t ${action} the reference. Check Notes storage and try again.`;
}

type PhasePrimaryAction = "Start" | "Resume" | "Recover" | "Review";

function sessionAction(session: NotesSessionLink): "Resume" | "Recover" {
  return session.sessionPath === null ? "Recover" : "Resume";
}

function primaryAction(phase: NotesPhase): PhasePrimaryAction {
  if (phase.status === "review" || phase.status === "done") return "Review";
  if (phase.status === "cancelled") {
    if (phase.overrides.status !== null) return "Review";
    return phase.session ? sessionAction(phase.session) : "Start";
  }
  if (phase.status === "needs-attention") {
    return phase.session ? sessionAction(phase.session) : "Start";
  }
  if (phase.status !== "not-started" || phase.session !== null) {
    return phase.session ? sessionAction(phase.session) : "Resume";
  }
  return "Start";
}

function latestRoadmapReport(phase: NotesPhase): NotesRoadmapStatusUpdate | null {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (event?.type === "status-update") return event;
  }
  return null;
}

function unresolvedRoadmapProposals(
  phase: NotesPhase,
): Array<{ proposal: NotesRoadmapReferenceProposal; report: NotesRoadmapStatusUpdate }> {
  const decided = new Set(
    phase.roadmapEvents
      .filter((event) => event.type === "reference-decision")
      .map((event) => event.proposalId),
  );
  const pending: Array<{
    proposal: NotesRoadmapReferenceProposal;
    report: NotesRoadmapStatusUpdate;
  }> = [];
  for (const event of phase.roadmapEvents) {
    if (event.type !== "status-update") continue;
    for (const proposal of event.proposedReferences) {
      if (proposal.disposition === "pending" && !decided.has(proposal.id)) {
        pending.push({ proposal, report: event });
      }
    }
  }
  return pending;
}

function latestProtectedStatus(phase: NotesPhase): NotesPhaseStatus {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (
      event?.type === "status-update" &&
      (event.statusOutcome === "manual-override" || event.statusOutcome === "done-terminal")
    ) {
      if (phase.status === "done") return "done";
      if (event.transition === "pending") return "planning";
      if (event.transition === "in-progress") return "in-progress";
      if (event.transition === "blocked") return "needs-attention";
      return "review";
    }
  }
  return phase.status;
}

function roadmapActorLabel(actor: NotesRoadmapStatusUpdate["actor"]): string {
  if (actor === "gg-coder") return "GG Coder";
  if (actor === "ken-autopilot") return "Autopilot Ken";
  return "Ken";
}

function roadmapProposalLabel(proposal: NotesRoadmapReferenceProposal): string {
  if (proposal.pullRequest !== null) return `Pull request #${proposal.pullRequest}`;
  if (proposal.issue !== null) return `Issue #${proposal.issue}`;
  if (proposal.path && proposal.range) {
    return `${proposal.path}:L${proposal.range.startLine}-L${proposal.range.endLine}`;
  }
  return proposal.path ?? proposal.revision ?? proposal.tool ?? proposal.provider;
}

type ActivityItem =
  | { kind: "lifecycle"; event: NotesPhase["lifecycleEvents"][number] }
  | { kind: "roadmap"; event: NotesRoadmapEvent };

function activityHistory(phase: NotesPhase): ActivityItem[] {
  return [
    ...phase.lifecycleEvents.map((event): ActivityItem => ({ kind: "lifecycle", event })),
    ...phase.roadmapEvents.map((event): ActivityItem => ({ kind: "roadmap", event })),
  ].sort((left, right) => Date.parse(right.event.timestamp) - Date.parse(left.event.timestamp));
}

function renderActivityItem(item: ActivityItem): React.ReactNode {
  const timestamp = (
    <time dateTime={item.event.timestamp}>{formatDateTime(item.event.timestamp)}</time>
  );
  if (item.kind === "lifecycle") {
    return (
      <>
        <strong>{item.event.source === "user" ? "User" : item.event.source}</strong> {timestamp}
        <p>
          {statusLabel(item.event.fromStatus ?? "not-started")} to{" "}
          {statusLabel(item.event.toStatus)}
          {item.event.reason ? `: ${item.event.reason}` : ""}
        </p>
      </>
    );
  }
  const event = item.event;
  if (event.type === "status-update") {
    return (
      <>
        <strong>{roadmapActorLabel(event.actor)}</strong> {timestamp}
        <p>
          {event.progress} Status outcome: {event.statusOutcome}.
        </p>
        {event.blocker && <p>Blocker: {event.blocker}</p>}
        {event.evidence.length > 0 && (
          <ul>
            {event.evidence.map((evidence, index) => (
              <li key={`${event.id}-history-evidence-${index}`}>{evidence}</li>
            ))}
          </ul>
        )}
      </>
    );
  }
  if (event.type === "reference-decision") {
    return (
      <>
        <strong>User</strong> {timestamp}
        <p>Reference proposal {event.decision}.</p>
      </>
    );
  }
  return (
    <>
      <strong>User</strong> {timestamp}
      <p>Automatic {event.field} updates resumed.</p>
    </>
  );
}

function roadmapMutationMessage(result: NotesRoadmapMutationResult): string {
  if (result.status === "committed") return "Roadmap change saved.";
  if (result.status === "already-decided") return `Proposal was already ${result.decision}.`;
  if (result.status === "decision-conflict") {
    return `Proposal was already ${result.decision} in another window.`;
  }
  if (result.status === "missing-proposal") {
    return "The proposal is no longer pending. Review the latest activity and try again.";
  }
  if (result.status === "missing-phase" || result.status === "archived-phase") {
    return "The phase is no longer available. Return to the Roadmap and choose an active phase.";
  }
  if (result.status === "no-protected-update") return "No protected status report is available.";
  return "The Roadmap change could not be saved. Check Notes storage and try again.";
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}
