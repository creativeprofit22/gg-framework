import { describe, expect, it } from "vitest";
import { clampToBytes, CONTEXT_LIMITS, resolveContextLimits } from "./context-limits.js";

describe("clampToBytes", () => {
  it("returns short text unchanged", () => {
    const result = clampToBytes("hello", 1024);
    expect(result).toEqual({ text: "hello", truncated: false, originalBytes: 5 });
  });

  it("returns text at exactly the budget unchanged", () => {
    const text = "a".repeat(100);
    const result = clampToBytes(text, 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  it("cuts ASCII and appends an ellipsis within budget", () => {
    const result = clampToBytes("a".repeat(1000), 100);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(1000);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(100);
    expect(result.text.endsWith("\u2026")).toBe(true);
  });

  it("never splits a multibyte codepoint at the boundary", () => {
    // "😀" is 4 bytes; a 33-byte cut must not leave a dangling lead byte.
    const text = "😀".repeat(20); // 80 bytes
    const result = clampToBytes(text, 33);
    expect(result.truncated).toBe(true);
    // Round-trips cleanly: no U+FFFD replacement characters.
    expect(result.text).not.toContain("\ufffd");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(33);
  });

  it("handles CJK text at the boundary", () => {
    const text = "漢".repeat(50); // 3 bytes each
    const result = clampToBytes(text, 10);
    expect(result.text).not.toContain("\ufffd");
    // 10 bytes = 3 CJK chars (9) + ellipsis (3) — one full char dropped.
    expect(result.text).toBe(`漢漢\u2026`);
  });

  it("degrades to empty for budgets smaller than an ellipsis", () => {
    const result = clampToBytes("hello", 2);
    expect(result).toEqual({ text: "", truncated: true, originalBytes: 5 });
  });

  it("leaves empty text empty", () => {
    expect(clampToBytes("", 8)).toEqual({ text: "", truncated: false, originalBytes: 0 });
  });
});

describe("resolveContextLimits", () => {
  it("returns defaults with no overrides", () => {
    expect(resolveContextLimits()).toEqual(CONTEXT_LIMITS);
  });

  it("merges only the provided keys", () => {
    const limits = resolveContextLimits({ skillDescriptionBytes: 2048 });
    expect(limits.skillDescriptionBytes).toBe(2048);
    expect(limits.skillCatalogBytes).toBe(CONTEXT_LIMITS.skillCatalogBytes);
  });
});
