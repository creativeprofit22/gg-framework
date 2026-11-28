import type { AgentSession } from "../core/agent-session.js";
import { APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES } from "../app-sidecar-roadmap-tool-host.js";

/**
 * Ken's read-only tool allow-list, shared by the desktop sidecar and
 * `ggcoder acp`. Excludes every mutating tool so the mentor agent can research
 * and see, but never change the repo.
 *
 * Upstream keeps these helpers in this module; the Local Fork's monolithic
 * sidecar imports them from here too.
 */
export const KEN_ALLOWED_TOOLS: string[] = [...APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES];

/** MCP servers Ken is allowed to use. kencode-search lets him look into real
 *  public repos / verify against actual code instead of assuming — core to how
 *  he's meant to work. Read-only research; no other MCP server is connected. */
export const KEN_ALLOWED_MCP_SERVERS = ["kencode-search"];

/** Extract the plain text of the most recent assistant message (Ken's reply).
 *  Strips tool-call / image blocks, returning just the prose Ken streamed. */
export function lastAssistantText(messages: ReturnType<AgentSession["getMessages"]>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .map((c) => (c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}
