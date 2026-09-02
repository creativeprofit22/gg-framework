// `steroids` tool — Agent Steroids' local corpus of real repos, wrapped as one
// native tool with an `action` discriminator. Every action is an argv array
// through execFile (never a shell string); the CLI's own JSON error shape
// (`{"error"}` on stdout, exit 1) becomes the tool error.
import { execFile } from "node:child_process";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { steroidsEnv } from "../core/steroids.js";

const TIMEOUT_MS = 30_000;
/** discover/recent hit GitHub; give them longer. */
const NETWORK_TIMEOUT_MS = 60_000;
/** add downloads whole repos; a batch of ten can take minutes. */
const INGEST_TIMEOUT_MS = 10 * 60_000;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const MAX_STDOUT = 1024 * 1024;

const SteroidsParams = z.object({
  action: z
    .enum(["search", "define", "show", "files", "repos", "discover", "recent", "add"])
    .describe("Which corpus query to run"),
  pattern: z.string().optional().describe("search: regex (or literal with fixed=true)"),
  fixed: z.boolean().optional().describe("search: match pattern literally"),
  symbol: z.string().optional().describe("define: function/class/constant name"),
  query: z
    .string()
    .optional()
    .describe(
      "discover: GitHub repo search. Keep it short: 'topic:X language:Y' or 2-3 keywords. A sentence finds nothing.",
    ),
  repo: z
    .string()
    .optional()
    .describe(
      "Repository, e.g. owner/name (filters search/recent; required for show/files; not supported by define)",
    ),
  path: z
    .string()
    .optional()
    .describe("show: file path; search: path glob or bare prefix ('src' = 'src/**')"),
  language: z.string().optional().describe("search/define/discover: language name or alias"),
  tag: z.string().optional().describe("Only repos carrying this label"),
  limit: z.number().int().positive().optional(),
  perRepo: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("search: max hits per repo (1 = breadth)"),
  context: z.number().int().min(0).optional().describe("search: lines either side of a match"),
  includeComments: z.boolean().optional().describe("search: also match inside comments"),
  from: z.number().int().positive().optional().describe("show: first line (1-based)"),
  to: z.number().int().positive().optional().describe("show: last line"),
  hours: z.number().int().positive().optional().describe("recent: look-back window (default 72)"),
  add: z.boolean().optional().describe("discover: index everything found (ask the user first)"),
  repos: z
    .array(z.string())
    .optional()
    .describe("add: repositories to index, owner/name each (only after the user agrees)"),
  maxTokens: z.number().int().positive().optional().describe("Output budget (default 6000)"),
});
type Params = z.infer<typeof SteroidsParams>;

class ArgError extends Error {}

function need(v: string | undefined, name: string, action: string): string {
  if (!v) throw new ArgError(`${action} requires \`${name}\``);
  return v;
}

/** Build the CLI argv for one action. Exported for tests; pure. */
export function buildSteroidsArgs(a: Params): string[] {
  const args: string[] = [a.action];
  // Positionals go LAST behind `--` so a pattern like `-foo` is never read as a flag.
  const positional: string[] = [];
  const flag = (name: string, v: string | number | undefined): void => {
    if (v !== undefined) args.push(`--${name}`, String(v));
  };
  switch (a.action) {
    case "search":
      if (a.fixed) args.push("-F");
      positional.push(need(a.pattern, "pattern", a.action));
      flag("repo", a.repo);
      flag("language", a.language);
      flag("path", a.path);
      flag("tag", a.tag);
      flag("limit", a.limit);
      flag("per-repo", a.perRepo);
      flag("context", a.context);
      if (a.includeComments) args.push("--include-comments");
      break;
    case "define":
      // The CLI has no --repo for define; dropping it silently returned
      // matches from unrelated repos. Fail loudly with the working alternative.
      if (a.repo) {
        throw new ArgError(
          `define has no repo filter. Use search with repo="${a.repo}" and a definition pattern instead, e.g. pattern="^type ${a.symbol ?? "Name"}\\b"`,
        );
      }
      positional.push(need(a.symbol, "symbol", a.action));
      flag("language", a.language);
      flag("tag", a.tag);
      flag("limit", a.limit);
      break;
    case "show":
      positional.push(need(a.repo, "repo", a.action), need(a.path, "path", a.action));
      flag("from", a.from);
      flag("to", a.to);
      flag("limit", a.limit);
      break;
    case "files":
      positional.push(need(a.repo, "repo", a.action));
      flag("limit", a.limit);
      break;
    case "repos":
      flag("tag", a.tag);
      flag("limit", a.limit);
      break;
    case "discover":
      if (a.add) args.push("--add");
      flag("language", a.language);
      flag("tag", a.tag);
      flag("limit", a.limit);
      positional.push(need(a.query, "query", a.action));
      break;
    case "recent":
      flag("tag", a.tag);
      flag("repo", a.repo);
      flag("hours", a.hours);
      flag("limit", a.limit);
      break;
    case "add": {
      const repos = a.repos ?? [];
      if (repos.length === 0) throw new ArgError("add requires `repos`");
      const bad = repos.find((r) => !REPO_NAME.test(r));
      if (bad) throw new ArgError(`add: not an owner/name repository: ${bad}`);
      flag("tag", a.tag);
      positional.push(...repos);
      break;
    }
  }
  if (a.action === "search" || a.action === "define") flag("max-tokens", a.maxTokens);
  // `add` reports progress as plain text; every other action speaks JSON.
  if (a.action !== "add") args.push("--json");
  if (positional.length > 0) args.push("--", ...positional);
  return args;
}

const DESCRIPTION = `Read real, current open-source code from a local corpus before writing anything non-trivial. Offline, no limits.
Actions:
- search: regex across every repo (fixed=true for literal). Filter by repo/language/path/tag; perRepo=1 for breadth.
- define: where a symbol is defined, corpus-wide (no repo filter; ts/js/py/go/rust/java only). For one repo or other languages use search with repo + a definition pattern.
- show: read a file (from/to for a region; search results carry line numbers).
- files: files indexed for one repo. repos: indexed repos, one line each (tag/limit to narrow).
- discover: find good GitHub repos; query is 'topic:X language:Y' or 2-3 keywords, never a sentence. add=true indexes everything found (ask the user first).
- add: index specific repos (owner/name list); the way to take a chosen subset of discover results.
- recent: upstream changes in the last N hours.
repo/language are case-insensitive; a path without globs is a prefix ('src' = 'src/**').
\`omitted\` = cut by maxTokens (default 6000); \`more_available\` = narrow the query.
Topic not covered = corpus gap, NOT a bad query. Do not retry variants: run discover, propose repos, add once the user agrees.`;

interface RepoRow {
  repo: string;
  language?: string;
  files?: number;
  last_commit?: string;
  tags?: string[];
}

/**
 * `repos --json` is ~370 bytes per repo (commit, byte counts, url, ...); a
 * 400-repo corpus came back as 160 KB and blew the tool-result cap. One line
 * per repo keeps the whole list readable.
 */
export function compactRepos(json: string): string {
  let parsed: { count?: number; repositories?: RepoRow[] };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return json;
  }
  const rows = parsed.repositories ?? [];
  const lines = rows.map((r) => {
    const tags = r.tags?.length ? ` [${r.tags.join(",")}]` : "";
    return `${r.repo}  ${r.language ?? "?"}  ${r.files ?? "?"} files  ${r.last_commit ?? ""}${tags}`;
  });
  return [`${parsed.count ?? rows.length} repos indexed, ${rows.length} shown`, ...lines].join(
    "\n",
  );
}

export function createSteroidsTool(
  bin: string,
  planModeRef?: { current: boolean },
): AgentTool<typeof SteroidsParams> {
  return {
    name: "steroids",
    description: DESCRIPTION,
    parameters: SteroidsParams,
    async execute(args, context) {
      const indexes = args.action === "add" || (args.action === "discover" && args.add);
      if (indexes && planModeRef?.current) {
        return "Error: cannot index repos in plan mode. Run discover without `add` for now.";
      }
      let argv: string[];
      try {
        argv = buildSteroidsArgs(args);
      } catch (err) {
        if (err instanceof ArgError) return `Error: ${err.message}`;
        throw err;
      }
      const timeout = indexes
        ? INGEST_TIMEOUT_MS
        : args.action === "discover" || args.action === "recent"
          ? NETWORK_TIMEOUT_MS
          : TIMEOUT_MS;
      return new Promise<string>((resolve) => {
        execFile(
          bin,
          argv,
          {
            env: steroidsEnv(),
            timeout,
            maxBuffer: MAX_STDOUT,
            windowsHide: true,
            signal: context.signal,
          },
          (err, stdout, stderr) => {
            const out = String(stdout).trim();
            if (err) {
              // The CLI reports failures as {"error": "..."} on stdout, exit 1.
              try {
                const parsed = JSON.parse(out) as { error?: unknown };
                if (typeof parsed.error === "string") {
                  resolve(`Error: ${parsed.error}`);
                  return;
                }
              } catch {
                /* not JSON — fall through to stderr */
              }
              const line = String(stderr).trim().split("\n")[0] || err.message;
              resolve(`Error: steroids ${args.action} failed: ${line}`);
              return;
            }
            resolve((args.action === "repos" ? compactRepos(out) : out) || "(no output)");
          },
        );
      });
    },
  };
}
