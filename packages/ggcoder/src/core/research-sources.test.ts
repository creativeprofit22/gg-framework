import { describe, expect, it } from "vitest";
import {
  ResearchSourceLedger,
  checkDraftCitations,
  MIN_NO_SOURCES_REASON_LENGTH,
  checkPlanCitations,
  githubRepoFromUrl,
} from "./research-sources.js";

const PERMALINK =
  "https://github.com/vercel/turborepo/blob/c42dc5320e1e62342d6cde0a05b8f027627f1412/examples/kitchen-sink/apps/api/src/server.ts#L8";

function searchOutput(repo: string, url: string): string {
  return JSON.stringify({ count: 1, matches: [{ repo, path: "a.ts", line: 8, url }] });
}

function ledgerWithSearch(): ResearchSourceLedger {
  const ledger = new ResearchSourceLedger();
  ledger.recordCorpusResult({ action: "search" }, searchOutput("vercel/turborepo", PERMALINK));
  return ledger;
}

describe("ResearchSourceLedger", () => {
  it("records repos and permalinks from search/define results and repos from show", () => {
    const ledger = ledgerWithSearch();
    ledger.recordCorpusResult({ action: "show", repo: "Railly/tinte", path: "x.ts" }, "code");

    expect(ledger.consultedRepos()).toEqual(["railly/tinte", "vercel/turborepo"]);
    expect(ledger.describe()).toContain(PERMALINK);
  });

  it.each([
    ["discovery does not count as retrieved code", { action: "discover" }, "{}"],
    ["unparseable search output is ignored", { action: "search" }, "not json"],
    ["malformed repo identities are ignored", { action: "show", repo: "../etc" }, "x"],
  ])("%s", (_label, args, output) => {
    const ledger = new ResearchSourceLedger();
    ledger.recordCorpusResult(args, output);
    expect(ledger.isEmpty()).toBe(true);
  });
});

describe("ResearchSourceLedger.recordPermalinksFromText", () => {
  it("records commit permalinks from prose and trims trailing punctuation", () => {
    const ledger = new ResearchSourceLedger();
    ledger.recordPermalinksFromText(`The server lives at ${PERMALINK}.`);

    expect(ledger.consultedRepos()).toEqual(["vercel/turborepo"]);
    expect(ledger.describe()).toContain(PERMALINK);
    expect(ledger.describe()).not.toContain(`${PERMALINK}.`);
  });

  it("records permalinks embedded in JSON and Markdown links without swallowing escapes", () => {
    const ledger = new ResearchSourceLedger();
    ledger.recordPermalinksFromText(
      JSON.stringify({ output: `See [server](${PERMALINK})\nand more` }),
    );

    expect(ledger.consultedRepos()).toEqual(["vercel/turborepo"]);
    expect(ledger.describe()).toContain(PERMALINK);
    expect(ledger.describe()).not.toMatch(/\\n|\)/);
  });

  it.each([
    ["a bare repository link", "See https://github.com/vercel/turborepo for details."],
    ["a branch (non-SHA) blob link", "https://github.com/vercel/turborepo/blob/main/a.ts"],
    ["a non-GitHub permalink", "https://gitlab.com/vercel/turborepo/blob/c42dc53/a.ts"],
    ["a permalink without a path", "https://github.com/vercel/turborepo/blob/c42dc53/"],
  ])("ignores %s", (_label, text) => {
    const ledger = new ResearchSourceLedger();
    ledger.recordPermalinksFromText(text);
    expect(ledger.isEmpty()).toBe(true);
  });
});

describe("checkPlanCitations", () => {
  it("passes when no corpus code was retrieved", () => {
    expect(checkPlanCitations("# Plan", new ResearchSourceLedger())).toEqual({ ok: true });
  });

  it("rejects a plan that omits retrieved corpus code and lists what to cite", () => {
    const result = checkPlanCitations("# Plan\n\n## Steps\n1. Do it\n", ledgerWithSearch());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(PERMALINK);
  });

  it.each([
    ["a permalink", `## Sources\n- ${PERMALINK}`],
    [
      "a repo link with different casing",
      "See https://github.com/Vercel/Turborepo for the pattern.",
    ],
    [
      "an explicit none declaration",
      "## Sources\nSources: none — the corpus results were unrelated.",
    ],
  ])("accepts %s", (_label, content) => {
    expect(checkPlanCitations(content, ledgerWithSearch())).toEqual({ ok: true });
  });

  it.each([
    ["a bare none declaration", "## Sources\nSources: none"],
    ["a none declaration with only punctuation", "## Sources\nSources: none."],
    [
      "a none declaration whose reason is on the next line",
      "Sources: none\nthe corpus results were unrelated.",
    ],
  ])("rejects %s", (_label, content) => {
    expect(checkPlanCitations(content, ledgerWithSearch()).ok).toBe(false);
  });

  it("does not accept a link to a different repository", () => {
    const content = "https://github.com/vercel/turborepo-extra/blob/abc1234/x.ts";
    expect(checkPlanCitations(content, ledgerWithSearch()).ok).toBe(false);
  });
});

describe("githubRepoFromUrl", () => {
  it.each([
    [PERMALINK, "vercel/turborepo"],
    ["https://github.com/Vercel/Turborepo.git", "vercel/turborepo"],
    ["https://www.github.com/a/b?tab=readme", "a/b"],
    ["https://example.com/x", null],
    ["https://evil.test/github.com/a/b", null],
  ])("%s -> %s", (url, expected) => {
    expect(githubRepoFromUrl(url)).toBe(expected);
  });
});

describe("checkDraftCitations", () => {
  it("rejects drafts without references to retrieved repos", () => {
    const result = checkDraftCitations(
      [{ owner: "other", repo: "repo", canonicalUrl: "https://github.com/other/repo" }],
      undefined,
      ledgerWithSearch(),
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    [
      "a commit permalink to a retrieved repo",
      [{ owner: "vercel", repo: "turborepo", canonicalUrl: PERMALINK }],
      undefined,
    ],
    [
      "a repo URL with different label and URL casing",
      [
        {
          owner: "Vercel",
          repo: "Turborepo",
          canonicalUrl: "https://github.com/VERCEL/turborepo.git",
        },
      ],
      undefined,
    ],
    ["an explicit reason", [], "Corpus results only confirmed the existing local design."],
  ])("accepts %s", (_label, refs, reason) => {
    expect(checkDraftCitations(refs, reason, ledgerWithSearch())).toEqual({ ok: true });
  });

  it.each([
    [
      "matching labels but a non-GitHub URL",
      { owner: "vercel", repo: "turborepo", canonicalUrl: "https://example.com/x" },
    ],
    [
      "matching labels but a URL to an unrelated repo",
      {
        owner: "vercel",
        repo: "turborepo",
        canonicalUrl: "https://github.com/evil/repo/blob/c42dc53/a.ts",
      },
    ],
    [
      "a retrieved-repo URL behind a non-GitHub host",
      {
        owner: "vercel",
        repo: "turborepo",
        canonicalUrl: "https://evil.test/github.com/vercel/turborepo",
      },
    ],
    [
      "a retrieved-repo URL with misleading labels",
      { owner: "other", repo: "repo", canonicalUrl: PERMALINK },
    ],
  ])("rejects %s", (_label, ref) => {
    expect(checkDraftCitations([ref], undefined, ledgerWithSearch()).ok).toBe(false);
  });

  it("ignores a whitespace-only reason", () => {
    expect(checkDraftCitations([], "   ", ledgerWithSearch()).ok).toBe(false);
  });
});

describe("no-sources reason minimum shared by both gates", () => {
  it.each([
    ["1-char", "x", false],
    ["9-char", "123456789", false],
    ["9-char padded with whitespace", "  123456789  ", false],
    ["10-char", "1234567890", true],
    ["10-char astral", "😀".repeat(10), true],
  ])("%s reason passes: %s", (_label, reason, expected) => {
    expect(MIN_NO_SOURCES_REASON_LENGTH).toBe(10);
    const plan = checkPlanCitations(`## Sources\nSources: none — ${reason}`, ledgerWithSearch());
    const draft = checkDraftCitations([], reason, ledgerWithSearch());
    expect(plan.ok).toBe(expected);
    expect(draft.ok).toBe(expected);
  });

  it("states the minimum in both rejection messages", () => {
    const plan = checkPlanCitations("Sources: none — n/a", ledgerWithSearch());
    const draft = checkDraftCitations([], "n/a", ledgerWithSearch());
    expect(plan.ok || plan.message).toContain("at least 10 characters");
    expect(draft.ok || draft.message).toContain("at least 10 characters");
  });
});
