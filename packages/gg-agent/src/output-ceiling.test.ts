import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampOutputTokens,
  outputRouteKey,
  outputTokenCeiling,
  parseOutputTokenCeiling,
  rememberOutputCeiling,
  resetOutputCeilingsForTests,
} from "./output-ceiling.js";

const key = outputRouteKey({ provider: "anthropic", model: "claude-x", baseUrl: undefined });

beforeEach(() => resetOutputCeilingsForTests());
afterEach(() => vi.useRealTimers());

describe("parseOutputTokenCeiling", () => {
  it("reads the accepted ceiling out of real provider rejections", () => {
    const cases: [string, number][] = [
      [
        "max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-x",
        64000,
      ],
      [
        "max_tokens is too large: 40000. This model supports at most 16384 completion tokens",
        16384,
      ],
      ["Invalid value for max_tokens: must be <= 4096", 4096],
      ["max output tokens is 8192 for this deployment", 8192],
    ];

    for (const [message, expected] of cases) {
      expect(parseOutputTokenCeiling(new Error(message))).toBe(expected);
    }
  });

  it("ignores errors that are not about the output budget", () => {
    // Clamping output because the INPUT was too big would truncate every reply
    // afterwards for a reason that has nothing to do with output.
    for (const message of [
      // OpenRouter's 402: names max_tokens, but the number is what we asked for
      // and a top-up fixes it — clamping here would throttle the session for good.
      "This request requires more credits, or fewer max_tokens. You requested up to 225702 tokens.",
      "prompt is too long: 250000 tokens > 200000 maximum context length",
      "429 rate limit exceeded: 20000 tokens/min",
      "Insufficient credits: requires more credits to run this request",
      "socket hang up",
    ]) {
      expect(parseOutputTokenCeiling(new Error(message))).toBeNull();
    }
  });

  it("rejects implausible numbers rather than trusting a stray match", () => {
    // Below the floor: far more likely a parse accident than a real ceiling.
    expect(parseOutputTokenCeiling(new Error("max_tokens must be <= 4"))).toBeNull();
    expect(parseOutputTokenCeiling(new Error("max output tokens is 12"))).toBeNull();
  });

  it("ignores anything that is not an Error, rather than parsing it", () => {
    // Provider rejections reach us as Errors; a bare string or object here means
    // the caller lost the original, and guessing a ceiling from it would clamp
    // every later turn on evidence we cannot trust.
    for (const notAnError of [
      "max_tokens: 100000 > 64000",
      { message: "max_tokens: 100000 > 64000" },
      null,
      undefined,
    ]) {
      expect(parseOutputTokenCeiling(notAnError)).toBeNull();
    }
  });
});

describe("learned ceilings", () => {
  it("is learned once, then clamps every later request on that route", () => {
    expect(clampOutputTokens(key, 100_000)).toBe(100_000);

    rememberOutputCeiling(key, 64_000);

    expect(clampOutputTokens(key, 100_000)).toBe(64_000);
    // A request already under the ceiling is left exactly as asked.
    expect(clampOutputTokens(key, 8_000)).toBe(8_000);
    // And an unspecified budget adopts the known-good value.
    expect(clampOutputTokens(key, undefined)).toBe(64_000);
  });

  it("keeps ceilings separate per provider, route and model", () => {
    rememberOutputCeiling(key, 64_000);

    // A gateway can cap lower than the origin, and a sibling model higher, so
    // one route's rejection must not silently throttle another.
    for (const other of [
      { provider: "anthropic", model: "claude-y" },
      { provider: "openai", model: "claude-x" },
      { provider: "anthropic", model: "claude-x", baseUrl: "https://gateway.example" },
    ]) {
      expect(clampOutputTokens(outputRouteKey(other), 100_000)).toBe(100_000);
    }
  });

  it("keeps the lower of two stated ceilings", () => {
    rememberOutputCeiling(key, 64_000);
    rememberOutputCeiling(key, 16_384);
    expect(outputTokenCeiling(key)).toBe(16_384);

    // A later, looser claim does not raise a limit that already held.
    rememberOutputCeiling(key, 64_000);
    expect(outputTokenCeiling(key)).toBe(16_384);
  });

  it("expires after 24h so a raised limit is not throttled forever", () => {
    vi.useFakeTimers();
    rememberOutputCeiling(key, 64_000);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1000);
    expect(clampOutputTokens(key, 100_000)).toBe(64_000);

    vi.advanceTimersByTime(2000);
    expect(outputTokenCeiling(key)).toBeUndefined();
    expect(clampOutputTokens(key, 100_000)).toBe(100_000);
  });
});
