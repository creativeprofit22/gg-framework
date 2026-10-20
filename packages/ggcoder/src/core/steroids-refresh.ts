// Background refresh of the Agent Steroids corpus.
//
// The CLI's own `update` re-checks every repository in one long write-locked
// run with no batch or per-run limit, and exits before indexing if a single
// repository fails. This pass keeps upstream's cheap change test (one small,
// unrate-limited git smart-HTTP request for HEAD per repository), then
// re-downloads only repositories that moved, in fixed-size `add` batches
// with a per-pass cap. Each batch takes and releases the corpus write lock,
// so agent searches and adds interleave. Order is deterministic: oldest
// indexed first, then by name.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { findSteroidsBinary, steroidsEnv } from "./steroids.js";

/** A finished pass is repeated after this long. */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
/** How often the daemon asks whether a pass is due; an incomplete pass resumes on the next tick. */
const TICK_MS = 60 * 60_000;
/** Leave daemon startup alone. */
const START_DELAY_MS = 10 * 60_000;
/** HEAD checks in flight; matches the CLI's own download parallelism. */
export const CHECK_CONCURRENCY = 8;
/** Repositories per `add` call. */
export const BATCH_SIZE = 10;
/** Re-downloads per pass; the rest wait for the next tick. */
export const MAX_UPDATES_PER_PASS = 100;
/** A pass that started this long ago without finishing is treated as dead. */
const CLAIM_TTL_MS = 3 * 60 * 60_000;
const REFS_TIMEOUT_MS = 15_000;
/** HEAD is advertised first; this prefix is enough even for repos with thousands of refs. */
const REFS_MAX_BYTES = 8 * 1024;
const LIST_TIMEOUT_MS = 60_000;
const ADD_TIMEOUT_MS = 10 * 60_000;
const COMPACT_TIMEOUT_MS = 30 * 60_000;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** Shared by every app identity and the CLI, like the corpus and the binary
    (`defaultInstallDir`); never the per-identity agent dir. */
export function defaultRefreshStatePath(): string {
  return path.join(os.homedir(), ".gg", "steroids-refresh.json");
}

const VerifiedSchema = z.object({ commit: z.string(), at: z.number() });
const StateSchema = z.object({
  lastStartedAt: z.number().optional(),
  lastFinishedAt: z.number().optional(),
  lastCompletedAt: z.number().optional(),
  /** Repos whose upstream HEAD was confirmed equal to the indexed commit. */
  verified: z.record(z.string(), VerifiedSchema).optional(),
});
export type RefreshState = z.infer<typeof StateSchema>;
export type VerifiedHeads = NonNullable<RefreshState["verified"]>;

export async function readRefreshState(statePath: string): Promise<RefreshState> {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(await readFile(statePath, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

async function writeRefreshState(statePath: string, state: RefreshState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const staged = `${statePath}.${process.pid}.tmp`;
  await writeFile(staged, JSON.stringify(state));
  await rename(staged, statePath);
}

/** Due when never completed, a day old, or the last pass stopped short (deferred work, offline). Never while one is in flight. */
export function isRefreshDue(state: RefreshState, now: number): boolean {
  const started = state.lastStartedAt ?? 0;
  const finished = state.lastFinishedAt ?? 0;
  if (started > finished && now - started < CLAIM_TTL_MS) return false;
  const completed = state.lastCompletedAt;
  if (completed === undefined) return true;
  return now - completed >= REFRESH_INTERVAL_MS || finished > completed;
}

/** HEAD's commit from a git smart-HTTP ref advertisement (pkt-line framed), or null. */
export function parseHeadCommit(body: Uint8Array): string | null {
  const text = Buffer.from(body).toString("latin1");
  let offset = 0;
  while (offset + 4 <= text.length) {
    const length = Number.parseInt(text.slice(offset, offset + 4), 16);
    if (!Number.isFinite(length)) return null;
    if (length < 4) {
      offset += 4; // flush / delimiter packets
      continue;
    }
    if (offset + length > text.length) return null;
    const payload = text.slice(offset + 4, offset + length);
    if (payload.slice(40, 45) === " HEAD") {
      const sha = payload.slice(0, 40);
      return SHA.test(sha) ? sha : null;
    }
    offset += length;
  }
  return null;
}

export async function fetchHeadCommit(
  repo: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  if (!REPO_NAME.test(repo)) return null;
  try {
    const res = await fetchFn(`https://github.com/${repo}/info/refs?service=git-upload-pack`, {
      headers: { "user-agent": "gg-coder", accept: "application/x-git-upload-pack-advertisement" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REFS_TIMEOUT_MS)]),
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < REFS_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel();
    return parseHeadCommit(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

const RepoRowSchema = z.object({
  repo: z.string(),
  commit: z.string().optional(),
  indexed_at: z.string().optional(),
});
const ReposSchema = z.object({ repositories: z.array(RepoRowSchema) });
export type CorpusRow = z.infer<typeof RepoRowSchema>;

/** Oldest indexed first, then by name: the same input always plans the same work. */
export function sortRows(rows: readonly CorpusRow[]): CorpusRow[] {
  const at = (r: CorpusRow): number => {
    const t = r.indexed_at ? Date.parse(r.indexed_at) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  return [...rows].sort(
    (a, b) => at(a) - at(b) || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0),
  );
}

export interface RefreshPlan {
  /** Moved upstream (or no indexed commit to compare), in refresh order. */
  changed: string[];
  verified: VerifiedHeads;
  unchanged: number;
  unreachable: number;
}

/**
 * Pure: decide what to re-download. A repo whose check failed keeps its
 * previous verification only if it still describes the indexed commit.
 */
export function planRefresh(
  rows: readonly CorpusRow[],
  heads: ReadonlyMap<string, string | null>,
  previous: VerifiedHeads,
  now: number,
): RefreshPlan {
  const plan: RefreshPlan = { changed: [], verified: {}, unchanged: 0, unreachable: 0 };
  for (const row of sortRows(rows)) {
    const head = heads.get(row.repo) ?? null;
    if (head === null) {
      plan.unreachable++;
      const prior = previous[row.repo];
      if (prior && prior.commit === row.commit) plan.verified[row.repo] = prior;
    } else if (head === row.commit) {
      plan.unchanged++;
      plan.verified[row.repo] = { commit: head, at: now };
    } else {
      plan.changed.push(row.repo);
    }
  }
  return plan;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export type SteroidsExec = (
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<{ ok: boolean; stdout: string; error?: string }>;

function execWith(bin: string): SteroidsExec {
  return (args, timeout, signal) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        { env: steroidsEnv(), timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
        (err, stdout, stderr) => {
          const error = err ? String(stderr).trim().split("\n")[0] || err.message : undefined;
          resolve({ ok: !err, stdout: String(stdout), ...(error ? { error } : {}) });
        },
      );
    });
}

export interface RefreshOutcome {
  status: "completed" | "partial" | "offline" | "aborted" | "failed";
  repos: number;
  unchanged: number;
  changed: number;
  updated: number;
  failedBatches: number;
  deferred: number;
  unreachable: number;
  error?: string;
}

export interface RefreshOptions {
  bin: string;
  statePath: string;
  signal: AbortSignal;
  now?: () => number;
  fetchFn?: typeof fetch;
  exec?: SteroidsExec;
}

/** One pass: list, check heads, re-download what moved in batches, compact, record. */
export async function runSteroidsRefresh(opts: RefreshOptions): Promise<RefreshOutcome> {
  const now = opts.now ?? Date.now;
  const exec = opts.exec ?? execWith(opts.bin);
  const fetchFn = opts.fetchFn ?? fetch;
  const { signal, statePath } = opts;
  const outcome: RefreshOutcome = {
    status: "failed",
    repos: 0,
    unchanged: 0,
    changed: 0,
    updated: 0,
    failedBatches: 0,
    deferred: 0,
    unreachable: 0,
  };
  const state = await readRefreshState(statePath);
  state.lastStartedAt = now();
  await writeRefreshState(statePath, state);
  const finish = async (status: RefreshOutcome["status"]): Promise<RefreshOutcome> => {
    outcome.status = status;
    state.lastFinishedAt = now();
    if (status === "completed") state.lastCompletedAt = state.lastFinishedAt;
    await writeRefreshState(statePath, state);
    return outcome;
  };

  const listed = await exec(["repos", "--json"], LIST_TIMEOUT_MS, signal);
  if (signal.aborted) return finish("aborted");
  let rows: CorpusRow[];
  try {
    const parsed = ReposSchema.safeParse(JSON.parse(listed.stdout));
    if (!listed.ok || !parsed.success) throw new Error(listed.error ?? "unreadable repos listing");
    rows = parsed.data.repositories.filter((r) => REPO_NAME.test(r.repo));
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
    return finish("failed");
  }
  outcome.repos = rows.length;

  const results = await mapLimit(rows, CHECK_CONCURRENCY, (r) =>
    fetchHeadCommit(r.repo, fetchFn, signal),
  );
  if (signal.aborted) return finish("aborted");
  const heads = new Map(rows.map((r, i) => [r.repo, results[i] ?? null]));
  const plan = planRefresh(rows, heads, state.verified ?? {}, now());
  state.verified = plan.verified;
  outcome.unchanged = plan.unchanged;
  outcome.unreachable = plan.unreachable;
  outcome.changed = plan.changed.length;
  if (rows.length > 0 && plan.unreachable === rows.length) return finish("offline");

  const selected = plan.changed.slice(0, MAX_UPDATES_PER_PASS);
  outcome.deferred = plan.changed.length - selected.length;
  for (let i = 0; i < selected.length; i += BATCH_SIZE) {
    if (signal.aborted) return finish("aborted");
    const batch = selected.slice(i, i + BATCH_SIZE);
    // `add` replaces each repo at its latest commit (tags kept) and indexes what landed.
    const res = await exec(["add", "--", ...batch], ADD_TIMEOUT_MS, signal);
    if (res.ok) outcome.updated += batch.length;
    else outcome.failedBatches++;
  }
  if (signal.aborted) return finish("aborted");
  // Replaced repos orphan their old bytes; reclaim them as `update` does.
  if (selected.length > 0) await exec(["compact"], COMPACT_TIMEOUT_MS, signal);
  if (signal.aborted) return finish("aborted");
  // Only deferred work resumes on the next tick; a failed batch is retried by
  // the next daily pass, so one broken repo cannot cause hourly re-checks.
  return finish(outcome.deferred > 0 ? "partial" : "completed");
}

export interface RefreshSchedulerOptions {
  log: (level: "INFO" | "WARN", message: string, data?: Record<string, string>) => void;
  statePath?: string;
  findBin?: () => string | null;
  /** Called after every finished pass, e.g. to tell open windows the corpus changed. */
  onPass?: (outcome: RefreshOutcome) => void;
  /** Test seam; defaults to runSteroidsRefresh. */
  runPass?: (opts: RefreshOptions) => Promise<RefreshOutcome>;
}

/** Hourly check (after a startup delay) that runs a pass when one is due. */
export function startSteroidsRefresh(opts: RefreshSchedulerOptions): { dispose(): void } {
  const statePath = opts.statePath ?? defaultRefreshStatePath();
  const findBin = opts.findBin ?? (() => findSteroidsBinary());
  const runPass = opts.runPass ?? runSteroidsRefresh;
  const controller = new AbortController();
  let running = false;
  const tick = async (): Promise<void> => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      const bin = findBin();
      if (!bin || !isRefreshDue(await readRefreshState(statePath), Date.now())) return;
      const r = await runPass({ bin, statePath, signal: controller.signal });
      opts.log(r.status === "failed" ? "WARN" : "INFO", "steroids refresh pass", {
        status: r.status,
        repos: String(r.repos),
        unchanged: String(r.unchanged),
        changed: String(r.changed),
        updated: String(r.updated),
        deferred: String(r.deferred),
        failedBatches: String(r.failedBatches),
        unreachable: String(r.unreachable),
        ...(r.error ? { error: r.error } : {}),
      });
      try {
        opts.onPass?.(r);
      } catch (err) {
        opts.log("WARN", "steroids refresh listener failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      opts.log("WARN", "steroids refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), START_DELAY_MS);
  const timer = setInterval(() => void tick(), TICK_MS);
  first.unref?.();
  timer.unref?.();
  return {
    dispose() {
      clearTimeout(first);
      clearInterval(timer);
      controller.abort();
    },
  };
}
