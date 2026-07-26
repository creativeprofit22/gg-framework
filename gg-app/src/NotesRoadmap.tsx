import { useEffect, useRef, useState } from "react";
import { referenceRepositoryLabel, referenceSourceLabel } from "./notes-reference";
import type { NotesPhaseInput } from "./useProjectNotes";
import type {
  NotesPhase,
  NotesPhaseStatus,
  NotesReference,
  NotesReferenceOperationResult,
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
}: RoadmapProps): React.ReactElement {
  const visiblePhases = phases.filter((phase) => phase.archivedAt === null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [announcement, setAnnouncement] = useState("");
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
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(phase.title);
  const [goal, setGoal] = useState(phase.goal);
  const [doneWhen, setDoneWhen] = useState(phase.doneWhen.join("\n"));

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
          <button type="button" onClick={onClose}>
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
              onChange={(event) => setGoal(event.target.value)}
            />
          </div>
          <div className="notes-field">
            <label htmlFor={`notes-phase-edit-done-${phase.id}`}>Edit Done when</label>
            <textarea
              id={`notes-phase-edit-done-${phase.id}`}
              value={doneWhen}
              onChange={(event) => setDoneWhen(event.target.value)}
            />
          </div>
          <div className="notes-phase-form-actions">
            <button type="submit" disabled={!title.trim()}>
              Save changes
            </button>
            <button type="button" onClick={() => finishEdit(false)}>
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
        </div>
        {references.length === 0 ? (
          <div className="notes-phase-references-empty">
            <p>Create a structured reference before attaching source context.</p>
            <button type="button" onClick={onCreateReference}>
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

      <div className="notes-phase-controls">
        <div className="notes-field notes-phase-status-control">
          <label htmlFor={`notes-phase-status-${phase.id}`}>Status override</label>
          <select
            id={`notes-phase-status-${phase.id}`}
            value={phase.status}
            onChange={(event) => onChangePhaseStatus(event.target.value as NotesPhaseStatus)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="notes-phase-secondary-actions">
          <button
            type="button"
            disabled={position === 0}
            onClick={() => onMovePhase(phase.id, "up")}
          >
            Move up
          </button>
          <button
            type="button"
            disabled={position === phaseCount - 1}
            onClick={() => onMovePhase(phase.id, "down")}
          >
            Move down
          </button>
          {phase.status !== "cancelled" && (
            <button type="button" onClick={onCancelPhase}>
              Cancel phase
            </button>
          )}
          <button type="button" onClick={onArchivePhase}>
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

function primaryAction(phase: NotesPhase): "Start" | "Resume" | "Review" {
  if (
    phase.status === "review" ||
    phase.status === "needs-attention" ||
    phase.status === "done" ||
    phase.status === "cancelled"
  ) {
    return "Review";
  }
  if (phase.status !== "not-started" || phase.session !== null) return "Resume";
  return "Start";
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
