import { createHash } from "node:crypto";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { log } from "../logger.js";

const MCP_TOOL_IDENTITY_VERSION = 1 as const;
const MCP_TOOL_DIGEST_PREFIX = "ggcoder:mcp-tool:v1\0";
const READABLE_COMPONENT_PATTERN = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;
const MCP_PROVIDER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MCP_TOOL_IDENTITY = Symbol("ggcoder.mcpToolIdentity");

export interface McpToolIdentity {
  readonly version: 1;
  /** Exact configured MCP server name. */
  readonly serverName: string;
  /** Exact MCP listTools/callTool name. */
  readonly toolName: string;
  /** Provider-valid alias exposed to the model. */
  readonly providerName: string;
}

type IdentityBearingTool = AgentTool & {
  readonly [MCP_TOOL_IDENTITY]?: McpToolIdentity;
};

export function isValidMcpProviderName(name: string): boolean {
  return MCP_PROVIDER_NAME_PATTERN.test(name);
}

function requireSourceName(value: string, field: "serverName" | "toolName"): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`MCP ${field} must be a non-empty string`);
  }
}

function fallbackProviderName(serverName: string, toolName: string): string {
  const digest = createHash("sha256")
    .update(MCP_TOOL_DIGEST_PREFIX, "utf8")
    .update(JSON.stringify([serverName, toolName]), "utf8")
    .digest("base64url");
  return `mcp__id__${digest}`;
}

export function createMcpToolIdentity(serverName: string, toolName: string): McpToolIdentity {
  requireSourceName(serverName, "serverName");
  requireSourceName(toolName, "toolName");

  const readableProviderName = `mcp__${serverName}__${toolName}`;
  const providerName =
    serverName !== "id" &&
    READABLE_COMPONENT_PATTERN.test(serverName) &&
    READABLE_COMPONENT_PATTERN.test(toolName) &&
    isValidMcpProviderName(readableProviderName)
      ? readableProviderName
      : fallbackProviderName(serverName, toolName);

  return Object.freeze({
    version: MCP_TOOL_IDENTITY_VERSION,
    serverName,
    toolName,
    providerName,
  });
}

function isMcpToolIdentity(value: unknown): value is McpToolIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<McpToolIdentity>;
  if (
    candidate.version !== MCP_TOOL_IDENTITY_VERSION ||
    typeof candidate.serverName !== "string" ||
    typeof candidate.toolName !== "string" ||
    typeof candidate.providerName !== "string"
  ) {
    return false;
  }

  try {
    return (
      createMcpToolIdentity(candidate.serverName, candidate.toolName).providerName ===
      candidate.providerName
    );
  } catch {
    return false;
  }
}

export function withMcpToolIdentity<T extends AgentTool>(
  agentTool: T,
  identity: McpToolIdentity,
): T {
  if (!isMcpToolIdentity(identity) || agentTool.name !== identity.providerName) {
    throw new TypeError("MCP tool identity does not match its provider-facing name");
  }
  Object.defineProperty(agentTool, MCP_TOOL_IDENTITY, {
    value: identity,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return agentTool;
}

export function getMcpToolIdentity(tool: unknown): McpToolIdentity | undefined {
  if (typeof tool !== "object" || tool === null) return undefined;
  const identity = (tool as IdentityBearingTool)[MCP_TOOL_IDENTITY];
  return isMcpToolIdentity(identity) ? identity : undefined;
}

function identityFrom(value: unknown): McpToolIdentity | undefined {
  return isMcpToolIdentity(value) ? value : getMcpToolIdentity(value);
}

export function sameMcpToolIdentity(a: unknown, b: unknown): boolean {
  const left = identityFrom(a);
  const right = identityFrom(b);
  return (
    left !== undefined &&
    right !== undefined &&
    left.version === right.version &&
    left.serverName === right.serverName &&
    left.toolName === right.toolName &&
    left.providerName === right.providerName
  );
}

/**
 * MCP dispatch identifies tools by name alone. If a server declares that name
 * more than once, omit every conflicting declaration rather than letting server
 * order choose which schema is shown and which implementation receives calls.
 */
export function dedupeMcpToolDefinitions<T extends { name: string }>(tools: readonly T[]): T[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);

  const duplicateNames = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicateNames.length > 0) {
    log("WARN", "mcp", "MCP server declared duplicate tool names; omitting all duplicates", {
      duplicateNames,
    });
  }

  return tools.filter((tool) => counts.get(tool.name) === 1);
}
