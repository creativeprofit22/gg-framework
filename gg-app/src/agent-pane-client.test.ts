import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn(),
    listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(name, cb);
      return () => listeners.delete(name);
    }),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import {
  createPaneAgentClient,
  getState,
  isRoadmapPhaseDraftChangeEvent,
  PlanMutationError,
  sendPrompt,
} from "./agent";

const target = {
  mode: "chat" as const,
  chatAgent: "therapist" as const,
  cwd: "/work",
  sessionPath: "/s",
};

describe("pane agent client", () => {
  beforeEach(() => {
    listeners.clear();
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_pane_status") {
        return { ready: true, error: null, generation: 1, sessionId: "session" };
      }
      if (command === "agent_switch_ken_model")
        return { kenProvider: "openai", kenModel: "gpt", kenModelOverride: false };
      if (command === "agent_prompt") return { queued: false, count: 0 };
      if (command === "agent_enhance_prompt") {
        return {
          enhanced: "Enhanced prompt",
          segments: [{ kind: "text", text: "Enhanced prompt" }],
        };
      }
      if (command === "agent_mcp_list") return { servers: [] };
      if (command === "agent_continuation_handoff") {
        return {
          version: 1,
          prompt: "## Objective\nContinue",
          preparedId: "prepared-pane",
          expiresAt: Date.now() + 60_000,
          source: {
            conversationId: "source-pane",
            sessionId: "source-session",
            leafId: "source-leaf",
            fingerprint: "source-fingerprint",
          },
        };
      }
      if (command === "agent_new_session") return { operationId: "new-session-op" };
      if (command === "agent_accept_plan") {
        return { ok: true, planTotal: 2, operationId: "plan-accept-op" };
      }
      if (command === "agent_revise_plan") {
        return { ok: true, operationId: "plan-revise-op" };
      }
      return {};
    });
  });

  it.each(["cannot switch Ken's model while running", "unknown model: missing"])(
    "rejects Ken HTTP errors: %s",
    async (message) => {
      invoke.mockRejectedValueOnce(message);
      await expect(createPaneAgentClient("right").switchKenModel("missing")).rejects.toEqual(
        message,
      );
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    {},
    { error: "unknown model: missing" },
    { kenProvider: "openai", kenModel: "gpt", kenModelOverride: "true" },
    { kenProvider: "openai", kenModel: " ", kenModelOverride: false },
  ])("rejects malformed Ken success bodies: %j", async (body) => {
    invoke.mockResolvedValueOnce(body);
    await expect(createPaneAgentClient("right").switchKenModel("gpt")).rejects.toThrow();
  });

  it.each(["gpt", null])("accepts Ken pin/clear %s", async (model) => {
    const result = { kenProvider: "openai", kenModel: "gpt", kenModelOverride: model !== null };
    invoke.mockResolvedValueOnce(result);
    await expect(createPaneAgentClient("right").switchKenModel(model)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("agent_switch_ken_model", { paneId: "right", model });
  });

  it.each([
    null,
    { error: "Enhancement failed" },
    {},
    { enhanced: " ", segments: [] },
    { enhanced: "Rewrite", segments: [null] },
    { enhanced: "Rewrite", segments: [{ kind: "term", text: "Rewrite" }] },
    { enhanced: "Rewrite", segments: [{ kind: "text", text: "Different text" }] },
  ])("rejects malformed pane enhancement responses: %j", async (response) => {
    invoke.mockResolvedValueOnce({ ready: true, generation: 1, sessionId: "right-session" });
    invoke.mockResolvedValueOnce(response);
    await expect(createPaneAgentClient("right").enhancePrompt("Keep my draft")).rejects.toThrow(
      "Invalid prompt enhancement response",
    );
    expect(invoke).toHaveBeenCalledWith("agent_enhance_prompt", {
      paneId: "right",
      text: "Keep my draft",
    });
  });

  it("routes enhancement readiness and exact results through the owning pane", async () => {
    const result = {
      enhanced: "  Rewrite\nexactly  ",
      segments: [{ kind: "text", text: "  Rewrite\nexactly  " }],
    };
    invoke.mockResolvedValueOnce({ ready: true, generation: 1, sessionId: "right-session" });
    invoke.mockResolvedValueOnce(result);
    await expect(createPaneAgentClient("right").enhancePrompt("  My draft\n  ")).resolves.toEqual(
      result,
    );
    expect(invoke.mock.calls).toEqual([
      ["agent_pane_status", { paneId: "right" }],
      ["agent_enhance_prompt", { paneId: "right", text: "  My draft\n  " }],
    ]);
  });

  it("routes the current IPC surface with the complete pane argument matrix", async () => {
    const c = createPaneAgentClient("right");
    await c.getState();
    await c.listMemories();
    await c.deleteMemory("m");
    await c.listJiwa();
    await c.deleteJiwa("j");
    await c.getProgress();
    await c.getSubscriptionUsage("openai");
    await c.enhancePrompt("e");
    await c.sendPrompt("p", [], { kenSent: true });
    await c.prepareContinuationHandoff("next exactly");
    await c.cancel();
    const kenTarget = { conversationId: "conversation", activationEpoch: "epoch" };
    await c.sendKenPrompt("k", kenTarget);
    expect(invoke).toHaveBeenCalledWith("agent_ken_prompt", {
      paneId: "right",
      text: "k",
      target: kenTarget,
    });
    const ken = { conversationId: "conversation", activationEpoch: "epoch", runId: "run" };
    await c.cancelKen(ken);
    expect(invoke).toHaveBeenCalledWith("agent_ken_cancel", { paneId: "right", ken });
    await c.setAutopilot(true);
    await c.acceptPlan("checkpoint-1", 3);
    await c.revisePlan("checkpoint-1", 3, "Add recovery tests");
    await c.listHistory();
    await c.authOAuthStart("openai");
    await c.authOAuthCode("code");
    await c.newSession();
    await c.getRadioState();
    await c.setRadio("lofi");
    await c.setRadioVolume(50);
    await c.listTasks();
    await c.runTask("t");
    await c.runAllTasks();
    await c.deleteTask("t");
    await c.killTask("bg");
    await c.cycleThinking();
    await c.listCommands();
    await c.listModels();
    await c.switchModel("m");
    await c.switchKenModel(null);
    await c.getSettings();
    await c.saveSettings("/projects");
    await c.listProjects();
    await c.searchFiles("q");
    await c.listSessions("/work", "all");
    await c.getTelegramStatus();
    await c.saveTelegramConfig("token", "1");
    await c.getServeStatus();
    await c.startServe();
    await c.stopServe();
    await c.listMcpServers("/work");
    await c.addMcpServer("cmd", "project", "/work");
    await c.loginMcpServer("mcp", "global");
    await c.removeMcpServer("mcp", "project", "/work");

    expect(invoke).toHaveBeenCalled();
    for (const [, args] of invoke.mock.calls) expect(args).toMatchObject({ paneId: "right" });
    expect(invoke).toHaveBeenCalledWith("agent_prompt", {
      paneId: "right",
      text: "p",
      attachments: [],
      meta: { kenSent: true },
    });
    expect(invoke).toHaveBeenCalledWith("agent_continuation_handoff", {
      paneId: "right",
      nextInstruction: "next exactly",
    });
    expect(invoke).toHaveBeenCalledWith("agent_accept_plan", {
      paneId: "right",
      checkpointId: "checkpoint-1",
      generation: 3,
    });
    expect(invoke).toHaveBeenCalledWith("agent_revise_plan", {
      paneId: "right",
      checkpointId: "checkpoint-1",
      generation: 3,
      feedback: "Add recovery tests",
    });
    expect(invoke).toHaveBeenCalledWith("agent_sessions", {
      paneId: "right",
      cwd: "/work",
      chatAgent: "all",
    });
  });

  it("propagates task list and delete failures", async () => {
    const c = createPaneAgentClient("right");
    invoke.mockRejectedValueOnce(new Error("task list unavailable"));
    await expect(c.listTasks()).rejects.toThrow("task list unavailable");

    invoke.mockRejectedValueOnce(new Error("task delete refused"));
    await expect(c.deleteTask("task-1")).rejects.toThrow("task delete refused");
  });

  it("parses stale plan mutation recovery into a typed client error", async () => {
    const pendingPlanReview = {
      checkpointId: "checkpoint-2",
      generation: 2,
      planPath: "/plans/latest.md",
      content: "## Latest plan",
      contentHash: "hash",
      state: "pending-review",
      reviewStatus: "ready",
      feedback: null,
    };
    invoke.mockRejectedValueOnce(
      JSON.stringify({ error: "stale-plan-checkpoint", pendingPlanReview }),
    );

    const error = await createPaneAgentClient("right")
      .acceptPlan("checkpoint-1", 1)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlanMutationError);
    expect(error).toMatchObject({
      message: expect.stringContaining("Review the latest checkpoint"),
      pendingPlanReview,
      payload: { error: "stale-plan-checkpoint", pendingPlanReview },
    });
  });

  it("preserves actionable checkpoint failure fields on revision errors", async () => {
    invoke.mockRejectedValueOnce(
      JSON.stringify({
        status: "failed",
        operationId: "operation-7",
        code: "checkpoint-write-failed",
        message: "Could not persist the phase checkpoint.",
        guidance: "Fix Project Notes permissions, then retry.",
        retryable: true,
        phaseId: "phase-1",
      }),
    );

    const error = await createPaneAgentClient("right")
      .revisePlan("checkpoint-1", 1, "Add recovery")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlanMutationError);
    expect(error).toMatchObject({
      message: "Could not persist the phase checkpoint. Fix Project Notes permissions, then retry.",
      payload: {
        status: "failed",
        operationId: "operation-7",
        code: "checkpoint-write-failed",
        retryable: true,
        phaseId: "phase-1",
      },
    });
  });

  it("routes and validates pane-scoped context profile changes", async () => {
    invoke.mockResolvedValueOnce({
      openAICodexContextProfile: "experimental",
      contextWindow: 872_000,
    });
    const client = createPaneAgentClient("right");

    await expect(client.setOpenAICodexContextProfile("experimental")).resolves.toEqual({
      openAICodexContextProfile: "experimental",
      contextWindow: 872_000,
    });
    expect(invoke).toHaveBeenCalledWith("agent_set_context_profile", {
      paneId: "right",
      profile: "experimental",
    });

    invoke.mockResolvedValueOnce({ openAICodexContextProfile: "preview", contextWindow: 1 });
    await expect(client.setOpenAICodexContextProfile("stable")).rejects.toThrow(
      "invalid context profile response",
    );
  });

  it("routes and validates pane-scoped Fast changes", async () => {
    invoke.mockResolvedValueOnce({ openAICodexFast: true });
    const client = createPaneAgentClient("right");

    await expect(client.setOpenAICodexFast(true)).resolves.toEqual({ openAICodexFast: true });
    expect(invoke).toHaveBeenCalledWith("agent_set_openai_codex_fast", {
      paneId: "right",
      enabled: true,
    });

    invoke.mockResolvedValueOnce({ openAICodexFast: "yes" });
    await expect(client.setOpenAICodexFast(false)).rejects.toThrow(
      "invalid OpenAI Codex Fast response",
    );
  });

  it("validates and routes Roadmap draft decisions through pane-scoped commands", async () => {
    const draft = {
      id: "draft-1",
      projectKey: "/work",
      basedOnRevision: 3,
      createdAt: "2026-08-05T12:00:00.000Z",
      createdBySessionId: "session-1",
      summary: "Create one peer phase",
      phases: [
        {
          phaseId: "phase-1",
          title: "Approval UI",
          goal: "Require an explicit decision.",
          doneWhen: ["The proposal is readable"],
          sourcePrompt: "Implement the approval UI only.",
        },
      ],
      status: "pending",
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_roadmap_phase_draft_get") return { status: "ok", draft };
      if (command === "agent_roadmap_phase_draft_approve") {
        return { status: "created", revision: 4, phaseIds: ["phase-1"] };
      }
      if (command === "agent_roadmap_phase_draft_reject") return { status: "rejected" };
      return {};
    });
    const client = createPaneAgentClient("right");

    await expect(client.getRoadmapPhaseDraft()).resolves.toEqual({
      ...draft,
      references: [],
      phases: [{ ...draft.phases[0], referenceIds: [] }],
    });
    await expect(client.approveRoadmapPhaseDraft("draft/1")).resolves.toMatchObject({
      status: "created",
      revision: 4,
    });
    await expect(client.rejectRoadmapPhaseDraft("draft/1", "Wrong scope")).resolves.toEqual({
      status: "rejected",
    });
    expect(invoke).toHaveBeenCalledWith("agent_roadmap_phase_draft_approve", {
      paneId: "right",
      draftId: "draft/1",
    });
    expect(invoke).toHaveBeenCalledWith("agent_roadmap_phase_draft_reject", {
      paneId: "right",
      draftId: "draft/1",
      feedback: "Wrong scope",
    });

    invoke.mockResolvedValueOnce({ status: "created", revision: 4, phaseIds: [] });
    await expect(client.approveRoadmapPhaseDraft("draft/1")).rejects.toThrow(
      "invalid Roadmap draft approval response",
    );
  });

  it("normalizes legacy Roadmap drafts identically on change events", () => {
    const event = {
      type: "roadmap_phase_draft_change",
      data: {
        id: "draft-1",
        projectKey: "/work",
        basedOnRevision: 3,
        createdAt: "2026-08-05T12:00:00.000Z",
        createdBySessionId: "session-1",
        summary: "Legacy draft",
        phases: [
          {
            phaseId: "phase-1",
            title: "Legacy",
            goal: "Stay compatible.",
            doneWhen: ["Compatibility passes"],
            sourcePrompt: "Keep compatibility.",
          },
        ],
        status: "pending",
      },
    };
    expect(isRoadmapPhaseDraftChangeEvent(event)).toBe(true);
    expect(event.data).toMatchObject({ references: [], phases: [{ referenceIds: [] }] });
  });

  it("cancels a Roadmap phase through its phase-specific pane command", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_phase_cancel") {
        return {
          status: "cancelled",
          phaseId: "phase/21",
          session: { sessionId: "bound", sessionPath: "/bound.jsonl" },
        };
      }
      return {};
    });
    const client = createPaneAgentClient("right");

    await expect(client.cancelPhaseRun("phase/21")).resolves.toMatchObject({
      status: "cancelled",
      phaseId: "phase/21",
    });
    expect(invoke).toHaveBeenCalledWith("agent_phase_cancel", {
      paneId: "right",
      phaseId: "phase/21",
    });

    invoke.mockResolvedValueOnce({ status: "cancelled", phaseId: "phase/21" });
    await expect(client.cancelPhaseRun("phase/21")).rejects.toThrow(
      "invalid phase cancellation response",
    );
  });

  it.each([
    ["8001 units", "x".repeat(8001), "8001"],
    ["whitespace", " \r\n\t", "nonblank"],
  ])("rejects %s before prepare IPC", async (_name, instruction, message) => {
    await expect(
      createPaneAgentClient("right").prepareContinuationHandoff(instruction),
    ).rejects.toThrow(message);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    { error: "next instruction is too long", message: "HTTP 413: Shorten the instruction." },
    { error: "HTTP 400: empty next instruction" },
    { error: "Session is busy. Retry preparation when idle." },
    { error: "Provider credentials expired. Sign in again." },
  ])("retains a server preparation error body: %j", async (body) => {
    invoke.mockResolvedValueOnce(body);
    await expect(createPaneAgentClient("right").prepareContinuationHandoff("next")).rejects.toThrow(
      body.message ?? body.error,
    );
  });

  it("retains native HTTP 413 rejection text", async () => {
    const message = "HTTP 413: Request body exceeds the transport limit.";
    invoke.mockRejectedValueOnce(message);
    await expect(createPaneAgentClient("right").prepareContinuationHandoff("next")).rejects.toBe(
      message,
    );
  });

  it("rejects malformed continuation-handoff responses", async () => {
    const client = createPaneAgentClient("right");
    for (const malformed of [
      null,
      { version: 2, prompt: "Continue" },
      { version: 1, prompt: "" },
      { version: 1, prompt: "Continue", extra: true },
      { version: 1 },
    ]) {
      invoke.mockResolvedValueOnce(malformed);
      await expect(client.prepareContinuationHandoff("next")).rejects.toThrow(
        "invalid continuation-handoff response",
      );
    }
  });

  it("keeps compatibility wrappers explicitly on primary", async () => {
    await getState();
    await sendPrompt("hello");
    expect(invoke).toHaveBeenNthCalledWith(1, "agent_state", { paneId: "primary" });
    expect(invoke).toHaveBeenNthCalledWith(2, "agent_prompt", {
      paneId: "primary",
      text: "hello",
      attachments: [],
      meta: null,
    });
  });

  it("keeps selection pending until its matching generation is ready", async () => {
    let status = {
      ready: true,
      error: null,
      generation: 1,
      sessionId: "old" as string | null,
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_pane_status") return status;
      if (command === "select_project") {
        status = { ready: false, error: null, generation: 2, sessionId: null };
        return 2;
      }
      return undefined;
    });
    const selection = createPaneAgentClient("right").selectWorkspace(target, 1);
    let settled = false;
    void selection.finally(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("select_project", expect.anything()),
    );
    expect(settled).toBe(false);
    await vi.waitFor(() => expect(listeners.has("agent-pane-ready")).toBe(true));
    listeners.get("agent-pane-ready")!({ payload: { paneId: "right", generation: 1 } });
    await Promise.resolve();
    expect(settled).toBe(false);
    status = { ready: true, error: null, generation: 2, sessionId: "new" };
    listeners.get("agent-pane-ready")!({ payload: { paneId: "right", generation: 2 } });

    await expect(selection).resolves.toBe(2);
    expect(invoke).toHaveBeenCalledWith("select_project", {
      paneId: "right",
      mode: "chat",
      chatAgent: "therapist",
      cwd: "/work",
      sessionPath: "/s",
      expectedGeneration: 1,
    });
  });

  it("ignores stale generation errors while awaiting a replacement", async () => {
    let status = { ready: true, error: null, generation: 1, sessionId: "old" as string | null };
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_pane_status") return status;
      if (command === "select_project") {
        status = { ready: false, error: null, generation: 2, sessionId: null };
        return 2;
      }
      return undefined;
    });
    const selection = createPaneAgentClient("right").selectWorkspace(target, 1);
    await vi.waitFor(() => expect(listeners.has("agent-pane-error")).toBe(true));

    listeners.get("agent-pane-error")!({
      payload: { paneId: "right", generation: 1, error: "stale failure" },
    });
    await Promise.resolve();
    status = { ready: true, error: null, generation: 2, sessionId: "new" };
    listeners.get("agent-pane-ready")!({ payload: { paneId: "right", generation: 2 } });

    await expect(selection).resolves.toBe(2);
  });

  it("propagates selection and matching startup errors without creating another pane", async () => {
    invoke
      .mockResolvedValueOnce({ ready: true, error: null, generation: 1, sessionId: "old" })
      .mockRejectedValueOnce(new Error("pane 'right' generation is stale"));
    const client = createPaneAgentClient("right");

    await expect(client.selectWorkspace(target, 1)).rejects.toThrow(
      "pane 'right' generation is stale",
    );
    expect(invoke).not.toHaveBeenCalledWith("agent_pane_create", expect.anything());

    invoke.mockReset();
    invoke
      .mockResolvedValueOnce({ ready: true, error: null, generation: 1, sessionId: "old" })
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce({
        ready: false,
        error: "resume failed",
        generation: 2,
        sessionId: null,
      });

    await expect(client.selectWorkspace(target, 1)).rejects.toThrow(
      "pane 'right' failed to start: resume failed",
    );
    expect(invoke).not.toHaveBeenCalledWith("agent_pane_create", expect.anything());
  });

  it("rejects readiness from a stale generation without creating another pane", async () => {
    invoke
      .mockResolvedValueOnce({ ready: true, error: null, generation: 1, sessionId: "old" })
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce({ ready: true, error: null, generation: 3, sessionId: "newer" });

    await expect(createPaneAgentClient("right").selectWorkspace(target, 1)).rejects.toThrow(
      "pane 'right' generation 2 was superseded",
    );
    expect(invoke).not.toHaveBeenCalledWith("agent_pane_create", expect.anything());
  });

  it("creates only when pane status proves the pane is absent", async () => {
    invoke
      .mockRejectedValueOnce("pane 'right' does not exist")
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce({ ready: true, error: null, generation: 4, sessionId: "created" });

    await expect(createPaneAgentClient("right").selectWorkspace(target, 0)).resolves.toBe(4);
    expect(invoke).toHaveBeenCalledWith("agent_pane_create", {
      paneId: "right",
      mode: "chat",
      chatAgent: "therapist",
      cwd: "/work",
      sessionPath: "/s",
    });

    invoke.mockReset();
    invoke.mockRejectedValueOnce(new Error("pane registry unavailable"));
    await expect(createPaneAgentClient("right").selectWorkspace(target, 0)).rejects.toThrow(
      "pane registry unavailable",
    );
    expect(invoke).not.toHaveBeenCalledWith("agent_pane_create", expect.anything());
  });

  it("preserves lifecycle generations and rejects stale pane events", async () => {
    const c = createPaneAgentClient("right");
    let status = { ready: true, error: null, generation: 7, sessionId: "created" };
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_pane_status") return status;
      if (command === "agent_pane_create") return 7;
      if (command === "agent_pane_restore") {
        status = { ready: true, error: null, generation: 8, sessionId: "restored" };
        return 8;
      }
      return undefined;
    });
    expect(await c.create(target)).toBe(7);
    expect(await c.restore(target)).toBe(8);
    status = { ready: true, error: null, generation: 9, sessionId: "active" };
    await c.dispose(8);
    expect(invoke).toHaveBeenCalledWith("agent_pane_dispose", { paneId: "right", generation: 8 });

    const onEvent = vi.fn();
    c.subscribe(onEvent);
    await vi.waitFor(() => expect(listeners.has("agent-event")).toBe(true));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "right" }),
    );
    await vi.waitFor(() => expect(listeners.has("agent-pane-ready")).toBe(true));
    const statusCallsBeforeReady = invoke.mock.calls.filter(
      ([command]) => command === "agent_pane_status",
    ).length;
    listeners.get("agent-pane-ready")!({ payload: { paneId: "right", generation: 10 } });
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.filter(([command]) => command === "agent_pane_status").length,
      ).toBeGreaterThan(statusCallsBeforeReady),
    );
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "stale", type: "delta", data: 1 },
    });
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "active", type: "delta", data: 2 },
    });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith({ type: "delta", data: 2 });
  });
});
