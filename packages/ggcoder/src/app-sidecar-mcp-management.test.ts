import { describe, expect, it } from "vitest";
import { mcpManagementRouteFailure } from "./app-sidecar-mcp-management.js";

describe("desktop MCP management route failures", () => {
  it("returns non-success failures for every management action", () => {
    expect(mcpManagementRouteFailure("list", new Error("proxy down"))).toEqual({
      status: 500,
      error: "Could not load MCP servers. Try again.",
    });
    expect(mcpManagementRouteFailure("add", new Error("disk details"))).toMatchObject({
      status: 500,
      error: expect.stringContaining("Could not add"),
    });
    expect(mcpManagementRouteFailure("remove", new Error("OAuth store details"))).toMatchObject({
      status: 500,
      error: expect.stringContaining("Could not remove"),
    });
    expect(mcpManagementRouteFailure("login", new Error("provider details"))).toMatchObject({
      status: 500,
      error: expect.stringContaining("Could not start MCP sign-in"),
    });
  });

  it("uses specific safe copy for malformed config without exposing its path", () => {
    const failure = mcpManagementRouteFailure(
      "list",
      new Error("MCP config at C:/secret/project/.gg/mcp.json is malformed"),
    );

    expect(failure).toEqual({
      status: 500,
      error: "An MCP config file is malformed. Fix it, then retry.",
    });
    expect(failure.error).not.toContain("C:/secret");
  });
});
