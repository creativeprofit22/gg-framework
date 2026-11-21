import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { childSubAgentEnv } from "../tools/subagent-shared.js";
import {
  assertProviderExecutionAllowed,
  isUnattendedWorker,
  runUnattended,
  QWEN_UNATTENDED_ERROR,
  UNATTENDED_AGENT_ENV,
} from "./provider-execution-policy.js";

vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stream: vi.fn(),
}));
let cwd: string;
let restore: () => void;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-execution-"));
  restore = useFakeHome(path.join(cwd, "home"));
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({
    accessToken: "fixture-only",
    refreshToken: "",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  vi.mocked(stream).mockClear();
  vi.mocked(stream).mockImplementation(
    () =>
      new StreamResult(
        (async function* () {
          yield { type: "text_delta", text: "Done." };
          return {
            message: { role: "assistant", content: "Done." },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        })(),
      ),
  );
});
afterEach(async () => {
  restore();
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

it.each(["interactive", "trusted-child", "headless", "scheduled"] as const)(
  "enforces %s intent at the real AgentSession provider boundary",
  async (kind) => {
    const unattended =
      kind === "headless" || (kind === "trusted-child" && isUnattendedWorker(childSubAgentEnv({})));
    const session = new AgentSession({
      cwd,
      provider: "qwen-cloud",
      model: "qwen-cloud/qwen3.8-max",
      unattended,
      transient: true,
      systemPrompt: "Fixture",
      mcpEnabled: false,
      allowedTools: ["read"],
    });
    try {
      await session.initialize();
      const run = () => session.prompt("Read the code and explain it.");
      if (kind === "headless" || kind === "scheduled") {
        await expect(kind === "scheduled" ? runUnattended(run) : run()).rejects.toThrow(
          QWEN_UNATTENDED_ERROR,
        );
        expect(stream).not.toHaveBeenCalled();
      } else {
        await run();
        expect(stream).toHaveBeenCalled();
        expect(
          vi.mocked(stream).mock.calls.every(([request]) => request.provider === "qwen-cloud"),
        ).toBe(true);
      }
    } finally {
      await session.dispose();
    }
  },
);

it("preserves unattended intent across trusted delegation and rejects malformed depth", () => {
  expect(isUnattendedWorker({})).toBe(true);
  expect(isUnattendedWorker({ GG_SUBAGENT_DEPTH: "1garbage" })).toBe(true);
  expect(isUnattendedWorker(childSubAgentEnv({}))).toBe(false);
  const child = runUnattended(() => childSubAgentEnv({}));
  expect(child[UNATTENDED_AGENT_ENV]).toBe("1");
  expect(isUnattendedWorker(child)).toBe(true);
  expect(isUnattendedWorker(childSubAgentEnv(child))).toBe(true);
});

it("isolates concurrent interactive work and never blocks other providers", async () => {
  await Promise.all([
    runUnattended(async () => {
      await Promise.resolve();
      expect(() => assertProviderExecutionAllowed("qwen-cloud")).toThrow(QWEN_UNATTENDED_ERROR);
      expect(() => assertProviderExecutionAllowed("anthropic")).not.toThrow();
    }),
    (async () => {
      await Promise.resolve();
      expect(() => assertProviderExecutionAllowed("qwen-cloud")).not.toThrow();
    })(),
  ]);
});
