import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectTask } from "./agent";

/**
 * Interaction state for the Tasks modal: which task is being inspected, which
 * action is in flight, whether a deletion is awaiting confirmation, and where
 * focus should land next.
 *
 * Deliberately owns no task policy. Eligibility stays in the `gg-core`
 * predicates (`isRunnableTaskStatus` / `isManuallyRunnableTaskStatus`) and the
 * lifecycle stays in the sidecar; this hook only stops the UI from dispatching
 * the same action twice and keeps feedback attached to the right task.
 */
export type TaskActionKind = "run" | "run-all" | "delete";

export type TasksPendingAction =
  { kind: "run" | "delete"; id: string } | { kind: "run-all"; id: null };

/** Where focus should move once the DOM reflects the latest state. */
export type TasksFocusRequest =
  { kind: "task"; id: string } | { kind: "delete-trigger"; id: string } | { kind: "empty" };

interface Options {
  tasks: readonly ProjectTask[];
  onRun: (id: string) => Promise<void> | void;
  onRunAll: () => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}

export interface TasksController {
  selectedTask: ProjectTask | null;
  pending: TasksPendingAction | null;
  confirmDeleteId: string | null;
  /** Inline failure message for the most recent action, or null. */
  error: string | null;
  /** Inline notice when the inspected task disappeared from the list. */
  notice: string | null;
  focusRequest: TasksFocusRequest | null;
  isPending: (kind: TaskActionKind, id: string | null) => boolean;
  select: (id: string) => void;
  back: () => void;
  dismissNotice: () => void;
  run: (id: string) => void;
  runAll: () => void;
  requestDelete: (id: string) => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
  clearFocusRequest: () => void;
}

export function taskActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim().length > 0 ? message.trim() : "The action failed. Try again.";
}

export function useTasksController({ tasks, onRun, onRunAll, onDelete }: Options): TasksController {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<TasksPendingAction | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<TasksFocusRequest | null>(null);
  // Actions resolve after an await; a stale resolution must not re-open state
  // for a task the user has already navigated away from.
  const pendingRef = useRef<TasksPendingAction | null>(null);

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;

  // The list is pushed by `tasks_list` SSE updates, so the inspected or
  // confirmed task can vanish underneath the user. Fall back to the list with a
  // short explanation rather than a blank panel or a confirmation that would
  // delete nothing.
  useEffect(() => {
    if (selectedId !== null && !tasks.some((task) => task.id === selectedId)) {
      setSelectedId(null);
      setConfirmDeleteId(null);
      setNotice("That task is no longer in the list.");
    } else if (confirmDeleteId !== null && !tasks.some((task) => task.id === confirmDeleteId)) {
      setConfirmDeleteId(null);
    }
  }, [tasks, selectedId, confirmDeleteId]);

  const isPending = useCallback(
    (kind: TaskActionKind, id: string | null) =>
      pending !== null && pending.kind === kind && pending.id === id,
    [pending],
  );

  const startPending = useCallback((action: TasksPendingAction): boolean => {
    if (pendingRef.current !== null) return false;
    pendingRef.current = action;
    setPending(action);
    setError(null);
    return true;
  }, []);

  const finishPending = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
  }, []);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setNotice(null);
    setError(null);
  }, []);

  const back = useCallback(() => {
    setSelectedId((current) => {
      if (current !== null) setFocusRequest({ kind: "task", id: current });
      return null;
    });
    setConfirmDeleteId(null);
    setError(null);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  /**
   * Dispatch once, synchronously (so a caller observes the request immediately),
   * then settle the pending flag when the returned promise resolves.
   */
  const dispatch = useCallback(
    (action: TasksPendingAction, invoke: () => Promise<void> | void, done?: () => void): void => {
      if (!startPending(action)) return;
      let result: Promise<void> | void;
      try {
        result = invoke();
      } catch (cause: unknown) {
        setError(taskActionErrorMessage(cause));
        finishPending();
        return;
      }
      void Promise.resolve(result)
        .then(() => done?.())
        .catch((cause: unknown) => setError(taskActionErrorMessage(cause)))
        .finally(finishPending);
    },
    [startPending, finishPending],
  );

  const run = useCallback(
    (id: string) => {
      dispatch({ kind: "run", id }, () => onRun(id));
    },
    [onRun, dispatch],
  );

  const runAll = useCallback(() => {
    dispatch({ kind: "run-all", id: null }, () => onRunAll());
  }, [onRunAll, dispatch]);

  const requestDelete = useCallback((id: string) => {
    setConfirmDeleteId(id);
    setError(null);
  }, []);

  const cancelDelete = useCallback(() => {
    setConfirmDeleteId((current) => {
      if (current !== null) setFocusRequest({ kind: "delete-trigger", id: current });
      return null;
    });
    setError(null);
  }, []);

  const confirmDelete = useCallback(() => {
    const id = confirmDeleteId;
    if (id === null) return;
    // Focus lands on whatever survives the removal: the next task, else the
    // previous one, else the run-all control, else the empty-state region.
    const index = tasks.findIndex((task) => task.id === id);
    const neighbour = tasks[index + 1] ?? tasks[index - 1] ?? null;
    dispatch(
      { kind: "delete", id },
      () => onDelete(id),
      () => {
        setConfirmDeleteId(null);
        setSelectedId((current) => (current === id ? null : current));
        setFocusRequest(neighbour ? { kind: "task", id: neighbour.id } : { kind: "empty" });
      },
    );
  }, [confirmDeleteId, tasks, onDelete, dispatch]);

  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);

  return {
    selectedTask,
    pending,
    confirmDeleteId,
    error,
    notice,
    focusRequest,
    isPending,
    select,
    back,
    dismissNotice,
    run,
    runAll,
    requestDelete,
    cancelDelete,
    confirmDelete,
    clearFocusRequest,
  };
}
