import { describe, expect, it } from "vitest";
import { MODELS } from "./model-registry.js";
import {
  clampThinkingLevel,
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./thinking-level.js";

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

    const azureSol = {
      ...MODELS.find((model) => model.id === "gpt-5.6-sol")!,
      id: "azure:gpt-5.6-sol",
      name: "Azure GPT-5.6 Sol",
      provider: "azure" as const,
    };
    MODELS.push(azureSol);
    try {
      expect(getSupportedThinkingLevels("azure", azureSol.id)).toEqual([...baseLevels, "ultra"]);
      expect(getNextThinkingLevel("azure", azureSol.id, "max")).toBe("ultra");
      expect(clampThinkingLevel("azure", azureSol.id, "ultra")).toBe("ultra");
    } finally {
      MODELS.splice(MODELS.indexOf(azureSol), 1);
    }
  });

  it("cycles Anthropic adaptive Opus models through max, including xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-opus-4-8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-opus-4-8", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("anthropic", "claude-opus-4-8", "max")).toBeUndefined();
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

  it("returns no levels for a registered model that does not support thinking", () => {
    const model = {
      id: "test-non-thinking-model",
      name: "Test Non-Thinking Model",
      provider: "azure" as const,
      contextWindow: 1_000,
      maxOutputTokens: 100,
      supportsThinking: false,
      supportsImages: false,
      supportsVideo: false,
      costTier: "low" as const,
      maxThinkingLevel: "low" as const,
    };
    MODELS.push(model);

    try {
      expect(getSupportedThinkingLevels(model.provider, model.id)).toEqual([]);
      expect(getNextThinkingLevel(model.provider, model.id, undefined)).toBeUndefined();
      expect(getNextThinkingLevel(model.provider, model.id, "high")).toBeUndefined();
      expect(clampThinkingLevel(model.provider, model.id, "high")).toBeUndefined();
    } finally {
      MODELS.splice(MODELS.indexOf(model), 1);
    }
  });

  it("preserves fallback thinking behavior for unknown models", () => {
    expect(getSupportedThinkingLevels("azure", "unknown-azure-model")).toEqual(["high"]);
    expect(getNextThinkingLevel("azure", "unknown-azure-model", undefined)).toBe("high");
  });

  it("keeps non-cycling providers at their model's sole supported effort", () => {
    expect(getSupportedThinkingLevels("moonshot", "kimi-k3")).toEqual(["max"]);
    expect(getNextThinkingLevel("moonshot", "kimi-k3", undefined)).toBe("max");
    expect(getNextThinkingLevel("moonshot", "kimi-k3", "max")).toBeUndefined();
    expect(getSupportedThinkingLevels("moonshot", "kimi-k2.7-code")).toEqual(["high"]);
    expect(getNextThinkingLevel("moonshot", "kimi-k2.7-code", undefined)).toBe("high");
    expect(getNextThinkingLevel("moonshot", "kimi-k2.7-code", "high")).toBeUndefined();
  });
});
