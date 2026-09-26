import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real task store runs against an in-memory file so a Windows-style
// EPERM/EBUSY on the atomic rename can be injected without touching ~/.gg-tasks.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    openSync: vi.fn(() => 1),
    closeSync: vi.fn(),
    writeSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  };
});

import { deleteTaskSync, loadTasksSync, type TaskRecord } from "./core/tasks-store.js";

const CWD = "project";
let tasksFile = "";
const staged = new Map<string, string>();

function task(id: string): TaskRecord {
  return { id, title: `Task ${id}`, prompt: `Run ${id}`, status: "pending", createdAt: "2026-09-04T00:00:00.000Z" };
}

beforeEach(() => {
  staged.clear();
  tasksFile = JSON.stringify([task("aaa"), task("bbb")]);
  vi.mocked(readFileSync).mockImplementation(((path: string) => {
    if (String(path).endsWith("tasks.json")) return tasksFile;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as typeof readFileSync);
  vi.mocked(writeFileSync).mockImplementation(((path: string, data: string) => {
    staged.set(String(path), String(data));
  }) as typeof writeFileSync);
  vi.mocked(renameSync).mockImplementation(((from: string) => {
    tasksFile = staged.get(String(from)) ?? tasksFile;
  }) as typeof renameSync);
});

interface Res { headersSent: boolean; status?: number; body?: Record<string, unknown>; done: () => void }

async function harness() {
  const source = await readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("sidecar.ts", source, ts.ScriptTarget.Latest, true);
  let route = "";
  let message = "";
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(file) === 'method === "POST" && url === "/tasks/delete"') route = node.getText(file);
    if (ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(file) === "TASK_DELETE_FAILED_MESSAGE") message = node.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(route).not.toBe("");
  expect(message).not.toBe("");
  const captureSidecarError = vi.fn();
  const context = vm.createContext({
    cwd: CWD,
    deleteTaskSync,
    captureSidecarError,
    readBody: async (req: { body: string | Error }) => {
      if (req.body instanceof Error) throw req.body;
      return req.body;
    },
    json: (res: Res, status: number, body: Record<string, unknown>) => {
      res.headersSent = true;
      res.status = status;
      res.body = body;
      res.done();
    },
  });
  vm.runInContext(
    ts.transpileModule(`${message}\nfunction request(req, res) { const method = "POST", url = "/tasks/delete"; ${route} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  const request = (body: string | Error) =>
    new Promise<Res>((resolve) => {
      const res: Res = { headersSent: false, done: () => resolve(res) };
      context.request({ body }, res);
    });
  return { request, captureSidecarError };
}

describe("POST /tasks/delete", () => {
  it("deletes the task and returns the remaining list", async () => {
    const h = await harness();
    const res = await h.request(JSON.stringify({ id: "aaa" }));
    expect(res.status).toBe(200);
    expect((res.body?.tasks as TaskRecord[]).map((t) => t.id)).toEqual(["bbb"]);
    expect(loadTasksSync(CWD).map((t) => t.id)).toEqual(["bbb"]);
  });

  it.each(["EPERM", "EBUSY"])("answers a failed save (%s) with a 500 and keeps the task", async (code) => {
    const h = await harness();
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`${code}: operation not permitted, rename C:\\private\\tasks.json`), { code });
    });
    const res = await h.request(JSON.stringify({ id: "aaa" }));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "task_delete_failed",
      message: "The task could not be deleted. It is still in the list. Try again.",
    });
    expect(JSON.stringify(res.body)).not.toContain("private");
    expect(loadTasksSync(CWD).map((t) => t.id)).toEqual(["aaa", "bbb"]);
    expect(h.captureSidecarError).toHaveBeenCalledTimes(1);
    // The retry succeeds once the file is writable again.
    const retry = await h.request(JSON.stringify({ id: "aaa" }));
    expect(retry.status).toBe(200);
    expect(loadTasksSync(CWD).map((t) => t.id)).toEqual(["bbb"]);
  });

  it("answers when the body read itself rejects", async () => {
    const h = await harness();
    const res = await h.request(new Error("socket reset"));
    expect(res.status).toBe(500);
    expect(res.body?.error).toBe("task_delete_failed");
    expect(loadTasksSync(CWD).map((t) => t.id)).toEqual(["aaa", "bbb"]);
  });

  it("keeps the 400 paths", async () => {
    const h = await harness();
    expect((await h.request("{not json")).status).toBe(400);
    expect((await h.request(JSON.stringify({ id: "  " }))).body).toEqual({ error: "missing task id" });
  });
});
