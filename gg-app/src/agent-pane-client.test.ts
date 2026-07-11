import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: mocks.listen,
    setTitle: vi.fn(async () => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(async () => {}),
  info: vi.fn(async () => {}),
}));

import {
  cancel,
  cancelKen,
  createPaneAgentClient,
  createPaneSession,
  deleteTask,
  disposePaneSession,
  getState,
  listCommands,
  listHistory,
  listModels,
  listProjects,
  listSessions,
  listTasks,
  newSession,
  openProjectPath,
  runAllTasks,
  runTask,
  searchFiles,
  selectProject,
  sendKenPrompt,
  sendPrompt,
  switchKenModel,
  switchModel,
} from "./agent";

type IpcCall = [command: string, args?: Record<string, unknown>];

function calls(): IpcCall[] {
  return mocks.invoke.mock.calls as IpcCall[];
}

function expectPane(command: string, paneId: string, args: Record<string, unknown> = {}): void {
  expect(calls()).toContainEqual([command, { ...args, paneId }]);
}

describe("agent pane client routing", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockClear();
    // Supply only readiness state; other helpers tolerate an empty response shape.
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "agent_pane_status" ? { ready: true, error: null } : {},
    );
  });

  it("keeps primary compatibility wrappers on the primary pane", async () => {
    await getState();
    await sendPrompt("hello");
    await sendKenPrompt("mentor");
    await cancel();
    await cancelKen();
    await newSession();
    await listHistory();
    await listModels();
    await switchModel("model-a");
    await switchKenModel(null);
    await listCommands();
    await searchFiles("agent");
    await listTasks();
    await runTask("task-1");
    await runAllTasks();
    await deleteTask("task-2");
    await listProjects();
    await listSessions("/project");
    await selectProject("/project", "/session");
    await openProjectPath("/project/file.ts");

    const routedCommands = calls().filter(
      ([command]) =>
        command.startsWith("agent_") ||
        command === "select_project" ||
        command === "open_project_path",
    );
    expect(routedCommands.length).toBeGreaterThan(0);
    for (const [, args] of routedCommands) {
      expect(args).toMatchObject({ paneId: "primary" });
    }
  });

  it("routes the pane-bound API to an arbitrary auxiliary pane", async () => {
    const client = createPaneAgentClient("pane-3");

    await client.getState();
    await client.sendPrompt("hello", [], { kenSent: true });
    await client.sendKenPrompt("mentor");
    await client.cancel();
    await client.cancelKen();
    await client.newSession();
    await client.listHistory();
    await client.listModels();
    await client.switchModel("model-b");
    await client.switchKenModel("ken-model");
    await client.listCommands();
    await client.searchFiles("pane");
    await client.listTasks();
    await client.runTask("task-1");
    await client.runAllTasks();
    await client.deleteTask("task-2");
    await client.listProjects();
    await client.listSessions("/auxiliary");
    await client.selectProject("/auxiliary", "/session-2", 16);
    await client.openProjectPath("/auxiliary/a%20b.ts");

    expect(client.paneId).toBe("pane-3");
    expectPane("agent_state", "pane-3");
    expectPane("agent_prompt", "pane-3", {
      text: "hello",
      attachments: [],
      meta: { kenSent: true },
    });
    expectPane("agent_ken_prompt", "pane-3", { text: "mentor" });
    expectPane("agent_cancel", "pane-3");
    expectPane("agent_ken_cancel", "pane-3");
    expectPane("agent_new_session", "pane-3");
    expectPane("agent_history", "pane-3");
    expectPane("agent_models", "pane-3");
    expectPane("agent_switch_model", "pane-3", { model: "model-b" });
    expectPane("agent_switch_ken_model", "pane-3", { model: "ken-model" });
    expectPane("agent_commands", "pane-3");
    expectPane("agent_files", "pane-3", { query: "pane" });
    expectPane("agent_tasks", "pane-3");
    expectPane("agent_run_tasks", "pane-3", { id: "task-1", all: false });
    expectPane("agent_run_tasks", "pane-3", { id: null, all: true });
    expectPane("agent_delete_task", "pane-3", { id: "task-2" });
    expectPane("agent_projects", "pane-3");
    expectPane("agent_sessions", "pane-3", { cwd: "/auxiliary" });
    expectPane("select_project", "pane-3", {
      cwd: "/auxiliary",
      sessionPath: "/session-2",
      expectedGeneration: 16,
    });
    expectPane("open_project_path", "pane-3", { path: "/auxiliary/a b.ts" });
  });

  it("uses dedicated create and dispose commands for arbitrary pane IDs", async () => {
    await createPaneSession("pane-3", "/project", "/session");
    await disposePaneSession("pane-3", 17);

    expect(mocks.invoke).toHaveBeenCalledWith("agent_pane_create", {
      paneId: "pane-3",
      cwd: "/project",
      sessionPath: "/session",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("agent_pane_dispose", {
      paneId: "pane-3",
      generation: 17,
    });
  });
});
