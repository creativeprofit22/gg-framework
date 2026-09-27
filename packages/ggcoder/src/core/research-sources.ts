/**
 * Session-local record of external code the agent actually retrieved from the
 * steroids corpus. Plans and Roadmap drafts are checked against it so research
 * that shaped a proposal is cited instead of silently dropped.
 */

import type { AgentTool } from "@kenkaiiii/gg-agent";

// Each segment needs an alphanumeric character, so `../etc` is not a repo.
const REPO_PATTERN = /^[\w.-]*[a-z0-9][\w.-]*\/[\w.-]*[a-z0-9][\w.-]*$/i;
const PERMALINK_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{7,64}\/\S+$/;
// Commit permalinks embedded in prose or JSON. The path stops at whitespace,
// quotes, brackets, and backslashes so JSON escapes (`\n`, `\"`) and Markdown
// link syntax are not swallowed into the URL.
const EMBEDDED_PERMALINK_PATTERN =
  /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/[0-9a-f]{7,64}\/[^\s"'`<>()[\]{}\\]+/g;
// owner/repo after a github.com host, stopping at a path/query/fragment or a
// prose delimiter; a trailing `.git` is not part of the identity.
const GITHUB_REPO_SOURCE = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/#?)\s\]>"'`]|$)/.source;
const EMBEDDED_GITHUB_REPO_PATTERN = new RegExp(GITHUB_REPO_SOURCE, "gi");
// A standalone URL must be on github.com itself, not merely mention it in a path.
const GITHUB_URL_REPO_PATTERN = new RegExp(/^https?:\/\/(?:www\.)?/.source + GITHUB_REPO_SOURCE, "i");
const MAX_LISTED_REPOS = 8;
/** Minimum trimmed length (in characters) of a "no sources used" reason, shared by the plan and draft gates. */
export const MIN_NO_SOURCES_REASON_LENGTH = 10;
// "Sources: none" followed by an optional separator and a reason on the same line.
const PLAN_NO_SOURCES_PATTERN =
  /^[^\S\r\n]*(?:[-*][^\S\r\n]*)?(?:external[^\S\r\n]+)?sources?[^\S\r\n]*:[^\S\r\n]*none\b[^\S\r\n]*[-—–:,.(]?(.*)$/gim;
const MAX_PERMALINKS_PER_REPO = 3;

export type CitationCheck = { ok: true } | { ok: false; message: string };

export class ResearchSourceLedger {
  private readonly repos = new Map<string, { display: string; permalinks: string[] }>();

  /** Record one successful corpus tool result. Unparseable output is ignored. */
  recordCorpusResult(args: unknown, output: string): void {
    const input = isRecord(args) ? args : {};
    const action = input.action;
    if (action === "show" && typeof input.repo === "string") {
      this.add(input.repo, null);
      return;
    }
    if (action !== "search" && action !== "define") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.matches)) return;
    for (const match of parsed.matches) {
      if (!isRecord(match) || typeof match.repo !== "string") continue;
      this.add(match.repo, typeof match.url === "string" ? match.url : null);
    }
  }

  /**
   * Record commit permalinks found in free text, such as a delegated agent's
   * report of its own corpus research. Only `blob/<sha>/<path>` links count;
   * bare repository links are ordinary mentions and create no obligation.
   */
  recordPermalinksFromText(text: string): void {
    for (const match of text.matchAll(EMBEDDED_PERMALINK_PATTERN)) {
      const url = match[0].replace(/[.,;:!?*_~]+$/, "");
      const repo = match[1];
      if (repo && PERMALINK_PATTERN.test(url)) this.add(repo, url);
    }
  }

  isEmpty(): boolean {
    return this.repos.size === 0;
  }

  /** Lower-cased owner/repo identities, sorted for deterministic messages. */
  consultedRepos(): string[] {
    return [...this.repos.keys()].sort();
  }

  clear(): void {
    this.repos.clear();
  }

  describe(): string {
    const lines: string[] = [];
    for (const key of this.consultedRepos().slice(0, MAX_LISTED_REPOS)) {
      const entry = this.repos.get(key);
      if (!entry) continue;
      const links = entry.permalinks.slice(0, MAX_PERMALINKS_PER_REPO);
      lines.push(
        links.length > 0
          ? `- ${entry.display}: ${links.join(" , ")}`
          : `- ${entry.display}: https://github.com/${entry.display} (read with show; cite the commit permalink from a search/define result)`,
      );
    }
    const hidden = this.repos.size - Math.min(this.repos.size, MAX_LISTED_REPOS);
    if (hidden > 0) lines.push(`- …and ${hidden} more`);
    return lines.join("\n");
  }

  private add(repo: string, url: string | null): void {
    const display = repo.trim();
    if (!REPO_PATTERN.test(display)) return;
    const key = display.toLowerCase();
    const entry = this.repos.get(key) ?? { display, permalinks: [] };
    if (url && PERMALINK_PATTERN.test(url) && !entry.permalinks.includes(url)) {
      entry.permalinks.push(url);
    }
    this.repos.set(key, entry);
  }
}

/** A plan must link at least one consulted repository, or explicitly declare none were used. */
export function checkPlanCitations(content: string, ledger: ResearchSourceLedger): CitationCheck {
  if (ledger.isEmpty()) return { ok: true };
  // "Sources: none" must carry a same-line reason meeting the minimum shared with the draft gate.
  for (const match of content.matchAll(PLAN_NO_SOURCES_PATTERN)) {
    if (isNoSourcesReason(match[1])) return { ok: true };
  }
  const linked = new Set(
    [...content.matchAll(EMBEDDED_GITHUB_REPO_PATTERN)].map(
      (match) => (match[1] ?? "").toLowerCase(),
    ),
  );
  if (ledger.consultedRepos().some((repo) => linked.has(repo))) return { ok: true };
  return {
    ok: false,
    message:
      "Plan rejected: this session retrieved external code from the steroids corpus (directly or via a delegated agent), but the plan cites none of it.\n" +
      "Add a '## Sources' section linking the code that informed the plan (prefer the commit permalinks below), " +
      `or write 'Sources: none' followed on the same line by a reason of at least ${MIN_NO_SOURCES_REASON_LENGTH} characters explaining why the retrieved code was not used. Then call exit_plan again.\n` +
      "Retrieved this session:\n" +
      ledger.describe(),
  };
}

/** Lower-cased `owner/repo` of a GitHub URL, or null when the URL is not on github.com. */
export function githubRepoFromUrl(url: string): string | null {
  const repo = GITHUB_URL_REPO_PATTERN.exec(url.trim())?.[1];
  return repo ? repo.toLowerCase() : null;
}

/**
 * A Roadmap draft must reference at least one consulted repository, or state why none applies.
 * The repository is taken from `canonicalUrl` (what the review UI opens), and the
 * `owner`/`repo` labels must agree with it so a label cannot misdescribe the link.
 */
export function checkDraftCitations(
  references: ReadonlyArray<{ owner: string; repo: string; canonicalUrl: string }>,
  sourcesNotCitedReason: string | undefined,
  ledger: ResearchSourceLedger,
): CitationCheck {
  if (ledger.isEmpty()) return { ok: true };
  if (isNoSourcesReason(sourcesNotCitedReason)) return { ok: true };
  const consulted = new Set(ledger.consultedRepos());
  const cites = (ref: { owner: string; repo: string; canonicalUrl: string }): boolean => {
    const urlRepo = githubRepoFromUrl(ref.canonicalUrl);
    return (
      urlRepo !== null &&
      consulted.has(urlRepo) &&
      `${ref.owner.trim()}/${ref.repo.trim()}`.toLowerCase() === urlRepo
    );
  };
  if (references.some(cites)) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      "This session retrieved external code from the steroids corpus (directly or via a delegated agent), but proposed_references cites none of it. " +
      "Add proposed_references (provider 'github', canonical_url = commit permalink, owner, repo, revision, path, range, relevance) " +
      `and link them from each phase's reference_keys, or set sources_not_cited to a reason of at least ${MIN_NO_SOURCES_REASON_LENGTH} characters explaining why the retrieved code did not inform these phases.\n` +
      "Retrieved this session:\n" +
      ledger.describe(),
  };
}

/**
 * Wrap a corpus tool so its successful results reach a session's ledger. The
 * ledger is resolved per call so hosts can wrap tools before the owning
 * session (and its ledger) exists; an unresolved ledger records nothing.
 */
export function withCorpusSourceRecording(
  tool: AgentTool,
  ledger: ResearchSourceLedger | (() => ResearchSourceLedger | undefined),
): AgentTool {
  return {
    ...tool,
    execute: async (args, context) => {
      const result = await tool.execute(args, context);
      if (typeof result === "string" && !result.startsWith("Error:")) {
        const target = typeof ledger === "function" ? ledger() : ledger;
        target?.recordCorpusResult(args, result);
      }
      return result;
    },
  };
}

/**
 * Wrap a delegation tool (subagent, wait_agent) so commit permalinks in a
 * child's successful report reach the parent's ledger. Children run in their
 * own processes with their own ledgers, so their report is the only evidence.
 */
export function withDelegatedSourceRecording(
  tool: AgentTool,
  ledger: ResearchSourceLedger,
): AgentTool {
  return {
    ...tool,
    execute: async (args, context) => {
      const result = await tool.execute(args, context);
      const text = successfulResultText(result);
      if (text) ledger.recordPermalinksFromText(text);
      return result;
    },
  };
}

function successfulResultText(result: Awaited<ReturnType<AgentTool["execute"]>>): string | null {
  if (typeof result === "string") return result.startsWith("Error:") ? null : result;
  if (result.isError) return null;
  const text =
    typeof result.content === "string"
      ? result.content
      : result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .filter(Boolean)
          .join("\n");
  return /^(?:Error:|Sub-agent failed|Failed to spawn)/.test(text) ? null : text;
}

function isNoSourcesReason(reason: string | undefined): boolean {
  return reason !== undefined && Array.from(reason.trim()).length >= MIN_NO_SOURCES_REASON_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
