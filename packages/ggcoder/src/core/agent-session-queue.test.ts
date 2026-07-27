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
import type { ActivePhaseContextV1 } from "../phase-context.js";
import { canonicalProjectKey } from "../project-notes-repository.js";
import { SessionManager } from "./session-manager.js";

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

function activePhaseContext(
  sessionId: string,
  sessionPath: string,
  projectKey = canonicalProjectKey(tmpProject),
): ActivePhaseContextV1 {
  return {
    version: 1,
    projectKey,
    phase: {
      id: "phase-21",
      title: "Bound phase",
      goal: "Keep only this phase in context.",
      doneWhen: ["Resume restores planning state."],
      sourcePrompt: null,
      status: "not-started",
      archivedAt: null,
    },
    session: { sessionId, sessionPath },
    references: [],
    executionStage: "planning",
  };
}

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

async function rewriteSessionFile(
  sessionPath: string,
  rewrite: (line: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const lines = (await fs.readFile(sessionPath, "utf-8")).trimEnd().split("\n");
  const rewritten = lines.map((line) => JSON.stringify(rewrite(JSON.parse(line))));
  await fs.writeFile(sessionPath, `${rewritten.join("\n")}\n`, "utf-8");
}

describe("AgentSession active phase context", () => {
  it("rejects activation and keeps context inactive when required persistence fails", async () => {
    const session = await makeSession(false);
    const state = session.getState();
    const append = vi
      .spyOn(SessionManager.prototype, "appendRequiredEntry")
      .mockRejectedValueOnce(new Error("Failed to persist required active phase context."));
    try {
      await expect(
        session.setActivePhaseContext(activePhaseContext(state.sessionId, state.sessionPath)),
      ).rejects.toThrow("Failed to persist required active phase context.");
      expect(session.getActivePhaseContext()).toBeUndefined();
      expect(String(session.getMessages()[0]?.content)).not.toContain("Active Roadmap phase");
    } finally {
      append.mockRestore();
      await session.dispose();
    }
  });

  it("persists, restores, and rebuilds Plan Mode before resume", async () => {
    const original = await makeSession(false);
    const originalState = original.getState();
    await original.setActivePhaseContext(
      activePhaseContext(originalState.sessionId, originalState.sessionPath),
    );
    await original.updateActivePhaseStage("awaiting-approval", ".gg/plans/phase-21.md");
    await original.dispose();
    await rewriteSessionFile(originalState.sessionPath, (line) =>
      line.type === "session"
        ? { ...line, cwd: `${tmpProject}${path.sep}same-project${path.sep}..` }
        : line,
    );

    const { AgentSession } = await import("./agent-session.js");
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: originalState.sessionPath,
    });
    await resumed.initialize();
    try {
      expect(resumed.getPlanMode()).toBe(true);
      expect(resumed.getActivePhaseContext()).toMatchObject({
        projectKey: canonicalProjectKey(tmpProject),
        phase: { id: "phase-21" },
        executionStage: "awaiting-approval",
        approvedPlanPath: ".gg/plans/phase-21.md",
      });
      expect(String(resumed.getMessages()[0]?.content)).toContain("Active Roadmap phase");
      expect(String(resumed.getMessages()[0]?.content)).toContain('"id": "phase-21"');
    } finally {
      await resumed.dispose();
    }
  }, 15_000);

  it("rejects Resume when the session header belongs to another project", async () => {
    const original = await makeSession(false);
    const originalState = original.getState();
    await original.setActivePhaseContext(
      activePhaseContext(originalState.sessionId, originalState.sessionPath),
    );
    await original.dispose();

    const foreignProject = path.join(tmpProject, "foreign-project");
    await rewriteSessionFile(originalState.sessionPath, (line) =>
      line.type === "session" ? { ...line, cwd: foreignProject } : line,
    );

    const { AgentSession } = await import("./agent-session.js");
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: originalState.sessionPath,
    });
    try {
      await expect(resumed.initialize()).rejects.toThrow(
        "Cannot resume a session from another project",
      );
      expect(resumed.getActivePhaseContext()).toBeUndefined();
      expect(String(resumed.getMessages()[0]?.content)).not.toContain("Active Roadmap phase");
      expect(String(resumed.getMessages()[0]?.content)).not.toContain('"id": "phase-21"');
    } finally {
      await resumed.dispose();
    }
  }, 15_000);

  it("rejects Resume when durable phase context belongs to another project", async () => {
    const original = await makeSession(false);
    const originalState = original.getState();
    await original.setActivePhaseContext(
      activePhaseContext(originalState.sessionId, originalState.sessionPath),
    );
    await original.dispose();

    const foreignProjectKey = canonicalProjectKey(path.join(tmpProject, "foreign-project"));
    await rewriteSessionFile(originalState.sessionPath, (line) => {
      if (line.type !== "custom" || line.kind !== "active_phase_context") return line;
      return {
        ...line,
        data: { ...(line.data as Record<string, unknown>), projectKey: foreignProjectKey },
      };
    });

    const { AgentSession } = await import("./agent-session.js");
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: originalState.sessionPath,
    });
    try {
      await expect(resumed.initialize()).rejects.toThrow(
        "Cannot resume phase context from another project",
      );
      expect(resumed.getActivePhaseContext()).toBeUndefined();
      expect(String(resumed.getMessages()[0]?.content)).not.toContain("Active Roadmap phase");
      expect(String(resumed.getMessages()[0]?.content)).not.toContain('"id": "phase-21"');
    } finally {
      await resumed.dispose();
    }
  }, 15_000);

  it("preserves metadata across a conversation checkpoint and clears it for explicit New Session", async () => {
    const session = await makeSession(false);
    const initial = session.getState();
    await session.setActivePhaseContext(activePhaseContext(initial.sessionId, initial.sessionPath));

    await session.newSession(true);
    const checkpoint = session.getState();
    expect(checkpoint.sessionId).not.toBe(initial.sessionId);
    expect(session.getActivePhaseContext()?.session).toEqual({
      sessionId: checkpoint.sessionId,
      sessionPath: checkpoint.sessionPath,
    });

    await session.newSession();
    expect(session.getActivePhaseContext()).toBeUndefined();
    expect(String(session.getMessages()[0]?.content)).not.toContain("Active Roadmap phase");
    await session.dispose();
  }, 15_000);
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
