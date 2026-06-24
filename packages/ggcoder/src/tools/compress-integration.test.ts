import { describe, it, expect } from "vitest";
import { compressToolOutput } from "./compress.js";
import { truncateTail, MAX_LINES } from "./truncate.js";

/**
 * Integration-level guarantees for the live tool path (bash / task_output).
 * The contract: compression only fires on output that was ALREADY going to be
 * truncated, and on that branch it must keep more signal than a blind tail
 * slice — never less — while staying reversible (caller keeps the overflow file).
 */
describe("compressToolOutput (live tool-output seam)", () => {
  it("keeps a FATAL line that blind tail-truncation would drop", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      if (i === 1200) lines.push("ERROR FATAL: segfault in worker pool");
      else lines.push(`INFO step ${i} ok`);
    }
    const raw = lines.join("\n");

    // Today's behaviour: tail slice keeps only the last MAX_LINES — the FATAL at
    // line 1200 is in the discarded head.
    const tail = truncateTail(raw);
    expect(tail.content).not.toContain("FATAL: segfault");

    // Compression keeps it.
    const c = compressToolOutput(raw);
    expect(c.content).toContain("FATAL: segfault in worker pool");
    expect(c.notice).toMatch(/fewer tokens/);
  });

  it("preserves the very end of the output (tail semantics)", () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${i}`);
    const c = compressToolOutput(lines.join("\n"));
    expect(c.content).toContain("line 5999");
    expect(c.content).toContain("line 5998");
  });

  it("collapses repeated spam into a count", () => {
    const lines = ["boot"];
    for (let i = 0; i < 3000; i++) lines.push("WARN socket hang up");
    lines.push("ERROR aborted");
    const c = compressToolOutput(lines.join("\n"));
    expect(c.content).toMatch(/×\d+/);
    expect(c.content).toContain("ERROR aborted");
  });

  it("produces fewer tokens than the original on large output", () => {
    const lines = Array.from({ length: 8000 }, (_, i) => `compiled module ${i} ok in ${i}ms`);
    const raw = lines.join("\n");
    const c = compressToolOutput(raw);
    expect(c.content.length).toBeLessThan(raw.length / 2);
  });

  it("only the over-limit branch is affected — small output is never compressed here", () => {
    // The tools call compressToolOutput ONLY when truncateTail reports truncated.
    // A small output stays below MAX_LINES, so the branch never runs. Assert the
    // gate, not the compressor: small output is not truncated.
    const small = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(truncateTail(small).truncated).toBe(false);
    expect(MAX_LINES).toBeGreaterThan(10);
  });
});
