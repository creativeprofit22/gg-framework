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

import { createPaneAgentClient, getState, NewSessionError, sendPrompt } from "./agent";

const target = {
  mode: "chat" as const,
  chatAgent: "therapist" as const,
  cwd: "/work",
  sessionPath: "/s",
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const notesTask = {
  id: "task-1",
  text: "verify transport",
  status: "todo" as const,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:00.000Z",
  completedAt: null,
  archivedAt: null,
};
const notesDocument = {
  version: 3 as const,
  reference: "reference",
  currentFocus: "focus",
  tasks: [notesTask],
  handoff: { text: "handoff", updatedAt: "2026-07-25T12:00:00.000Z", readAt: null },
  updatedAt: "2026-07-25T12:00:00.000Z",
  legacyImportedAt: null,
  phases: [],
  references: [],
};
const notesSnapshot = { projectKey: "/work", revision: 1, document: notesDocument };
describe("pane agent client", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "agent_pane_status") {
        return { ready: true, error: null, generation: 1, sessionId: "session" };
      }
      if (command === "agent_notes_get") {
        return { status: "ok", snapshot: notesSnapshot, recoveredFromBackup: false };
      }
      if (command === "agent_notes_migrate") {
        return { status: "ok", snapshot: notesSnapshot, migrated: true };
      }
      if (command === "agent_notes_save") {
        return { status: "ok", snapshot: { ...notesSnapshot, revision: 2 } };
      }
      if (command === "agent_reminder_reserve") return { status: "none" };
      if (command === "agent_reminder_claim") return { status: "already-delivered" };
      if (command === "agent_reminder_release") return { status: "released" };
      if (command === "agent_new_session") return { operationId: "operation-1" };
      if (command === "agent_phase_start") {
        return {
          status: "accepted",
          operationId: "phase-operation-1",
          session: { sessionId: "bound-session", sessionPath: "/bound.jsonl" },
          packageTokenCount: 321,
        };
      }
      if (command === "agent_prompt") return { queued: false, count: 0 };
      return {};
    });
  });

  it("routes the current IPC surface with the complete pane argument matrix", async () => {
    const c = createPaneAgentClient("right");
    await c.getState();
    await c.getNotes();
    await c.migrateNotes(notesDocument);
    await c.saveNotes(1, notesDocument);
    await c.reserveReminder(true);
    await c.claimReminder("lease-1", "native", "granted");
    await c.releaseReminder("lease-1");
    await c.startPhase("phase/21");
    await c.listMemories();
    await c.deleteMemory("m");
    await c.listJiwa();
    await c.deleteJiwa("j");
    await c.getProgress();
    await c.getSubscriptionUsage("openai");
    await c.enhancePrompt("e");
    await expect(c.sendPrompt("p", [], { kenSent: true })).resolves.toEqual({
      queued: false,
      count: 0,
    });
    await c.cancel();
    await c.sendKenPrompt("k");
    await c.cancelKen();
    await c.setAutopilot(true);
    await c.acceptPlan("plan");
    await c.listHistory();
    await c.authOAuthStart("openai");
    await c.authOAuthCode("code");
    expect(await c.newSession()).toEqual({ operationId: "operation-1" });
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
    expect(invoke).toHaveBeenCalledWith("agent_kill_task", {
      paneId: "right",
      id: "bg",
    });
    expect(invoke).toHaveBeenCalledWith("agent_sessions", {
      paneId: "right",
      cwd: "/work",
      chatAgent: "all",
    });
    expect(invoke).toHaveBeenCalledWith("agent_notes_get", { paneId: "right" });
    expect(invoke).toHaveBeenCalledWith("agent_notes_migrate", {
      paneId: "right",
      document: notesDocument,
    });
    expect(invoke).toHaveBeenCalledWith("agent_notes_save", {
      paneId: "right",
      expectedRevision: 1,
      document: notesDocument,
    });
    expect(invoke).toHaveBeenCalledWith("agent_reminder_reserve", {
      paneId: "right",
      focused: true,
    });
    expect(invoke).toHaveBeenCalledWith("agent_reminder_claim", {
      paneId: "right",
      leaseToken: "lease-1",
      channel: "native",
      permission: "granted",
    });
    expect(invoke).toHaveBeenCalledWith("agent_reminder_release", {
      paneId: "right",
      leaseToken: "lease-1",
    });
    expect(invoke).toHaveBeenCalledWith("agent_phase_start", {
      paneId: "right",
      phaseId: "phase/21",
    });
  });

  it("strictly validates reminder reserve, claim, and release outcomes", async () => {
    const client = createPaneAgentClient("right");
    const reserved = {
      status: "reserved",
      leaseToken: "lease-1",
      expiresAt: "2026-07-25T12:00:15.000Z",
      phase: {
        id: "phase-1",
        title: "Private in-app title",
        session: { sessionId: "session-1", sessionPath: "/session" },
      },
      reminder: {
        id: "reminder-1",
        occurrenceKey: "occurrence-1",
        dueAt: "2026-07-25T12:00:00.000Z",
        note: "Private in-app note",
      },
    } as const;
    invoke.mockResolvedValueOnce(reserved);
    await expect(client.reserveReminder(true)).resolves.toBe(reserved);

    for (const invalid of [
      { ...reserved, extra: true },
      { ...reserved, phase: { ...reserved.phase, sourcePrompt: "leak" } },
      { ...reserved, reminder: { ...reserved.reminder, dueAt: "soon" } },
      { status: "deferred" },
    ]) {
      invoke.mockResolvedValueOnce(invalid);
      await expect(client.reserveReminder(true)).rejects.toThrow(
        "invalid reminder reserve response",
      );
    }

    invoke.mockResolvedValueOnce({ status: "not-due" });
    await expect(client.claimReminder("lease-1", "native", "granted")).resolves.toEqual({
      status: "not-due",
    });
    invoke.mockResolvedValueOnce({ status: "not-due", snapshot: notesSnapshot });
    await expect(client.claimReminder("lease-1", "native", "granted")).rejects.toThrow(
      "invalid reminder claim response",
    );

    invoke.mockResolvedValueOnce({ status: "released" });
    await expect(client.releaseReminder("lease-1")).resolves.toEqual({ status: "released" });
    invoke.mockResolvedValueOnce({ status: "released", extra: true });
    await expect(client.releaseReminder("lease-1")).rejects.toThrow(
      "invalid reminder release response",
    );
  });

  it("strictly validates phase-start outcomes", async () => {
    const client = createPaneAgentClient("right");
    const accepted = {
      status: "accepted",
      operationId: "operation-1",
      session: { sessionId: "session-1", sessionPath: "/session.jsonl" },
      packageTokenCount: 42,
    } as const;
    invoke.mockResolvedValueOnce(accepted);
    await expect(client.startPhase("phase-21")).resolves.toBe(accepted);

    for (const invalid of [
      { ...accepted, extra: true },
      { ...accepted, packageTokenCount: -1 },
      { ...accepted, session: { sessionId: "session-1" } },
      { status: "failed", code: "busy", operationId: null },
    ]) {
      invoke.mockResolvedValueOnce(invalid);
      await expect(client.startPhase("phase-21")).rejects.toThrow("invalid phase start response");
    }
  });

  it("validates and preserves the authoritative prompt queue result", async () => {
    const client = createPaneAgentClient("right");
    invoke.mockResolvedValueOnce({ queued: true, count: 2 });
    await expect(client.sendPrompt("queued Ken prompt", [], { kenSent: true })).resolves.toEqual({
      queued: true,
      count: 2,
    });

    for (const invalid of [
      { accepted: true },
      { queued: true, count: 0 },
      { queued: false, count: 1 },
    ]) {
      invoke.mockResolvedValueOnce(invalid);
      await expect(client.sendPrompt("bad shape")).rejects.toThrow(
        "invalid prompt submission response",
      );
    }
  });

  it("types new-session HTTP rejection separately from an unknown transport outcome", async () => {
    const client = createPaneAgentClient("right");
    invoke
      .mockRejectedValueOnce(
        JSON.stringify({
          kind: "creation-rejected",
          status: 409,
          message: "cannot start a new session while running",
        }),
      )
      .mockRejectedValueOnce(
        JSON.stringify({
          kind: "outcome-unknown",
          status: 500,
          message: "session storage failed after reset",
        }),
      )
      .mockRejectedValueOnce(new Error("connection closed"));

    await expect(client.newSession()).rejects.toEqual(
      new NewSessionError("creation-rejected", "cannot start a new session while running", 409),
    );
    await expect(client.newSession()).rejects.toEqual(
      new NewSessionError("outcome-unknown", "session storage failed after reset", 500),
    );
    await expect(client.newSession()).rejects.toEqual(
      new NewSessionError("outcome-unknown", "connection closed"),
    );
  });

  it("passes validated typed Notes outcomes through unchanged", async () => {
    const client = createPaneAgentClient("right");
    const read = { status: "ok", snapshot: notesSnapshot, recoveredFromBackup: false } as const;
    const migrated = { status: "ok", snapshot: notesSnapshot, migrated: false } as const;
    const saved = { status: "conflict", snapshot: notesSnapshot } as const;
    invoke.mockResolvedValueOnce(read).mockResolvedValueOnce(migrated).mockResolvedValueOnce(saved);

    expect(await client.getNotes()).toBe(read);
    expect(await client.migrateNotes(notesDocument)).toBe(migrated);
    expect(await client.saveNotes(1, notesDocument)).toBe(saved);
  });

  it("passes schema, route, and event-authority errors unchanged and rejects legacy bare outcomes", async () => {
    const client = createPaneAgentClient("right");
    const schemaError = {
      status: "invalid",
      error: { path: "references[0].canonicalUrl", message: "expected an absolute http(s) URL" },
    } as const;
    const malformedJson = {
      status: "invalid",
      error: { path: "$", message: "malformed JSON request body" },
    } as const;
    const invalidBody = {
      status: "invalid",
      error: { path: "$", message: "invalid request body" },
    } as const;
    const eventAuthorityError = {
      status: "invalid",
      error: {
        path: "phases[0].roadmapEvents[0].type",
        message: "privileged roadmap events require their dedicated authority path",
      },
    } as const;
    invoke
      .mockResolvedValueOnce(schemaError)
      .mockResolvedValueOnce(malformedJson)
      .mockResolvedValueOnce(invalidBody)
      .mockResolvedValueOnce(eventAuthorityError)
      .mockResolvedValueOnce({ status: "invalid" });

    expect(await client.migrateNotes(notesDocument)).toBe(schemaError);
    expect(await client.migrateNotes(notesDocument)).toBe(malformedJson);
    expect(await client.saveNotes(1, notesDocument)).toBe(invalidBody);
    expect(await client.saveNotes(1, notesDocument)).toBe(eventAuthorityError);
    await expect(client.saveNotes(1, notesDocument)).rejects.toThrow("invalid Notes save response");
  });

  it("rejects Notes response snapshots with unknown document, task, handoff, or snapshot keys", async () => {
    const client = createPaneAgentClient("right");
    const documentWithExtra = { ...notesDocument, extra: true };
    const taskWithExtra = {
      ...notesDocument,
      tasks: [{ ...notesDocument.tasks[0], extra: true }],
    };
    const handoffWithExtra = {
      ...notesDocument,
      handoff: { ...notesDocument.handoff, extra: true },
    };

    invoke
      .mockResolvedValueOnce({
        status: "ok",
        snapshot: { ...notesSnapshot, document: documentWithExtra },
        recoveredFromBackup: false,
      })
      .mockResolvedValueOnce({
        status: "ok",
        snapshot: { ...notesSnapshot, document: taskWithExtra },
        migrated: true,
      })
      .mockResolvedValueOnce({
        status: "ok",
        snapshot: { ...notesSnapshot, document: handoffWithExtra },
      })
      .mockResolvedValueOnce({
        status: "ok",
        snapshot: { ...notesSnapshot, extra: true },
        recoveredFromBackup: false,
      });

    await expect(client.getNotes()).rejects.toThrow("invalid Notes read response");
    await expect(client.migrateNotes(notesDocument)).rejects.toThrow(
      "invalid Notes migration response",
    );
    await expect(client.saveNotes(1, notesDocument)).rejects.toThrow("invalid Notes save response");
    await expect(client.getNotes()).rejects.toThrow("invalid Notes read response");
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

  it("buffers pane events until session identity resolves and drops stale sessions", async () => {
    const status = deferred<{
      ready: boolean;
      error: null;
      generation: number;
      sessionId: string;
    }>();
    invoke.mockImplementation((command: string) =>
      command === "agent_pane_status" ? status.promise : Promise.resolve({}),
    );
    const onEvent = vi.fn();
    const unsubscribe = createPaneAgentClient("right").subscribe(onEvent);
    await vi.waitFor(() => expect(listeners.has("agent-event")).toBe(true));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "right" }),
    );

    listeners.get("agent-event")!({
      payload: {
        paneId: "right",
        sessionId: "session",
        type: "notes_change",
        data: notesSnapshot,
      },
    });
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "stale", type: "delta", data: "stale" },
    });
    expect(onEvent).not.toHaveBeenCalled();

    status.resolve({ ready: true, error: null, generation: 1, sessionId: "session" });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith({ type: "notes_change", data: notesSnapshot });
    unsubscribe();
  });

  it("forwards typed phase-completion events without changing their payload", async () => {
    const onEvent = vi.fn();
    const unsubscribe = createPaneAgentClient("right").subscribe(onEvent);
    await vi.waitFor(() => expect(listeners.has("agent-event")).toBe(true));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "right" }),
    );
    const data = {
      phaseId: "phase-24",
      session: { sessionId: "session", sessionPath: "/sessions/24.jsonl" },
      gateOutcome: "needs-attention",
      unmetGateCodes: ["failed-verification"],
      recovery: "Fix verification, then rerun final review.",
    };

    listeners.get("agent-event")!({
      payload: {
        paneId: "right",
        sessionId: "session",
        type: "phase_completion_review_blocked",
        data,
      },
    });

    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({
        type: "phase_completion_review_blocked",
        data,
      }),
    );
    unsubscribe();
  });

  it("refreshes identity and re-evaluates mismatched envelopes once in arrival order", async () => {
    const refreshedStatus = deferred<{
      ready: boolean;
      error: null;
      generation: number;
      sessionId: string;
    }>();
    let statusCalls = 0;
    invoke.mockImplementation((command: string) => {
      if (command !== "agent_pane_status") return Promise.resolve({});
      statusCalls += 1;
      return statusCalls === 1
        ? Promise.resolve({ ready: true, error: null, generation: 1, sessionId: "old" })
        : refreshedStatus.promise;
    });
    const onEvent = vi.fn();
    const unsubscribe = createPaneAgentClient("right").subscribe(onEvent);
    await vi.waitFor(() => expect(listeners.has("agent-event")).toBe(true));

    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "old", type: "delta", data: "initialized" },
    });
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({ type: "delta", data: "initialized" }),
    );
    onEvent.mockClear();

    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "new", type: "delta", data: 1 },
    });
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "new", type: "delta", data: 2 },
    });
    await vi.waitFor(() => expect(statusCalls).toBe(2));
    expect(onEvent).not.toHaveBeenCalled();

    refreshedStatus.resolve({ ready: true, error: null, generation: 2, sessionId: "new" });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));
    expect(onEvent.mock.calls).toEqual([
      [{ type: "delta", data: 1 }],
      [{ type: "delta", data: 2 }],
    ]);
    unsubscribe();
  });

  it("does not deliver buffered envelopes after disposal", async () => {
    const status = deferred<{
      ready: boolean;
      error: null;
      generation: number;
      sessionId: string;
    }>();
    invoke.mockImplementation((command: string) =>
      command === "agent_pane_status" ? status.promise : Promise.resolve({}),
    );
    const onEvent = vi.fn();
    const unsubscribe = createPaneAgentClient("right").subscribe(onEvent);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "right" }),
    );
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "session", type: "delta", data: 1 },
    });

    unsubscribe();
    status.resolve({ ready: true, error: null, generation: 1, sessionId: "session" });
    await Promise.resolve();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("preserves lifecycle generations and rejects stale pane events", async () => {
    const c = createPaneAgentClient("right");
    invoke.mockImplementation(async (command: string) =>
      command === "agent_pane_status"
        ? { ready: true, error: null, generation: 9, sessionId: "active" }
        : command === "agent_pane_create"
          ? 7
          : command === "agent_pane_restore"
            ? 8
            : undefined,
    );
    expect(await c.create(target)).toBe(7);
    expect(await c.restore(target)).toBe(8);
    await c.dispose(8);
    expect(invoke).toHaveBeenCalledWith("agent_pane_dispose", { paneId: "right", generation: 8 });

    const onEvent = vi.fn();
    const unsubscribe = c.subscribe(onEvent);
    await vi.waitFor(() => expect(listeners.has("agent-event")).toBe(true));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "right" }),
    );
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "stale", type: "delta", data: 1 },
    });
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "active", type: "delta", data: 2 },
    });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith({ type: "delta", data: 2 });
    unsubscribe();
  });
});
