import { describe, expect, it } from "vitest";
import {
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./thinking-level.js";

describe("getNextThinkingLevel", () => {
  it("cycles GPT-6 Astra through low, medium, high, xhigh, max, ultra, then off", () => {
    expect(getNextThinkingLevel("openai", "gpt-6-astra", undefined)).toBe("low");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "low")).toBe("medium");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "medium")).toBe("high");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "max")).toBe("ultra");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "ultra")).toBeUndefined();
  });

  it("recognizes every Astra cycle level as supported", () => {
    expect(getSupportedThinkingLevels("openai", "gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(isThinkingLevelSupported("openai", "gpt-6-astra", "low")).toBe(true);
    expect(isThinkingLevelSupported("openai", "gpt-6-astra", "medium")).toBe(true);
    expect(isThinkingLevelSupported("openai", "gpt-6-astra", "high")).toBe(true);
    expect(isThinkingLevelSupported("openai", "gpt-6-astra", "xhigh")).toBe(true);
    expect(isThinkingLevelSupported("openai", "gpt-6-astra", "max")).toBe(true);
    expect(isThinkingLevelSupported("openai", "gpt-6-astra", "ultra")).toBe(true);
  });

  it("cycles Anthropic adaptive models through low, medium, high, xhigh, max, then off", () => {
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", undefined)).toBe("low");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", "low")).toBe("medium");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", "medium")).toBe("high");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5", "max")).toBeUndefined();
  });

  it("recognizes Anthropic adaptive effort levels supported by each model", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getSupportedThinkingLevels("anthropic", "claude-sonnet-5")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(isThinkingLevelSupported("anthropic", "claude-opus-5", "max")).toBe(true);
  });

  it("keeps non-GPT OpenAI models as a binary max-thinking toggle", () => {
    expect(getNextThinkingLevel("openai", "o3", undefined)).toBe("high");
    expect(getNextThinkingLevel("openai", "o3", "high")).toBeUndefined();
  });
});
