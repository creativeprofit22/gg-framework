import { describe, expect, it } from "vitest";
import { MotionReviewCoverage } from "./motion-review-coverage.js";

describe("production chapter coverage", () => {
  it("cannot approve a long film from only its first chapter", () => {
    const coverage = new MotionReviewCoverage();
    coverage.record("render-source-a", { start: 0, end: 120 }, true);
    expect(coverage.complete("render-source-a", 240)).toBe(false);
    coverage.record("render-source-a", { start: 120, end: 240 }, false);
    expect(coverage.complete("render-source-a", 240)).toBe(false);
    coverage.record("render-source-a", { start: 120, end: 240 }, true);
    expect(coverage.complete("render-source-a", 240)).toBe(true);
    expect(coverage.complete("render-source-b", 240)).toBe(false);
  });
  it("requires contiguous coverage and invalidates observed work", () => {
    const coverage = new MotionReviewCoverage();
    coverage.record("a", { start: 0, end: 1 }, true);
    coverage.record("a", { start: 1.1, end: 2 }, true);
    expect(coverage.complete("a", 2)).toBe(false);
    coverage.record("a", { start: 1, end: 2 }, true);
    expect(coverage.complete("a", 2)).toBe(true);
    coverage.clear();
    expect(coverage.complete("a", 2)).toBe(false);
  });
});
