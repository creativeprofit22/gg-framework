import { describe, expect, it } from "vitest";
import {
  getBossFooterContextPercent,
  getBossFooterScopeLabel,
  getBossFooterThinkingLabel,
} from "./boss-footer.js";

describe("BossFooter helpers", () => {
  it("reports the actual thinking tier", () => {
    expect(getBossFooterThinkingLabel(undefined)).toBe("Thinking off");
    expect(getBossFooterThinkingLabel("medium")).toBe("Thinking medium");
    expect(getBossFooterThinkingLabel("high")).toBe("Thinking high");
  });

  it("formats the all-projects scope label", () => {
    expect(getBossFooterScopeLabel("all")).toBe("all projects");
    expect(getBossFooterScopeLabel("api")).toBe("api");
  });

  it("computes context percentage from the boss model window", () => {
    expect(getBossFooterContextPercent("claude-sonnet-5", 0)).toBe(0);
    expect(getBossFooterContextPercent("claude-sonnet-5", 20_000)).toBeGreaterThan(0);
    expect(getBossFooterContextPercent("claude-sonnet-5", 20_000)).toBeLessThan(100);
    expect(getBossFooterContextPercent("gpt-5.5", 136_000, 272_000)).toBe(50);
  });
});
