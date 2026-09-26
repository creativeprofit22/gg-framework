import { describe, expect, it } from "vitest";
import { scaledFirstEventTimeoutMs } from "./agent-loop.js";

/**
 * Regression shape of the 2026-09-22 incident: GLM's public transport
 * re-prefills the whole prompt every turn (~3-5K tok/s uncached), so a
 * 213K-token session measured 44-68s to first event — above the fixed 45s
 * first-event watchdog. Every such turn aborted as a "stall" and retried
 * cold, which is how a simple task spent ~28 of its 60 minutes waiting on
 * prefill. The watchdog must scale with prompt size.
 */
describe("scaledFirstEventTimeoutMs", () => {
  it("keeps the fixed 45s budget for small prompts (fast stall detection)", () => {
    expect(scaledFirstEventTimeoutMs(1_000)).toBeNull();
    expect(scaledFirstEventTimeoutMs(19_999)).toBeNull();
  });

  it("scales linearly with prompt tokens once prefill dominates", () => {
    const t100k = scaledFirstEventTimeoutMs(100_000);
    const t200k = scaledFirstEventTimeoutMs(200_000);
    expect(t100k).not.toBeNull();
    expect(t200k).not.toBeNull();
    // 45s base + tokens/1000 × 640ms
    expect(t100k!).toBe(45_000 + 100 * 640);
    expect(t200k!).toBe(45_000 + 200 * 640);
    // Monotone in prompt size.
    expect(t200k!).toBeGreaterThan(t100k!);
  });

  it("covers the observed incident: 213K tokens reached first event in 44-68s", () => {
    const t213k = scaledFirstEventTimeoutMs(213_000);
    expect(t213k!).toBeGreaterThanOrEqual(68_000); // no false abort at the observed worst case
  });

  it("is capped so a true stall is still detected within a bounded wait", () => {
    expect(scaledFirstEventTimeoutMs(500_000)).toBe(180_000);
    expect(scaledFirstEventTimeoutMs(1_000_000)).toBe(180_000);
  });
});
