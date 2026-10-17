import { describe, expect, it } from "vitest";
import {
  CODE_COLLAPSE_LINE_THRESHOLD,
  ROW_COLLAPSE_CHARS,
  collapsedCode,
  diffLineKind,
  diffMetaEnd,
  isDiffLanguage,
  shouldCollapseCode,
  shouldCollapseRow,
  visibleBlockCount,
} from "./collapse";

const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

describe("diff preview line kinds (mirrors highlight.js diff grammar)", () => {
  it.each([
    ["@@ -1,2 +1,2 @@ fn", "meta"],
    ["@@ -1 +1 @@", "meta"],
    ["--- 1,4 ----", "meta"],
    ["diff --git a/x b/x", "comment"],
    ["index 3f2a1c0..9b7e4d2 100644", "comment"],
    ["--- a/x", "comment"],
    ["+++ b/x", "comment"],
    ["Index: x", "comment"],
    ["+added", "addition"],
    ["!changed", "addition"],
    ["-removed", "deletion"],
    [" context", null],
    ["@@ not a hunk", null],
    ["", null],
  ] as const)("%j is %s", (line, kind) => {
    expect(diffLineKind(line)).toBe(kind);
  });
});

describe("diff hunk header colour extent (highlight.js meta is a plain match)", () => {
  it.each([
    ["@@ -1,2 +1,2 @@ fn", 15],
    ["@@ -1 +1 @@", 11],
    ["--- 1,4 ----", 12],
    ["+added", null],
    ["@@ not a hunk", null],
  ] as const)("%j colours %s chars", (line, end) => {
    expect(diffMetaEnd(line)).toBe(end);
  });
});

describe("diff fence languages", () => {
  it.each([
    ["diff", true],
    ["patch", true],
    ["ts", false],
    [null, false],
  ] as const)("%j is a diff: %s", (lang, expected) => {
    expect(isDiffLanguage(lang)).toBe(expected);
  });
});

describe("fenced-block collapse threshold", () => {
  it("leaves a block at the threshold alone", () => {
    const text = lines(CODE_COLLAPSE_LINE_THRESHOLD);
    expect(shouldCollapseCode(text)).toBe(false);
    expect(collapsedCode(text).hiddenLines).toBe(0);
    expect(collapsedCode(text).preview).toBe(text);
  });

  it("folds the first block past the threshold", () => {
    const text = lines(CODE_COLLAPSE_LINE_THRESHOLD + 1);
    expect(shouldCollapseCode(text)).toBe(true);
    expect(collapsedCode(text).hiddenLines).toBe(1);
  });

  it("previews exactly the threshold count and hides the rest", () => {
    const { preview, hiddenLines } = collapsedCode(lines(1000));
    expect(preview.split("\n")).toHaveLength(CODE_COLLAPSE_LINE_THRESHOLD);
    expect(hiddenLines).toBe(1000 - CODE_COLLAPSE_LINE_THRESHOLD);
    // The win is what is NOT mounted: the preview is a rounding error next to
    // the full dump that used to be rendered as highlighted spans.
    expect(preview.length).toBeLessThan(lines(1000).length / 50);
  });

  it("ignores the trailing newline a fence leaves behind", () => {
    expect(shouldCollapseCode(`${lines(CODE_COLLAPSE_LINE_THRESHOLD)}\n`)).toBe(false);
  });
});

describe("oversized-row collapse", () => {
  it("renders every block when the content fits the budget", () => {
    const blocks = ["a".repeat(100), "b".repeat(100)];
    expect(visibleBlockCount(blocks)).toBe(2);
    expect(shouldCollapseRow(blocks)).toBe(false);
  });

  it("holds blocks back once the content exceeds the budget", () => {
    const blocks = Array.from({ length: 40 }, () => "x".repeat(1024));
    expect(shouldCollapseRow(blocks)).toBe(true);
    // 8 KB budget over 1 KB blocks: the ninth crosses it, so eight stay.
    expect(visibleBlockCount(blocks)).toBe(ROW_COLLAPSE_CHARS / 1024);
  });

  it("still renders one block when a single block blows the whole budget", () => {
    // A lone 200 KB block must not collapse to an empty row — its own fenced
    // collapse handles the size instead.
    expect(visibleBlockCount(["z".repeat(200_000)])).toBe(1);
  });

  it("never splits a block mid-way", () => {
    const blocks = ["short", "y".repeat(ROW_COLLAPSE_CHARS * 2), "tail"];
    const count = visibleBlockCount(blocks);
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(blocks.length);
  });
});
