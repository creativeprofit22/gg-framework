import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import { runUserTurn, type UserTurnDeps } from "./app-sidecar-user-turn.js";
import { AppSidecarPlanGate } from "./app-sidecar-plan-gate.js";

// Execute production session wiring and routes, without booting providers or native services.
async function pane(shared: AppSidecarProjectAutopilotState, cwd: string, mode = "code",
  load = async () => false) {
  const source = await readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("sidecar.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, string>();
  let route = "";
  let queuedEnabled = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(file));
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(file) === "userTurnDeps")) {
      declarations.set("userTurnDeps", node.getText(file));
    }
    if (ts.isIfStatement(node) && node.expression.getText(file) === 'method === "POST" && url === "/autopilot"') route = node.getText(file);
    if (ts.isCallExpression(node) && node.expression.getText(file) === "shouldStartAutopilotCycle") {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const enabled = argument.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(file) === "enabled");
        if (enabled && ts.isPropertyAssignment(enabled)) queuedEnabled = enabled.initializer.getText(file);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(route).not.toBe("");
  expect(queuedEnabled).not.toBe("");
  const start = source.indexOf('  if (mode === "code") await projectAutopilot.initialize');
  const end = source.indexOf("  const sessionBusyState", start);
  expect(start).toBeGreaterThan(0);
  const messages: Message[] = [];
  const prompt = async () => {
    messages.push({ role: "assistant", content: [{ type: "tool_call", id: String(messages.length), name: "edit", args: {} }] });
  };
  const session = {
    newSession: async () => { messages.length = 0; }, getQueuedCount: () => 0,
    getAppMarkers: () => [], persistAppMarker: async () => {},
    setIdealReviewSuppressed: vi.fn(), getState: () => ({ provider: "test", model: "test" }),
    getThinkingLevel: () => null, getMessages: () => messages, getPlanMode: () => false,
    getRoadmapPhaseLeaseMarker: () => null, dispose: async () => {},
  };
  const events = vi.fn();
  const review = vi.fn(async () => "all-clear" as const);
  const programmaticChat = { dispose: vi.fn((): void => {}) };
  const context = vm.createContext({
    mode, cwd, projectAutopilot: shared, loadAutopilot: load, session, broadcast: events,
    autopilotCancelled: false, runAgent: async (_text: string, run: () => Promise<void>) => run(),
    runAutopilotCycle: review, runStrandedQueue: async () => {}, planGate: { pending: () => null },
    log: () => {}, readBody: async (req: { body: string }) => req.body,
    json: (res: { resolve: (body: unknown) => void }, _status: number, body: unknown) => res.resolve(body),
    saveAutopilot: async () => {}, lastNewSessionReset: null, chatAgent: null, running: false,
    runLifecycle: { state: "idle" }, getSupportedThinkingLevels: () => [], getModel: () => null,
    kenStatePayload: () => ({}), footerExtras: () => ({}),
    reminderCoordinator: { unwatchSession: () => {} }, opts: { id: cwd },
    phaseCandidates: { dispose: async () => {} }, elicitations: { cancelAll: () => {} }, asks: { cancelAll: () => {} },
    tasksPollStopped: false, tasksPoll: null, gitPollStopped: false, gitPoll: null,
    gitHubPollStopped: false, gitHubPoll: null, phaseLeaseHeartbeat: null, ciPoll: { stop: () => {} },
    serveController: null, clients: [], kenLifecycle: { abort: () => {} }, kenAutoAbort: { abort: () => {} },
    kenSession: null, kenAutoSession: null, programmaticChat,
    taskTurnActive: false, runUserTurn, promptActiveSession: prompt, AUTOMATION_PROVENANCE: {},
    loadTasksSync: () => [{ id: "task", title: "Implement change", prompt: "Implement change", status: "pending" }],
    isManuallyRunnableTaskStatus: (status: string) => status === "pending",
    planGateConflict: () => null, deactivateApprovedPlan: () => {}, injectedAutopilotPrompts: [],
    AppSidecarPlanGate, persistPlanGateMarker: async () => {}, markTaskInProgress: () => {},
    finalizeTaskRun: () => {}, pruneDoneTasksSync: () => [],
    isWorkflowCommandText: () => false, loadWorkflowCommandSpecs: async () => [],
  });
  const code = `async function initialize() {
    ${source.slice(start, end)}
    ${declarations.get("userTurnDeps")}
    ${declarations.get("stateSnapshot")}
    ${declarations.get("dispose")}
    ${declarations.get("runTaskById")}
    function request(req, res) { const method = "POST", url = "/autopilot"; ${route} }
    return { userTurnDeps, stateSnapshot, dispose, request, runTaskById,
      queuedEnabled: () => ${queuedEnabled}, setActive: (active) => { autopilotActive = active; },
      replace: (replacement) => { session = replacement; } };
  } initialize();`;
  const api = await vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context) as {
    userTurnDeps: UserTurnDeps; stateSnapshot: () => { autopilot: boolean }; dispose: () => Promise<void>;
    runTaskById: (id: string) => Promise<boolean>;
    request: (req: { body: string }, res: { resolve: (body: unknown) => void }) => void;
    queuedEnabled: () => boolean; setActive: (active: boolean) => void; replace: (replacement: typeof session) => void;
  };
  return { ...api, events, session, review, programmaticChat,
    toggle: (enabled: boolean) => new Promise((resolve) => api.request({ body: JSON.stringify({ enabled }) }, { resolve })),
    turn: () => runUserTurn(api.userTurnDeps, "Implement change", prompt, false),
  };
}

describe("live project Autopilot session composition", () => {
  it("fans out on/off to snapshots, ordinary/task gates, queued gates and Ideal suppression", async () => {
    const shared = new AppSidecarProjectAutopilotState();
    const cwd = path.resolve("work", "project");
    const equivalent = process.platform === "win32" ? cwd.toUpperCase().replaceAll("\\", "/") : path.join(cwd, "..", "project");
    const a = await pane(shared, cwd);
    const b = await pane(shared, equivalent);
    const other = await pane(shared, path.resolve("work", "other"));
    const chat = await pane(shared, cwd, "chat");
    for (const enabled of [true, false]) {
      expect(await a.toggle(enabled)).toEqual({ autopilot: enabled });
      for (const current of [a, b]) {
        expect(current.stateSnapshot().autopilot).toBe(enabled);
        expect(current.userTurnDeps.gateState().enabled).toBe(enabled);
        expect(current.queuedEnabled()).toBe(enabled);
        expect(current.session.setIdealReviewSuppressed).toHaveBeenLastCalledWith(enabled);
        expect(await current.turn()).toBe(enabled ? "all-clear" : "no-review");
        const reviewsBeforeTask = current.review.mock.calls.length;
        expect(await current.runTaskById("task")).toBe(true);
        expect(current.review).toHaveBeenCalledTimes(reviewsBeforeTask + Number(enabled));
      }
      expect(other.stateSnapshot().autopilot).toBe(false);
      expect(chat.stateSnapshot().autopilot).toBe(false);
    }
    for (const current of [a, b]) expect(current.events.mock.calls.filter(([type]) => type === "autopilot")).toEqual([
      ["autopilot", { autopilot: true }], ["autopilot", { autopilot: false }],
    ]);
    expect(other.events).not.toHaveBeenCalled();
    expect(chat.events).not.toHaveBeenCalled();
    b.setActive(true);
    await a.toggle(true);
    await a.toggle(false);
    expect(b.session.setIdealReviewSuppressed).toHaveBeenLastCalledWith(true);
    expect(b.stateSnapshot().autopilot).toBe(false);
    expect(b.programmaticChat.dispose).not.toHaveBeenCalled();
    await b.dispose();
    expect(b.programmaticChat.dispose).toHaveBeenCalledExactlyOnceWith();
    const count = b.events.mock.calls.length;
    await a.toggle(true);
    expect(b.events).toHaveBeenCalledTimes(count);
    const late = await pane(shared, cwd);
    expect(late.stateSnapshot().autopilot).toBe(true);
    expect(late.session.setIdealReviewSuppressed).toHaveBeenLastCalledWith(true);
    const replacement = { ...a.session, setIdealReviewSuppressed: vi.fn() };
    a.replace(replacement);
    await late.toggle(false);
    expect(replacement.setIdealReviewSuppressed).toHaveBeenLastCalledWith(false);
    await Promise.all([a.dispose(), other.dispose(), chat.dispose(), late.dispose()]);
    for (const current of [a, b, other, chat, late]) {
      expect(current.programmaticChat.dispose).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it("starts with the latest policy when mutation races persisted initialization", async () => {
    const shared = new AppSidecarProjectAutopilotState();
    const cwd = path.resolve("work", "racing");
    const current = await pane(shared, cwd, "code", async () => {
      shared.set(cwd, true);
      return false;
    });
    expect(current.stateSnapshot().autopilot).toBe(true);
    expect(current.session.setIdealReviewSuppressed).toHaveBeenLastCalledWith(true);
    await current.toggle(false);
    expect(current.stateSnapshot().autopilot).toBe(false);
    expect(current.programmaticChat.dispose).not.toHaveBeenCalled();
    await current.dispose();
    expect(current.programmaticChat.dispose).toHaveBeenCalledExactlyOnceWith();
  });
});
