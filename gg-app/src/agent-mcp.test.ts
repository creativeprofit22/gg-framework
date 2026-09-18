import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", setTitle: vi.fn(), listen: mocks.listen }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import { addMcpServer, createPaneAgentClient, listMcpServers, loginMcpServer, removeMcpServer } from "./agent";

const ready = { ready: true, error: null, generation: 1, sessionId: "session-1" };

function respondToMcp(command: string, response: unknown, rejected = false): void {
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name === "agent_pane_status") return ready;
    if (name === command) {
      if (rejected) throw response;
      return response;
    }
    throw new Error(`Unexpected command: ${name}`);
  });
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listen.mockClear();
});

describe.each([
  ["primary", "primary", listMcpServers],
  ["pane-bound", "mcp-fixture-pane", (cwd?: string) => createPaneAgentClient("mcp-fixture-pane").listMcpServers(cwd)],
] as const)("%s MCP status decoding", (_label, paneId, list) => {
  const base = { name: "fixture", scope: "global", kind: "http", summary: "https://fixture.invalid/mcp", ok: false, toolCount: 0 };

  it("preserves all four statuses and targets the correct pane", async () => {
    const servers = [
      { ...base, name: "disabled", enabled: false },
      { ...base, name: "connected", enabled: true, ok: true, toolCount: 2 },
      { ...base, name: "auth", enabled: true, requiresAuth: true, error: "Requires login." },
      { ...base, name: "failed", enabled: true, requiresAuth: false, error: "Connection refused" },
    ];
    respondToMcp("agent_mcp_list", { servers });
    await expect(list("fixture-project")).resolves.toEqual(servers);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_mcp_list", { paneId, cwd: "fixture-project" });
  });

  it.each(["trust-blocked", "connection-failed"])("retains the safe %s display discriminator", async (failureReason) => {
    const row = { ...base, scope: "project", enabled: true, failureReason, error: "Connection failed: [REDACTED]" };
    respondToMcp("agent_mcp_list", { servers: [row] });
    await expect(list()).resolves.toEqual([row]);
  });

  it.each(["arbitrary diagnostic", null, 42])("rejects invalid failure reasons %s", async (failureReason) => {
    respondToMcp("agent_mcp_list", { servers: [{ ...base, failureReason }] });
    await expect(list()).rejects.toThrow("Could not load MCP servers");
  });

  it("accepts older daemon rows without enabled", async () => {
    respondToMcp("agent_mcp_list", { servers: [base] });
    await expect(list()).resolves.toEqual([{ ...base, enabled: true }]);
  });

  it.each(["false", 0, null])("rejects malformed enabled state %s", async (enabled) => {
    respondToMcp("agent_mcp_list", { servers: [{ ...base, enabled }] });
    await expect(list()).rejects.toThrow("Could not load MCP servers");
  });
});

describe("desktop MCP client failures", () => {
  it("rejects list proxy failures instead of returning an empty list", async () => {
    respondToMcp("agent_mcp_list", new Error("HTTP 500"), true);

    await expect(listMcpServers()).rejects.toThrow(
      "Could not load MCP servers. Check the desktop connection, then retry.",
    );
  });

  it("rejects malformed list responses", async () => {
    respondToMcp("agent_mcp_list", { servers: [{ name: "missing required fields" }] });

    await expect(listMcpServers()).rejects.toThrow("Could not load MCP servers");
  });

  it("maps malformed config failures to specific safe copy", async () => {
    respondToMcp(
      "agent_mcp_list",
      new Error("MCP config at C:/private/.gg/mcp.json is malformed"),
      true,
    );

    await expect(listMcpServers()).rejects.toThrow(
      "An MCP config file is malformed. Fix it, then retry.",
    );
  });

  it.each([
    ["add", () => addMcpServer("claude mcp add bad", "global"), "agent_mcp_add", "Could not add"],
    ["remove", () => removeMcpServer("bad", "global"), "agent_mcp_remove", "Could not remove"],
    [
      "OAuth",
      () => loginMcpServer("bad", "global"),
      "agent_mcp_login",
      "Could not start MCP sign-in",
    ],
  ])(
    "rejects %s failures instead of reporting success",
    async (_label, operation, command, message) => {
      respondToMcp(command, new Error("sidecar unavailable"), true);

      await expect(operation()).rejects.toThrow(message);
    },
  );
});
