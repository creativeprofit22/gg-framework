import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  isRunnableTaskStatus,
  type KnownProjectTaskBlockReason,
  type ProjectTask,
} from "@kenkaiiii/gg-core";

const TASKS_BASE = join(homedir(), ".gg-tasks", "projects");

export interface TaskRecord extends ProjectTask {
  /** @deprecated Old field — migrated to title+prompt on load. */
  text?: string;
  details?: string;
  /** Desktop task completion is provisional until its user-turn/review settles. */
  completionPending?: boolean;
}

export interface RunnableTaskInfo {
  id: string;
  title: string;
  prompt: string;
}

function hashPath(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function projectDir(cwd: string): string {
  return join(TASKS_BASE, hashPath(cwd));
}

function taskFilePath(cwd: string): string {
  return join(projectDir(cwd), "tasks.json");
}

/**
 * tasks.json is shared by the daemon's HTTP routes, the task runner and the
 * agent `tasks` tool (possibly in another process). Same invariant as auth.json:
 * lock, re-read the latest file, replace atomically — never write a snapshot
 * captured before the lock was held.
 */
const LOCK_STALE_MS = 10_000;
const LOCK_MAX_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;
let tmpCounter = 0;

function lockFilePath(cwd: string): string {
  return taskFilePath(cwd) + ".lock";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Blocking lock acquisition for the synchronous callers. Best effort: when the
 * project directory does not exist yet there is no file to protect, and any
 * unexpected lock failure degrades to an unlocked (but still atomic) write
 * rather than breaking the task list.
 */
function acquireLockSync(cwd: string): () => void {
  let path: string;
  try {
    ensureProjectSync(cwd); // The lock file needs the project directory to exist.
    path = lockFilePath(cwd);
  } catch {
    return () => {}; // Unusable path: degrade to an unlocked (still atomic) write.
  }
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already released */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return () => {};
      // Held elsewhere: break it once it is stale (holder crashed) or we waited
      // long enough that deadlocking would be worse than proceeding.
      let staleAt: number;
      try {
        staleAt = statSync(path).mtimeMs;
      } catch {
        continue; // Released between open and stat — retry immediately.
      }
      if (Date.now() - staleAt > LOCK_STALE_MS || Date.now() - start > LOCK_MAX_WAIT_MS) {
        try {
          unlinkSync(path);
        } catch {
          /* someone else broke it first */
        }
        continue;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function migrateTask(task: TaskRecord): TaskRecord {
  if (!task.prompt && task.text) {
    return { ...task, title: task.title || task.text, prompt: task.text, text: undefined };
  }
  return task;
}

export function createTaskRecord(title: string, prompt: string): TaskRecord {
  return {
    id: randomUUID(),
    title,
    prompt,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export async function loadTasks(cwd: string): Promise<TaskRecord[]> {
  try {
    const data = await readFile(taskFilePath(cwd), "utf-8");
    const raw = JSON.parse(data) as TaskRecord[];
    return raw.map(migrateTask);
  } catch {
    return [];
  }
}

export function loadTasksSync(cwd: string): TaskRecord[] {
  try {
    const data = readFileSync(taskFilePath(cwd), "utf-8");
    const raw = JSON.parse(data) as TaskRecord[];
    return raw.map(migrateTask);
  } catch {
    return [];
  }
}

/**
 * Guarantee the project directory (and its discovery metadata) exist before a
 * locked mutation — the sync writers used to rely on `saveTasks` creating them.
 */
function ensureProjectSync(cwd: string): void {
  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const meta = join(dir, "meta.json");
  if (!existsSync(meta)) {
    writeFileSync(meta, JSON.stringify({ path: cwd, name: basename(cwd) }, null, 2) + "\n", "utf-8");
  }
}

function serialize(tasks: readonly TaskRecord[]): string {
  return JSON.stringify(tasks, null, 2) + "\n";
}

function tempFilePath(cwd: string): string {
  return `${taskFilePath(cwd)}.tmp-${process.pid}-${tmpCounter++}`;
}

export async function saveTasks(cwd: string, tasks: readonly TaskRecord[]): Promise<void> {
  const dir = projectDir(cwd);
  await mkdir(dir, { recursive: true });
  // Temp file + rename: a crash or a concurrent reader never sees a half list.
  const tmp = tempFilePath(cwd);
  await writeFile(tmp, serialize(tasks), "utf-8");
  await rename(tmp, taskFilePath(cwd));
  const meta = JSON.stringify({ path: cwd, name: basename(cwd) }, null, 2) + "\n";
  await writeFile(join(dir, "meta.json"), meta, "utf-8");
}

export function saveTasksSync(cwd: string, tasks: readonly TaskRecord[]): void {
  const tmp = tempFilePath(cwd);
  writeFileSync(tmp, serialize(tasks), "utf-8");
  try {
    renameSync(tmp, taskFilePath(cwd));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing staged */
    }
    throw err;
  }
}

/**
 * Single-writer mutation: hold the lock, re-read the file, apply `fn` to that
 * fresh list and replace atomically. Return `null` from `fn` to leave the file
 * untouched. Every writer must go through this instead of load → mutate → save,
 * which silently drops whatever another writer committed in between.
 */
export function mutateTasksSync(
  cwd: string,
  fn: (tasks: TaskRecord[]) => TaskRecord[] | null,
): TaskRecord[] {
  const release = acquireLockSync(cwd);
  try {
    const current = loadTasksSync(cwd);
    const next = fn(current);
    if (next === null) return current;
    saveTasksSync(cwd, next);
    return next;
  } finally {
    release();
  }
}

/**
 * Async callers (the `tasks` tool) share the SAME synchronous critical section.
 * An async lock holder would block a sync waiter's event loop, so the two would
 * deadlock until the stale timeout broke the lock; the file is small enough that
 * one short synchronous section costs less than that hazard.
 */
export async function mutateTasks(
  cwd: string,
  fn: (tasks: TaskRecord[]) => TaskRecord[] | null,
): Promise<TaskRecord[]> {
  return mutateTasksSync(cwd, fn);
}

export function getTaskCount(cwd: string): number {
  return loadTasksSync(cwd).filter((task) => task.status !== "done").length;
}

export function getNextRunnableTask(cwd: string): RunnableTaskInfo | null {
  const runnable = loadTasksSync(cwd).find((task) => isRunnableTaskStatus(task.status));
  if (!runnable) return null;
  return {
    id: runnable.id,
    title: runnable.title,
    prompt: runnable.prompt || runnable.text || runnable.title,
  };
}

/**
 * Drop every completed task and persist the pruned list, returning the
 * survivors. Used by the desktop app so finished tasks disappear from the Tasks
 * modal on completion instead of lingering with a "done" badge. No-op write
 * when nothing was done (keeps the file untouched on idle runs).
 */
export function pruneDoneTasksSync(cwd: string): TaskRecord[] {
  return mutateTasksSync(cwd, (tasks) => {
    const remaining = tasks.filter((task) => task.status !== "done" || task.completionPending);
    return remaining.length === tasks.length ? null : remaining;
  });
}

export function markTaskInProgress(cwd: string, taskId: string, completionPending = false): void {
  mutateTasksSync(cwd, (tasks) => {
    if (tasks.length === 0) return null;
    return tasks.map((task) =>
      task.id === taskId ? { ...task, status: "in-progress" as const, completionPending } : task,
    );
  });
}

/**
 * Release provisional completion only after orchestration has explicitly
 * settled. A blocked run records why (`lastOutcome`); a successful run clears it.
 */
export function finalizeTaskRun(
  cwd: string,
  taskId: string,
  succeeded: boolean,
  blockReason?: KnownProjectTaskBlockReason,
): void {
  mutateTasksSync(cwd, (tasks) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return null; // Respect an explicit removal during the run.
    if (succeeded) {
      delete task.lastOutcome;
    } else {
      task.status = "blocked";
      if (blockReason) task.lastOutcome = { reason: blockReason, at: new Date().toISOString() };
      else delete task.lastOutcome; // Unknown cause: never show a stale reason.
    }
    delete task.completionPending;
    return tasks;
  });
}

/** Drop a task by exact or short id, returning the surviving list. */
export function deleteTaskSync(cwd: string, id: string): TaskRecord[] {
  return mutateTasksSync(cwd, (tasks) =>
    tasks.filter((task) => task.id !== id && !task.id.startsWith(id)),
  );
}
