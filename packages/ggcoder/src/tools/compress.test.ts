import { describe, it, expect } from "vitest";
import { compressOutput } from "./compress.js";

describe("compressOutput", () => {
  it("leaves small output untouched", () => {
    const small = "line one\nline two\nline three";
    const r = compressOutput(small);
    expect(r.strategy).toBe("none");
    expect(r.content).toBe(small);
  });

  it("keeps a FATAL line buried in the middle of a huge log", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      if (i === 2600) lines.push("ERROR FATAL: heap allocation failed at chunk 8821");
      else lines.push(`INFO compiled module ${i} ok`);
    }
    const r = compressOutput(lines.join("\n"));
    expect(r.strategy).toBe("log");
    expect(r.content).toContain("FATAL: heap allocation failed at chunk 8821");
    expect(r.compressedTokens).toBeLessThan(r.originalTokens * 0.2);
  });

  it("collapses repeated runs into a count", () => {
    const lines = ["start"];
    for (let i = 0; i < 200; i++) lines.push("WARN retry: Connection refused: postgres:5432");
    lines.push("ERROR giving up after 200 attempts");
    const r = compressOutput(lines.join("\n"));
    expect(r.content).toContain("Connection refused: postgres:5432");
    expect(r.content).toContain("giving up after 200 attempts");
    expect(r.content).toMatch(/×\d+/);
  });

  it("summarises a long JSON array but keeps shape and early matches", () => {
    const matches = [];
    for (let i = 0; i < 412; i++) {
      matches.push({ path: i === 3 ? "src/core/auth.ts" : `src/gen/file-${i}.ts`, line: i });
    }
    const r = compressOutput(JSON.stringify({ total: 412, matches }, null, 2));
    expect(r.strategy).toBe("json");
    expect(r.content).toContain('"total": 412');
    expect(r.content).toContain("src/core/auth.ts");
    expect(r.content).toMatch(/more of 412 items omitted/);
    expect(r.compressedTokens).toBeLessThan(r.originalTokens * 0.5);
  });

  it("preserves the failing assertion among thousands of passes", () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      if (i === 1450) {
        lines.push("✗ user-auth › rejects expired token");
        lines.push("  AssertionError: Expected 401 but received 200");
      } else lines.push(`✓ case ${i}`);
    }
    const r = compressOutput(lines.join("\n"));
    expect(r.content).toContain("rejects expired token");
    expect(r.content).toContain("Expected 401 but received 200");
  });
});
