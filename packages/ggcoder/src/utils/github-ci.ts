import { withoutQwenRuntimeSecret } from "../tools/safe-env.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { GitHubCI } from "@kenkaiiii/gg-core/desktop-session-ux";
import { runBackgroundGit } from "./git.js";
import { getGitHubRepoSlug } from "./github.js";

const exec = promisify(execFile);

export type { GitHubCI };

const resultSchema = z.object({
  id: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const runSchema = resultSchema.extend({
  workflow_id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string(),
});
const runPagesSchema = z.array(z.object({ workflow_runs: z.array(runSchema) }));
const jobSchema = resultSchema.extend({
  steps: z.array(z.unknown()).optional(),
  runner_id: z.number().nullish(),
  runner_name: z.string().nullish(),
});
const jobPagesSchema = z.array(z.object({ jobs: z.array(jobSchema) }));
const annotationsSchema = z.array(z.object({ message: z.string() }));
const repoSchema = z.object({
  default_branch: z
    .string()
    .regex(/^[\w./-]+$/)
    .refine((branch) => !branch.includes("..")),
});
const branchRunsSchema = z.object({
  workflow_runs: z.array(
    runSchema.extend({ run_started_at: z.string().nullish(), updated_at: z.string() }),
  ),
});
type Run = z.infer<typeof runSchema>;
type Job = z.infer<typeof jobSchema>;
const nonFailures = new Set(["success", "skipped", "neutral", "cancelled"]);
const failed = (result: z.infer<typeof resultSchema>): boolean =>
  result.status === "completed" &&
  (result.conclusion === null || !nonFailures.has(result.conclusion));

async function api(endpoint: string, signal?: AbortSignal, paginate = true): Promise<unknown> {
  const { stdout } = await exec(
    "gh",
    ["api", "--hostname", "github.com", endpoint, ...(paginate ? ["--paginate", "--slurp"] : [])],
    { env: withoutQwenRuntimeSecret(), timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal },
  );
  return JSON.parse(stdout);
}

/** `runId.attempt` -> GitHub refused to start it. A finished attempt never changes. */
export type NotStartedCache = Map<string, boolean>;
const NOT_STARTED_CACHE_LIMIT = 100;
const NOT_STARTED = /job was not started/i;
const BILLING = /payments have failed|spending limit|billing/i;

function remember(cache: NotStartedCache | undefined, key: string, value: boolean): void {
  if (!cache) return;
  cache.set(key, value);
  const oldest = cache.keys().next();
  if (cache.size > NOT_STARTED_CACHE_LIMIT && !oldest.done) cache.delete(oldest.value);
}

const neverRan = (job: Job): boolean =>
  job.status === "completed" && job.steps?.length === 0 && !job.runner_id && !job.runner_name;

async function jobsFor(slug: string, run: Run, signal?: AbortSignal): Promise<Job[]> {
  const pages = jobPagesSchema.parse(
    await api(
      `repos/${slug}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      signal,
    ),
  );
  return pages.flatMap((page) => page.jobs);
}

/**
 * A finished, unsuccessful run whose jobs never got a runner or a step and which
 * GitHub annotated as refused for billing. One annotation request per uncached run;
 * an unreadable annotation stays an ordinary failure and is not cached.
 */
async function refusedToStart(
  slug: string,
  run: Run,
  jobs: readonly Job[] | undefined,
  cache: NotStartedCache | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (run.status !== "completed" || run.conclusion === "success") return false;
  const key = `${run.id}.${run.run_attempt}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  const all = jobs ?? (await jobsFor(slug, run, signal));
  const probe = all.find((job) => job.conclusion !== "skipped") ?? all[0];
  if (!probe || !all.every(neverRan)) {
    remember(cache, key, false);
    return false;
  }
  let messages: string[];
  try {
    messages = annotationsSchema
      .parse(
        await api(`repos/${slug}/check-runs/${probe.id}/annotations?per_page=10`, signal, false),
      )
      .map((annotation) => annotation.message);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
  if (!messages.length) return false;
  const refused = messages.some((message) => NOT_STARTED.test(message) && BILLING.test(message));
  remember(cache, key, refused);
  return refused;
}

export interface GitHubCIHistory {
  defaultBranch: string;
  lastSuccessAt: string | null;
  notStartedStreak: number;
}

const STREAK_LIMIT = 10;

/** Default branch's last green run and how many newest runs GitHub refused; ~3 calls once cached. */
export async function getGitHubCIHistory(
  slug: string,
  options: { defaultBranch?: string; cache?: NotStartedCache; signal?: AbortSignal } = {},
): Promise<GitHubCIHistory> {
  const { cache, signal } = options;
  const defaultBranch =
    options.defaultBranch ??
    repoSchema.parse(await api(`repos/${slug}`, signal, false)).default_branch;
  const branch = encodeURIComponent(defaultBranch);
  const [lastGreen] = branchRunsSchema.parse(
    await api(
      `repos/${slug}/actions/runs?branch=${branch}&status=success&per_page=1`,
      signal,
      false,
    ),
  ).workflow_runs;
  const lastSuccessAt = lastGreen ? (lastGreen.run_started_at ?? lastGreen.updated_at) : null;
  if (lastSuccessAt !== null && !Number.isFinite(Date.parse(lastSuccessAt))) {
    throw new Error("Invalid GitHub run time");
  }
  const recent = branchRunsSchema
    .parse(
      await api(
        `repos/${slug}/actions/runs?branch=${branch}&per_page=${STREAK_LIMIT}`,
        signal,
        false,
      ),
    )
    .workflow_runs.sort((a, b) => b.id - a.id);
  let notStartedStreak = 0;
  for (const run of recent) {
    // A run still queued or in progress says nothing yet; look past it.
    if (run.status !== "completed") continue;
    if (!(await refusedToStart(slug, run, undefined, cache, signal))) break;
    notStartedStreak += 1;
  }
  return { defaultBranch, lastSuccessAt, notStartedStreak };
}

/** Exact HEAD only, latest run per workflow, latest attempt's jobs, across all pages. */
export async function getGitHubCI(
  slug: string,
  sha: string,
  signal?: AbortSignal,
  cache?: NotStartedCache,
): Promise<GitHubCI | null> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(slug) ||
    slug.split("/").some((part) => part === "." || part === "..") ||
    !/^[a-f0-9]{40,64}$/i.test(sha)
  ) {
    throw new Error("Invalid GitHub CI repository or commit");
  }
  const pages = runPagesSchema.parse(
    await api(`repos/${slug}/actions/runs?head_sha=${sha}&per_page=100`, signal),
  );
  const latest = new Map<number, Run>();
  for (const run of pages.flatMap((page) => page.workflow_runs)) {
    if (run.head_sha !== sha) continue;
    const previous = latest.get(run.workflow_id);
    if (!previous || run.id > previous.id) latest.set(run.workflow_id, run);
  }
  const runs = [...latest.values()].sort((a, b) => a.id - b.id);
  if (!runs.length) return null;
  // simplification: cap fan-out at 20 workflows; larger repos need a shared request cache.
  if (runs.length > 20) throw new Error("Too many workflows for title-bar polling");
  const runJobs: Job[][] = [];
  // Sequential requests bound subprocess concurrency even on repositories with many workflows.
  for (const run of runs) runJobs.push(await jobsFor(slug, run, signal));
  const jobs = runJobs.flat();
  const active = runs.some((run) => run.status !== "completed");
  const failedJobs = jobs.filter(failed).length;
  const hasFailure = failedJobs > 0 || runs.some(failed);
  const allPassed = runs.every((run) => run.conclusion === "success");
  // Any real failure wins; a billing refusal counts only when no workflow actually ran.
  let notStarted = !active && hasFailure;
  for (const [index, run] of runs.entries()) {
    if (!notStarted) break;
    notStarted = await refusedToStart(slug, run, runJobs[index], cache, signal);
  }
  const target = runs.find(failed) ?? runs.find((run) => run.status !== "completed") ?? runs[0];
  return {
    key: `${slug}:${sha}:${runs.map((run) => `${run.id}.${run.run_attempt}`).join(",")}`,
    url: `https://github.com/${slug}/actions/runs/${target.id}`,
    total: jobs.length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: failedJobs || (hasFailure ? 1 : 0),
    active,
    conclusion: active
      ? null
      : notStarted
        ? "not_started"
        : hasFailure
          ? "failure"
          : allPassed
            ? "success"
            : "cancelled",
  };
}

async function context(cwd: string): Promise<{ slug: string; sha: string } | null> {
  const [slug, head] = await Promise.all([
    getGitHubRepoSlug(cwd),
    runBackgroundGit(["rev-parse", "--verify", "HEAD"], { cwd, timeoutMs: 2000 }).catch(() => null),
  ]);
  return slug && head ? { slug, sha: head.stdout.trim() } : null;
}

const HISTORY_INTERVAL_MS = 10 * 60_000;

/** One in-flight poll per session, slower while idle, stopped with the session. */
export function startGitHubCIPoll(
  cwd: string,
  onChange: (ci: GitHubCI | null) => void,
  options: { now?: () => number } = {},
) {
  const clock = options.now ?? Date.now;
  const abort = new AbortController();
  const cache: NotStartedCache = new Map();
  const defaultBranches = new Map<string, string>();
  let history: { slug: string; at: number; value: GitHubCIHistory | null } | null = null;
  let stopped = false;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;
  let last: GitHubCI | null = null;
  let lastContext = "";
  // Only a not-started HEAD needs history: refetched at most every 10 minutes, never fatal.
  const withHistory = async (slug: string, ci: GitHubCI | null): Promise<GitHubCI | null> => {
    if (ci?.conclusion !== "not_started") return ci;
    if (history?.slug !== slug || clock() - history.at >= HISTORY_INTERVAL_MS) {
      let value: GitHubCIHistory | null = null;
      try {
        value = await getGitHubCIHistory(slug, {
          defaultBranch: defaultBranches.get(slug),
          cache,
          signal: abort.signal,
        });
        defaultBranches.set(slug, value.defaultBranch);
      } catch (error) {
        if (abort.signal.aborted) throw error;
      }
      history = { slug, at: clock(), value };
    }
    const value = history.value;
    return value
      ? { ...ci, lastSuccessAt: value.lastSuccessAt, notStartedStreak: value.notStartedStreak }
      : ci;
  };
  const publish = (next: GitHubCI | null): void => {
    if (stopped) return;
    if (JSON.stringify(next) !== JSON.stringify(last)) {
      last = next;
      onChange(next);
    }
  };
  const refresh = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    clearTimeout(timer);
    try {
      const current = await context(cwd);
      const key = current ? `${current.slug}:${current.sha}` : "";
      if (key !== lastContext) {
        lastContext = key;
        publish(null);
      }
      if (!current || stopped) return;
      const next = await withHistory(
        current.slug,
        await getGitHubCI(current.slug, current.sha, abort.signal, cache),
      );
      // A checkout/commit during a network request must never paint the previous HEAD green.
      const now = await context(cwd);
      if (now?.sha !== current.sha || now?.slug !== current.slug) {
        publish(null);
        return;
      }
      publish(next);
    } catch {
      // Never turn missing auth, offline, malformed output, or rate limits into a pass.
      if (last) publish({ ...last, stale: true });
    } finally {
      busy = false;
      if (!stopped) {
        timer = setTimeout(() => void refresh(), last?.active && !last.stale ? 15_000 : 60_000);
        timer.unref?.();
      }
    }
  };
  void refresh();
  return {
    refresh,
    stop: (): void => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    },
  };
}

const DAY_MS = 86_400_000;

/**
 * One short agent notice per session id once GitHub has refused CI for longer than
 * the threshold. Silent while history is unknown, so a lookup failure never alarms.
 */
export function createCINotStartedNotifier(
  options: { thresholdMs?: number; now?: () => number } = {},
): (sessionId: string, ci: GitHubCI | null) => string | null {
  const thresholdMs = options.thresholdMs ?? 3 * DAY_MS;
  const now = options.now ?? Date.now;
  const notified = new Set<string>();
  return (sessionId, ci) => {
    if (notified.has(sessionId) || ci?.conclusion !== "not_started" || ci.stale) return null;
    const { lastSuccessAt, notStartedStreak } = ci;
    if (lastSuccessAt === undefined) return null;
    if (lastSuccessAt !== null) {
      const at = Date.parse(lastSuccessAt);
      if (!Number.isFinite(at) || now() - at <= thresholdMs) return null;
    }
    notified.add(sessionId);
    const since =
      lastSuccessAt === null
        ? "GitHub Actions has no successful run on the default branch"
        : `GitHub Actions has not had a successful run on the default branch since ${lastSuccessAt.slice(0, 10)}`;
    const count = notStartedStreak
      ? notStartedStreak >= STREAK_LIMIT
        ? `the last ${STREAK_LIMIT}+ runs`
        : notStartedStreak === 1
          ? "the latest run"
          : `the last ${notStartedStreak} runs`
      : "the latest runs";
    return `${since}: GitHub refused to start ${count}, most likely an account billing or spending-limit problem. Checks that only run in CI have not run, so local checks are the only gate. Status notice only; not verification evidence.`;
  };
}

export interface CINotStartedTarget {
  getConversationIdentity(): { sessionId: string };
  notify(id: string, text: string): void;
}

// Re-checked on poll changes and before every run: a steady refused state never
// republishes, so a new or loaded conversation would otherwise never hear it.
export function createCINotStartedNotify(
  currentSession: () => CINotStartedTarget,
  options: { thresholdMs?: number; now?: () => number } = {},
): (ci: GitHubCI | null) => void {
  const notice = createCINotStartedNotifier(options);
  return (ci) => {
    const session = currentSession();
    const text = notice(session.getConversationIdentity().sessionId, ci);
    if (text) session.notify("github-ci-not-started", text);
  };
}
