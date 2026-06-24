/**
 * Benchmark 12: Markdown Re-parse During Streaming
 *
 * Simulates the exact cost of re-parsing accumulated markdown on every
 * text_delta token. In the current codebase, ReactMarkdown + remarkGfm
 * + rehypeHighlight re-parses the ENTIRE accumulated text on every token.
 *
 * This benchmark measures the theoretical cost savings of debouncing:
 *   1. CURRENT: parse on every token (O(n²) total)
 *   2. PROPOSED: parse only on completion (O(n) total)
 *
 * We can't run ReactMarkdown in Node, so we simulate the parse cost
 * using a markdown parser (marked) with syntax highlighting.
 */
import { bench, type BenchResult } from "./harness.js";

// We'll use 'marked' as a stand-in for remark+rehype — same O(n) parse cost
// per invocation. The point is to measure the cumulative cost of N parses
// of progressively longer text vs 1 final parse.
import { marked } from "marked";

// Generate a realistic code-heavy markdown response
function generateCodeHeavyMarkdown(tokens: number): string {
  const lines: string[] = [
    "Here's the implementation:\n",
    "```typescript",
  ];
  for (let i = 0; i < tokens; i++) {
    lines.push(`function process_${i}(data: Map<string, unknown>): boolean {`);
    lines.push(`  const result = data.get("key_${i}");`);
    lines.push(`  if (!result) return false;`);
    lines.push(`  return Object.keys(result).length > 0;`);
    lines.push(`}`);
    lines.push("");
  }
  lines.push("```");
  lines.push("\nThis approach handles edge cases efficiently.");
  return lines.join("\n");
}

export async function runMarkdownBench(): Promise<{ results: BenchResult[]; comparisons: { name: string; beforeMs: number; afterMs: number; speedup: number }[] }> {
  const comparisons: { name: string; beforeMs: number; afterMs: number; speedup: number }[] = [];
  const results: BenchResult[] = [];

  const tokenCounts = [50, 100, 200, 500];

  for (const tokenCount of tokenCounts) {
    const fullMarkdown = generateCodeHeavyMarkdown(tokenCount);

    // CURRENT: re-parse on every "token" (simulate streaming)
    // Each iteration re-parses text from 1..N tokens
    const before = await bench(`markdown:reparse-every-token(${tokenCount} tokens)`, () => {
      // Simulate streaming: parse progressively longer text
      const lines = fullMarkdown.split("\n");
      const totalLines = lines.length;
      const linesPerToken = Math.ceil(totalLines / tokenCount);
      for (let t = 1; t <= tokenCount; t++) {
        const partial = lines.slice(0, t * linesPerToken).join("\n");
        marked.parse(partial);
      }
    }, tokenCount <= 100 ? 5 : 3);

    // PROPOSED: parse only once at completion
    const after = await bench(`markdown:parse-once(${tokenCount} tokens)`, () => {
      marked.parse(fullMarkdown);
    }, tokenCount <= 100 ? 50 : 20);

    results.push(before, after);
    const speedup = Math.round((before.meanMs / after.meanMs) * 100) / 100;
    comparisons.push({ name: `Markdown parse (${tokenCount} tokens)`, beforeMs: before.meanMs, afterMs: after.meanMs, speedup });
  }

  return { results, comparisons };
}
