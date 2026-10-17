import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { log } from "../core/logger.js";
import { createTaskRecord, loadTasks, mutateTasks, type TaskRecord } from "../core/tasks-store.js";

const TasksParams = z.object({
  action: z
    .enum(["add", "list", "done", "remove"])
    .describe("Action: add a task, list tasks, mark done, or remove"),
  title: z
    .string()
    .optional()
    .describe("Short task title for display (max ~10 words, required for add)"),
  prompt: z
    .string()
    .optional()
    .describe(
      "The standalone prompt sent to an agent with no context (required for add). " +
        "Concise, actionable instruction with file paths and what to change.",
    ),
  id: z.string().optional().describe("Task ID (required for done/remove — use list to find IDs)"),
});

export function createTasksTool(
  cwd: string,
  onTasksChanged?: () => void,
): AgentTool<typeof TasksParams> {
  let pending: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return {
    name: "tasks",
    description:
      "Manage the project task list. Each task has a short title (shown in " +
      "the task pane) and a prompt (sent as a standalone instruction to an " +
      "agent with no context). Write prompts as concise, actionable directives " +
      "with specific file paths — the agent must complete it from the prompt alone. " +
      "When adding multiple tasks, order them by dependency — foundational work " +
      "first, then core logic, integration, UI, and tests. " +
      "Do not use this tool proactively — only manage the task list when the user explicitly requests it.",
    parameters: TasksParams,
    executionMode: "sequential",
    execute({ action, title, prompt, id }) {
      return enqueue(async () => {
        switch (action) {
          case "add": {
            if (!title) return "Error: title is required for add action.";
            if (!prompt) return "Error: prompt is required for add action.";
            const task = createTaskRecord(title, prompt);
            // Re-read under the lock: a concurrent delete elsewhere must not be
            // undone by writing a list captured before it landed.
            await mutateTasks(cwd, (tasks) => [...tasks, task]);
            onTasksChanged?.();
            log("INFO", "tasks", `Task added: ${title}`, { id: task.id });
            return `Task added: "${title}" (id: ${task.id.slice(0, 8)})`;
          }

          case "list": {
            const tasks = await loadTasks(cwd);
            if (tasks.length === 0) return "No tasks.";
            const lines = tasks.map((task) => {
              const check =
                task.status === "done" ? "✓" : task.status === "in-progress" ? "~" : " ";
              return `[${check}] ${task.title}  (id: ${task.id.slice(0, 8)}, ${task.status})`;
            });
            log("INFO", "tasks", `Listed ${tasks.length} tasks`);
            return lines.join("\n");
          }

          case "done": {
            if (!id) return "Error: id is required for done action.";
            const picked: { task: TaskRecord | null } = { task: null };
            await mutateTasks(cwd, (tasks) => {
              const task = tasks.find(
                (candidate) => candidate.id === id || candidate.id.startsWith(id),
              );
              if (!task) return null;
              task.status = "done";
              picked.task = task;
              return tasks;
            });
            const done = picked.task;
            if (!done) return `Error: no task found matching id "${id}".`;
            onTasksChanged?.();
            log("INFO", "tasks", `Task done: ${done.title}`, { id: done.id });
            return `Marked done: "${done.title}"`;
          }

          case "remove": {
            if (!id) return "Error: id is required for remove action.";
            const taken: { task: TaskRecord | null } = { task: null };
            await mutateTasks(cwd, (tasks) => {
              const idx = tasks.findIndex(
                (candidate) => candidate.id === id || candidate.id.startsWith(id),
              );
              if (idx === -1) return null;
              const [record] = tasks.splice(idx, 1);
              if (!record) return null;
              taken.task = record;
              return tasks;
            });
            const removed = taken.task;
            if (!removed) return `Error: no task found matching id "${id}".`;
            onTasksChanged?.();
            log("INFO", "tasks", `Task removed: ${removed.title}`, { id: removed.id });
            return `Removed: "${removed.title}"`;
          }
        }
      });
    },
  };
}
