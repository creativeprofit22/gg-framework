import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeModels, registerRuntimeModels } from "./model-registry.js";
import {
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./thinking-level.js";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";

describe("thinking-level helpers", () => {
  it("cycles OpenAI GPT models through supported reasoning efforts", () => {
    expect(getSupportedThinkingLevels("openai", "gpt-5.5")).toEqual(["medium", "high", "xhigh"]);
    expect(getNextThinkingLevel("openai", "gpt-5.5", undefined)).toBe("medium");
    expect(getNextThinkingLevel("openai", "gpt-5.5", "medium")).toBe("high");
    expect(getNextThinkingLevel("openai", "gpt-5.5", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("openai", "gpt-5.5", "xhigh")).toBeUndefined();
  });

  it("exposes Ultra only for GPT-5.6 models that support proactive delegation", () => {
    const baseLevels = ["low", "medium", "high", "xhigh", "max"];
    expect(getSupportedThinkingLevels("openai", "gpt-5.6-sol")).toEqual([...baseLevels, "ultra"]);
    expect(getSupportedThinkingLevels("openai", "gpt-5.6-terra")).toEqual([...baseLevels, "ultra"]);
    expect(getSupportedThinkingLevels("openai", "gpt-5.6-luna")).toEqual(baseLevels);
    expect(getNextThinkingLevel("openai", "gpt-5.6-sol", "max")).toBe("ultra");
    expect(getNextThinkingLevel("openai", "gpt-5.6-sol", "ultra")).toBeUndefined();
  });

  it("cycles Anthropic adaptive Opus models through max, including xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", "max")).toBeUndefined();
  });

  it("cycles Anthropic adaptive Sonnet models without xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-sonnet-5")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-sonnet-5", "high")).toBe("max");
    expect(isThinkingLevelSupported("anthropic", "claude-sonnet-5", "xhigh")).toBe(false);
  });

  it("cycles xAI Grok 4.5 through low, medium, and high", () => {
    expect(getSupportedThinkingLevels("xai", "grok-4.5")).toEqual(["low", "medium", "high"]);
    expect(getNextThinkingLevel("xai", "grok-4.5", undefined)).toBe("low");
    expect(getNextThinkingLevel("xai", "grok-4.5", "low")).toBe("medium");
    expect(getNextThinkingLevel("xai", "grok-4.5", "medium")).toBe("high");
    expect(getNextThinkingLevel("xai", "grok-4.5", "high")).toBeUndefined();
    expect(isThinkingLevelSupported("xai", "grok-4.5", "xhigh")).toBe(false);
  });

  it("cycles Sakana Fugu through high and xhigh", () => {
    expect(getSupportedThinkingLevels("sakana", "fugu")).toEqual(["high", "xhigh"]);
    expect(getSupportedThinkingLevels("sakana", "fugu-ultra")).toEqual(["high", "xhigh"]);
    expect(getNextThinkingLevel("sakana", "fugu", undefined)).toBe("high");
    expect(getNextThinkingLevel("sakana", "fugu", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("sakana", "fugu", "xhigh")).toBeUndefined();
    expect(isThinkingLevelSupported("sakana", "fugu", "medium")).toBe(false);
  });

  it("cycles Kimi K3 through its server-declared low, high, max ladder", () => {
    expect(getSupportedThinkingLevels("moonshot", "kimi-k3")).toEqual(["low", "high", "max"]);
    expect(getNextThinkingLevel("moonshot", "kimi-k3", undefined)).toBe("low");
    expect(getNextThinkingLevel("moonshot", "kimi-k3", "low")).toBe("high");
    expect(getNextThinkingLevel("moonshot", "kimi-k3", "high")).toBe("max");
    expect(getNextThinkingLevel("moonshot", "kimi-k3", "max")).toBeUndefined();
    expect(isThinkingLevelSupported("moonshot", "kimi-k3", "medium")).toBe(false);
  });

  it("keeps non-cycling providers at their model's sole supported effort", () => {
    expect(getSupportedThinkingLevels("moonshot", "kimi-k2.7-code")).toEqual(["high"]);
    expect(getNextThinkingLevel("moonshot", "kimi-k2.7-code", undefined)).toBe("high");
    expect(getNextThinkingLevel("moonshot", "kimi-k2.7-code", "high")).toBeUndefined();
  });
});

describe("local models", () => {
  const base = {
    provider: "local" as const,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsImages: false,
    supportsVideo: false,
    costTier: "low" as const,
    maxThinkingLevel: "high" as const,
  };

  afterEach(() => clearRuntimeModels());

  it("offers no levels for a local model that does not reason", () => {
    registerRuntimeModels([
      { ...base, id: "local/ollama/plain", name: "plain", supportsThinking: false },
    ]);

    expect(getSupportedThinkingLevels("local", "local/ollama/plain")).toEqual([]);
    // Toggling thinking is a no-op instead of sending a reasoning_effort the
    // server would reject.
    expect(getNextThinkingLevel("local", "local/ollama/plain", undefined)).toBeUndefined();
    expect(isThinkingLevelSupported("local", "local/ollama/plain", "high")).toBe(false);
  });

  it("offers the generic ladder for a thinking-capable local model", () => {
    registerRuntimeModels([
      { ...base, id: "local/ollama/qwen3", name: "qwen3", supportsThinking: true },
    ]);

    expect(getSupportedThinkingLevels("local", "local/ollama/qwen3")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("cycles an Ollama model up to max, then off", () => {
    // Ollama accepts low/medium/high/max on reasoning_effort (verified on 0.32),
    // so discovery gives its models a "max" ceiling.
    registerRuntimeModels([
      {
        ...base,
        id: "local/ollama/qwen3",
        name: "qwen3",
        supportsThinking: true,
        maxThinkingLevel: "max",
      },
    ]);
    const next = (current: ThinkingLevel | undefined) =>
      getNextThinkingLevel("local", "local/ollama/qwen3", current);

    expect(getSupportedThinkingLevels("local", "local/ollama/qwen3")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(next(undefined)).toBe("low");
    expect(next("low")).toBe("medium");
    expect(next("medium")).toBe("high");
    expect(next("high")).toBe("max");
    expect(next("max")).toBeUndefined();
  });

  it("stops at high on servers that never declared max", () => {
    registerRuntimeModels([
      {
        ...base,
        id: "local/vllm/qwen3",
        name: "qwen3",
        supportsThinking: true,
        maxThinkingLevel: "high",
      },
    ]);

    const levels = getSupportedThinkingLevels("local", "local/vllm/qwen3");

    expect(levels).toEqual(["low", "medium", "high"]);
    expect(getNextThinkingLevel("local", "local/vllm/qwen3", "high")).toBeUndefined();
    expect(isThinkingLevelSupported("local", "local/vllm/qwen3", "max")).toBe(false);
  });

  it("never offers xhigh on any local model — no local server accepts it", () => {
    registerRuntimeModels([
      {
        ...base,
        id: "local/ollama/qwen3",
        name: "qwen3",
        supportsThinking: true,
        maxThinkingLevel: "max",
      },
    ]);

    expect(getSupportedThinkingLevels("local", "local/ollama/qwen3")).not.toContain("xhigh");
    expect(isThinkingLevelSupported("local", "local/ollama/qwen3", "xhigh")).toBe(false);
  });

  it("offers nothing for an unknown local id (never discovered)", () => {
    expect(getSupportedThinkingLevels("local", "local/ollama/ghost")).toEqual([]);
  });
});
