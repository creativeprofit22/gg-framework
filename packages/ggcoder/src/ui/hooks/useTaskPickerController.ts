import { useCallback, useState } from "react";
import { assertProviderExecutionAllowed } from "../../core/provider-execution-policy.js";
import {
  getNextRunnableTask,
  loadTasksSync,
  saveTasksSync,
  type TaskRecord,
} from "../../core/tasks-store.js";

interface UseTaskPickerControllerOptions {
  displayedCwd: string;
  provider: string;
  onError: (error: unknown) => void;
  onStartTask: (title: string, prompt: string, taskId: string, unattended: boolean) => void;
  onRunAllTasksChange: (runAll: boolean) => void;
}

interface TaskPickerController {
  open: boolean;
  tasks: TaskRecord[];
  close: () => void;
  openPicker: () => void;
  toggle: () => void;
  start: (task: TaskRecord) => void;
  runAll: (task?: TaskRecord) => void;
  deleteTask: (task: TaskRecord) => void;
}

export function useTaskPickerController({
  displayedCwd,
  provider,
  onError,
  onStartTask,
  onRunAllTasksChange,
}: UseTaskPickerControllerOptions): TaskPickerController {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>(() => loadTasksSync(displayedCwd));

  const refresh = useCallback(() => setTasks(loadTasksSync(displayedCwd)), [displayedCwd]);
  const close = useCallback(() => setOpen(false), []);

  const openPicker = useCallback(() => {
    setTasks(loadTasksSync(displayedCwd));
    setOpen(true);
  }, [displayedCwd]);

  const toggle = useCallback(() => {
    setTasks(loadTasksSync(displayedCwd));
    setOpen((current) => !current);
  }, [displayedCwd]);

  const start = useCallback(
    (task: TaskRecord) => {
      setOpen(false);
      onRunAllTasksChange(false);
      onStartTask(task.title, task.prompt, task.id, false);
      refresh();
    },
    [onRunAllTasksChange, onStartTask, refresh],
  );

  const runAll = useCallback(
    (task?: TaskRecord) => {
      try {
        assertProviderExecutionAllowed(provider, true);
      } catch (error) {
        onError(error);
        return;
      }
      setOpen(false);
      onRunAllTasksChange(true);
      const selected = task
        ? { id: task.id, title: task.title, prompt: task.prompt || task.text || task.title }
        : getNextRunnableTask(displayedCwd);
      if (!selected) return;
      onStartTask(selected.title, selected.prompt, selected.id, true);
      refresh();
    },
    [displayedCwd, provider, onError, onRunAllTasksChange, onStartTask, refresh],
  );

  const deleteTask = useCallback(
    (task: TaskRecord) => {
      const nextTasks = loadTasksSync(displayedCwd).filter((candidate) => candidate.id !== task.id);
      saveTasksSync(displayedCwd, nextTasks);
      setTasks(nextTasks);
    },
    [displayedCwd],
  );

  return { open, tasks, close, openPicker, toggle, start, runAll, deleteTask };
}
