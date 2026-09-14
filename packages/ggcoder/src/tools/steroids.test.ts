import { afterEach, describe, expect, it } from "vitest";
import { buildSteroidsArgs, compactRepos, createSteroidsTool } from "./steroids.js";
import { createTools, type CreateToolsResult } from "./index.js";

const results: CreateToolsResult[] = [];
afterEach(async () => {
  await Promise.all(
    results.splice(0).map(async ({ processManager, lspManager }) => {
      await lspManager?.shutdownAll();
      processManager.shutdownAll();
    }),
  );
});

describe("buildSteroidsArgs", () => {
  it("puts flags first and positionals behind -- so a leading dash is never a flag", () => {
    expect(
      buildSteroidsArgs({
        action: "search",
        pattern: "-foo",
        fixed: true,
        repo: "a/b",
        perRepo: 1,
      }),
    ).toEqual(["search", "-F", "--repo", "a/b", "--per-repo", "1", "--json", "--", "-foo"]);
    expect(buildSteroidsArgs({ action: "show", repo: "a/b", path: "src/x.ts", from: 10 })).toEqual([
      "show",
      "--from",
      "10",
      "--json",
      "--",
      "a/b",
      "src/x.ts",
    ]);
    expect(buildSteroidsArgs({ action: "repos" })).toEqual(["repos", "--json"]);
  });

  it("refuses a repo filter on define instead of silently dropping it", () => {
    expect(() =>
      buildSteroidsArgs({ action: "define", symbol: "Router", repo: "go-chi/chi" }),
    ).toThrow(/search with repo="go-chi\/chi"/);
  });

  it("builds add from an owner/name list and refuses anything else", () => {
    expect(
      buildSteroidsArgs({ action: "add", repos: ["go-chi/chi", "tw93/Pake"], tag: "web" }),
    ).toEqual(["add", "--tag", "web", "--", "go-chi/chi", "tw93/Pake"]);
    expect(() => buildSteroidsArgs({ action: "add", repos: [] })).toThrow(/repos/);
    expect(() => buildSteroidsArgs({ action: "add", repos: ["--root=/etc"] })).toThrow(
      /owner\/name/,
    );
    expect(() => buildSteroidsArgs({ action: "add", repos: ["a/b/c"] })).toThrow(/owner\/name/);
  });

  it("rejects an action missing its required argument", () => {
    expect(() => buildSteroidsArgs({ action: "search" })).toThrow(/pattern/);
    expect(() => buildSteroidsArgs({ action: "show", repo: "a/b" })).toThrow(/path/);
  });
});

describe("compactRepos", () => {
  it("collapses repos --json to one line per repo", () => {
    const json = JSON.stringify({
      count: 2,
      repositories: [
        { repo: "a/b", language: "go", files: 12, last_commit: "2026-09-01", tags: ["web"] },
        { repo: "c/d", language: "rust", files: 3, last_commit: "2026-08-30", tags: [] },
      ],
      shown: 2,
    });
    expect(compactRepos(json)).toBe(
      "2 repos indexed, 2 shown\na/b  go  12 files  2026-09-01 [web]\nc/d  rust  3 files  2026-08-30",
    );
  });

  it("passes non-JSON through untouched", () => {
    expect(compactRepos("not json")).toBe("not json");
  });
});

describe("steroids tool", () => {
  it("never refuses indexing on plan-mode grounds (corpus is not the workspace)", async () => {
    // A plan grounded in real code needs the corpus filled first; the user
    // approves the repo list via the prompt, so no plan-mode gate here.
    const tool = createSteroidsTool("/nonexistent/steroids");
    const out = await tool.execute({ action: "add", repos: ["go-chi/chi"] }, {
      signal: new AbortController().signal,
    } as never);
    expect(out).not.toMatch(/plan mode/);
    expect(out).toMatch(/^Error: steroids add failed/);
  });

  it("reports a missing binary as a tool error, not a throw", async () => {
    const tool = createSteroidsTool("/nonexistent/steroids");
    const out = await tool.execute({ action: "repos" }, {
      signal: new AbortController().signal,
    } as never);
    expect(out).toMatch(/^Error: steroids repos failed/);
  });

  it("is omitted from createTools when no binary is found", async () => {
    const result = await createTools(process.cwd(), { lspDiagnostics: false, steroidsBin: null });
    results.push(result);
    expect(result.tools.map((t) => t.name)).not.toContain("steroids");
  });

  it("is registered when a binary path is supplied", async () => {
    const result = await createTools(process.cwd(), {
      lspDiagnostics: false,
      steroidsBin: "/nonexistent/steroids",
    });
    results.push(result);
    expect(result.tools.map((t) => t.name)).toContain("steroids");
  });
});
