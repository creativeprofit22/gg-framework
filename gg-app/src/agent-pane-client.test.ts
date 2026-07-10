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

  it("routes the pane-bound API to its secondary pane", async () => {
    const client = createPaneAgentClient("secondary");

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
    await client.listSessions("/secondary");
    await client.selectProject("/secondary", "/session-2");
    await client.openProjectPath("/secondary/a%20b.ts");

    expect(client.paneId).toBe("secondary");
    expectPane("agent_state", "secondary");
    expectPane("agent_prompt", "secondary", {
      text: "hello",
      attachments: [],
      meta: { kenSent: true },
    });
    expectPane("agent_ken_prompt", "secondary", { text: "mentor" });
    expectPane("agent_cancel", "secondary");
    expectPane("agent_ken_cancel", "secondary");
    expectPane("agent_new_session", "secondary");
    expectPane("agent_history", "secondary");
    expectPane("agent_models", "secondary");
    expectPane("agent_switch_model", "secondary", { model: "model-b" });
    expectPane("agent_switch_ken_model", "secondary", { model: "ken-model" });
    expectPane("agent_commands", "secondary");
    expectPane("agent_files", "secondary", { query: "pane" });
    expectPane("agent_tasks", "secondary");
    expectPane("agent_run_tasks", "secondary", { id: "task-1", all: false });
    expectPane("agent_run_tasks", "secondary", { id: null, all: true });
    expectPane("agent_delete_task", "secondary", { id: "task-2" });
    expectPane("agent_projects", "secondary");
    expectPane("agent_sessions", "secondary", { cwd: "/secondary" });
    expectPane("select_project", "secondary", {
      cwd: "/secondary",
      sessionPath: "/session-2",
    });
    expectPane("open_project_path", "secondary", { path: "/secondary/a b.ts" });
  });

  it("uses dedicated create and dispose commands", async () => {
    await createPaneSession("secondary", "/project", "/session");
    await disposePaneSession("secondary");

    expect(mocks.invoke).toHaveBeenCalledWith("agent_pane_create", {
      paneId: "secondary",
      cwd: "/project",
      sessionPath: "/session",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("agent_pane_dispose", { paneId: "secondary" });
  });
});
