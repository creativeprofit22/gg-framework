import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpRows } from "./app-sidecar-mcp-rows.js";
import { MCPClientManager } from "./core/mcp/client.js";
import { loadServers, fromStoredEntry } from "./core/mcp/store.js";
import type * as McpStore from "./core/mcp/store.js";
import type * as Config from "./config.js";

vi.mock("./core/mcp/store.js", async (importOriginal) => ({
  ...await importOriginal<typeof McpStore>(),
  loadServers: vi.fn(),
}));
vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof Config>(),
  loadSavedSettings: vi.fn(() => ({ trustProjectMcpServers: false, trustedProjects: [] })),
}));

afterEach(() => vi.restoreAllMocks());

const disabled = {
  scope: "global" as const,
  config: fromStoredEntry("disabled", { url: "https://disabled.invalid/mcp", enabled: false }),
};

describe("desktop MCP list row building", () => {
  it("returns explicit disabled, connected, auth-required and failed response rows", async () => {
    vi.mocked(loadServers).mockResolvedValue([
      disabled,
      ...["connected", "auth", "failed"].map((name) => ({
        scope: "global" as const,
        config: { name, url: `https://${name}.invalid/mcp` },
      })),
    ]);
    vi.spyOn(MCPClientManager.prototype, "connectAllDetailed").mockResolvedValue([
      { name: "connected", ok: true, toolCount: 2, tools: [] },
      { name: "auth", ok: false, toolCount: 0, tools: [], requiresAuth: true, error: "Requires login." },
      { name: "failed", ok: false, toolCount: 0, tools: [], requiresAuth: false, error: "Connection refused" },
    ]);
    const dispose = vi.spyOn(MCPClientManager.prototype, "dispose");
    // Exercise the same builder used by the HTTP response, including JSON serialization.
    const rows = JSON.parse(JSON.stringify(await buildMcpRows("fixture-project", "fixture-settings")));
    expect(rows).toEqual([
      { name: "disabled", scope: "global", enabled: false, ok: false, toolCount: 0, kind: "http", summary: disabled.config.url },
      { name: "connected", scope: "global", enabled: true, ok: true, toolCount: 2, kind: "http", summary: "https://connected.invalid/mcp" },
      { name: "auth", scope: "global", enabled: true, ok: false, toolCount: 0, kind: "http", summary: "https://auth.invalid/mcp", requiresAuth: true, error: "Requires login." },
      { name: "failed", scope: "global", enabled: true, ok: false, toolCount: 0, kind: "http", summary: "https://failed.invalid/mcp", requiresAuth: false, error: "Connection refused", failureReason: "connection-failed" },
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses the real disabled execution gate without connecting or probing", async () => {
    vi.mocked(loadServers).mockResolvedValue([disabled, {
      scope: "global",
      config: { name: "disabled-stdio", command: "must-not-spawn", enabled: false },
    }]);
    const connect = vi.spyOn(Client.prototype, "connect").mockRejectedValue(new Error("Unexpected connection"));
    const probe = vi.spyOn(MCPClientManager.prototype, "probe");
    const rows = await buildMcpRows("fixture-project", "fixture-settings");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ enabled: false, ok: false, toolCount: 0 });
      expect(row.error).toBeUndefined();
      expect(row.failureReason).toBeUndefined();
      expect(row.requiresAuth).toBeUndefined();
    }
    expect(connect).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("preserves project trust errors independently of enabled state", async () => {
    vi.mocked(loadServers).mockResolvedValue([true, false].map((enabled) => ({
      scope: "project" as const,
      config: { name: `project-${enabled}`, command: "must-not-spawn", enabled },
    })));
    const connect = vi.spyOn(MCPClientManager.prototype, "connectAllDetailed");
    const rows = await buildMcpRows("fixture-project", "fixture-settings");
    expect(rows.map((row) => row.enabled)).toEqual([true, false]);
    expect(rows.map((row) => row.failureReason)).toEqual(["trust-blocked", undefined]);
    for (const row of rows) {
      expect(row).toMatchObject({ scope: "project", ok: false, toolCount: 0 });
      expect(row.error).toContain("Project-scope server not connected");
    }
    expect(connect).not.toHaveBeenCalled();
  });
});
