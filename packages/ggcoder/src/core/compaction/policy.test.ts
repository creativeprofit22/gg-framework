import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_THRESHOLD, resolveCompactionPolicy } from "./policy.js";

describe("resolveCompactionPolicy", () => {
  it("uses the shared 0.85 default and exact whole-token trigger", () => {
    const policy = resolveCompactionPolicy({
      provider: "anthropic",
      model: "claude-test",
      contextWindow: 200_000,
    });

    expect(policy.threshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(policy.targetTokens).toBe(170_000);
  });

  it("keys retries by transport, model, threshold, and approved plan", () => {
    const api = resolveCompactionPolicy({
      provider: "openai",
      model: "gpt-5.5",
      contextWindow: 1_050_000,
      threshold: 0.8,
    });
    const codex = resolveCompactionPolicy({
      provider: "openai",
      model: "gpt-5.5",
      contextWindow: 272_000,
      threshold: 0.8,
      accountId: "account",
      approvedPlanPath: "/tmp/plan.md",
    });

    expect(api.targetTokens).toBe(840_000);
    expect(codex.targetTokens).toBe(217_600);
    expect(codex.policyKey).not.toBe(api.policyKey);
    expect(codex.policyKey).toContain("codex_oauth");
    expect(codex.policyKey).toContain("/tmp/plan.md");
  });
});
