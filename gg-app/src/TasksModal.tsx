import { useEffect, useRef, useState } from "react";
import {
  isManuallyRunnableTaskStatus,
  isRunnableTaskStatus,
} from "@kenkaiiii/gg-core/project-task-contract";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { useTasksController } from "./useTasksController";
import type { ProjectTask } from "./agent";

/**
 * Task list modal. Mirrors the CLI's task pane: shows every project task with
 * its status, lets the user inspect a task's full prompt, run one task (fresh
 * session, end-to-end) or run all runnable tasks sequentially, and delete tasks
 * behind a confirmation. The agent loop streams progress back into the
 * transcript — this modal just kicks things off and reflects the live status
 * updates pushed via the `tasks_list` SSE event.
 *
 * Presentation only: eligibility comes from the `gg-core` predicates and all
 * interaction state (selection, pending action, confirmation) lives in
 * `useTasksController`.
 */
interface Props {
  tasks: readonly ProjectTask[];
  /** True while the session is busy, including Autopilot review — disables run actions. */
  running: boolean;
  onRun: (id: string) => Promise<void> | void;
  onRunAll: () => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onClose: () => void;
}

const UNKNOWN_STATUS_STYLE = { label: "unknown", color: theme.textMuted };
const STATUS_STYLE: Partial<Record<ProjectTask["status"], { label: string; color: string }>> = {
  pending: { label: "pending", color: theme.textMuted },
  "in-progress": { label: "running", color: theme.warning },
  done: { label: "done", color: theme.success },
  blocked: { label: "blocked", color: theme.textMuted },
};

/**
 * The run control does the same thing for every eligible status — a fresh
 * session, end to end — so only the wording changes, to say honestly whether
 * this is a first run, a retry after a block, or another pass over something
 * already in progress.
 */
function runLabel(status: ProjectTask["status"]): string {
  if (status === "blocked") return "Retry";
  if (status === "in-progress") return "Run again";
  return "Run";
}

/**
 * Presentation-only wording for why the last run ended blocked. The daemon
 * decides the reason; unknown reasons from a newer build render nothing.
 */
const OUTCOME_SENTENCE: Partial<Record<string, string>> = {
  "review-failed": "Last run stopped: Autopilot review did not clear the work.",
  "run-failed": "Last run stopped: the agent\u2019s turn ended with an error.",
  cancelled: "Last run stopped: it was cancelled.",
  "plan-mode":
    "Last run stopped: the session was in plan mode, so the task was not carried out. Leave plan mode before retrying.",
  "plan-checkpoint":
    "Last run stopped: a plan is waiting for your approval or revision, so the task was not finished. Resolve the plan before retrying.",
  "queued-messages":
    "Last run stopped: messages were queued during the run. Send or cancel them before retrying.",
};

function outcomeSentence(task: ProjectTask): string | null {
  const reason = task.lastOutcome?.reason;
  return reason === undefined ? null : (OUTCOME_SENTENCE[reason] ?? null);
}

function statusStyle(status: ProjectTask["status"]): { label: string; color: string } {
  return STATUS_STYLE[status] ?? UNKNOWN_STATUS_STYLE;
}

function statusGlyph(status: ProjectTask["status"]): string {
  if (status === "done") return "\u2713";
  if (status === "in-progress") return "\u23FA";
  return "\u25CB";
}

function formatCreatedAt(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function TasksModal({
  tasks,
  running,
  onRun,
  onRunAll,
  onDelete,
  onClose,
}: Props): React.ReactElement {
  const controller = useTasksController({ tasks, onRun, onRunAll, onDelete });
  const {
    selectedTask,
    confirmDeleteId,
    error,
    notice,
    focusRequest,
    isPending,
    pending,
    clearFocusRequest,
  } = controller;
  const [lastViewedId, setLastViewedId] = useState<string | null>(null);

  const titleRefs = useRef(new Map<string, HTMLButtonElement>());
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());
  const runAllRef = useRef<HTMLButtonElement | null>(null);
  const emptyRef = useRef<HTMLDivElement | null>(null);
  const keepTaskRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listScrollTop = useRef(0);

  // Move focus once the DOM reflects the new state: back to the row that opened
  // the detail panel, back to the delete trigger after Cancel, or on to a
  // surviving control after a successful removal.
  useEffect(() => {
    if (!focusRequest) return;
    const target =
      focusRequest.kind === "task"
        ? titleRefs.current.get(focusRequest.id)
        : focusRequest.kind === "delete-trigger"
          ? deleteRefs.current.get(focusRequest.id)
          : emptyRef.current;
    target?.focus();
    clearFocusRequest();
  }, [focusRequest, clearFocusRequest]);

  // Least-destructive control takes focus when the confirmation opens.
  useEffect(() => {
    if (confirmDeleteId !== null) keepTaskRef.current?.focus();
  }, [confirmDeleteId]);

  // Restore the list's scroll offset when returning from the detail panel.
  useEffect(() => {
    if (selectedTask === null && listRef.current) listRef.current.scrollTop = listScrollTop.current;
  }, [selectedTask]);

  const confirmingTask = tasks.find((task) => task.id === confirmDeleteId) ?? null;
  const confirmBusy = confirmDeleteId !== null && isPending("delete", confirmDeleteId);
  const runnable = tasks.filter((task) => isRunnableTaskStatus(task.status));
  const hasRunnable = runnable.length > 0;
  const actionsBlocked = pending !== null || confirmDeleteId !== null;

  const openDetail = (task: ProjectTask): void => {
    listScrollTop.current = listRef.current?.scrollTop ?? 0;
    setLastViewedId(task.id);
    controller.select(task.id);
  };

  function runButton(task: ProjectTask, wide: boolean): React.ReactElement | null {
    if (!isManuallyRunnableTaskStatus(task.status)) return null;
    const label = runLabel(task.status);
    const busy = isPending("run", task.id);
    return (
      <button
        className={`btn btn-sm ${wide ? "btn-primary" : "btn-ghost"} tasks-run-one`}
        type="button"
        disabled={running || actionsBlocked}
        aria-label={`${label}: ${task.title}`}
        title={`${label} this task in a fresh session`}
        onClick={() => controller.run(task.id)}
      >
        {busy ? "Starting…" : label}
      </button>
    );
  }

  function deleteButton(task: ProjectTask, wide: boolean): React.ReactElement {
    return (
      <button
        ref={(element) => {
          if (element) deleteRefs.current.set(task.id, element);
          else deleteRefs.current.delete(task.id);
        }}
        className={wide ? "btn btn-sm btn-ghost tasks-delete-wide" : "tasks-delete"}
        type="button"
        style={wide ? undefined : { color: theme.textDim }}
        disabled={actionsBlocked}
        aria-label={`Delete task: ${task.title}`}
        title={`Delete task: ${task.title}`}
        onClick={() => controller.requestDelete(task.id)}
      >
        {wide ? "Delete task" : "\u00d7"}
      </button>
    );
  }

  const confirmation = confirmingTask && (
    <div
      className="tasks-confirm"
      role="alertdialog"
      aria-labelledby="tasks-confirm-title"
      aria-describedby="tasks-confirm-message"
    >
      <h4 id="tasks-confirm-title">{`Delete \u201c${confirmingTask.title}\u201d?`}</h4>
      <p id="tasks-confirm-message" style={{ color: theme.textSecondary }}>
        This removes the task and its prompt from this project. It cannot be undone — there is no
        recovery for deleted tasks.
        {confirmingTask.status === "in-progress" &&
          " This task is running now, and deleting it does not stop the run in progress."}
      </p>
      {error !== null && (
        <p className="tasks-error" role="alert" style={{ color: theme.error }}>
          {error}
        </p>
      )}
      <div className="tasks-confirm-actions">
        <button
          ref={keepTaskRef}
          className="modal-btn"
          type="button"
          disabled={confirmBusy}
          onClick={controller.cancelDelete}
        >
          Keep task
        </button>
        <button
          className="modal-btn tasks-confirm-delete"
          type="button"
          disabled={confirmBusy}
          onClick={controller.confirmDelete}
        >
          {confirmBusy ? "Deleting…" : "Delete task"}
        </button>
      </div>
    </div>
  );

  if (tasks.length === 0) {
    return (
      <Modal title="Tasks" className="tasks-modal" onClose={onClose}>
        <div
          ref={emptyRef}
          className="tasks-empty"
          tabIndex={-1}
          style={{ color: theme.textMuted }}
        >
          No tasks yet. Ask the agent to add tasks, then run them here.
        </div>
        {notice !== null && (
          <p className="tasks-notice" role="status" style={{ color: theme.textSecondary }}>
            {notice}
          </p>
        )}
      </Modal>
    );
  }

  if (selectedTask) {
    const status = statusStyle(selectedTask.status);
    const created = formatCreatedAt(selectedTask.createdAt);
    const outcome = outcomeSentence(selectedTask);
    return (
      <Modal title="Tasks" className="tasks-modal" onClose={onClose}>
        <div className="tasks-detail">
          <button
            className="btn btn-sm btn-ghost tasks-back"
            type="button"
            onClick={controller.back}
          >
            {"\u2190 Back to tasks"}
          </button>
          <h3 className="tasks-detail-title" style={{ color: theme.text }}>
            {selectedTask.title}
          </h3>
          <div className="tasks-detail-meta">
            <span className="tasks-status" style={{ color: status.color }}>
              {status.label}
            </span>
            {created !== null && (
              <span style={{ color: theme.textMuted }}>{`Added ${created}`}</span>
            )}
          </div>
          {outcome !== null && (
            <div className="tasks-detail-meta" data-testid="tasks-last-outcome">
              <span style={{ color: theme.textMuted }}>{outcome}</span>
            </div>
          )}
          {(selectedTask.prompt ?? "").trim() === "" ? (
            // Legacy/hand-edited records can carry an empty or missing prompt; the runner
            // falls back to the title, so say that instead of showing an empty box.
            <p className="tasks-empty" style={{ color: theme.textMuted }}>
              This task has no separate prompt. Running it sends its title as the instruction.
            </p>
          ) : (
            <p className="tasks-detail-prompt" style={{ color: theme.textSecondary }}>
              {selectedTask.prompt}
            </p>
          )}
          {error !== null && confirmDeleteId === null && (
            <p className="tasks-error" role="alert" style={{ color: theme.error }}>
              {error}
            </p>
          )}
          {confirmation}
          <div className="tasks-actions">
            {deleteButton(selectedTask, true)}
            {runButton(selectedTask, true)}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Tasks" className="tasks-modal" onClose={onClose}>
      {notice !== null && (
        <p className="tasks-notice" role="status" style={{ color: theme.textSecondary }}>
          {notice}
        </p>
      )}
      <div className="tasks-list" ref={listRef}>
        {tasks.map((task) => {
          const status = statusStyle(task.status);
          const isDone = task.status === "done";
          return (
            <div
              className={`tasks-item${task.id === lastViewedId ? " is-viewed" : ""}`}
              key={task.id}
            >
              <span className="tasks-dot" style={{ color: status.color }} title={status.label}>
                {statusGlyph(task.status)}
              </span>
              <button
                ref={(element) => {
                  if (element) titleRefs.current.set(task.id, element);
                  else titleRefs.current.delete(task.id);
                }}
                className="tasks-title"
                type="button"
                aria-label={`Inspect task: ${task.title}`}
                aria-expanded={false}
                style={{ color: isDone ? theme.textMuted : theme.text }}
                onClick={() => openDetail(task)}
              >
                {task.title}
              </button>
              <span className="tasks-status" style={{ color: status.color }}>
                {status.label}
              </span>
              {runButton(task, false)}
              {deleteButton(task, false)}
            </div>
          );
        })}
      </div>
      {error !== null && confirmDeleteId === null && (
        <p className="tasks-error" role="alert" style={{ color: theme.error }}>
          {error}
        </p>
      )}
      {confirmation}
      <div className="tasks-actions">
        <button
          ref={runAllRef}
          className="btn btn-sm btn-primary"
          type="button"
          disabled={running || !hasRunnable || actionsBlocked}
          title={
            hasRunnable
              ? "Run all runnable tasks, one fresh session each"
              : "No runnable tasks to run"
          }
          onClick={controller.runAll}
        >
          {isPending("run-all", null) ? "Starting…" : `Run all (${runnable.length})`}
        </button>
      </div>
    </Modal>
  );
}
