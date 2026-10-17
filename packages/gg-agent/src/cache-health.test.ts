import { describe, expect, it } from "vitest";
import { assessCacheHealth } from "./agent-loop.js";

/**
 * Prompt-cache health is the evidence layer for provider-agnostic latency
 * caps: a provider whose large prompts are consistently served mostly
 * uncached re-prefills the whole context every turn (the GLM incident
 * pattern), no matter what its docs claim about caching.
 *
 * Usage convention (normalized in gg-ai, Anthropic-style): inputTokens
 * EXCLUDES cache hits, so the served-from-cache share of the prompt is
 * cacheRead / (input + cacheRead + cacheWrite).
 */
describe("assessCacheHealth", () => {
  it("ignores small prompts — a miss there is cheap and uninteresting", () => {
    const health = assessCacheHealth({ inputTokens: 10_000, outputTokens: 5 });
    expect(health.ratio).toBeNull();
    expect(health.low).toBe(false);
  });

  it("reports the served-from-cache share of a large prompt", () => {
    // 100K served from cache, 20K fresh prefill, 10K cache write
    const health = assessCacheHealth({
      inputTokens: 20_000,
      outputTokens: 5,
      cacheRead: 100_000,
      cacheWrite: 10_000,
    });
    expect(health.promptTokens).toBe(130_000);
    expect(health.ratio).toBeCloseTo(100_000 / 130_000);
    expect(health.low).toBe(false);
  });

  it("flags the GLM pattern: large prompt, almost nothing served from cache", () => {
    // Incident shape: 200K prompt, zero cache read
    const health = assessCacheHealth({ inputTokens: 200_000, outputTokens: 500 });
    expect(health.promptTokens).toBe(200_000);
    expect(health.cacheRead).toBe(0);
    expect(health.ratio).toBe(0);
    expect(health.low).toBe(true);
  });

  it("flags partial misses below the low-water mark", () => {
    // 100K prompt, 40K cached → ratio 0.4 < 0.5
    const health = assessCacheHealth({
      inputTokens: 60_000,
      outputTokens: 5,
      cacheRead: 40_000,
    });
    expect(health.ratio).toBeCloseTo(0.4);
    expect(health.low).toBe(true);
  });

  it("treats exactly-half-cached as healthy", () => {
    const health = assessCacheHealth({
      inputTokens: 50_000,
      outputTokens: 5,
      cacheRead: 50_000,
    });
    expect(health.ratio).toBeCloseTo(0.5);
    expect(health.low).toBe(false);
  });
});
