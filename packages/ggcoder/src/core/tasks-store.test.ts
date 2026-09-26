import { rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type * as Os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Redirect ~/.gg-tasks into a scratch home so the real task store is exercised
// on a real filesystem (temp file + rename and the lock file both matter here).
vi.mock("node:os", async (original) => {
  const os = await original<typeof Os>();
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(os.tmpdir(), "tasks-store-"));
  return { ...os, homedir: () => home };
});

import {
  createTaskRecord,
  deleteTaskSync,
  loadTasksSync,
  mutateTasks,
  mutateTasksSync,
  saveTasks,
  type TaskRecord,
} from "./tasks-store.js";

afterAll(async () => {
  await rm(homedir(), { recursive: true, force: true });
});

async function project(name: string, tasks: TaskRecord[]): Promise<string> {
  const cwd = join(tmpdir(), "project", name);
  await saveTasks(cwd, tasks);
  return cwd;
}

function record(title: string): TaskRecord {
  return createTaskRecord(title, `Do ${title}`);
}

describe("tasks-store single-writer mutations", () => {
  it("preserves both intents when an add and a delete interleave", async () => {
    const keep = record("keep");
    const doomed = record("doomed");
    const cwd = await project("interleave", [keep, doomed]);

    // The agent's `tasks` tool reads the list, then the desktop delete lands
    // before it writes. A writer that trusted its stale snapshot would resurrect
    // the deleted task; the mutation helper must re-read instead.
    const stale = loadTasksSync(cwd);
    expect(stale.map((task) => task.id)).toContain(doomed.id);
    deleteTaskSync(cwd, doomed.id);

    const added = record("added");
    await mutateTasks(cwd, (tasks) => {
      expect(tasks.map((task) => task.id)).not.toContain(doomed.id);
      return [...tasks, added];
    });

    const titles = loadTasksSync(cwd).map((task) => task.title);
    expect(titles).toContain("keep");
    expect(titles).toContain("added"); // The add survived the delete.
    expect(titles).not.toContain("doomed"); // The delete was not resurrected.
  });

  it("keeps a done mark when an unrelated delete lands concurrently", async () => {
    const finished = record("finished");
    const doomed = record("doomed");
    const cwd = await project("done-vs-delete", [finished, doomed]);

    // Mark done first, then a delete that started from the pre-done snapshot.
    await mutateTasks(cwd, (tasks) => {
      const task = tasks.find((candidate) => candidate.id === finished.id);
      if (!task) return null;
      task.status = "done";
      return tasks;
    });
    deleteTaskSync(cwd, doomed.id);

    const tasks = loadTasksSync(cwd);
    expect(tasks.find((task) => task.id === finished.id)?.status).toBe("done");
    expect(tasks.some((task) => task.id === doomed.id)).toBe(false);
  });

  it("replaces the file atomically so readers never see a partial list", async () => {
    const cwd = await project("atomic", [record("one")]);
    const dir = projectDirFor(cwd);
    mutateTasksSync(cwd, (tasks) => [...tasks, record("two")]);
    // Whatever is on disk always parses: writes land via temp file + rename,
    // and no staged temp file is left behind.
    expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"))).toHaveLength(2);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

/** Resolve the hashed project directory without duplicating the hash logic. */
function projectDirFor(cwd: string): string {
  const base = join(homedir(), ".gg-tasks", "projects");
  const match = readdirSync(base).find((dir) => {
    try {
      const meta = JSON.parse(readFileSync(join(base, dir, "meta.json"), "utf-8")) as {
        path?: string;
      };
      return meta.path === cwd;
    } catch {
      return false;
    }
  });
  if (!match) throw new Error(`no project dir for ${cwd}`);
  return join(base, match);
}
