import { describe, it, expect } from "vitest";
import {
  runFullBenchmark,
  runBenchmark,
  createDefaultWorkload,
  createVirtualBenchmarkClock,
  formatComparison,
  MockBenchmarkProvider,
  REALISTIC_TIMING,
  type MockTimingConfig,
} from "./speed-benchmark.js";

describe("Speed Benchmark", () => {
  it("optimized should be faster than baseline on multi-turn workload", async () => {
    const comparison = await runFullBenchmark({ clock: createVirtualBenchmarkClock() });

    // Print the full comparison table for visibility.
    const report = formatComparison(comparison);
    console.log(report);

    // The optimized run should have a higher cache hit rate — the 7-min gap
    // turn (turn 4) misses the 5-min cache but hits the 1-h cache.
    expect(comparison.optimized.cacheHitRate).toBeGreaterThan(comparison.baseline.cacheHitRate);

    // The optimization target is lower TTFT. Total wall-clock includes fixed
    // output streaming sleeps and can jitter by a few milliseconds in CI.
    expect(comparison.optimized.totalTtftMs).toBeLessThan(comparison.baseline.totalTtftMs);

    // TTFT improvement should be meaningful (> 5%).
    expect(comparison.ttftImprovement).toBeGreaterThan(5);
  });

  it("baseline misses cache on turn after 5-min gap", async () => {
    const workload = createDefaultWorkload();
    const baselineConfig: MockTimingConfig = {
      ...REALISTIC_TIMING,
      coldPrefillMsPerToken: 0.015, // scaled for speed
      warmPrefillMsPerToken: 0.0015,
      outputMsPerToken: 1.2,
      networkOverheadMs: 20,
      cacheTtlMs: 5 * 60 * 1000, // 5 min
    };

    const result = await runBenchmark(workload, baselineConfig, {
      name: "5min TTL",
      clock: createVirtualBenchmarkClock(),
    });

    // Turn 4 has a 7-min delay — should be a cache miss with 5-min TTL.
    const turn4 = result.turns[3];
    expect(turn4).toBeDefined();
    expect(turn4.cacheHit).toBe(false);

    // Turns 2 and 3 (3-min and 4-min delays) should be cache hits.
    expect(result.turns[1].cacheHit).toBe(true);
    expect(result.turns[2].cacheHit).toBe(true);
  });

  it("optimized hits cache on turn after 5-min gap (1-h TTL)", async () => {
    const workload = createDefaultWorkload();
    const optimizedConfig: MockTimingConfig = {
      ...REALISTIC_TIMING,
      coldPrefillMsPerToken: 0.015,
      warmPrefillMsPerToken: 0.0015,
      outputMsPerToken: 1.2,
      networkOverheadMs: 20,
      cacheTtlMs: 60 * 60 * 1000, // 1 hour
    };

    const result = await runBenchmark(workload, optimizedConfig, {
      name: "1h TTL",
      prewarm: true,
      clock: createVirtualBenchmarkClock(),
    });

    // Turn 4 has a 7-min delay — should be a cache HIT with 1-h TTL.
    const turn4 = result.turns[3];
    expect(turn4).toBeDefined();
    expect(turn4.cacheHit).toBe(true);

    // Turn 1 should be a cache hit too (pre-warmed).
    expect(result.turns[0].cacheHit).toBe(true);
  });

  it("pre-warming makes first turn a cache hit", async () => {
    const workload = createDefaultWorkload();
    const config: MockTimingConfig = {
      ...REALISTIC_TIMING,
      coldPrefillMsPerToken: 0.015,
      warmPrefillMsPerToken: 0.0015,
      outputMsPerToken: 1.2,
      networkOverheadMs: 20,
      cacheTtlMs: 60 * 60 * 1000,
    };

    // Without pre-warm.
    const cold = await runBenchmark(workload, config, {
      name: "No prewarm",
      clock: createVirtualBenchmarkClock(),
    });
    expect(cold.turns[0].cacheHit).toBe(false);

    // With pre-warm.
    const warm = await runBenchmark(workload, config, {
      name: "With prewarm",
      prewarm: true,
      clock: createVirtualBenchmarkClock(),
    });
    expect(warm.turns[0].cacheHit).toBe(true);

    // First-turn TTFT should be lower with pre-warm.
    expect(warm.turns[0].ttftMs).toBeLessThan(cold.turns[0].ttftMs);
  });

  it("uses the injected clock instead of real time", async () => {
    const clock = createVirtualBenchmarkClock();
    const realStart = performance.now();
    const result = await runBenchmark(createDefaultWorkload(), REALISTIC_TIMING, {
      name: "Unscaled",
      clock,
    });
    const realElapsedMs = performance.now() - realStart;

    // Every measured millisecond came from the fake clock.
    expect(result.totalWallClockMs).toBeCloseTo(clock.now());
    expect(result.totalWallClockMs).toBeGreaterThan(9_000);
    expect(realElapsedMs).toBeLessThan(1_000);

    const turn1 = result.turns[0];
    expect(turn1).toBeDefined();
    // The first event arrives after network + cold prefill + one output token.
    expect(turn1.ttftMs).toBeCloseTo(
      REALISTIC_TIMING.networkOverheadMs +
        turn1.inputTokens * REALISTIC_TIMING.coldPrefillMsPerToken +
        REALISTIC_TIMING.outputMsPerToken,
    );
  });

  it("mock provider tracks stats correctly", () => {
    const provider = new MockBenchmarkProvider({
      ...REALISTIC_TIMING,
      cacheTtlMs: 60 * 60 * 1000,
    });

    // Pre-warm.
    provider.prewarm("test-key", 1000);
    expect(provider.stats.cacheWrites).toBe(1);

    // Reset.
    provider.reset();
    expect(provider.stats.cacheWrites).toBe(0);
    expect(provider.getCacheSize()).toBe(0);
  });
});
