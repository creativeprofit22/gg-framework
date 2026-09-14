import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import type { AgentDefinition } from "../core/agents.js";
import { createSubAgentTool, isModelUnavailableError } from "./subagent.js";
import {
  MAX_BLOCKING_SUBAGENT_DEPTH,
  SUB_AGENT_DEPTH_ENV,
  SUB_AGENT_TIMEOUT_MS,
} from "./subagent-shared.js";

class MockChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const owl: AgentDefinition = {
  name: "owl",
  description: "Read-only scout",
  tools: ["read"],
  // Declares the cheap tier explicitly — the only way an agent opts out of the
  // parent's model now — which is what arms the fast-model fallback path below.
  model: "fast",
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

/**
 * A child killed by a signal reports `code === null` and writes no stderr —
 * exactly the shape the desktop hang produced once the parent gave up on it.
 */
function mockSignalDeath(stdout = ""): MockChildProcess {
  const child = new MockChildProcess();
  setImmediate(() => {
    if (stdout) child.stdout.write(`${JSON.stringify({ type: "text_delta", text: stdout })}\n`);
    child.stdout.end();
    child.stderr.end();
  });
  return child;
}

function owlTool() {
  return createSubAgentTool(
    process.cwd(),
    [owl],
    () => "openai",
    () => "gpt-5.6-sol",
    () => "parent-cache",
  );
}

async function runOwl() {
  return owlTool().execute(
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

  it("does not mistake partial progress text for a successful final answer", async () => {
    // Real failure shape: the model narrates before its first tool call, then
    // the provider rate-limits the next turn and the child exits non-zero. The
    // old collector returned only "I'll start..." as a successful tool result,
    // hiding both the failure and the fact that no review/work was completed.
    spawnMock.mockImplementationOnce(() =>
      mockExit(
        "Rate limited by Anthropic. Wait a moment and try again.",
        1,
        "I'll read both files now.",
      ),
    );

    await expect(runOwl()).resolves.toMatchObject({
      content:
        "Sub-agent failed (exit 1): Rate limited by Anthropic. Wait a moment and try again.\n\n" +
        "Partial output before failure:\nI'll read both files now.",
    });
    expect(spawnedModels()).toEqual(["gpt-5.6-luna"]);
  });

  it("names the timeout instead of reporting a signal death as 'unknown error'", async () => {
    // Regression: every desktop sub-agent hung until the parent killed it, and
    // `close(null)` with empty stderr surfaced as "exit null: unknown error",
    // hiding both the cause and the fact that the child had already answered.
    const child = mockSignalDeath("CLEAR");
    spawnMock.mockImplementationOnce(() => child);
    const pending = runOwl();
    await new Promise((resolve) => setImmediate(resolve));

    child.emit("close", null, "SIGTERM");
    const result = (await pending) as { content: string };

    expect(result.content).not.toContain("unknown error");
    expect(result.content).toContain("SIGTERM");
    // Whatever the child did finish is still handed back for diagnosis.
    expect(result.content).toContain("CLEAR");
  });

  it("names parent cancellation when the caller's signal aborts the child", async () => {
    const child = mockSignalDeath();
    spawnMock.mockImplementationOnce(() => child);
    const controller = new AbortController();
    const pending = owlTool().execute(
      { agent: "owl", task: "Inspect the registry." },
      { signal: controller.signal, toolCallId: "test-call" },
    );
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");

    const result = (await pending) as { content: string };
    expect(result.content).toContain("cancelled by the parent");
    expect(result.content).not.toContain("unknown error");
  });

  it("claims a loop timeout ceiling above its own sub-agent budget", () => {
    // The loop's default per-tool timeout is SHORTER than SUB_AGENT_TIMEOUT_MS,
    // so without this override the loop cancelled first and the tool's specific
    // "exceeded its time limit" message could never be produced.
    expect(owlTool().timeoutMs).toBeGreaterThan(SUB_AGENT_TIMEOUT_MS);
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
