import { execFile } from "node:child_process";
import { z } from "zod";
import { runBackgroundGit } from "./git.js";

/**
 * Everything the app's Git panel shows for a project: the open issues and pull
 * requests on its GitHub repo, and the files changed in the working tree with
 * their line counts. Each half fails on its own: no `gh` (or a non-GitHub
 * origin) still lists the changes, and a non-git folder still lists nothing
 * rather than erroring.
 */
export interface GitHubItem {
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  /** Pull requests only. */
  draft?: boolean;
}

export interface ChangedFile {
  path: string;
  /** null for binary files, which have no line counts. */
  added: number | null;
  removed: number | null;
  /** M modified, A added (incl. untracked), D deleted, R renamed. */
  status: "M" | "A" | "D" | "R";
}

export interface GitOverview {
  /** null when GitHub couldn't be asked (no gh, not signed in, not GitHub). */
  issues: GitHubItem[] | null;
  pulls: GitHubItem[] | null;
  changes: ChangedFile[];
}

/** How many of each to fetch; the panel shows the newest. */
export const GITHUB_ITEM_LIMIT = 20;
const CHANGE_LIMIT = 200;

const ghItem = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  author: z.object({ login: z.string() }).nullable().optional(),
  updatedAt: z.string(),
  isDraft: z.boolean().optional(),
});

/** Parse `gh … list --json` output; anything off-shape is dropped, not trusted. */
export function parseGitHubItems(stdout: string): GitHubItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const items: GitHubItem[] = [];
  for (const entry of raw) {
    const parsed = ghItem.safeParse(entry);
    if (!parsed.success) continue;
    const { number, title, url, author, updatedAt, isDraft } = parsed.data;
    // Only GitHub links are opened from the panel.
    if (!/^https:\/\/github\.com\//.test(url)) continue;
    items.push({
      number,
      title,
      url,
      author: author?.login ?? "",
      updatedAt,
      ...(isDraft !== undefined ? { draft: isDraft } : {}),
    });
  }
  return items;
}

function gh(args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function listGitHub(
  kind: "issue" | "pr",
  slug: string,
  signal?: AbortSignal,
): Promise<GitHubItem[] | null> {
  const fields =
    kind === "pr"
      ? "number,title,url,author,updatedAt,isDraft"
      : "number,title,url,author,updatedAt";
  try {
    const stdout = await gh(
      [
        kind,
        "list",
        "--repo",
        slug,
        "--state",
        "open",
        "--limit",
        String(GITHUB_ITEM_LIMIT),
        "--json",
        fields,
      ],
      signal,
    );
    return parseGitHubItems(stdout);
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --numstat HEAD` plus `git status --porcelain` into changed
 * files. numstat gives the counts ("-" for binary); porcelain gives the status
 * and the untracked files numstat never lists.
 */
export function parseChanges(numstat: string, porcelain: string): ChangedFile[] {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const line of numstat.split("\n")) {
    const [a, r, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (!file || a === undefined || r === undefined) continue;
    // A rename shows as "old => new" or "dir/{old => new}"; key it by the new path.
    const path = file.includes(" => ")
      ? file.replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "")
      : file;
    counts.set(path, {
      added: a === "-" ? null : Number.parseInt(a, 10),
      removed: r === "-" ? null : Number.parseInt(r, 10),
    });
  }
  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").pop() ?? path;
    path = path.replace(/^"(.*)"$/, "$1");
    if (seen.has(path)) continue;
    seen.add(path);
    const status: ChangedFile["status"] =
      code === "??" || code.includes("A")
        ? "A"
        : code.includes("D")
          ? "D"
          : code.includes("R")
            ? "R"
            : "M";
    const count = counts.get(path);
    files.push({ path, status, added: count?.added ?? null, removed: count?.removed ?? null });
    if (files.length >= CHANGE_LIMIT) break;
  }
  return files;
}

async function listChanges(cwd: string, signal?: AbortSignal): Promise<ChangedFile[]> {
  try {
    const [numstat, status] = await Promise.all([
      runBackgroundGit(["diff", "--numstat", "HEAD"], { cwd, timeoutMs: 5000, signal }).catch(
        () => ({ stdout: "" }),
      ),
      runBackgroundGit(["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd,
        timeoutMs: 5000,
        signal,
      }),
    ]);
    return parseChanges(numstat.stdout, status.stdout);
  } catch {
    return [];
  }
}

export async function getGitOverview(
  cwd: string,
  slug: string | null,
  signal?: AbortSignal,
): Promise<GitOverview> {
  const [issues, pulls, changes] = await Promise.all([
    slug ? listGitHub("issue", slug, signal) : Promise.resolve(null),
    slug ? listGitHub("pr", slug, signal) : Promise.resolve(null),
    listChanges(cwd, signal),
  ]);
  return { issues, pulls, changes };
}
