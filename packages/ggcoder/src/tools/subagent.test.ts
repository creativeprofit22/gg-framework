import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import type { AgentDefinition } from "../core/agents.js";
import { createSubAgentTool, isModelUnavailableError } from "./subagent.js";
import { MAX_BLOCKING_SUBAGENT_DEPTH, SUB_AGENT_DEPTH_ENV } from "./subagent-shared.js";

class MockChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const owl: AgentDefinition = {
  name: "owl",
  description: "Read-only scout",
  tools: ["read"],
  systemPrompt: "Inspect code and report findings.",
  source: "bundled",
};

function spawnedModels(): string[] {
  return spawnMock.mock.calls.map(([, rawArgs]) => {
    const args = rawArgs as string[];
    return args[args.indexOf("--model") + 1]!;
  });
}

function spawnedCacheKeys(): string[] {
  return spawnMock.mock.calls.map(([, rawArgs]) => {
    const args = rawArgs as string[];
    return args[args.indexOf("--prompt-cache-key") + 1]!;
  });
}

function mockExit(
  stderr: string,
  code: number,
  stdout = "",
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
): MockChildProcess {
  const child = new MockChildProcess();
  setImmediate(() => {
    if (stdout) child.stdout.write(`${JSON.stringify({ type: "text_delta", text: stdout })}\n`);
    if (usage) child.stdout.write(`${JSON.stringify({ type: "turn_end", usage })}\n`);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

async function runOwl() {
  const tool = createSubAgentTool(
    process.cwd(),
    [owl],
    () => "openai",
    () => "gpt-5.6-sol",
    () => "parent-cache",
  );
  return tool.execute(
    { agent: "owl", task: "Inspect the registry." },
    { signal: new AbortController().signal, toolCallId: "test-call" },
  );
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("createSubAgentTool fast-model fallback", () => {
  it("respawns with the parent model when the fast model is unavailable", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        mockExit("OpenAI does not recognize the requested model (not).", 1),
      )
      .mockImplementationOnce(() => mockExit("", 0, "fallback succeeded"));

    await expect(runOwl()).resolves.toMatchObject({ content: "fallback succeeded" });
    expect(spawnedModels()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(spawnedCacheKeys()).toEqual([
      "parent-cache:subagent:gpt-5.6-luna:owl",
      "parent-cache:subagent:gpt-5.6-luna:owl",
    ]);
  });

  it("returns cache reads and writes with the normalized token totals", async () => {
    spawnMock.mockImplementationOnce(() =>
      mockExit("", 0, "done", {
        inputTokens: 10,
        outputTokens: 3,
        cacheRead: 20,
        cacheWrite: 5,
      }),
    );

    await expect(runOwl()).resolves.toMatchObject({
      content: "done",
      details: {
        tokenUsage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 },
      },
    });
  });

  it("does not retry unrelated child failures", async () => {
    spawnMock.mockImplementationOnce(() => mockExit("usage limit reached", 1));

    await expect(runOwl()).resolves.toMatchObject({
      content: "Sub-agent failed (exit 1): usage limit reached",
    });
    expect(spawnedModels()).toEqual(["gpt-5.6-luna"]);
  });

  it("keeps Azure provider, deployment, endpoint environment, and cancellation in blocking children", async () => {
    const previous = {
      key: process.env.AZURE_OPENAI_API_KEY,
      baseUrl: process.env.AZURE_OPENAI_BASE_URL,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    };
    process.env.AZURE_OPENAI_API_KEY = "azure-child-key";
    process.env.AZURE_OPENAI_BASE_URL = "https://example.openai.azure.com/openai/v1/responses";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5.6-sol";
    const worker = { ...owl, name: "worker", tools: ["read", "bash"] };
    const child = new MockChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const controller = new AbortController();
    const tool = createSubAgentTool(
      process.cwd(),
      [worker],
      () => "azure",
      () => "azure:gpt-5.6-sol",
      () => "azure-parent-cache",
    );

    try {
      const result = tool.execute(
        { agent: "worker", task: "Keep running." },
        { signal: controller.signal, toolCallId: "azure-child" },
      );
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      const [, args, options] = spawnMock.mock.calls[0]!;
      expect(args).toEqual(
        expect.arrayContaining(["--provider", "azure", "--model", "azure:gpt-5.6-sol"]),
      );
      expect(options).toMatchObject({
        env: {
          AZURE_OPENAI_API_KEY: "azure-child-key",
          AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/responses",
          AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
        },
      });

      controller.abort();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null);
      await expect(result).resolves.toMatchObject({ content: expect.any(String) });
    } finally {
      if (previous.key === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = previous.key;
      if (previous.baseUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
      else process.env.AZURE_OPENAI_BASE_URL = previous.baseUrl;
      if (previous.deployment === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT;
      else process.env.AZURE_OPENAI_DEPLOYMENT = previous.deployment;
    }
  });

  it("keeps the blocking contract while rejecting recursive process storms", async () => {
    const previousDepth = process.env[SUB_AGENT_DEPTH_ENV];
    process.env[SUB_AGENT_DEPTH_ENV] = String(MAX_BLOCKING_SUBAGENT_DEPTH);
    try {
      const tool = createSubAgentTool(
        process.cwd(),
        [owl],
        () => "openai",
        () => "gpt-5.6-sol",
      );
      await expect(
        tool.execute(
          { task: "Recurse again." },
          { signal: new AbortController().signal, toolCallId: "depth-test" },
        ),
      ).resolves.toMatchObject({ content: expect.stringContaining("nesting limit") });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (previousDepth === undefined) delete process.env[SUB_AGENT_DEPTH_ENV];
      else process.env[SUB_AGENT_DEPTH_ENV] = previousDepth;
    }
  });
});

describe("isModelUnavailableError", () => {
  it("recognizes unavailable-model failures", () => {
    expect(
      isModelUnavailableError(
        "OpenAI does not recognize the requested model (not). It may not exist or your account may not have access.",
      ),
    ).toBe(true);
    expect(isModelUnavailableError("The requested model is not available for this account.")).toBe(
      true,
    );
    expect(isModelUnavailableError("Model gpt-example does not exist.")).toBe(true);
  });

  it("does not retry unrelated provider or process failures", () => {
    expect(isModelUnavailableError("usage limit reached")).toBe(false);
    expect(isModelUnavailableError("401 invalid authentication credentials")).toBe(false);
    expect(isModelUnavailableError("spawn node ENOENT")).toBe(false);
  });
});
