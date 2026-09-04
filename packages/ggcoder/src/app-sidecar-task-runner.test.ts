import { readFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, readFileSync: vi.fn() };
});

import { getNextRunnableTask, type TaskRecord } from "./core/tasks-store.js";

function task(id: string, status: string): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    prompt: `Run ${id}`,
    status,
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("app sidecar task runner", () => {
  it("selects blocked tasks while skipping in-progress and unknown statuses", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([
        task("running", "in-progress"),
        task("unknown", "paused-by-policy"),
        task("blocked", "blocked"),
        task("pending", "pending"),
      ]),
    );

    expect(getNextRunnableTask("project")).toMatchObject({ id: "blocked" });
  });

  it("returns no run-all candidate when every task is done, running, or unknown", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([
        task("done", "done"),
        task("running", "in-progress"),
        task("unknown", "paused-by-policy"),
      ]),
    );

    expect(getNextRunnableTask("project")).toBeNull();
  });

  it("wires both sidecar run-all selections through the runnable selector", async () => {
    const source = await readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    expect(source.match(/getNextRunnableTask\(cwd\)/g)).toHaveLength(2);
    expect(source).not.toContain("getNextPendingTask");
  });
});
