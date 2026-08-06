import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { restoreUserRow, resolveRestoredCommand } from "./session-history.js";
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

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "slash-restore-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "slash-restore-project-"));
  restoreHome = useFakeHome(tmpHome);
  agentLoopMock.mockReset().mockImplementation(async function* (messages: Message[]) {
    messages.push({ role: "assistant", content: "done" });
    yield { type: "agent_done" };
  });
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
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

async function writeCustomCommand(name: string, body: string): Promise<void> {
  const dir = path.join(tmpProject, ".gg", "commands");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.md`), body, "utf-8");
}

describe("slash-command restore", () => {
  it("expands a custom command to its template and reports it as expanding", async () => {
    const { AgentSession } = await import("./agent-session.js");
    await writeCustomCommand("shipit", "Ship the release now.");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "sys",
    });
    await session.initialize();

    expect(await session.willExpandPromptTemplate("/shipit")).toBe(true);
    // Not a command at all, and a command with no template body.
    expect(await session.willExpandPromptTemplate("just a message")).toBe(false);
    expect(await session.willExpandPromptTemplate("/nope-not-real")).toBe(false);

    await session.prompt("/shipit patch only");
    const users = session.getMessages().filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    // The MODEL sees the expanded template...
    const body = users[0]!.content as string;
    expect(body).toContain("Ship the release now.");
    expect(body).toContain("patch only");

    // ...and the restored row recovers the `/name args` chip from that body.
    const restored = restoreUserRow(users[0]!.content);
    const candidates = [{ name: "shipit", prompt: "Ship the release now." }];
    expect(resolveRestoredCommand(null, restored.text, candidates)).toBe("/shipit patch only");
    await session.dispose();
  }, 20_000);

  it("still executes registry slash commands without persisting a user message", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "sys",
    });
    await session.initialize();

    // A registry command (no prompt template) must not expand, must not become
    // a user message, and must not start an agent run.
    expect(await session.willExpandPromptTemplate("/help")).toBe(false);
    await session.prompt("/help");
    expect(session.getMessages().filter((m) => m.role === "user")).toHaveLength(0);
    expect(agentLoopMock).not.toHaveBeenCalled();
    await session.dispose();
  }, 20_000);

  // The reported bug: after a template is edited, body matching can no longer
  // recover `/name`, so the reopened session dumped the raw template.
  it("restores the chip from the recorded invocation after the template changes", async () => {
    const { AgentSession } = await import("./agent-session.js");
    await writeCustomCommand("shipit", "Ship the release now.");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "sys",
    });
    await session.initialize();
    await session.prompt("/shipit");

    // The command file is edited after the fact.
    await writeCustomCommand("shipit", "Ship the release, but carefully this time.");
    const drifted = [{ name: "shipit", prompt: "Ship the release, but carefully this time." }];
    const restored = restoreUserRow(
      session.getMessages().filter((m) => m.role === "user")[0]!.content,
    );

    // Body matching alone now fails — this is what rendered the raw body.
    expect(resolveRestoredCommand(null, restored.text, drifted)).toBeNull();
    // The invocation persisted at send time still restores the chip.
    expect(resolveRestoredCommand("/shipit", restored.text, drifted)).toBe("/shipit");
    await session.dispose();
  }, 20_000);
});
