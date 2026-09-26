import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: vi.fn(() => (async function* emptyLoop() {})()) };
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

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "packs-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "packs-project-"));
  restoreHome = useFakeHome(tempHome);
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
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
});

function systemPrompt(session: { getMessages: () => { role: string; content: unknown }[] }) {
  const first = session.getMessages()[0];
  expect(first?.role).toBe("system");
  return String(first?.content);
}

// The desktop app and every non-TUI mode build prompts through AgentSession
// alone; before this, only the Ink UI injected language packs.
describe("AgentSession language style packs (shared/app path)", () => {
  it("adds packs for languages present, including ones created mid-session", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cwd: tempProject,
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
      orchestrationPrompt: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();
    try {
      await session.prompt("hello");
      expect(systemPrompt(session)).not.toContain("## Language Style Packs");

      // A project scaffolded during a previous task gets its pack next turn.
      await fs.writeFile(path.join(tempProject, "tsconfig.json"), "{}");
      await session.prompt("next task");
      const prompt = systemPrompt(session);
      expect(prompt).toContain("## Language Style Packs");
      expect(prompt).toContain("TypeScript");
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
