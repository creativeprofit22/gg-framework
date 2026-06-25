import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function writeCommand(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, "utf-8");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-project-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  agentLoopMock.mockReset();
  agentLoopMock.mockImplementation(async function* () {
    yield { type: "agent_done" };
  });

  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
    autoCompact: false,
    idealReviewEnabled: false,
  });
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

describe("AgentSession attachment prompt commands", () => {
  it("delegates empty attachment prompts to normal slash-command handling", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      transient: true,
    });

    await session.initialize();
    await session.promptWithAttachments("/help", []);
    await session.dispose();

    expect(agentLoopMock).not.toHaveBeenCalled();
  });

  it("expands custom prompt commands before building attachment content", async () => {
    await writeCommand(
      path.join(tmpProject, ".gg", "commands", "echo-test.md"),
      "---\nname: echo-test\ndescription: Echo command\n---\nUse this custom command body.",
    );

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      transient: true,
    });

    await session.initialize();
    await session.promptWithAttachments("/echo-test extra details", [
      {
        kind: "file",
        mediaType: "text/plain",
        data: "SGVsbG8=",
        name: "note.txt",
        path: path.join(tmpProject, ".gg", "uploads", "note.txt"),
      },
    ]);
    await session.dispose();

    const messages = agentLoopMock.mock.calls[0]?.[0] as Message[] | undefined;
    const userMessage = messages?.find((message) => message.role === "user");
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const firstBlock = Array.isArray(userMessage?.content) ? userMessage.content[0] : undefined;
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.stringContaining("Use this custom command body."),
    });
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.stringContaining("## User Instructions\n\nextra details"),
    });
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.stringContaining("Attached files (inspect with your tools):"),
    });
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.not.stringContaining("/echo-test"),
    });
  });

  it("expands queued custom prompt commands before building attachment steering content", async () => {
    await writeCommand(
      path.join(tmpProject, ".gg", "commands", "queued-test.md"),
      "---\nname: queued-test\ndescription: Queued command\n---\nUse this queued command body.",
    );

    let steeringMessages: Message[] | null | undefined;
    agentLoopMock.mockImplementation(async function* (
      _messages: Message[],
      options: GgAgentModule.AgentOptions,
    ) {
      steeringMessages = await options.getSteeringMessages?.();
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      transient: true,
    });

    await session.initialize();
    session.queueMessage("/queued-test queued details", [
      {
        kind: "file",
        mediaType: "text/plain",
        data: "SGVsbG8=",
        name: "queued-note.txt",
        path: path.join(tmpProject, ".gg", "uploads", "queued-note.txt"),
      },
    ]);
    await session.prompt("start run");
    await session.dispose();

    const queuedMessage = steeringMessages?.[0];
    expect(Array.isArray(queuedMessage?.content)).toBe(true);
    const firstBlock = Array.isArray(queuedMessage?.content) ? queuedMessage.content[0] : undefined;
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.stringContaining("Use this queued command body."),
    });
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.stringContaining("## User Instructions\n\nqueued details"),
    });
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.stringContaining("Attached files (inspect with your tools):"),
    });
    expect(firstBlock).toMatchObject({
      type: "text",
      text: expect.not.stringContaining("/queued-test"),
    });
  });
});
