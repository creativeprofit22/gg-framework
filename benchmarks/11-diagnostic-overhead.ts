/**
 * Benchmark 11: Per-Turn Diagnostic Overhead
 *
 * Measures: the char-counting loop that runs at the top of every turn.
 * OLD: runs unconditionally every turn.
 * NEW: gated behind _diagFn check (skipped in production where no
 * diagnostic callback is registered).
 */
import { bench, type BenchResult } from "./harness.js";
import { generateConversation } from "./fixtures.js";

// ── Types ──
interface ContentPart {
  type: string;
  text?: string;
  content?: unknown;
}
interface Message {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[];
}

// ── OLD: unguarded char counting ──
function countCharsOld(messages: Message[]): number {
  let msgChars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") msgChars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if ("text" in p && typeof p.text === "string") msgChars += p.text.length;
        if ("content" in p && typeof p.content === "string") msgChars += p.content.length;
      }
    }
  }
  return msgChars;
}

export async function runDiagnosticBench(): Promise<{ results: BenchResult[]; comparisons: { name: string; beforeMs: number; afterMs: number; speedup: number }[] }> {
  const comparisons: { name: string; beforeMs: number; afterMs: number; speedup: number }[] = [];
  const results: BenchResult[] = [];

  const sizes = [100, 300, 500, 1000, 2000];

  for (const turns of sizes) {
    const messages = generateConversation(turns) as Message[];

    // OLD: always runs the char-counting loop
    const before = await bench(`diag:unguarded-char-count(${turns} turns)`, () => {
      countCharsOld(messages);
    }, turns <= 500 ? 200 : 50);

    // NEW: gated — when _diagFn is null (production), the loop is skipped entirely.
    // The cost is just the `if (_diagFn)` check = ~0.
    const after = await bench(`diag:gated-skip(${turns} turns)`, () => {
      // In production, _diagFn is null, so this entire block is skipped.
      // We simulate the "gated" path by just doing the check.
      const _diagFn = null; // production default
      if (_diagFn) {
        countCharsOld(messages);
      }
    }, turns <= 500 ? 200 : 50);

    results.push(before, after);
    const speedup = before.meanMs > 0.01 ? Math.round((before.meanMs / Math.max(after.meanMs, 0.001)) * 100) / 100 : 1;
    comparisons.push({ name: `Diagnostic char-count (${turns} turns)`, beforeMs: before.meanMs, afterMs: after.meanMs, speedup });
  }

  // Cumulative: simulate running char-count every turn in a session
  for (const totalTurns of [100, 300]) {
    const msgs = generateConversation(totalTurns) as Message[];

    const before = await bench(`diag:cumulative-unguarded(${totalTurns}T)`, () => {
      // Simulate: run char-count at every turn from 1..N
      for (let t = 1; t <= totalTurns; t++) {
        countCharsOld(msgs.slice(0, t * 3));
      }
    }, 5);

    const after = await bench(`diag:cumulative-gated(${totalTurns}T)`, () => {
      // Gated: _diagFn is null in production → skip every turn
      const _diagFn = null;
      for (let t = 1; t <= totalTurns; t++) {
        if (_diagFn) {
          countCharsOld(msgs.slice(0, t * 3));
        }
      }
    }, 5);

    results.push(before, after);
    const speedup = Math.round((before.meanMs / Math.max(after.meanMs, 0.001)) * 100) / 100;
    comparisons.push({ name: `Cumulative diag overhead (${totalTurns} turns)`, beforeMs: before.meanMs, afterMs: after.meanMs, speedup });
  }

  return { results, comparisons };
}
