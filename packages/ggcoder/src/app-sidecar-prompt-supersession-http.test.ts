import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createAskUserBridge } from "./core/ask-user.js";
import { resolveChatResearchCommandRoute } from "./app-sidecar-chat-research-handoff.js";
import { handleAppSidecarChatResearchPrompt } from "./app-sidecar-chat-research-route.js";
import { withRealSidecar } from "./test-support/real-sidecar.js";
import { isAppSidecarSessionBusy } from "./app-sidecar-session-mutation.js";

it.each(["research", "attachment", "accepted"] as const)(
  "controller supersession follows acceptance: %s",
  async (scenario) => {
    await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
      const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
      const pane = await open(saved.path, "chat");
      const stream = await subscribe(pane);
      expect((await request("/prompt", pane, { text: "Ask for approval" })).status).toBe(202);
      const question = await stream.waitFor("ask_user");
      if (scenario === "attachment") {
        await fs.mkdir(path.join(project, ".gg"), { recursive: true });
        await fs.writeFile(path.join(project, ".gg", "uploads"), "Not a directory");
      }
      const response = await request("/prompt", pane, {
        text: scenario === "research" ? "/research" : "Change direction",
        attachments: scenario === "attachment"
          ? [{ kind: "file", name: "notes.txt", mediaType: "text/plain", data: "aGVsbG8=" }]
          : [],
      });
      expect(response.status).toBe(scenario === "research" ? 409 : scenario === "attachment" ? 500 : 202);
      if (scenario === "accepted") {
        expect(await response.json()).toEqual({ queued: true, count: 1, queueId: "q1" });
        await stream.waitFor("ask_user_settled");
      } else {
        if (scenario === "research") expect(await response.json()).toMatchObject({ error: "research_session_busy" });
        // The HTTP answer below proves the actual parked bridge remains answerable.
        expect(stream.events.filter((event) => event.type === "ask_user_settled")).toEqual([]);
        expect((await request(`/ask/${question.data.id}`, pane, {
          action: "answer", answers: { approval: "allow" },
        })).status).toBe(200);
        await stream.waitFor("ask_user_settled");
      }
      expect(stream.events.filter((event) => event.type === "ask_user_settled").map((event) => event.data))
        .toEqual([{ id: question.data.id, action: scenario === "accepted" ? "cancel" : "answer" }]);
    }, { parkQuestion: true });
  }, 60_000,
);

// Exercise otherwise transient lifecycle states without adding production test routes.
// Extract the ENTIRE controller callback, including all supersession side effects.
async function promptController(bindings: Record<string, unknown>) {
  const source = ts.createSourceFile("app-sidecar.ts", await fs.readFile(
    new URL("./app-sidecar.ts", import.meta.url), "utf8"), ts.ScriptTarget.ES2022, true);
  const callbacks: ts.ArrowFunction[] = [];
  const busyProjections: ts.VariableStatement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(source) === "sessionBusyState")) {
      busyProjections.push(node);
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "perform" &&
      ts.isArrowFunction(node.initializer) && node.initializer.parameters[0]?.name.getText(source) === "onAccepted") {
      callbacks.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(callbacks).toHaveLength(1);
  expect(busyProjections).toHaveLength(1);
  // Execute the same busy-state projection as the production controller.
  const javascript = ts.transpileModule(`${busyProjections[0]!.getText(source)}\nconst perform = ${callbacks[0]!.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const perform = new Function("isAppSidecarSessionBusy", ...Object.keys(bindings), `${javascript}\nreturn perform;`)(isAppSidecarSessionBusy, ...Object.values(bindings)) as
    (onAccepted: () => void) => Promise<void>;
  await perform(() => {});
}

it.each(["cancelling", "cancel_failed", "new-question"] as const)(
  "controller preserves captured ask ownership during %s", async (state) => {
    const settled = vi.fn();
    const asks = createAskUserBridge({ broadcast: () => {}, onSettled: settled });
    const question = { questions: [{ id: "q", question: "Continue?", kind: "confirm" as const }] };
    const original = asks.park(question);
    const json = vi.fn();
    const queued = vi.fn(() => {
      // The blocked tool has not resumed before its replacement enters the queue.
      expect(settled.mock.calls).toEqual(state === "new-question" ? [[{ id: "ask-1", action: "answer" }]] : []);
      return 1;
    });
    try {
      await promptController({
        asks, programmaticExecutionActive: false, text: "Change direction", attachments: [{}],
        running: true, runClaim: { active: false }, taskSweepClaim: { active: false }, autopilotActive: false, mode: "code", meta: undefined,
        runLifecycle: { running: true, generation: 1, state, isCancellationRequested: () => state !== "new-question" },
        handleAppSidecarProgrammaticExecution: async () => false,
        resolveChatResearchCommandRoute, handleAppSidecarChatResearchPrompt,
        runAgent: vi.fn(), session: { getPlanMode: () => false, queueMessage: queued, listQueuedMessages: () => [{ id: "q1" }] },
        res: {}, json, broadcast: vi.fn(), cwd: ".",
        prepareAttachments: async () => {
          asks.settle("ask-1", { action: "answer", answers: { q: "yes" } });
          void asks.park(question);
          return [];
        },
      });
      expect(asks.pendingCount).toBe(1);
      if (state === "new-question") {
        expect(json).toHaveBeenCalledWith({}, 202, { queued: true, count: 1, queueId: "q1" });
        expect(settled).toHaveBeenCalledExactlyOnceWith({ id: "ask-1", action: "answer" });
        expect(asks.settle("ask-2", { action: "answer", answers: { q: "yes" } })).toBe(true);
      } else {
        expect(json).toHaveBeenCalledWith({}, 409, { error: state === "cancelling" ? "run_cancelling" : "cancel_failed", runState: state });
        expect(settled).not.toHaveBeenCalled();
        expect(queued).not.toHaveBeenCalled();
        expect(asks.settle("ask-1", { action: "answer", answers: { q: "yes" } })).toBe(true);
      }
      await expect(original).resolves.toEqual({ action: "answer", answers: { q: "yes" } });
    } finally { asks.cancelAll(); }
  },
);
