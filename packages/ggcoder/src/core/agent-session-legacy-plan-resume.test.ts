import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { approvedPlanContentHash } from "./session-manager.js";
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function findSessionFile(): Promise<string> {
  const root = path.join(tmpHome, ".gg", "sessions");
  for (const dir of await fs.readdir(root)) {
    const file = (await fs.readdir(path.join(root, dir))).find((name) => name.endsWith(".jsonl"));
    if (file) return path.join(root, dir, file);
  }
  throw new Error("expected a persisted session");
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-plan-resume-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-plan-resume-project-"));
  restoreHome = useFakeHome(tmpHome);
  agentLoopMock.mockReset().mockImplementation(async function* () {
    yield { type: "agent_done" };
  });
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), { autoCompact: false });
});

afterEach(async () => {
  restoreHome?.();
  vi.restoreAllMocks();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

describe("legacy approved-plan recovery on Windows", () => {
  it("resumes a recovered approval when read-handle fsync returns EPERM, just like normal chat", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const planContent = "# Site Bench plan\n\n1. Continue the approved implementation.";
    const implementationPrompt = "The plan has been approved. Continue with implementation.";
    const original = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await original.initialize();
    await original.persistApprovedPlanConsumption({
      checkpointId: "legacy-site-bench-checkpoint",
      generation: 1,
      content: planContent,
      contentHash: approvedPlanContentHash(planContent),
      approvedPlanPath: path.join(tmpProject, ".gg", "plans", "approved.md"),
    });
    await original.dispose();

    const recovered = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: await findSessionFile(),
    });
    await recovered.initialize();
    expect(recovered.getApprovedPlanConsumption()).toMatchObject({
      checkpointId: "legacy-site-bench-checkpoint",
      generation: 1,
      state: "approval-committed",
    });

    const normalChat = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await normalChat.initialize();

    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[1] !== "r") return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
                code: "EPERM",
                syscall: "fsync",
              });
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    // Ordinary chat never opens the final read handle for a second durability
    // sync, matching the installed app where typing "resume" succeeds.
    await expect(normalChat.prompt("resume")).resolves.toBeUndefined();

    const run = vi.fn(async () => {});
    await expect(
      recovered.resumeApprovedPlanImplementation(implementationPrompt, 1, run),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();

    await normalChat.dispose();
    await recovered.dispose();
  });

  it("quarantines restored plan content until canonical hydration", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const legacyContent = "# STALE-PLAN-CONTENT\n\n## Steps\n1. Do not hydrate this.";
    const original = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
    });
    await original.initialize();
    await original.persistApprovedPlanConsumption({
      checkpointId: "durable-plan",
      generation: 2,
      content: legacyContent,
      contentHash: approvedPlanContentHash(legacyContent),
      approvedPlanPath: path.join(tmpProject, ".gg", "plans", "legacy.md"),
    });
    await original.dispose();

    const recovered = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      sessionId: await findSessionFile(),
      deferApprovedPlanHydration: true,
    });
    await recovered.initialize();
    expect(String(recovered.getMessages()[0]?.content)).not.toContain("STALE-PLAN-CONTENT");
    expect(recovered.getApprovedPlanConsumption()?.content).toBe(legacyContent);

    const canonicalContent = "<!-- gg-plan-status: approved -->\n# CANONICAL-PLAN-CONTENT";
    await recovered.hydrateCanonicalApprovedPlan({
      checkpointId: "durable-plan",
      generation: 2,
      content: canonicalContent,
      contentHash: approvedPlanContentHash(canonicalContent),
      state: "implementation-prompt-started",
      approvedPlanPath: path.join(tmpProject, ".gg", "plans", "canonical.md"),
    });
    expect(String(recovered.getMessages()[0]?.content)).toContain("CANONICAL-PLAN-CONTENT");
    await recovered.dispose();
  });
});
