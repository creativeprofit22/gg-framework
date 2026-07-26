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

import { createPaneAgentClient, getState, sendPrompt } from "./agent";

const target = {
  mode: "chat" as const,
  chatAgent: "therapist" as const,
  cwd: "/work",
  sessionPath: "/s",
};

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
      return {};
    });
  });

  it("routes the current IPC surface with the complete pane argument matrix", async () => {
    const c = createPaneAgentClient("right");
    await c.getState();
    await c.getNotes();
    await c.migrateNotes(notesDocument);
    await c.saveNotes(1, notesDocument);
    await c.listMemories();
    await c.deleteMemory("m");
    await c.listJiwa();
    await c.deleteJiwa("j");
    await c.getProgress();
    await c.getSubscriptionUsage("openai");
    await c.enhancePrompt("e");
    await c.sendPrompt("p", [], { kenSent: true });
    await c.cancel();
    await c.sendKenPrompt("k");
    await c.cancelKen();
    await c.setAutopilot(true);
    await c.acceptPlan("plan");
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

  it("passes schema and route validation errors unchanged and rejects legacy bare outcomes", async () => {
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
    invoke
      .mockResolvedValueOnce(schemaError)
      .mockResolvedValueOnce(malformedJson)
      .mockResolvedValueOnce(invalidBody)
      .mockResolvedValueOnce({ status: "invalid" });

    expect(await client.migrateNotes(notesDocument)).toBe(schemaError);
    expect(await client.migrateNotes(notesDocument)).toBe(malformedJson);
    expect(await client.saveNotes(1, notesDocument)).toBe(invalidBody);
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
    c.subscribe(onEvent);
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
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: "delta", data: 2 });
  });
});
