import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  resolveCompactionPolicy,
  resolveLatencyWindowCap,
} from "./policy.js";

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

  it("caps GLM's trigger window on a latency budget despite the 1M advertised window", () => {
    // Regression shape of the 2026-09-22 incident: a GLM session at 213K
    // tokens (21% of a 1M window) paid 44-68s TTFT on every turn and never
    // triggered the 85% compaction (limit: 850K). The latency cap must pull
    // the trigger down to ~150K so long-looping sessions summarize long
    // before every turn costs a minute of prefill.
    expect(resolveLatencyWindowCap("glm")).toBe(176_000);

    const policy = resolveCompactionPolicy({
      provider: "glm",
      model: "glm-5.3",
      contextWindow: 1_000_000,
    });
    expect(policy.targetTokens).toBe(149_600); // 0.85 × 176K latency cap
    expect(policy.policyKey).toContain('"contextWindow":176000');
  });

  it("keeps a smaller advertised window authoritative over the latency cap", () => {
    const policy = resolveCompactionPolicy({
      provider: "glm",
      model: "glm-future-lite",
      contextWindow: 120_000,
    });
    expect(policy.targetTokens).toBe(102_000); // 0.85 × 120K — cap is a max, not a floor
  });

  it("applies the latency cap through the user-configured threshold", () => {
    const policy = resolveCompactionPolicy({
      provider: "glm",
      model: "glm-5.3",
      contextWindow: 1_000_000,
      threshold: 0.5,
    });
    expect(policy.targetTokens).toBe(88_000); // 0.5 × 176K
  });

  it("leaves measured-healthy providers on the advertised window", () => {
    // anthropic: explicit cache_control breakpoints; openai: measured flat
    // TTFT at 237K (sidecar audit). Both keep their full windows.
    expect(resolveLatencyWindowCap("anthropic")).toBeUndefined();
    expect(resolveLatencyWindowCap("openai")).toBeUndefined();
    const policy = resolveCompactionPolicy({
      provider: "anthropic",
      model: "claude-test",
      contextWindow: 200_000,
      threshold: 0.8,
    });
    expect(policy.targetTokens).toBe(160_000);
  });

  it("applies the conservative default cap to UNMEASURED providers with mega-windows", () => {
    // Any model a user picks that we have no cache evidence for gets the
    // default ceiling — this is deliberately not GLM-only.
    expect(resolveLatencyWindowCap("gemini")).toBe(400_000);
    expect(resolveLatencyWindowCap("minimax")).toBe(400_000);
    expect(resolveLatencyWindowCap("xiaomi")).toBe(400_000);

    const policy = resolveCompactionPolicy({
      provider: "gemini",
      model: "gemini-3.8-flash",
      contextWindow: 1_048_576,
    });
    expect(policy.targetTokens).toBe(340_000); // 0.85 × 400K default cap
  });

  it("never raises a trigger the provider's real window keeps lower", () => {
    // A typical 256K window under the 400K default: min() keeps it authoritative.
    const policy = resolveCompactionPolicy({
      provider: "moonshot",
      model: "kimi-k2.7-code",
      contextWindow: 262_144,
      threshold: 0.8,
    });
    expect(policy.targetTokens).toBe(209_716); // 0.8 × 262,144 — unchanged
  });
});
