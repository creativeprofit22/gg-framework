import { describe, expect, it } from "vitest";
import { parseMcpAddCommand } from "./parse-add-command.js";

describe("parseMcpAddCommand", () => {
  it("parses an http server (Notion docs example)", () => {
    const r = parseMcpAddCommand("--transport http notion https://mcp.notion.com/mcp");
    expect(r).toEqual({
      ok: true,
      value: {
        config: { name: "notion", url: "https://mcp.notion.com/mcp", transport: "http" },
      },
    });
  });

  it("parses an sse server (Asana docs example)", () => {
    const r = parseMcpAddCommand("--transport sse asana https://mcp.asana.com/sse");
    expect(r.ok && r.value.config).toEqual({
      name: "asana",
      url: "https://mcp.asana.com/sse",
      transport: "sse",
    });
  });

  it("parses a stdio server with --env (Airtable docs example)", () => {
    const r = parseMcpAddCommand(
      "--env AIRTABLE_API_KEY=key airtable -- npx -y airtable-mcp-server",
    );
    expect(r.ok && r.value.config).toEqual({
      name: "airtable",
      command: "npx",
      args: ["-y", "airtable-mcp-server"],
      env: { AIRTABLE_API_KEY: "key" },
    });
  });

  it("parses a bearer --header", () => {
    const r = parseMcpAddCommand(
      '--transport http api https://api.example/mcp --header "Authorization: Bearer tok"',
    );
    expect(r.ok && r.value.config.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("strips a `claude mcp add` prefix", () => {
    const r = parseMcpAddCommand(
      "claude mcp add --transport http notion https://mcp.notion.com/mcp",
    );
    expect(r.ok && r.value.config.name).toBe("notion");
  });

  it("strips a `ggcoder mcp add` prefix", () => {
    const r = parseMcpAddCommand("ggcoder mcp add foo -- node server.js");
    expect(r.ok && r.value.config).toEqual({
      name: "foo",
      command: "node",
      args: ["server.js"],
    });
  });

  it("handles quoted args", () => {
    const r = parseMcpAddCommand('foo -- node "my server.js" --flag "a b"');
    expect(r.ok && r.value.config.args).toEqual(["my server.js", "--flag", "a b"]);
  });

  it("maps --scope user to global and project to project", () => {
    const u = parseMcpAddCommand("--scope user --transport http n https://x/mcp");
    expect(u.ok && u.value.scope).toBe("global");
    const p = parseMcpAddCommand("--scope project --transport http n https://x/mcp");
    expect(p.ok && p.value.scope).toBe("project");
  });

  it("defaults stdio when a command follows --", () => {
    const r = parseMcpAddCommand("local -- ./bin/server");
    expect(r.ok && r.value.config.command).toBe("./bin/server");
  });

  it("errors on missing name", () => {
    const r = parseMcpAddCommand("--transport http");
    expect(r.ok).toBe(false);
  });

  it("errors when http transport has no url", () => {
    const r = parseMcpAddCommand("--transport http notion");
    expect(r.ok).toBe(false);
  });

  it("errors when stdio has no command", () => {
    const r = parseMcpAddCommand("notion");
    expect(r.ok).toBe(false);
  });

  it("rejects websocket transport", () => {
    const r = parseMcpAddCommand("--transport ws notion ws://x");
    expect(r).toEqual({ ok: false, error: "WebSocket transport isn't supported yet." });
  });

  it("rejects an unsafe name", () => {
    const r = parseMcpAddCommand("bad/name -- node x.js");
    expect(r.ok).toBe(false);
  });
});
