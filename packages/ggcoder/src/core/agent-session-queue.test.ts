/**
 * Queue semantics the sidecar's stranded-queue drain depends on: a message
 * queued while autopilot reviews (no run in flight) must come back OUT of the
 * queue intact — text AND attachments — in FIFO order, exactly once.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as McpModule from "./mcp/index.js";

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return {
    ...actual,
    agentLoop: agentLoopMock,
  };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return {
        connectAll: vi.fn(async () => []),
        dispose: vi.fn(async () => {}),
      };
    }),
  };
});

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let tmpHome: string;
let tmpProject: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-project-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  agentLoopMock.mockReset();
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function makeSession(transient = true) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    systemPrompt: "test system prompt",
    transient,
  });
  await session.initialize();
  return session;
}

describe("AgentSession queue — takeNextQueuedMessage", () => {
  it("returns queued messages FIFO with attachments preserved, then null", async () => {
    const session = await makeSession();
    try {
      const att = {
        kind: "image" as const,
        name: "x.png",
        mediaType: "image/png",
        data: "AAAA",
        path: "/x.png",
      };
      expect(session.queueMessage("first")).toBe(1);
      expect(session.queueMessage("second", [att], { kenSent: true })).toBe(2);
      expect(session.getQueuedCount()).toBe(2);

      const a = session.takeNextQueuedMessage();
      expect(a).toEqual({ text: "first", attachments: [] });
      const b = session.takeNextQueuedMessage();
      expect(b?.text).toBe("second");
      // Attachments survive the take — drainQueue would have dropped them.
      expect(b?.attachments).toEqual([att]);
      expect(b?.meta).toEqual({ kenSent: true });

      expect(session.getQueuedCount()).toBe(0);
      expect(session.takeNextQueuedMessage()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 15_000);

  it("take and drain never double-deliver the same message", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("only one");
      expect(session.takeNextQueuedMessage()?.text).toBe("only one");
      // Already taken — a subsequent cancel-path drain finds nothing.
      expect(session.drainQueue()).toBe("");
      expect(session.getQueuedCount()).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it("injects queued metadata once and persists its marker at the drained user slot", async () => {
    let firstSteering: Message[] | null | undefined;
    let secondSteering: Message[] | null | undefined;
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: GgAgentModule.AgentOptions,
    ) {
      firstSteering = await options.getSteeringMessages?.();
      if (firstSteering) messages.push(...firstSteering);
      secondSteering = await options.getSteeringMessages?.();
      yield { type: "agent_done" };
    });

    const session = await makeSession(false);
    const sessionPath = session.getState().sessionPath;
    try {
      session.queueMessage("queued Ken prompt", [], { kenSent: true });
      await session.prompt("start the run");

      expect(firstSteering).toHaveLength(1);
      expect(secondSteering).toBeNull();
      expect(session.getQueuedCount()).toBe(0);
      expect(session.getAppMarkers()).toContainEqual({
        version: 1,
        kind: "user_hint",
        afterMessageCount: 2,
        data: { kenSent: true },
      });
    } finally {
      await session.dispose();
    }

    const { AgentSession } = await import("./agent-session.js");
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: sessionPath,
    });
    try {
      await resumed.initialize();
      expect(resumed.getAppMarkers()).toContainEqual({
        version: 1,
        kind: "user_hint",
        afterMessageCount: 2,
        data: { kenSent: true },
      });
    } finally {
      await resumed.dispose();
    }
  });

  it("drainQueue still returns merged text for the cancel path", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("alpha");
      session.queueMessage("beta");
      expect(session.drainQueue()).toBe("alpha\n\nbeta");
      expect(session.takeNextQueuedMessage()).toBeNull();
    } finally {
      await session.dispose();
    }
  });
});
