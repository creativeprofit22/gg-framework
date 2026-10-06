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
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { normalizePromptMeta } from "@kenkaiiii/gg-core/desktop-session-ux";

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

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-project-"));
  restoreHome = useFakeHome(tmpHome);
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
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function makeSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    systemPrompt: "test system prompt",
    transient: true,
  });
  await session.initialize();
  return session;
}

describe("prompt display metadata validation", () => {
  it("copies supported fields and discards model instructions and malformed segments", () => {
    expect(
      normalizePromptMeta({
        kenSent: true,
        instructions: "not display metadata",
        enhancements: [{ kind: "text", text: "hello", extra: "ignored" }],
      }),
    ).toEqual({ kenSent: true, enhancements: [{ kind: "text", text: "hello" }] });
    for (const enhancements of [
      [null],
      [{ kind: "term", text: "missing original" }],
      [{ kind: "term", text: "term", original: "old", note: 42 }],
      "not segments",
    ]) {
      expect(normalizePromptMeta({ kenSent: true, enhancements })).toEqual({ kenSent: true });
    }
    expect(normalizePromptMeta({ kenSent: "true" })).toBeUndefined();
    expect(normalizePromptMeta(null)).toBeUndefined();
    expect(normalizePromptMeta([])).toBeUndefined();
  });
});

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
      const meta = {
        kenSent: true,
        enhancements: [
          {
            kind: "term" as const,
            text: "second",
            original: "original second",
            note: "Display only",
          },
        ],
      };
      expect(session.queueMessage("second", [att], meta)).toBe(2);
      meta.enhancements[0].note = "Changed after enqueue";
      expect(session.getQueuedCount()).toBe(2);

      const a = session.takeNextQueuedMessage();
      expect(a).toEqual({ id: "q1", text: "first", attachments: [] });
      const b = session.takeNextQueuedMessage();
      expect(b?.text).toBe("second");
      // Attachments survive the take — drainQueue would have dropped them.
      expect(b?.attachments).toEqual([att]);
      expect(b?.id).toBe("q2");
      expect(b?.meta).toEqual({
        kenSent: true,
        enhancements: [
          { kind: "term", text: "second", original: "original second", note: "Display only" },
        ],
      });

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

describe("AgentSession queue — deferred prompts", () => {
  it("wait out the run: no interrupt, no steering drain, then FIFO and cancellable", async () => {
    const session = await makeSession();
    try {
      const interrupts = vi.fn();
      (session as unknown as { steeringListeners: Set<() => void> }).steeringListeners.add(
        interrupts,
      );
      await session.queuePrompt("first", [], undefined, { deferred: true });
      await session.queuePrompt("second", [], undefined, { deferred: true });
      await session.queuePrompt("third", [], undefined, { deferred: true });
      session.queueMessage("steer now");
      expect(interrupts).toHaveBeenCalledTimes(1);

      const steering = (
        session as unknown as { getHookSteeringMessages(): Array<{ content: unknown }> | null }
      ).getHookSteeringMessages();
      expect(JSON.stringify(steering)).toContain("steer now");
      expect(JSON.stringify(steering)).not.toContain("first");
      expect(session.listQueuedMessages().map((m) => m.text)).toEqual(["first", "second", "third"]);

      expect(session.cancelQueuedMessage(session.listQueuedMessages()[1]!.id)).toBe(true);
      expect(session.takeNextQueuedMessage()?.text).toBe("first");
      expect(session.takeNextQueuedMessage()?.text).toBe("third");
      expect(session.takeNextQueuedMessage()).toBeNull();
    } finally {
      await session.dispose();
    }
  });

  it("leave template commands unexpanded for the later send, unlike steering entries", async () => {
    const commands = path.join(tmpProject, ".gg", "commands");
    await fs.mkdir(commands, { recursive: true });
    await fs.writeFile(path.join(commands, "shipit.md"), "Ship the release now.", "utf-8");
    const session = await makeSession();
    try {
      await session.queuePrompt("/shipit later", [], undefined, { deferred: true });
      await session.queuePrompt("/shipit now");

      const deferred = session.takeNextQueuedMessage();
      expect(deferred?.text).toBe("/shipit later");
      expect(deferred?.deferred).toBe(true);
      expect(deferred?.modelText).toBeUndefined();

      const steering = session.takeNextQueuedMessage();
      expect(steering?.text).toBe("/shipit now");
      expect(steering?.modelText).toContain("Ship the release now.");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("do not block post-turn compaction, while steering entries still do", async () => {
    const session = await makeSession();
    try {
      const internal = session as unknown as {
        compactionOccurred: boolean;
        observePlanStepProgress: (...args: unknown[]) => void;
        maybeCompactPostTurn(creds: { accessToken: string }): void;
      };
      // compactionOccurred short-circuits right after the guards; reaching
      // observePlanStepProgress proves the queue guard let the attempt through.
      internal.compactionOccurred = true;
      const passedGuards = vi.fn();
      internal.observePlanStepProgress = passedGuards;

      await session.queuePrompt("later", [], undefined, { deferred: true });
      internal.maybeCompactPostTurn({ accessToken: "t" });
      expect(passedGuards).toHaveBeenCalledTimes(1);

      session.queueMessage("steer now");
      internal.maybeCompactPostTurn({ accessToken: "t" });
      expect(passedGuards).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });
});

describe("AgentSession queue — per-message cancellation", () => {
  it("lists pending messages with stable ids", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      session.queueMessage("second");
      const listed = session.listQueuedMessages();
      expect(listed.map((m) => m.text)).toEqual(["first", "second"]);
      // Ids must be distinct and stable across reads, since the client holds
      // them between rendering a cancel affordance and the click arriving.
      expect(new Set(listed.map((m) => m.id)).size).toBe(2);
      expect(session.listQueuedMessages().map((m) => m.id)).toEqual(listed.map((m) => m.id));
    } finally {
      await session.dispose();
    }
  });

  it("cancels one message by id and leaves the rest in order", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      session.queueMessage("second");
      session.queueMessage("third");
      const [, middle] = session.listQueuedMessages();

      expect(session.cancelQueuedMessage(middle!.id)).toBe(true);
      expect(session.listQueuedMessages().map((m) => m.text)).toEqual(["first", "third"]);
      expect(session.getQueuedCount()).toBe(2);
    } finally {
      await session.dispose();
    }
  });

  it("reports false for an id that already drained, rather than throwing", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      const [only] = session.listQueuedMessages();
      session.takeNextQueuedMessage();

      // The normal race: the agent consumed it between render and click.
      expect(session.cancelQueuedMessage(only!.id)).toBe(false);
      expect(session.getQueuedCount()).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it("does not reuse ids after a cancel, so a stale click cannot hit a new message", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      const [first] = session.listQueuedMessages();
      session.cancelQueuedMessage(first!.id);
      session.queueMessage("second");

      const [second] = session.listQueuedMessages();
      expect(second!.id).not.toBe(first!.id);
      // A late click carrying the old id must be a no-op, not a cancel of the
      // message that happens to occupy the same position now.
      expect(session.cancelQueuedMessage(first!.id)).toBe(false);
      expect(session.listQueuedMessages().map((m) => m.text)).toEqual(["second"]);
    } finally {
      await session.dispose();
    }
  });
});
