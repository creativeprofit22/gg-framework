/**
 * A mid-session model switch must be replayable state, not a silent mutation:
 * recorded as a durable marker, injected as its own trailing message, and — the
 * expensive part — kept OFF the cached system prefix so the next turn still
 * reads from cache.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { stream, StreamResult, type StreamEvent, type StreamResponse } from "@kenkaiiii/gg-ai";
import { getModel } from "./model-registry.js";
import { AuthStorage } from "./auth-storage.js";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stream: vi.fn(),
}));

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
let tempHome: string;
let tempProject: string;

const CACHE_MARKER = "<!-- uncached -->";

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-switch-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-switch-project-"));
  restoreHome = useFakeHome(tempHome);
  agentLoopMock.mockReset();
  vi.mocked(stream)
    .mockReset()
    .mockImplementation(
      () =>
        new StreamResult(
          (async function* (): AsyncGenerator<StreamEvent, StreamResponse> {
            yield { type: "text_delta", text: "Fix the bug." };
            return {
              message: { role: "assistant", content: "Fix the bug." },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        ),
    );
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "claude-code-version.json"),
    JSON.stringify({ version: "2.1.75", fetchedAt: Date.now() }),
  );
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      gemini: {
        accessToken: "test-gemini-token",
        refreshToken: "test-gemini-refresh",
        expiresAt: Date.now() + 3_600_000,
        projectId: "test-google-project",
      },
      anthropic: { accessToken: "t", refreshToken: "t", expiresAt: Date.now() + 3_600_000 },
      openai: { accessToken: "t", refreshToken: "t", expiresAt: Date.now() + 3_600_000 },
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await Promise.all([
    fs.rm(tempHome, { recursive: true, force: true }),
    fs.rm(tempProject, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function createSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "openai",
    model: "gpt-5.6-sol",
    // Repo cwd so the bundled agent definitions register spawn_agent — the
    // Sol/Ultra orchestration block only renders when that tool exists, and it
    // is the model-dependent prompt content this test is about.
    cwd: process.cwd(),
    systemPrompt: "stable role prompt",
    thinkingLevel: "ultra",
    transient: true,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  // A conversation must already exist for the switch note to have a job.
  session
    .getMessages()
    .push({ role: "user", content: "start the work" }, { role: "assistant", content: "on it" });
  return session;
}

/**
 * System-prompt bytes that carry cache_control. Mirrors the provider split in
 * gg-ai `transform.ts`: everything before the marker, trimmed at the end.
 */
function cachedPrefix(content: string): string {
  const index = content.indexOf(CACHE_MARKER);
  return (index === -1 ? content : content.slice(0, index)).trimEnd();
}

describe("AgentSession model switch", () => {
  it("enhances with the active model and its settings after switching providers", async () => {
    const session = await createSession();
    try {
      for (const [provider, model] of [
        ["openai", "gpt-5.6-sol"],
        ["anthropic", "claude-fable-5-1"],
        ["gemini", "gemini-3.1-pro-preview"],
        ["openai", "custom-future-model"],
      ]) {
        await session.switchModel(provider, model);
        session.setThinkingLevel("high");
        const messages = [...session.getMessages()];
        expect((await session.enhancePrompt("fix bug")).enhanced).toBe("Fix the bug.");
        expect(session.getMessages()).toEqual(messages);
        const request = vi.mocked(stream).mock.lastCall![0];
        expect(request).toMatchObject({
          provider,
          model,
          thinking: "high",
          maxTokens: getModel(model)?.maxOutputTokens ?? 16384,
        });
        if (provider === "anthropic") {
          expect(request.userAgent).toMatch(/^claude-cli\//);
        }
        if (provider === "gemini") {
          expect(request.projectId).toBe("test-google-project");
        }
      }
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("keeps the click-time model paired with its credentials during a switch", async () => {
    const session = await createSession();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveCredentials = AuthStorage.prototype.resolveCredentials;
    vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockImplementationOnce(async function (
      this: AuthStorage,
      provider,
      options,
    ) {
      const credentials = await resolveCredentials.call(this, provider, options);
      await pending;
      return credentials;
    });
    try {
      session.setThinkingLevel("high");
      const enhancement = session.enhancePrompt("fix bug");
      await session.switchModel("anthropic", "claude-fable-5-1");
      session.setThinkingLevel("low");
      release();
      await enhancement;
      expect(vi.mocked(stream).mock.lastCall![0]).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-sol",
        thinking: "high",
      });
    } finally {
      release();
      await session.dispose();
    }
  }, 30_000);

  it("keeps the cached system prefix byte-identical across a switch", async () => {
    const session = await createSession();
    try {
      const before = String(session.getMessages()[0]!.content);
      // Sol/Ultra guidance is live, so the switch really does change the prompt.
      expect(before).toContain(CACHE_MARKER);
      expect(before).toContain("Proactively use spawn_agent");

      await session.switchModel("openai", "gpt-5.5-codex");

      const after = String(session.getMessages()[0]!.content);
      expect(cachedPrefix(after)).toBe(cachedPrefix(before));
      // Model-dependent guidance followed the model, out of the cached region.
      expect(after).not.toContain("Proactively use spawn_agent");
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("appends the switch as its own trailing message", async () => {
    const session = await createSession();
    try {
      await session.switchModel("openai", "gpt-5.5-codex");

      const messages = session.getMessages();
      const last = messages[messages.length - 1]!;
      expect(last.role).toBe("user");
      expect(String(last.content)).toContain("gpt-5.6-sol");
      expect(String(last.content)).toContain("gpt-5.5-codex");
      // Cross-provider switches name the provider on both sides.
      await session.switchModel("anthropic", "claude-test");
      expect(String(session.getMessages().at(-1)!.content)).toContain("anthropic/claude-test");
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("records a replayable model_switch marker", async () => {
    const session = await createSession();
    try {
      await session.switchModel("openai", "gpt-5.5-codex");

      const markers = session.getAppMarkers().filter((m) => m.kind === "model_switch");
      expect(markers).toHaveLength(1);
      expect(markers[0]!.data).toMatchObject({
        from: "gpt-5.6-sol",
        to: "gpt-5.5-codex",
        provider: "openai",
        fromProvider: "openai",
      });
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("does nothing when the model did not actually change", async () => {
    const session = await createSession();
    try {
      const before = [...session.getMessages()];

      await session.switchModel("openai", "gpt-5.6-sol");

      expect(session.getMessages()).toHaveLength(before.length);
      expect(session.getAppMarkers().filter((m) => m.kind === "model_switch")).toHaveLength(0);
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("does not break tool pairing when a switch lands mid tool call", async () => {
    const session = await createSession();
    try {
      session.getMessages().push({
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: {} }],
      });
      const count = session.getMessages().length;

      await session.switchModel("openai", "gpt-5.5-codex");

      // No user message may sit between tool_use and its tool_result.
      expect(session.getMessages()).toHaveLength(count);
      // The switch is still recorded durably.
      expect(session.getAppMarkers().filter((m) => m.kind === "model_switch")).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  }, 30_000);
});
