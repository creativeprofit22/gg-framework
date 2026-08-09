import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpCatalogCache } from "./catalog-cache.js";
import { MCPClientManager, type MCPConnectResult } from "./client.js";
import { DEFAULT_MCP_SERVERS } from "./defaults.js";
import {
  isShareableServer,
  SharedMcpPool,
  type SharedAcquireOptions,
  type SharedConnector,
} from "./shared-pool.js";
import type { MCPElicitHandler } from "./client.js";
import type { MCPServerConfig } from "./types.js";
import type { ToolContext } from "@kenkaiiii/gg-agent";

function toolContext(): ToolContext {
  return { signal: new AbortController().signal, toolCallId: "call-1" };
}

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const FIXTURE = path.join(FIXTURE_DIR, "legacy-mcp-server.mjs");
const ELICIT_FIXTURE = path.join(FIXTURE_DIR, "elicit-mcp-server.mjs");

let dir: string;
let cachePath: string;
const managers: MCPClientManager[] = [];
const pools: SharedMcpPool[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-shared-"));
  cachePath = path.join(dir, "mcp-catalog.json");
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.dispose()));
  await Promise.all(pools.splice(0).map((pool) => pool.disposeAll()));
  await fs.rm(dir, { recursive: true, force: true });
});

function newPool(): SharedMcpPool {
  const pool = new SharedMcpPool();
  pools.push(pool);
  return pool;
}

/** A manager wired to a test-local pool, standing in for one session. */
function session(pool: SharedMcpPool): MCPClientManager {
  const instance = new MCPClientManager({
    catalogCache: new McpCatalogCache(cachePath),
    sharedPool: pool,
  });
  managers.push(instance);
  return instance;
}

/**
 * A real stdio MCP server, tagged with a marker argument so its process can be
 * counted in `ps` and so each test gets its own pool key (args are part of the
 * config hash).
 */
function sharedFixture(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "shared-fixture",
    command: process.execPath,
    args: [FIXTURE, `--gg-marker=${crypto.randomUUID()}`],
    timeout: 10_000,
    ...overrides,
  };
}

/** Live child processes carrying this config's marker argument. */
function processCount(config: MCPServerConfig): number {
  const marker = config.args?.find((arg) => arg.startsWith("--gg-marker="));
  if (!marker) throw new Error("fixture config has no marker argument");
  const out = execFileSync("ps", ["-eo", "command"], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes(marker)).length;
}

function fakeConnector(log: string[], name = "fake"): SharedConnector {
  return {
    connect: async (config) => {
      log.push(`connect:${config.name}`);
      return { name: config.name, ok: true, toolCount: 0, tools: [] } satisfies MCPConnectResult;
    },
    dispose: async () => {
      log.push(`dispose:${name}`);
    },
  };
}

describe("isShareableServer", () => {
  /** Sharing is the default for stdio: no config change makes a server share. */
  it("shares any stdio server by default", () => {
    expect(isShareableServer({ name: "s", command: "node" })).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    expect(isShareableServer({ name: "s", command: "node", shared: false })).toBe(false);
  });

  /** Sharing collapses duplicate processes; HTTP has none and carries auth. */
  it("never shares an HTTP server, even when explicitly asked to", () => {
    expect(isShareableServer({ name: "s", url: "https://x.test/mcp", shared: true })).toBe(false);
  });

  it("shares every default server, kencode-search included", () => {
    const stdio = DEFAULT_MCP_SERVERS.filter((s) => s.command);
    expect(stdio.length).toBeGreaterThan(0);
    expect(stdio.every((s) => isShareableServer(s))).toBe(true);
  });
});

describe("SharedMcpPool refcounting", () => {
  const config: MCPServerConfig = { name: "pooled", command: "node" };

  it("connects once for two acquirers and disposes only after both release", async () => {
    const log: string[] = [];
    const pool = newPool();
    let built = 0;
    const factory = () => {
      built += 1;
      return fakeConnector(log);
    };

    const first = await pool.acquire(config, factory);
    const second = await pool.acquire(config, factory);

    expect(built).toBe(1);
    expect(log).toEqual(["connect:pooled"]);
    expect(pool.refCount(config)).toBe(2);

    await first.release();
    expect(log).toEqual(["connect:pooled"]); // still held by the second session
    expect(pool.refCount(config)).toBe(1);

    await second.release();
    expect(log).toEqual(["connect:pooled", "dispose:fake"]);
    expect(pool.refCount(config)).toBe(0);
    expect(pool.size).toBe(0);
  });

  it("shares one in-flight connect between concurrent acquirers", async () => {
    const pool = newPool();
    let built = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = (): SharedConnector => {
      built += 1;
      return {
        connect: async (target) => {
          await gate;
          return { name: target.name, ok: true, toolCount: 0, tools: [] };
        },
        dispose: async () => {},
      };
    };

    const both = Promise.all([pool.acquire(config, factory), pool.acquire(config, factory)]);
    release();
    const [a, b] = await both;

    expect(built).toBe(1);
    expect(a.result.ok && b.result.ok).toBe(true);
    expect(pool.refCount(config)).toBe(2);
  });

  /** Session dispose can run twice; a double release must not evict early. */
  it("ignores a repeated release instead of dropping another session's claim", async () => {
    const log: string[] = [];
    const pool = newPool();
    const factory = () => fakeConnector(log);

    const first = await pool.acquire(config, factory);
    const second = await pool.acquire(config, factory);

    await first.release();
    await first.release();

    expect(log).toEqual(["connect:pooled"]);
    expect(pool.refCount(config)).toBe(1);

    await second.release();
    expect(log).toEqual(["connect:pooled", "dispose:fake"]);
  });

  it("does not pool a failed connection, so a later session retries", async () => {
    const pool = newPool();
    let attempts = 0;
    const factory = (): SharedConnector => ({
      connect: async (target) => {
        attempts += 1;
        if (attempts === 1) {
          return { name: target.name, ok: false, toolCount: 0, tools: [], error: "boom" };
        }
        return { name: target.name, ok: true, toolCount: 0, tools: [] };
      },
      dispose: async () => {},
    });

    const failed = await pool.acquire(config, factory);
    expect(failed.result.ok).toBe(false);
    expect(pool.size).toBe(0);

    const retried = await pool.acquire(config, factory);
    expect(retried.result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  /**
   * Elicitation is the one genuinely per-window concern on a shared connection:
   * "ask the user" has to name a window. The pool routes each request to the
   * session that has a tool call in flight, which is by definition the one that
   * provoked it.
   */
  describe("elicitation routing", () => {
    /** Captures the handler the pool installs on the shared connection. */
    function connectorCapturingElicit(sink: { onElicit?: MCPElicitHandler }) {
      return (opts: SharedAcquireOptions): SharedConnector => {
        sink.onElicit = opts.onElicit;
        return {
          connect: async (target) => ({ name: target.name, ok: true, toolCount: 0, tools: [] }),
          dispose: async () => {},
        };
      };
    }

    const request = { server: "pooled", message: "who?", requestedSchema: {} };

    it("routes a prompt to the session whose tool call is in flight", async () => {
      const pool = newPool();
      const sink: { onElicit?: MCPElicitHandler } = {};
      const seen: string[] = [];
      const handlerFor = (id: string): MCPElicitHandler => {
        return async () => {
          seen.push(id);
          return { action: "accept", content: { id } };
        };
      };

      const windowA = await pool.acquire(config, connectorCapturingElicit(sink), {
        onElicit: handlerFor("A"),
      });
      const windowB = await pool.acquire(config, connectorCapturingElicit(sink), {
        onElicit: handlerFor("B"),
      });

      // Only window B is mid-call, so only B's window should see the form.
      const endB = windowB.beginCall();
      const result = await sink.onElicit!(request);
      endB();

      expect(seen).toEqual(["B"]);
      expect(result).toEqual({ action: "accept", content: { id: "B" } });
      await windowA.release();
      await windowB.release();
    });

    /** Guessing would show one project's consent form in another's window. */
    it("cancels rather than guessing when two sessions are calling at once", async () => {
      const pool = newPool();
      const sink: { onElicit?: MCPElicitHandler } = {};
      let prompted = 0;
      const handler: MCPElicitHandler = async () => {
        prompted++;
        return { action: "accept", content: {} };
      };

      const windowA = await pool.acquire(config, connectorCapturingElicit(sink), {
        onElicit: handler,
      });
      const windowB = await pool.acquire(config, connectorCapturingElicit(sink), {
        onElicit: handler,
      });

      const endA = windowA.beginCall();
      const endB = windowB.beginCall();
      expect(await sink.onElicit!(request)).toEqual({ action: "cancel" });
      expect(prompted).toBe(0);
      endA();
      endB();
      await windowA.release();
      await windowB.release();
    });

    it("cancels an unsolicited prompt that belongs to no call", async () => {
      const pool = newPool();
      const sink: { onElicit?: MCPElicitHandler } = {};
      const handle = await pool.acquire(config, connectorCapturingElicit(sink), {
        onElicit: async () => ({ action: "accept", content: {} }),
      });

      expect(await sink.onElicit!(request)).toEqual({ action: "cancel" });
      await handle.release();
    });

    /**
     * A connection declares its elicitation capability once, at initialize, and
     * servers use that to decide whether to ask at all. So a headless caller
     * (CLI, JSON mode) gets its OWN connection that declares nothing, rather
     * than sharing one that promises prompting it cannot deliver.
     */
    it("separates headless callers from windowed ones, and declares no handler for them", async () => {
      const pool = newPool();
      const headlessSink: { onElicit?: MCPElicitHandler } = {};
      const windowedSink: { onElicit?: MCPElicitHandler } = {};

      const headless = await pool.acquire(config, connectorCapturingElicit(headlessSink), {});
      const windowed = await pool.acquire(config, connectorCapturingElicit(windowedSink), {
        onElicit: async () => ({ action: "accept", content: { from: "window" } }),
      });

      expect(pool.size).toBe(2);
      // No dispatcher on the headless connection => it declares no capability.
      expect(headlessSink.onElicit).toBeUndefined();
      expect(windowedSink.onElicit).toBeDefined();

      const end = windowed.beginCall();
      expect(await windowedSink.onElicit!(request)).toEqual({
        action: "accept",
        content: { from: "window" },
      });
      end();
      await headless.release();
      await windowed.release();
    });
  });

  it("keeps distinct configs and protocol eras in separate entries", async () => {
    const pool = newPool();
    const log: string[] = [];
    const factory = () => fakeConnector(log);

    await pool.acquire(config, factory);
    await pool.acquire({ ...config, args: ["--different"] }, factory);
    await pool.acquire(config, factory, { modernProtocol: true });

    expect(pool.size).toBe(3);
  });
});

/**
 * The user-visible claim: two sessions on one machine share ONE child process,
 * and that process outlives the first session's dispose. Counted in `ps`,
 * because a refcount in memory is not what was costing 43 MB per session.
 */
describe.skipIf(process.platform === "win32")(
  "shared servers across two sessions (real child process)",
  () => {
    it("spawns one process for two sessions and kills it only after both dispose", async () => {
      const config = sharedFixture();
      const pool = newPool();
      const sessionA = session(pool);
      const sessionB = session(pool);

      const resultA = await sessionA.connectAllDetailed([config]);
      const resultB = await sessionB.connectAllDetailed([config]);

      // Both sessions get working tools...
      expect(resultA[0]?.ok).toBe(true);
      expect(resultB[0]?.ok).toBe(true);
      expect(resultA[0]?.tools.map((t) => t.name)).toEqual(["mcp__shared-fixture__echo"]);
      expect(resultB[0]?.tools.map((t) => t.name)).toEqual(["mcp__shared-fixture__echo"]);

      // ...from a single child process.
      expect(processCount(config)).toBe(1);
      expect(pool.refCount(config)).toBe(2);

      // A tool call still works through the shared connection.
      const echo = await resultB[0]!.tools[0]!.execute({ text: "hello" }, toolContext());
      expect(echo).toBe("hello");

      // First session leaving must not take the other session's server with it.
      await sessionA.dispose();
      expect(processCount(config)).toBe(1);
      expect(pool.refCount(config)).toBe(1);

      // Last one out turns off the lights.
      await sessionB.dispose();
      await waitForProcessExit(config);
      expect(processCount(config)).toBe(0);
      expect(pool.size).toBe(0);
    }, 40_000);

    /** Opted-out servers must keep per-session isolation. */
    it("still gives each session its own process when the server opts out", async () => {
      const config = sharedFixture({ shared: false });
      const pool = newPool();

      await session(pool).connectAllDetailed([config]);
      await session(pool).connectAllDetailed([config]);

      expect(processCount(config)).toBe(2);
      expect(pool.size).toBe(0);
    }, 40_000);

    /**
     * A pooled child that dies must not become a permanent daemon-wide outage.
     *
     * Stdio servers have no in-call recovery on purpose (`canRecoverSession`
     * excludes them: respawning a child mid-call would be a surprise). Before
     * pooling, a crash broke the one session that owned it. Shared, the same
     * crash would break every holder AND every session that connects later,
     * because the pool would keep handing out the corpse. The connection must
     * therefore retire itself on close.
     */
    it("retires a shared connection whose server dies, so the next session reconnects", async () => {
      const config = sharedFixture();
      const pool = newPool();

      const first = session(pool);
      const [connected] = await first.connectAllDetailed([config]);
      expect(connected?.ok).toBe(true);
      expect(pool.size).toBe(1);

      // Kill the child out from under the pool, exactly like a crash. Located
      // with `ps` rather than `pgrep`, whose BSD build reads this fixture's
      // leading `--` marker as an illegal option.
      const marker = config.args!.find((arg) => arg.startsWith("--gg-marker="))!;
      const row = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" })
        .split("\n")
        .find((line) => line.includes(marker));
      expect(row, "the shared child should be running").toBeDefined();
      process.kill(Number(row!.trim().split(/\s+/)[0]), "SIGKILL");

      // Give the transport's close event a moment to propagate.
      const deadline = Date.now() + 5000;
      while (pool.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // The dead entry is gone rather than cached forever...
      expect(pool.size).toBe(0);

      // ...so a session connecting afterwards gets a working server again.
      const second = session(pool);
      const [reconnected] = await second.connectAllDetailed([config]);
      expect(reconnected?.ok).toBe(true);
      expect(processCount(config)).toBe(1);

      const echo = await reconnected!.tools[0]!.execute({ text: "alive" }, toolContext());
      expect(echo).toBe("alive");
    }, 40_000);

    /**
     * End-to-end proof of the mechanism that makes default-on sharing safe: a
     * REAL server elicits mid tool call over a connection two sessions share,
     * and the prompt reaches the window that made the call — not the other one.
     */
    it("routes a real server's mid-call prompt to the calling session's window", async () => {
      const config: MCPServerConfig = {
        name: "elicit-fixture",
        command: process.execPath,
        args: [ELICIT_FIXTURE, `--gg-marker=${crypto.randomUUID()}`],
        timeout: 10_000,
      };
      const pool = newPool();
      const prompted: string[] = [];
      const windowed = (id: string): MCPClientManager => {
        const instance = new MCPClientManager({
          catalogCache: new McpCatalogCache(cachePath),
          sharedPool: pool,
          modernProtocol: true,
          onElicit: async () => {
            prompted.push(id);
            return { action: "accept", content: { name: id } };
          },
        });
        managers.push(instance);
        return instance;
      };

      const sessionA = windowed("window-A");
      const sessionB = windowed("window-B");
      const [connectedA] = await sessionA.connectAllDetailed([config]);
      await sessionB.connectAllDetailed([config]);

      // One shared child serves both windows.
      expect(processCount(config)).toBe(1);

      // Window A makes the call, so window A must be the one that is asked.
      const ask = connectedA!.tools.find((tool) => tool.name.endsWith("__ask"));
      const answer = await ask!.execute({}, toolContext());

      expect(prompted).toEqual(["window-A"]);
      expect(answer).toContain("window-A");
      expect(answer).toContain("accept");
    }, 40_000);
  },
);

/** Child exit is asynchronous after `close()`; poll briefly rather than sleep. */
async function waitForProcessExit(config: MCPServerConfig, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processCount(config) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
