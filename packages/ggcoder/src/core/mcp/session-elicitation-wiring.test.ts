import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MCPConnectResult, MCPElicitHandler } from "./client.js";
import { SharedMcpPool, type SharedConnector } from "./shared-pool.js";
import type { MCPServerConfig } from "./types.js";

/**
 * Guards the wiring that makes one MCP process serve a whole window.
 *
 * A daemon window runs THREE sessions — the coding agent, Ken chat, and Ken
 * autopilot — and every one of them connects to the same MCP servers. They only
 * collapse onto a single child process if they agree on one thing: whether they
 * can prompt the user.
 *
 * That is not a stylistic detail. A connection declares its elicitation
 * capability once, at initialize, and servers use that declaration to decide
 * whether to ask at all — so the pool cannot hand a prompting session and a
 * headless one the same connection without lying to one of them. It keys them
 * apart instead (see shared-pool.ts `keyFor`).
 *
 * The regression this file exists to catch: Ken's two factories originally
 * omitted `onMcpElicit`, which made them headless, which split the pool, which
 * produced a SECOND kencode-search process per daemon — measured, before the
 * fix, as 2 processes for 6 sessions instead of 1. Nothing else failed, which is
 * exactly why it needs a test.
 */

const APP_SIDECAR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../app-sidecar.ts",
);

/**
 * Extract the object literal passed to each `new AgentSession({ ... })`.
 *
 * Brace-balanced rather than regex-terminated: these literals contain nested
 * callbacks with their own braces, so a non-greedy match would stop at the
 * first inner `}` and silently "pass" by inspecting a fragment.
 */
function agentSessionOptionBlocks(source: string): string[] {
  const blocks: string[] = [];
  const marker = "new AgentSession({";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) return blocks;
    let depth = 0;
    let end = start + marker.length - 1;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(start, end + 1));
    from = end + 1;
  }
}

describe("app-sidecar wires every window session for elicitation", () => {
  it("passes an elicit handler to all three session factories", async () => {
    const source = await fs.readFile(APP_SIDECAR, "utf8");
    const blocks = agentSessionOptionBlocks(source);

    // Coding agent + Ken chat + Ken autopilot. If this count changes, a new
    // session kind was added and it needs the same wiring decision made
    // deliberately rather than inherited by accident.
    expect(blocks).toHaveLength(3);

    for (const block of blocks) {
      // Either wired directly, or via the shared base options object that
      // carries `onMcpElicit` for the coding session.
      const wired = block.includes("onMcpElicit") || block.includes("...baseSessionOptions");
      expect(wired).toBe(true);
    }
  });

  /**
   * Named factories specifically, so the assertion above cannot be satisfied by
   * three blocks that happen to be the wrong three.
   */
  it("wires Ken chat and Ken autopilot specifically, not just the coding agent", async () => {
    const source = await fs.readFile(APP_SIDECAR, "utf8");

    for (const factory of ["ensureKenSession", "ensureKenAutoSession"]) {
      const start = source.indexOf(`async function ${factory}(`);
      expect(start, `${factory} should exist`).toBeGreaterThan(-1);
      const [options] = agentSessionOptionBlocks(source.slice(start));
      expect(options, `${factory} should construct an AgentSession`).toBeDefined();
      expect(options).toContain("onMcpElicit");
    }
  });

  /** `onMcpElicit` must still be the option AgentSession forwards to MCP. */
  it("forwards that option into the MCP client as onElicit", async () => {
    const agentSession = await fs.readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../agent-session.ts"),
      "utf8",
    );
    expect(agentSession).toContain("onElicit: this.opts.onMcpElicit");
  });
});

describe("pool keying for a window's three sessions", () => {
  const config: MCPServerConfig = { name: "kencode-search", command: "npx" };

  function connector(spawns: { count: number }): SharedConnector {
    spawns.count += 1;
    return {
      connect: async (target): Promise<MCPConnectResult> => ({
        name: target.name,
        ok: true,
        toolCount: 0,
        tools: [],
      }),
      dispose: async () => {},
    };
  }

  const handler: MCPElicitHandler = async () => ({ action: "cancel" });

  /** The shipped arrangement: coding + Ken chat + Ken autopilot, all windowed. */
  it("gives all three a single shared connection when each can prompt", async () => {
    const pool = new SharedMcpPool();
    const spawns = { count: 0 };

    const coding = await pool.acquire(config, () => connector(spawns), { onElicit: handler });
    const kenChat = await pool.acquire(config, () => connector(spawns), { onElicit: handler });
    const kenAuto = await pool.acquire(config, () => connector(spawns), { onElicit: handler });

    expect(spawns.count).toBe(1);
    expect(pool.size).toBe(1);
    expect(pool.refCount(config, { onElicit: handler })).toBe(3);

    await coding.release();
    await kenChat.release();
    await kenAuto.release();
    expect(pool.size).toBe(0);
  });

  /**
   * The regression, reproduced: drop the handler from Ken's sessions and the
   * pool splits — one connection for the coding agent, a second for the two
   * headless Ken sessions. Two processes where there should be one.
   */
  it("splits into a second connection when Ken's sessions cannot prompt", async () => {
    const pool = new SharedMcpPool();
    const spawns = { count: 0 };

    await pool.acquire(config, () => connector(spawns), { onElicit: handler });
    await pool.acquire(config, () => connector(spawns), {});
    await pool.acquire(config, () => connector(spawns), {});

    expect(spawns.count).toBe(2);
    expect(pool.size).toBe(2);
  });
});
