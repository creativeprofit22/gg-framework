import { readFileSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import { runUserTurn, type UserTurnDeps, type UserTurnOutcome } from "./app-sidecar-user-turn.js";
import { isWorkflowCommandText } from "./core/autopilot-gate.js";
import { driveAutopilotCycle, frameAutopilotInjection } from "./core/autopilot-cycle.js";
import type { AutopilotVerdict } from "./core/autopilot-verdict.js";
import { AppSidecarPlanGate, planGateConflictCode } from "./app-sidecar-plan-gate.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn() };
});

import {
  getNextRunnableTask, loadTasksSync, markTaskInProgress, pruneDoneTasksSync,
  finalizeTaskRun, type TaskRecord,
} from "./core/tasks-store.js";

function task(id: string, status: string): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    prompt: `Run ${id}`,
    status,
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

async function taskRunnerHarness(enabled = true, cancelledDuringRun = false, options: {
  verdict?: AutopilotVerdict | null;
  plan?: "submitted" | "drafting";
  failure?: "initial" | "injected" | "review" | "session";
  cancelAt?: "review" | "between-tasks";
  mechanical?: boolean;
  workflow?: boolean;
  queued?: boolean;
} = {}) {
  const source = await readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("app-sidecar.ts", source, ts.ScriptTarget.Latest, true);
  const declarations: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && ["runTaskById", "runTasks", "runAutopilotCycle"].includes(node.name?.text ?? "")) {
      declarations.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(declarations).toHaveLength(3);
  let tasks = [task("first", "pending"), task("second", "pending")];
  if (options.workflow) tasks.forEach((task) => { task.prompt = "/compare"; });
  vi.mocked(readFileSync).mockImplementation(() => JSON.stringify(tasks));
  vi.mocked(writeFileSync).mockImplementation((_path, data) => {
    tasks = JSON.parse(String(data)) as TaskRecord[];
  });
  let messages: Message[] = [];
  let cancelled = true; // A previous cancellation must not disable a new task.
  let planMode = false;
  const broadcast = vi.fn();
  const newSession = vi.fn(async () => {
    if (options.failure === "session") throw new Error("session failed");
    messages = [];
    planMode = false;
  });
  const verdict = vi.fn(async (): Promise<AutopilotVerdict | null> => {
    if (options.failure === "review") throw new Error("review failed");
    if (options.cancelAt === "review") cancelled = true;
    return options.verdict === undefined ? { kind: "all_clear" } : options.verdict;
  });
  const review = vi.fn(async (text: string): Promise<UserTurnOutcome> => context.runAutopilotCycle(text));
  const prompt = vi.fn(async () => {
    messages.push({ role: "assistant", content: [
      { type: "tool_call", id: "edit-task", name: options.mechanical ? "read" : "edit", args: { file_path: "task.ts" } },
      { type: "text", text: "Implemented the change." },
    ] });
    cancelled = cancelledDuringRun;
    const current = tasks.find((candidate) => candidate.status === "in-progress");
    if (current) current.status = "done";
    if (options.plan === "submitted") await context.planGate.submit("plan.md", "Draft plan");
    if (options.plan === "drafting") planMode = true;
    if (options.failure === "initial" || (options.failure === "injected" && prompt.mock.calls.length > 1)) {
      throw new Error("work failed");
    }
  });
  const userTurnDeps: UserTurnDeps = {
    runAgent: async (_text, run) => {
      try { await run(); } catch { /* Production runAgent reports and swallows failures. */ }
      context.pruneDoneTasksSync(); // The real runAgent's early cleanup boundary.
    },
    getMessages: () => messages,
    clearCancelled: () => { cancelled = false; },
    gateState: () => ({ enabled, cancelled, planMode, planPending: context.planGate.pending() !== null }),
    review,
    drainQueue: vi.fn(async () => {}),
    decision: vi.fn(),
  };
  const code = ts.transpileModule(
    `${declarations.join("\n")}\nrunTasks;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const context: vm.Context = vm.createContext({
    running: false, taskRunAll: false, taskTurnActive: false,
    cwd: "project", session: {
      newSession, getAppMarkers: () => [], getPlanMode: () => planMode,
      persistAppMarker: async () => {}, persistAutopilotMarker: async () => {},
      setIdealReviewSuppressed: () => {}, getPersistedTranscriptCount: () => messages.length,
      getQueuedCount: () => options.queued && messages.length > 0 ? 1 : 0,
    },
    isAutopilotEnabled: () => enabled, get autopilotCancelled() { return cancelled; },
    set autopilotCancelled(value: boolean) { cancelled = value; }, autopilotActive: false,
    runLifecycle: { begin: () => ({ generation: 1 }) }, abortOwnedWork: () => {},
    pendingCancelDrain: null, MAX_AUTOPILOT_ROUNDS: 1, kenAutoSession: null,
    finishOwnedGeneration: vi.fn(), queueMicrotask: () => {}, runStrandedQueue: vi.fn(async () => {}),
    runAutopilotReview: verdict, runAutopilotPlanReview: verdict,
    driveAutopilotCycle, frameAutopilotInjection, autopilotMarkerCopySeed: () => 1,
    deactivateApprovedPlan: () => {}, injectedAutopilotPrompts: [],
    planGate: new AppSidecarPlanGate([], async () => {}),
    planGateConflict: () => planGateConflictCode(context.planGate.current()),
    AppSidecarPlanGate, persistPlanGateMarker: async () => {}, broadcast,
    broadcastError: vi.fn(), loadTasksSync,
    isManuallyRunnableTaskStatus: (status: string) => status === "pending" || status === "blocked",
    markTaskInProgress, finalizeTaskRun, pruneDoneTasksSync, getNextRunnableTask,
    runAgent: userTurnDeps.runAgent, promptActiveSession: prompt, AUTOMATION_PROVENANCE: {},
    userTurnDeps, runUserTurn, isWorkflowCommandText,
    loadWorkflowCommandSpecs: async () => [{ name: "compare", prompt: "Compare the work" }],
    setTimeout: (callback: () => void) => {
      if (options.cancelAt === "between-tasks") { cancelled = true; context.taskRunAll = false; }
      callback();
    },
  });
  const runTasks = vm.runInContext(code, context) as (startId: string | null, all: boolean) => Promise<void>;
  return { runTasks, review, prompt, userTurnDeps, newSession, broadcast, context, verdict,
    getTasks: () => tasks, getMessages: () => messages };
}

describe("app sidecar task runner", () => {
  it.each([
    { name: "HUMAN", verdict: { kind: "human", reason: "Choose scope" } },
    { name: "capped", verdict: { kind: "prompt", body: "Fix again" } },
    { name: "review failure", verdict: null },
  ] satisfies Array<{ name: string; verdict: AutopilotVerdict | null }>) (
    "retains the first conversation after $name", async ({ verdict }) => {
      const runner = await taskRunnerHarness(true, false, { verdict });
      await runner.runTasks("first", true);
      expect(runner.newSession).toHaveBeenCalledOnce();
      expect(runner.getMessages()).not.toHaveLength(0);
      expect(runner.getTasks()).toMatchObject([
        { id: "first", status: "blocked" }, { id: "second", status: "pending" },
      ]);
      expect(pruneDoneTasksSync("project")).toHaveLength(2);
      expect(runner.context.planGate.current()).toBeNull();
      expect(runner.review).toHaveBeenCalledOnce(); // Injected prompts never open nested cycles.
      expect(runner.broadcast).toHaveBeenCalledWith("tasks_run_done", {});
      expect(runner.context.taskRunAll).toBe(false);
    },
  );
  it.each(["all_clear", "ignore"] as const)("advances only after %s", async (kind) => {
    const runner = await taskRunnerHarness(true, false, { verdict: { kind } });
    await runner.runTasks("first", true);
    expect(runner.newSession).toHaveBeenCalledTimes(2);
    expect(runner.getTasks()).toEqual([]);
  });

  it.each([true, false])("keeps submitted plan pending for human approval (enabled=%s)", async (enabled) => {
    const runner = await taskRunnerHarness(enabled, false, { plan: "submitted" });
    await runner.runTasks("first", true);
    expect(runner.newSession).toHaveBeenCalledOnce();
    expect(runner.userTurnDeps.gateState()).toMatchObject({ planMode: false, planPending: true });
    expect(runner.context.planGate.pending()).toMatchObject({
      state: "pending-review", reviewStatus: enabled ? "ready" : "unreviewed", content: "Draft plan",
    });
    expect(runner.getTasks()).toMatchObject([{ status: "blocked" }, { status: "pending" }]);
    const gate = runner.context.planGate;
    await runner.runTasks("second", true);
    expect(runner.newSession).toHaveBeenCalledOnce();
    expect(runner.context.planGate).toBe(gate);
  });

  it.each([true, false])("keeps a drafting plan in its first session (enabled=%s)", async (enabled) => {
    const runner = await taskRunnerHarness(enabled, false, { plan: "drafting" });
    await runner.runTasks("first", true);
    expect(runner.newSession).toHaveBeenCalledOnce();
    expect(runner.userTurnDeps.gateState().planMode).toBe(true);
    expect(runner.review).not.toHaveBeenCalled();
    expect(runner.getTasks()).toMatchObject([{ status: "blocked" }, { status: "pending" }]);
  });

  it.each(["initial", "injected", "review"] as const)("pauses after %s failure", async (failure) => {
    const runner = await taskRunnerHarness(true, false, {
      failure, ...(failure === "injected" ? { verdict: { kind: "prompt" as const, body: "Fix" } } : {}),
    });
    await runner.runTasks("first", true);
    expect(runner.newSession).toHaveBeenCalledOnce();
    expect(runner.getTasks()).toMatchObject([{ status: "blocked" }, { status: "pending" }]);
    expect(runner.context.taskRunAll).toBe(false);
    expect(runner.context.taskTurnActive).toBe(false);
    expect(runner.broadcast).toHaveBeenCalledWith("tasks_run_done", {});
    expect(runner.broadcast).not.toHaveBeenCalledWith("autopilot_done", expect.anything());
    if (failure === "initial") expect(runner.review).not.toHaveBeenCalled();
    else expect(runner.context.finishOwnedGeneration).toHaveBeenCalledWith(1, true, "failed");
  });

  it.each(["work", "review", "between-tasks"] as const)("stops cancellation during %s", async (when) => {
    const runner = await taskRunnerHarness(true, when === "work", {
      ...(when !== "work" ? { cancelAt: when } : {}),
    });
    await runner.runTasks("first", true);
    expect(runner.newSession).toHaveBeenCalledOnce();
    expect(runner.context.taskRunAll).toBe(false);
    expect(runner.broadcast).toHaveBeenCalledWith("tasks_run_done", {});
    if (when !== "between-tasks") {
      expect(runner.getTasks()).toMatchObject([{ status: "blocked" }, { status: "pending" }]);
      expect(runner.broadcast).not.toHaveBeenCalledWith("autopilot_done", expect.anything());
    }
  });

  it.each(["disabled", "workflow", "mechanical"] as const)("advances legitimate %s exclusions", async (skip) => {
    const runner = await taskRunnerHarness(skip !== "disabled", false, {
      workflow: skip === "workflow", mechanical: skip === "mechanical",
    });
    await runner.runTasks("first", true);
    expect(runner.newSession).toHaveBeenCalledTimes(2);
    expect(runner.review).not.toHaveBeenCalled();
    expect(runner.getTasks()).toEqual([]);
  });

  it("preserves queued user input rather than replacing its conversation", async () => {
    const runner = await taskRunnerHarness(true, false, { queued: true });
    await runner.runTasks("first", true);
    expect(runner.newSession).toHaveBeenCalledOnce();
    expect(runner.getTasks()).toMatchObject([{ status: "blocked" }, { status: "pending" }]);
    expect(runner.context.runStrandedQueue).toHaveBeenCalledOnce();
  });

  it("settles an unexpected user-turn rejection without pruning provisional work", async () => {
    const runner = await taskRunnerHarness();
    runner.userTurnDeps.runAgent = async (_text, run) => {
      await run();
      throw new Error("unexpected turn failure");
    };
    await expect(runner.runTasks("first", true)).rejects.toThrow("unexpected turn failure");
    expect(runner.newSession).toHaveBeenCalledOnce();
    expect(runner.context.taskRunAll).toBe(false);
    expect(runner.context.taskTurnActive).toBe(false);
    expect(runner.getTasks()).toMatchObject([{ status: "blocked" }, { status: "pending" }]);
    expect(runner.broadcast).toHaveBeenCalledWith("tasks_run_done", {});
    expect(runner.review).not.toHaveBeenCalled();
  });

  it("settles Run All when session creation throws", async () => {
    const runner = await taskRunnerHarness(true, false, { failure: "session" });
    await expect(runner.runTasks("first", true)).rejects.toThrow("session failed");
    expect(runner.context.taskRunAll).toBe(false);
    expect(runner.broadcast).toHaveBeenCalledWith("tasks_run_done", {});
    expect(runner.getTasks()).toMatchObject([{ status: "pending" }, { status: "pending" }]);
  });

  it.each([false, true])("reviews completed tasks with Autopilot enabled (run all: %s)", async (all) => {
    const runner = await taskRunnerHarness();
    await runner.runTasks("first", all);
    expect(runner.review.mock.calls.map(([text]) => text)).toEqual(all ? ["Run first", "Run second"] : ["Run first"]);
  });

  it("waits for review before starting the next task", async () => {
    const runner = await taskRunnerHarness();
    let release!: () => void;
    const pending = new Promise<UserTurnOutcome>((resolve) => { release = () => resolve("all-clear"); });
    runner.review.mockImplementationOnce(() => pending);
    const running = runner.runTasks("first", true);
    try {
      await vi.waitFor(() => expect(runner.review).toHaveBeenCalledTimes(1));
      expect(runner.prompt).toHaveBeenCalledTimes(1);
      // Both runAgent cleanup and /tasks use this real store pruning function.
      expect(pruneDoneTasksSync("project")).toMatchObject([
        { id: "first", status: "done", completionPending: true }, { id: "second", status: "pending" },
      ]);
    } finally {
      release();
      await running;
    }
    expect(runner.review).toHaveBeenCalledTimes(2);
  });

  it.each([[false, false], [true, true]])("respects enabled=%s and cancelled=%s", async (enabled, cancelled) => {
    const runner = await taskRunnerHarness(enabled, cancelled);
    await runner.runTasks("first", false);
    expect(runner.prompt).toHaveBeenCalledOnce();
    expect(runner.review).not.toHaveBeenCalled();
  });
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
