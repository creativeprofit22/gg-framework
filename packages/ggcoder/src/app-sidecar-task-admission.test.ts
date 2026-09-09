import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { formatSidecarError } from "./app-sidecar-error.js";
import { RunClaim } from "./core/run-claim.js";
import { AppSidecarPlanGate } from "./app-sidecar-plan-gate.js";
import { AppSidecarReloadCoordinator } from "./app-sidecar-reload.js";
import { AppSidecarSessionMutationCoordinator, isAppSidecarSessionBusy, appSidecarSessionBusyConflictBody } from "./app-sidecar-session-mutation.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness() {
  const source = await readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("sidecar.ts", source, ts.ScriptTarget.Latest, true);
  let route = "";
  let runner = "";
  let taskRunner = "";
  let errorReporter = "";
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(file) === 'method === "POST" && url === "/tasks/run"') route = node.getText(file);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runTasks") runner = node.getText(file);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "broadcastError") errorReporter = node.getText(file);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runTaskById") taskRunner = node.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(route).not.toBe("");
  expect(runner).not.toBe("");
  const reset = deferred();
  const review = deferred();
  const cadence = deferred();
  const queue = deferred();
  const reviewed = deferred();
  const between = deferred();
  const draining = deferred();
  let conversation = "original";
  const tasks = ["pending", "pending"];
  const newSession = vi.fn(async () => {
    await reset.promise;
    conversation = `conversation-${newSession.mock.calls.length}`;
  });
  const context = vm.createContext({
    running: false, autopilotActive: false, taskTurnActive: false, taskRunAll: false,
    autopilotCancelled: false, runLifecycle: { running: false },
    runClaim: new RunClaim(), taskSweepClaim: new RunClaim(),
    sessionMutations: new AppSidecarSessionMutationCoordinator(),
    reloadCoordinator: new AppSidecarReloadCoordinator(),
    isAppSidecarSessionBusy, appSidecarSessionBusyConflictBody,
    planGateConflict: () => null,
    readBody: async (req: { body: string }) => req.body,
    json: (res: { resolve: (value: number) => void }, status: number) => res.resolve(status),
    log: vi.fn(), cwd: "project", formatSidecarError,
    desktopGuidance: (text: string) => text, sidecarErrorSecrets: [], captureSidecarError: vi.fn(),
    session: { newSession, getQueuedCount: () => 0, getPlanMode: () => false,
      getAppMarkers: () => [], persistAppMarker: async () => {} },
    loadTasksSync: () => tasks.map((status, index) => ({ id: String(index), title: String(index), prompt: String(index), status })),
    isManuallyRunnableTaskStatus: (status: string) => status === "pending" || status === "blocked",
    markTaskInProgress: (_cwd: string, id: string) => { tasks[Number(id)] = "in-progress"; },
    finalizeTaskRun: (_cwd: string, id: string, success: boolean) => { tasks[Number(id)] = success ? "done" : "blocked"; },
    pruneDoneTasksSync: () => tasks,
    AppSidecarPlanGate, persistPlanGateMarker: async () => {}, deactivateApprovedPlan: () => {},
    injectedAutopilotPrompts: [], planGate: new AppSidecarPlanGate([], async () => {}),
    userTurnDeps: {}, isWorkflowCommandText: () => false, loadWorkflowCommandSpecs: async () => [],
    runUserTurn: async () => {
      context.autopilotActive = true;
      reviewed.resolve();
      await review.promise;
      context.autopilotActive = false;
      return "all-clear";
    },
    getNextRunnableTask: () => { const index = tasks.indexOf("pending"); return index < 0 ? null : { id: String(index) }; },
    broadcast: vi.fn(),
    setTimeout: (callback: () => void) => { between.resolve(); void cadence.promise.then(callback); },
    runStrandedQueue: async () => { draining.resolve(); await queue.promise; },
  });
  // Extract the authoritative busy projection too, rather than duplicating its contract.
  const busy = source.slice(source.indexOf("  const sessionBusyState ="), source.indexOf("  // Set by /cancel"));
  vm.runInContext(ts.transpileModule(`${busy}\n${errorReporter}\n${taskRunner}\n${runner}\nfunction request(req, res) { const method = "POST", url = "/tasks/run"; ${route} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const runTaskById = vi.fn(context.runTaskById);
  context.runTaskById = runTaskById;
  const request = (all = false) => new Promise<number>((resolve) => context.request({ body: JSON.stringify({ id: "0", all }), resume() {} }, { resolve }));
  const settled = async () => { queue.resolve(); await vi.waitFor(() => expect(context.taskSweepClaim.active).toBe(false)); };
  return { context, request, reset, review, cadence, reviewed, between, draining, settled, runTaskById, newSession,
    snapshot: () => ({ conversation, tasks: [...tasks], all: context.taskRunAll }) };
}

describe("task route admission", () => {
  it.each([
    ["session", false], ["session", true],
    ["persistence", false], ["persistence", true],
    ["workflow", false], ["workflow", true],
  ] as const)("reports accepted %s failure once and permits retry (all=%s)", async (failure, all) => {
    const h = await harness();
    const secretError = new Error("Session persistence failed: C:\\private\\sessions token=private-value");
    if (failure === "session") h.newSession.mockRejectedValueOnce(secretError);
    if (failure === "persistence") {
      const original = h.context.markTaskInProgress;
      h.context.markTaskInProgress = vi.fn().mockImplementationOnce(() => { throw secretError; }).mockImplementation(original);
    }
    if (failure === "workflow") h.context.loadWorkflowCommandSpecs = vi.fn().mockRejectedValueOnce(secretError).mockResolvedValue([]);
    expect(await h.request(all)).toBe(202);
    h.reset.resolve();
    await h.draining.promise;
    await h.settled();
    const events = h.context.broadcast.mock.calls as [string, Record<string, unknown>][];
    expect(events.filter(([type]) => type === "error")).toEqual([["error", {
      headline: all ? "Run All stopped" : "Task run stopped",
      message: "Task setup or execution could not finish.",
      guidance: "Open Tasks and retry the unfinished task. If it fails again, report the problem.",
    }]]);
    expect(events.filter(([type]) => type === "tasks_run_done")).toHaveLength(1);
    expect(events.some(([type]) => type === "run_end")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(h.snapshot().tasks).toEqual([failure === "workflow" ? "blocked" : "pending", "pending"]);
    expect(h.snapshot().conversation).toBe(failure === "session" ? "original" : "conversation-1");
    expect(await h.request()).toBe(202);
    h.review.resolve();
    await h.settled();
    expect(events.filter(([type]) => type === "error")).toHaveLength(1);
  });
  it("does not duplicate a provider failure already reported by the runner", async () => {
    const h = await harness();
    h.context.runUserTurn = async () => {
      h.context.broadcastError("error", "run failed", new Error("provider unavailable"));
      return "failed";
    };
    expect(await h.request(true)).toBe(202);
    h.reset.resolve();
    await h.draining.promise;
    await h.settled();
    const events = h.context.broadcast.mock.calls as [string, Record<string, unknown>][];
    expect(events.filter(([type]) => type === "error")).toHaveLength(1);
    expect(events.filter(([type]) => type === "tasks_run_done")).toHaveLength(1);
    expect(events.some(([, data]) => data.headline === "Run All stopped")).toBe(false);
    expect(h.snapshot().tasks).toEqual(["blocked", "pending"]);
  });

  it.each([false, true])("rejects a pending Autopilot review (all=%s) without changing state", async (all) => {
    const h = await harness();
    h.context.autopilotActive = true;
    const before = h.snapshot();
    expect(await h.request(all)).toBe(409);
    expect(h.snapshot()).toEqual(before);
    expect(h.runTaskById).not.toHaveBeenCalled();
    h.context.autopilotActive = false;
    expect(await h.request()).toBe(202);
    h.reset.resolve(); h.review.resolve();
    await h.draining.promise; await h.settled();
  });

  it.each([false, true])("owns reset, review, cadence and queue windows (all=%s)", async (all) => {
    const h = await harness();
    expect(await h.request(all)).toBe(202);
    const beforeReset = h.snapshot();
    expect(await h.request(!all)).toBe(409);
    expect(h.snapshot()).toEqual(beforeReset);
    expect(h.runTaskById).toHaveBeenCalledTimes(1);
    h.reset.resolve(); await h.reviewed.promise;
    const beforeReview = h.snapshot();
    expect(await h.request(!all)).toBe(409);
    expect(h.snapshot()).toEqual(beforeReview);
    h.review.resolve();
    if (all) {
      await h.between.promise;
      const between = h.snapshot();
      expect(await h.request()).toBe(409);
      expect(h.snapshot()).toEqual(between);
      h.cadence.resolve();
    }
    await h.draining.promise;
    expect(await h.request()).toBe(409);
    await h.settled();
    expect(h.context.broadcast.mock.calls.filter(([type]: [string]) => type === "error")).toHaveLength(0);
    expect(h.context.broadcast.mock.calls.filter(([type]: [string]) => type === "tasks_run_done")).toHaveLength(1);
    expect(await h.request()).toBe(202);
    await h.settled();
  });

  it("releases task and reload ownership when session reset fails", async () => {
    const h = await harness();
    h.newSession.mockRejectedValueOnce(new Error("reset failed"));
    expect(await h.request()).toBe(202);
    await h.draining.promise;
    await h.settled();
    expect(h.context.reloadCoordinator.prepare([])).toEqual({ ok: true });
    h.context.reloadCoordinator.cancel();
    expect(await h.request()).toBe(202);
    h.reset.resolve(); h.review.resolve();
    await h.settled();
    expect(h.newSession).toHaveBeenCalledTimes(2);
  });

  it("keeps ownership through cancellation during reset without starting task work", async () => {
    const h = await harness();
    expect(await h.request()).toBe(202);
    h.context.autopilotCancelled = true;
    h.context.taskRunAll = false;
    expect(await h.request(true)).toBe(409);
    h.reset.resolve();
    await h.draining.promise;
    expect(h.snapshot().tasks).toEqual(["pending", "pending"]);
    await h.settled();
    expect(await h.request()).toBe(202);
    h.review.resolve();
    await h.settled();
  });

  it("does not retain task ownership when configuration reload rejects admission", async () => {
    const h = await harness();
    h.context.reloadCoordinator.prepare([]);
    expect(await h.request()).toBe(409);
    expect(h.context.taskSweepClaim.active).toBe(false);
    expect(h.newSession).not.toHaveBeenCalled();
  });

  it.each(["lifecycle", "provider", "mutation"])("rejects an existing %s owner", async (owner) => {
    const h = await harness();
    if (owner === "lifecycle") h.context.runLifecycle.running = true;
    if (owner === "provider") h.context.runClaim.claim();
    if (owner === "mutation") h.context.sessionMutations.tryAcquire("new-session");
    expect(await h.request()).toBe(409);
    expect(h.runTaskById).not.toHaveBeenCalled();
  });
});
