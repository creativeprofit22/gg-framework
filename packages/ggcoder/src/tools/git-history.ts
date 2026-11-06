import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { repositoryRelativePathSchema } from "../core/programmatic/contracts.js";
import { BackgroundGitError, runBackgroundGit } from "../utils/git.js";

export const GIT_HISTORY_LIMITS = {
  perCallTimeoutMs: 5_000,
  overallTimeoutMs: 10_000,
  maxBuffer: 4 * 1024 * 1024,
  maxOutputChars: 16_000,
  largeCommitFiles: 200,
  subjectChars: 160,
};

export type GitHistoryLimits = typeof GIT_HISTORY_LIMITS;

export const GitHistoryParams = z.strictObject({
  action: z
    .enum(["change_frequency", "recent_subjects", "co_changes"])
    .describe(
      "change_frequency: commits per file/folder; recent_subjects: newest commit subjects; co_changes: files changed in the same commits as path",
    ),
  path: z
    .string()
    .optional()
    .describe("Repository path relative to the project folder; required for co_changes"),
  since_days: z.number().int().min(1).max(3650).optional().describe("Window in days (default 365)"),
  max_commits: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Newest commits read (default 300)"),
  limit: z.number().int().min(1).max(50).optional().describe("Entries returned (default 20)"),
  group_by: z
    .enum(["file", "folder"])
    .optional()
    .describe("change_frequency grouping (default file)"),
  depth: z.number().int().min(1).max(6).optional().describe("Folder depth for group_by folder"),
});

export type GitHistoryUnavailableReason =
  | "not-a-git-repository"
  | "no-commits"
  | "git-unavailable"
  | "timed-out"
  | "output-too-large"
  | "untrusted-repository-owner"
  | "git-failed";

const UNAVAILABLE_MESSAGES: Record<GitHistoryUnavailableReason, string> = {
  "not-a-git-repository": "This project folder is not inside a git work tree.",
  "no-commits": "The repository has no commits yet.",
  "git-unavailable": "git is not installed or could not be started.",
  "timed-out": "git did not answer within the time limit.",
  "output-too-large": "git history output exceeded the size limit; narrow path or max_commits.",
  "untrusted-repository-owner": "git refused the repository because of its ownership.",
  "git-failed": "git could not read the history.",
};

const NOTE = "Change frequency only; not evidence that automation would help.";

/** Normalize a model-supplied path to a repository-relative POSIX path, or throw. */
export function validateHistoryPath(raw: string): string {
  const value = raw.replace(/\\/g, "/").replace(/(?<=.)\/+$/, "");
  if (
    value.includes("\0") ||
    value.startsWith("-") ||
    value.startsWith(":") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")
  ) {
    throw new Error(
      `git_history path must be a plain path inside the project: ${JSON.stringify(raw)}`,
    );
  }
  const parsed = repositoryRelativePathSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `git_history path must be a plain path inside the project: ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

interface Commit {
  commit: string;
  date: string;
  subject: string;
  files: string[];
}

function parseLog(stdout: string, withFiles: boolean): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of stdout.split("\x1e")) {
    if (chunk === "") continue;
    const headerEnd = chunk.indexOf("\0");
    const header = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
    const [commit = "", date = "", ...subjectParts] = header.split("\x1f");
    // A record that does not start like our format is not ours to interpret.
    if (!/^[0-9a-f]{4,64}$/.test(commit) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const files =
      withFiles && headerEnd !== -1
        ? chunk
            .slice(headerEnd + 1)
            .replace(/^\n/, "")
            .split("\0")
            .filter((name) => name !== "")
        : [];
    commits.push({ commit, date, subject: subjectParts.join(" "), files: [...new Set(files)] });
  }
  return commits;
}

function sanitizeSubject(subject: string, maxChars: number): string {
  const clean = subject
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[^\s@<>()[\]"',;]+@[^\s@<>()[\]"',;]+\.[^\s@<>()[\]"',;]+/g, "[email]")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length <= maxChars ? clean : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function folderOf(file: string, depth: number): string {
  const dirs = file.split("/").slice(0, -1);
  return dirs.length === 0 ? "." : dirs.slice(0, depth).join("/");
}

function ranked(counts: Map<string, number>): { path: string; commits: number }[] {
  return [...counts]
    .map(([key, commits]) => ({ path: key, commits }))
    .sort((a, b) =>
      b.commits !== a.commits
        ? b.commits - a.commits
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0,
    );
}

function classify(error: unknown): GitHistoryUnavailableReason {
  if (!(error instanceof BackgroundGitError)) return "git-failed";
  if (error.code === "ENOENT") return "git-unavailable";
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output-too-large";
  if (error.killed || error.code === "ABORT_ERR") return "timed-out";
  if (/dubious ownership/i.test(error.stderr)) return "untrusted-repository-owner";
  if (/not a git repository/i.test(error.stderr)) return "not-a-git-repository";
  return "git-failed";
}

class Unavailable extends Error {
  constructor(readonly reason: GitHistoryUnavailableReason) {
    super(reason);
  }
}

export function createGitHistoryTool(
  cwd: string,
  options: { now?: () => Date; limits?: Partial<GitHistoryLimits> } = {},
): AgentTool<typeof GitHistoryParams> {
  const now = options.now ?? (() => new Date());
  const limits: GitHistoryLimits = { ...GIT_HISTORY_LIMITS, ...options.limits };

  return {
    name: "git_history",
    description:
      "Read-only, bounded git history facts for the project: commit counts per file or folder, recent commit subjects, or files that change together with a path. Fixed git commands only; no diffs, no author names or emails. Shows change frequency only, not that automation would help.",
    parameters: GitHistoryParams,
    async execute(args, context) {
      const params = GitHistoryParams.parse(args);
      const path = params.path === undefined ? undefined : validateHistoryPath(params.path);
      if (params.action === "co_changes" && path === undefined) {
        throw new Error("git_history co_changes requires path.");
      }
      const sinceDays = params.since_days ?? 365;
      const maxCommits = params.max_commits ?? 300;
      const limit = params.limit ?? 20;
      const groupBy = params.group_by ?? "file";
      const depth = params.depth ?? 2;
      const since = new Date(now().getTime() - sinceDays * 86_400_000).toISOString();

      context.signal.throwIfAborted();
      const deadline = AbortSignal.timeout(limits.overallTimeoutMs);
      const signal = AbortSignal.any([context.signal, deadline]);

      const git = async (gitArgs: string[], globalArgs: string[] = []): Promise<string> => {
        try {
          const { stdout } = await runBackgroundGit(gitArgs, {
            cwd,
            globalArgs,
            signal,
            timeoutMs: limits.perCallTimeoutMs,
            maxBuffer: limits.maxBuffer,
            isolateRepository: true,
          });
          return stdout;
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason ?? error;
          if (deadline.aborted) throw new Unavailable("timed-out");
          throw error;
        }
      };

      const unavailable = (reason: GitHistoryUnavailableReason) =>
        JSON.stringify({ status: "unavailable", reason, message: UNAVAILABLE_MESSAGES[reason] });

      try {
        let shallow: boolean;
        try {
          const lines = (
            await git(["rev-parse", "--is-inside-work-tree", "--is-shallow-repository"])
          ).split(/\r?\n/);
          if (lines[0]?.trim() !== "true") return unavailable("not-a-git-repository");
          shallow = lines[1]?.trim() === "true";
        } catch (error) {
          if (
            error instanceof BackgroundGitError &&
            typeof error.code === "number" &&
            !error.killed &&
            classify(error) !== "untrusted-repository-owner"
          ) {
            return unavailable("not-a-git-repository");
          }
          throw error;
        }
        try {
          await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
        } catch (error) {
          if (
            error instanceof BackgroundGitError &&
            typeof error.code === "number" &&
            !error.killed
          )
            return unavailable("no-commits");
          throw error;
        }

        const withFiles = params.action !== "recent_subjects";
        const stdout = await git(
          [
            "log",
            "-z",
            ...(withFiles ? ["--name-only"] : []),
            ...(params.action === "co_changes" ? ["--full-diff"] : []),
            "--no-merges",
            "--no-renames",
            "--relative",
            `--since=${since}`,
            `--max-count=${maxCommits + 1}`,
            "--format=%x1e%h%x1f%cs%x1f%s",
            "HEAD",
            "--",
            path ?? ".",
          ],
          // Pathspec magic (`:(glob)`, `:/`) is never interpreted.
          ["--literal-pathspecs"],
        );
        const parsed = parseLog(stdout, withFiles);
        const commits = parsed.slice(0, maxCommits);
        let largeCommitsSkipped = 0;
        let all: Record<string, unknown>[];
        if (params.action === "recent_subjects") {
          all = commits.map((c) => ({
            commit: c.commit,
            date: c.date,
            subject: sanitizeSubject(c.subject, limits.subjectChars),
          }));
        } else {
          const counts = new Map<string, number>();
          for (const c of commits) {
            if (params.action === "co_changes" && c.files.length > limits.largeCommitFiles) {
              largeCommitsSkipped += 1;
              continue;
            }
            const keys =
              params.action === "change_frequency" && groupBy === "folder"
                ? new Set(c.files.map((f) => folderOf(f, depth)))
                : new Set(c.files);
            for (const key of keys) {
              if (params.action === "co_changes" && path !== undefined) {
                if (key === path || key.startsWith(`${path}/`)) continue;
              }
              counts.set(key, (counts.get(key) ?? 0) + 1);
            }
          }
          all = ranked(counts);
        }

        const entries = all.slice(0, limit);
        const result = {
          status: "ok",
          action: params.action,
          path: path ?? null,
          ...(params.action === "change_frequency"
            ? { groupBy, depth: groupBy === "folder" ? depth : null }
            : {}),
          window: {
            sinceDays,
            since,
            oldestCommitDate: commits.at(-1)?.date ?? null,
          },
          commitsRead: commits.length,
          shallow,
          entries,
          truncated: {
            commits: parsed.length > maxCommits,
            entries: all.length > limit,
            output: false,
            largeCommitsSkipped,
          },
          note: NOTE,
        };
        let text = JSON.stringify(result);
        while (text.length > limits.maxOutputChars && result.entries.length > 0) {
          result.entries.pop();
          result.truncated.output = true;
          text = JSON.stringify(result);
        }
        if (text.length > limits.maxOutputChars) return unavailable("output-too-large");
        return text;
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        if (error instanceof Unavailable) return unavailable(error.reason);
        return unavailable(classify(error));
      }
    },
  };
}
