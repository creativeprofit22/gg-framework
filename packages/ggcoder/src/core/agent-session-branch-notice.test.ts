/**
 * A branch switched from the app reaches the model as an appended hidden note,
 * never as a re-rendered system prompt.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return { connectAll: vi.fn(async () => []), dispose: vi.fn(async () => {}) };
    }),
  };
});

type SeenMessage = { role: string; content: unknown; provenance?: unknown };

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let seen: SeenMessage[];

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-branch-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-branch-project-"));
  restoreHome = useFakeHome(tmpHome);
  seen = [];
  agentLoopMock.mockReset();
  agentLoopMock.mockImplementation(async function* (messages: SeenMessage[]) {
    seen.splice(0, seen.length, ...messages);
    messages.push({ role: "assistant", content: "ok" });
    yield {
      type: "agent_done",
      totalTurns: 1,
      totalUsage: { inputTokens: 0, outputTokens: 0 },
    };
  });
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: { accessToken: "test", refreshToken: "test", expiresAt: Date.now() + 3_600_000 },
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

interface SessionInternals {
  getHookSteeringMessages: () => SeenMessage[] | null;
}

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
  return { session, internals: session as unknown as SessionInternals };
}

const branchNotes = (messages: readonly SeenMessage[]): SeenMessage[] =>
  messages.filter((m) => String(m.content).includes("The git branch changed"));

const systemText = (messages: readonly SeenMessage[]): string =>
  JSON.stringify(messages.find((m) => m.role === "system")?.content);

describe("AgentSession branch change notice", () => {
  it("appends a hidden note before the next prompt and leaves the system prompt alone", async () => {
    const { session } = await makeSession();
    try {
      await session.prompt("first");
      const systemBefore = systemText(session.getMessages() as SeenMessage[]);
      const countBefore = session.getMessages().length;

      session.noteBranchChange("main", "feature/x");
      await session.prompt("second");

      const [note, prompt] = seen.slice(-2);
      expect(String(note?.content)).toContain('changed from "main" to "feature/x"');
      expect(note?.provenance).toEqual({
        source: "runtime",
        kind: "notification",
        visibility: "hidden",
      });
      expect(prompt).toMatchObject({ role: "user", content: "second" });
      expect(systemText(seen)).toBe(systemBefore);
      // Appended after everything that was already there.
      expect(seen.slice(0, countBefore).map((m) => JSON.stringify(m.content))).toEqual(
        session
          .getMessages()
          .slice(0, countBefore)
          .map((m) => JSON.stringify(m.content)),
      );

      await session.prompt("third");
      expect(branchNotes(seen)).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  }, 60_000);

  it("collapses repeated switches into one note, or none when back where it started", async () => {
    const { session } = await makeSession();
    try {
      session.noteBranchChange("a", "b");
      session.noteBranchChange("b", "c");
      await session.prompt("go");
      const notes = branchNotes(seen);
      expect(notes).toHaveLength(1);
      expect(String(notes[0]?.content)).toContain('changed from "a" to "c"');

      session.noteBranchChange("c", "d");
      session.noteBranchChange("d", "c");
      await session.prompt("again");
      expect(branchNotes(seen)).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  }, 60_000);

  it("rides out on the steering path when a run is live", async () => {
    const { session, internals } = await makeSession();
    try {
      session.noteBranchChange(null, "main");
      const messages = internals.getHookSteeringMessages();
      expect(messages).toHaveLength(1);
      expect(String(messages![0]!.content)).toContain('from a detached HEAD to "main"');
      expect(internals.getHookSteeringMessages()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 60_000);
});
