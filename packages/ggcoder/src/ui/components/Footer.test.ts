import { describe, expect, it } from "vitest";
import { doesFooterFitOnOneLine, getFooterContextPercent, getFooterRightLength, getThinkingFooterLabel } from "./Footer.js";

describe("Footer thinking labels", () => {
  it.each(["qwen-cloud/qwen3.7-max", "qwen-cloud/qwen3.6-flash"])("shows binary on/off for %s", (model) => {
    expect(getThinkingFooterLabel("high", model)).toBe("Thinking on");
    expect(getThinkingFooterLabel(undefined, model)).toBe("Thinking off");
  });

  it("shows mandatory GLM thinking and preserves direct-provider labels", () => {
    expect(getThinkingFooterLabel(undefined, "qwen-cloud/glm-5.3")).toBe("Thinking high");
    expect(getThinkingFooterLabel("high", "glm-5.3")).toBe("Thinking high");
    expect(getThinkingFooterLabel(undefined, "glm-5.3")).toBe("Thinking off");
    expect(getThinkingFooterLabel("max", "claude-opus-5")).toBe("Thinking max");
  });

  it.each([
    ["qwen-cloud/qwen3.7-max", "high", "Thinking on"],
    ["qwen-cloud/qwen3.6-flash", undefined, "Thinking off"],
    ["qwen-cloud/glm-5.3", undefined, "Thinking high"],
  ] as const)("measures the rendered label for %s", (model, thinkingLevel, thinkingText) => {
    const rightLength = getFooterRightLength({ barWidth: 8, contextPct: 0, modelName: model, thinkingText });
    const columns = "project".length + 2 + rightLength + 2;
    const options = { model, thinkingLevel, tokensIn: 0, cwd: "/project" };
    expect(doesFooterFitOnOneLine({ ...options, columns })).toBe(true);
    expect(doesFooterFitOnOneLine({ ...options, columns: columns - 1 })).toBe(false);
  });
});

describe("Footer route-aware context percentage", () => {
  it("uses the larger public window for API-key OpenAI routes", () => {
    expect(
      getFooterContextPercent("gpt-6-sol", 64_000, {
        provider: "openai",
      }),
    ).toBe(6);
  });

  it("uses the Codex product cap for OAuth OpenAI routes", () => {
    expect(
      getFooterContextPercent("gpt-6-sol", 64_000, {
        provider: "openai",
        accountId: "acct_123",
      }),
    ).toBe(24);
  });
});
