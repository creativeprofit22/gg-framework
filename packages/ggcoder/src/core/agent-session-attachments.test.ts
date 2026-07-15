import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let home: string;
let project: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

async function writeCommand(name: string, body: string): Promise<void> {
  const filePath = path.join(project, ".gg", "commands", `${name}.md`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `---\nname: ${name}\ndescription: Test command\n---\n${body}`,
    "utf-8",
  );
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-session-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-session-project-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  agentLoopMock.mockReset();
  agentLoopMock.mockImplementation(async function* () {
    yield { type: "agent_done" };
  });
  await writeJson(path.join(home, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(home, ".gg", "settings.json"), {
    autoCompact: false,
    idealReviewEnabled: false,
  });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(project, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
});

async function createSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: project,
    systemPrompt: "test system prompt",
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
  });
  await session.initialize();
  return session;
}

function userText(messages: Message[] | undefined): string {
  const user = messages?.find((message) => message.role === "user");
  if (!user || !Array.isArray(user.content)) return "";
  return user.content
    .filter(
      (block): block is Extract<(typeof user.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

describe("AgentSession attachment command expansion", () => {
  it("keeps the zero-attachment boundary on normal slash-command handling", async () => {
    const session = await createSession();
    await session.promptWithAttachments("/help", []);
    await session.dispose();
    expect(agentLoopMock).not.toHaveBeenCalled();
  });

  it("expands a custom command before adding all attachment path notes", async () => {
    await writeCommand("inspect", "Inspect using this custom body.");
    const session = await createSession();
    await session.promptWithAttachments("/inspect extra details", [
      {
        kind: "file",
        mediaType: "text/plain",
        data: "QQ==",
        name: "one.txt",
        path: path.join(project, ".gg", "uploads", "one.txt"),
      },
      {
        kind: "file",
        mediaType: "text/plain",
        data: "Qg==",
        name: "two.txt",
        path: path.join(project, ".gg", "uploads", "two.txt"),
      },
    ]);
    await session.dispose();

    const messages = agentLoopMock.mock.calls[0]?.[0] as Message[] | undefined;
    const text = userText(messages);
    expect(text).toContain("Inspect using this custom body.");
    expect(text).toContain("## User Instructions\n\nextra details");
    expect(text).toContain("one.txt");
    expect(text).toContain("two.txt");
    expect(text).not.toContain("/inspect");
  });

  it("expands queued commands before attachment steering is built", async () => {
    await writeCommand("queued", "Run the queued custom body.");
    let steering: Message[] | null | undefined;
    agentLoopMock.mockImplementation(async function* (
      _messages: Message[],
      options: GgAgentModule.AgentOptions,
    ) {
      steering = await options.getSteeringMessages?.();
      yield { type: "agent_done" };
    });

    const session = await createSession();
    session.queueMessage("/queued queued details", [
      {
        kind: "file",
        mediaType: "text/plain",
        data: "QQ==",
        name: "queued.txt",
        path: path.join(project, ".gg", "uploads", "queued.txt"),
      },
    ]);
    await session.prompt("start");
    await session.dispose();

    const text = userText(steering ?? undefined);
    expect(text).toContain("Run the queued custom body.");
    expect(text).toContain("queued details");
    expect(text).toContain("queued.txt");
    expect(text).not.toContain("/queued");
  });
});
