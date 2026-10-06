import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import type * as Os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Same scratch-home redirection as tasks-store.test.ts: the notifier hook must
// be exercised against the real lock + temp-file-rename write path, not a mock.
vi.mock("node:os", async (original) => {
  const os = await original<typeof Os>();
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(os.tmpdir(), "tasks-tool-"));
  return { ...os, homedir: () => home };
});

import { createTasksTool } from "./tasks.js";

afterAll(async () => {
  await rm(homedir(), { recursive: true, force: true });
});

function project(name: string): string {
  return join(tmpdir(), "tasks-tool-project", name);
}

// AgentTool.execute signatures vary across tool result shapes; tests only care
// about the string the `tasks` tool always returns.
async function run(
  tool: ReturnType<typeof createTasksTool>,
  args: Parameters<typeof createTasksTool>[0] extends string ? Record<string, unknown> : never,
): Promise<string> {
  return (await tool.execute(args as never, {} as never)) as string;
}

describe("createTasksTool onTasksChanged notifier", () => {
  it("fires once after a successful add", async () => {
    const cwd = project("add");
    const onTasksChanged = vi.fn();
    const tool = createTasksTool(cwd, onTasksChanged);

    const result = await run(tool, { action: "add", title: "Ship it", prompt: "Ship the thing" });

    expect(result).toContain("Task added");
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
  });

  it("does not fire when add fails validation (missing title)", async () => {
    const cwd = project("add-invalid");
    const onTasksChanged = vi.fn();
    const tool = createTasksTool(cwd, onTasksChanged);

    const result = await run(tool, { action: "add", prompt: "Ship the thing" });

    expect(result).toContain("Error");
    expect(onTasksChanged).not.toHaveBeenCalled();
  });

  it("fires once after a successful done, not on an unmatched id", async () => {
    const cwd = project("done");
    const onTasksChanged = vi.fn();
    const tool = createTasksTool(cwd, onTasksChanged);

    const added = await run(tool, { action: "add", title: "Ship it", prompt: "Ship the thing" });
    onTasksChanged.mockClear();
    const id = /id: ([0-9a-f]{8})/.exec(added)?.[1];
    expect(id).toBeTruthy();

    const missResult = await run(tool, { action: "done", id: "00000000" });
    expect(missResult).toContain("Error");
    expect(onTasksChanged).not.toHaveBeenCalled();

    const hitResult = await run(tool, { action: "done", id: id! });
    expect(hitResult).toContain("Marked done");
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
  });

  it("fires once after a successful remove, not on an unmatched id", async () => {
    const cwd = project("remove");
    const onTasksChanged = vi.fn();
    const tool = createTasksTool(cwd, onTasksChanged);

    const added = await run(tool, { action: "add", title: "Ship it", prompt: "Ship the thing" });
    onTasksChanged.mockClear();
    const id = /id: ([0-9a-f]{8})/.exec(added)?.[1];
    expect(id).toBeTruthy();

    const missResult = await run(tool, { action: "remove", id: "00000000" });
    expect(missResult).toContain("Error");
    expect(onTasksChanged).not.toHaveBeenCalled();

    const hitResult = await run(tool, { action: "remove", id: id! });
    expect(hitResult).toContain("Removed");
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
  });

  it("never fires for the read-only list action", async () => {
    const cwd = project("list");
    const onTasksChanged = vi.fn();
    const tool = createTasksTool(cwd, onTasksChanged);

    await run(tool, { action: "add", title: "Ship it", prompt: "Ship the thing" });
    onTasksChanged.mockClear();

    const result = await run(tool, { action: "list" });
    expect(result).toContain("Ship it");
    expect(onTasksChanged).not.toHaveBeenCalled();
  });

  it("works without a notifier (backward compatible)", async () => {
    const cwd = project("no-notifier");
    const tool = createTasksTool(cwd);

    const result = await run(tool, { action: "add", title: "Ship it", prompt: "Ship the thing" });
    expect(result).toContain("Task added");
  });
});
