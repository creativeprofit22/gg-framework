/**
 * Benchmark 02: Edit Fuzzy Matching
 *
 * Measures: fuzzyFindText + countOccurrences on large files.
 * Tests exact match (fast path), whitespace-drift match (fuzzy path),
 * and no-match (worst case — full scan).
 */
import { bench } from "./harness.js";
import {
  readFixtureContent,
} from "./fixtures.js";
import {
  fuzzyFindText,
  countOccurrences,
} from "../packages/ggcoder/dist/tools/edit-diff.js";

export async function runEditBench(): Promise<import("./harness.js").BenchResult[]> {
  const results: import("./harness.js").BenchResult[] = [];
  const sizes = [500, 2000, 5000, 10000];

  for (const lines of sizes) {
    const content = readFixtureContent("tsfile", lines);

    // Extract a snippet from the middle for matching
    const contentLines = content.split("\n");
    const midStart = Math.floor(lines / 2);
    const snippet = contentLines.slice(midStart, midStart + 10).join("\n");

    // Exact match — the fast path
    results.push(
      await bench(`edit-fuzzy:exact-match(${lines} lines)`, () => {
        fuzzyFindText(content, snippet);
      }, 100),
    );

    // Fuzzy match — add trailing whitespace drift to the snippet
    const drifted = snippet
      .split("\n")
      .map((l: string) => l + "  ")
      .join("\n");
    results.push(
      await bench(`edit-fuzzy:whitespace-drift(${lines} lines)`, () => {
        fuzzyFindText(content, drifted);
      }, 50),
    );

    // Worst case — no match anywhere (full O(n*m) scan)
    const noMatchSnippet = "this text does not exist anywhere in the file\n".repeat(5);
    results.push(
      await bench(`edit-fuzzy:no-match-full-scan(${lines} lines)`, () => {
        fuzzyFindText(content, noMatchSnippet);
      }, 20),
    );

    // countOccurrences — fuzzy path
    results.push(
      await bench(`edit-count:occurrences(${lines} lines)`, () => {
        countOccurrences(content, drifted);
      }, 50),
    );
  }

  return results;
}
