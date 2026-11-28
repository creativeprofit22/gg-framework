import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({ log: logMock }));

import {
  createMcpToolIdentity,
  dedupeMcpToolDefinitions,
  getMcpToolIdentity,
  isValidMcpProviderName,
  sameMcpToolIdentity,
  withMcpToolIdentity,
} from "./tool-identity.js";

function tool(name: string): AgentTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    execute: async () => name,
  };
}

beforeEach(() => logMock.mockClear());

describe("MCP tool identity v1", () => {
  it("preserves representative readable aliases, including the 64-character boundary", () => {
    expect(createMcpToolIdentity("kencode-search", "searchCode").providerName).toBe(
      "mcp__kencode-search__searchCode",
    );
    expect(createMcpToolIdentity("AZaz09-one_two", "x-Y_9").providerName).toBe(
      "mcp__AZaz09-one_two__x-Y_9",
    );

    const boundary = createMcpToolIdentity("s", "t".repeat(56)).providerName;
    expect(boundary).toHaveLength(64);
    expect(boundary).toBe(`mcp__s__${"t".repeat(56)}`);
    expect(createMcpToolIdentity("s", "t".repeat(57)).providerName).toMatch(/^mcp__id__/);
  });

  it.each([
    ["server name", "tool"],
    ["server", "tool.name"],
    ["server", "tool:name"],
    ["日本語", "検索"],
    ["_server", "tool"],
    ["server_", "tool"],
    ["server__name", "tool"],
    ["server", "_tool"],
    ["server", "tool_"],
    ["server", "tool__name"],
    ["server", "x".repeat(1_000)],
  ])("creates a common-provider alias for %j / %j", (serverName, toolName) => {
    const alias = createMcpToolIdentity(serverName, toolName).providerName;
    expect(alias).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(isValidMcpProviderName(alias)).toBe(true);
  });

  it("rejects empty original identity components", () => {
    expect(() => createMcpToolIdentity("", "tool")).toThrow("serverName");
    expect(() => createMcpToolIdentity("server", "")).toThrow("toolName");
  });

  it("separates identities that slug replacement or delimiter parsing would collapse", () => {
    const pairs: Array<[string, string]> = [
      ["a b", "tool"],
      ["a-b", "tool"],
      ["server", "a b"],
      ["server", "a-b"],
      ["a", "b__c"],
      ["a__b", "c"],
    ];
    const aliases = pairs.map(
      ([serverName, toolName]) => createMcpToolIdentity(serverName, toolName).providerName,
    );
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("is stable across repeated construction and discovery permutations", () => {
    const pairs: Array<[string, string]> = [
      ["safe", "one"],
      ["unsafe server", "two"],
      ["safe", "three:four"],
    ];
    const aliases = new Map(
      pairs.map(([serverName, toolName]) => [
        JSON.stringify([serverName, toolName]),
        createMcpToolIdentity(serverName, toolName).providerName,
      ]),
    );

    for (const [serverName, toolName] of [...pairs].reverse()) {
      expect(createMcpToolIdentity(serverName, toolName).providerName).toBe(
        aliases.get(JSON.stringify([serverName, toolName])),
      );
    }
  });

  it("locks fixed digest vectors and reserves the real server name id", () => {
    expect(createMcpToolIdentity("server name", "tool:name").providerName).toBe(
      "mcp__id__p2PeWPjYNf763cgkt0G1Weiab6CHAUVyf-wG602yBlY",
    );
    expect(createMcpToolIdentity("日本語", "space tool").providerName).toBe(
      "mcp__id__2G_vDRH4CbsaCBpaTly_zyokMSxKE9pqic301eTViJ4",
    );
    expect(createMcpToolIdentity("id", "tool").providerName).toBe(
      "mcp__id__kVzvL7-Z93DYv9lqfEUOBHdM7_g0gFG3EYj3g2tQ62Y",
    );
    expect(createMcpToolIdentity("id", "tool").providerName).not.toBe("mcp__id__tool");
  });

  it("attaches exact non-serialized identity metadata", () => {
    const identity = createMcpToolIdentity("server name", "tool:name");
    const attached = withMcpToolIdentity(tool(identity.providerName), identity);
    expect(getMcpToolIdentity(attached)).toEqual(identity);
    expect(sameMcpToolIdentity(attached, identity)).toBe(true);
    expect(Object.keys(attached)).not.toContain("mcpToolIdentity");
    expect(JSON.stringify(attached)).not.toContain("server name");
  });

  it("drops every duplicate declaration while retaining unrelated tools and warning once", () => {
    const definitions = [
      { name: "same", schema: 1 },
      { name: "other", schema: 2 },
      { name: "same", schema: 3 },
      { name: "third", schema: 4 },
      { name: "third", schema: 5 },
    ];
    expect(dedupeMcpToolDefinitions(definitions)).toEqual([{ name: "other", schema: 2 }]);
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith(
      "WARN",
      "mcp",
      expect.stringContaining("duplicate tool names"),
      { duplicateNames: ["same", "third"] },
    );
  });
});
