import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGrepTool } from "./grep.js";
import { localOperations, type ToolOperations } from "./operations.js";

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

describe("createGrepTool", () => {
  it("stops after max_results before scanning later files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-limit-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "needle\n");
    await fs.writeFile(path.join(tmpDir, "z.txt"), "needle\n");

    const result = await createGrepTool(tmpDir).execute(
      { pattern: "needle", include: "*.txt", max_results: 1 },
      context(),
    );

    expect(result).toContain("a.txt:1:needle");
    expect(result).not.toContain("z.txt:1:needle");
    expect(result).toContain("[Truncated at 1 matches]");
  });

  it("accepts a leading (?i) as a case-insensitive regex flag", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-inline-flag-"));
    await fs.writeFile(path.join(tmpDir, "deploy.txt"), "Deploy to Railway\n");

    const result = await createGrepTool(tmpDir).execute(
      { pattern: "(?i)deploy|railway", include: "*.txt" },
      context(),
    );

    expect(result).toContain("deploy.txt:1:Deploy to Railway");
  });

  it.each(["(a+)+$", "(\\w+\\s?)*$", "(x*){2,}", "((ab)+)+"])(
    "rejects nested-quantifier pattern %s before touching the filesystem",
    async (pattern) => {
      let touched = false;
      const ops: ToolOperations = {
        ...localOperations,
        stat: (p) => {
          touched = true;
          return localOperations.stat(p);
        },
      };

      await expect(
        createGrepTool("/nonexistent-root", ops).execute({ pattern }, context()),
      ).rejects.toThrow(/nested quantifier/);
      expect(touched).toBe(false);
    },
  );

  it("allows a quantified group whose body has no quantifier", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-safe-quant-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "abab\n");

    const result = await createGrepTool(tmpDir).execute(
      { pattern: "(ab)+", include: "*.txt" },
      context(),
    );

    expect(result).toContain("a.txt:1:abab");
  });

  it.each(["(?:ab)+", "(?:ab|ba)+", "(?:a|b)*b", "(\\d+)?ab", "(a+){1,3}"])(
    "allows benign pattern %s",
    async (pattern) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-benign-"));
      await fs.writeFile(path.join(tmpDir, "a.txt"), "abab\n");

      const result = await createGrepTool(tmpDir).execute({ pattern, include: "*.txt" }, context());

      expect(result).toContain("a.txt:1:abab");
    },
  );

  it("rejects an oversize pattern", async () => {
    await expect(
      createGrepTool("/nonexistent-root").execute({ pattern: "a".repeat(1001) }, context()),
    ).rejects.toThrow(/exceeds the 1000-character limit/);
  });

  it("returns partial results plus a notice when the deadline expires", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-deadline-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "needle\n");
    await fs.writeFile(path.join(tmpDir, "z.txt"), "needle\n");

    const slowOps: ToolOperations = {
      ...localOperations,
      stat: async (p) => {
        const stat = await localOperations.stat(p);
        if (stat.isFile()) await new Promise((resolve) => setTimeout(resolve, 40));
        return stat;
      },
    };

    const result = await createGrepTool(tmpDir, slowOps, 20).execute(
      { pattern: "needle", include: "*.txt" },
      context(),
    );

    expect(result).toContain("a.txt:1:needle");
    expect(result).not.toContain("z.txt:1:needle");
    expect(result).toContain("Stopped after 0.02s");
  });

  it("reports the deadline notice when nothing matched", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-deadline-empty-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "needle\n");

    const result = await createGrepTool(tmpDir, localOperations, 0).execute(
      { pattern: "needle", include: "*.txt" },
      context(),
    );

    expect(result).toContain("No matches found.");
    expect(result).toContain("narrow the pattern");
  });
});
