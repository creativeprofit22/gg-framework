import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exec, repo } = vi.hoisted(() => ({ exec: vi.fn(), repo: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: exec }),
}));
vi.mock("./github.js", () => ({ getGitHubRepoSlug: repo }));
// Background git goes through the hardened runner; route it to the same mock.
vi.mock("./git.js", () => ({
  runBackgroundGit: (args: string[], options: unknown) => exec("git", args, options),
}));
import {
  createCINotStartedNotifier,
  createCINotStartedNotify,
  getGitHubCI,
  getGitHubCIHistory,
  startGitHubCIPoll,
  type GitHubCI,
  type NotStartedCache,
} from "./github-ci.js";
import supa from "./__fixtures__/github-ci/supa-2026-10-30.json";

const sha = "a".repeat(40);
const run = (
  id = 10,
  workflow_id = 1,
  status = "in_progress",
  conclusion: string | null = null,
) => ({
  id,
  workflow_id,
  status,
  conclusion,
  run_attempt: 1,
  head_sha: sha,
});
const job = (id: number, status = "completed", conclusion: string | null = "success") => ({
  id,
  status,
  conclusion,
});
let runs: ReturnType<typeof run>[];
let jobs: ReturnType<typeof job>[];
let head: string;
let stops: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  stops = [];
  head = sha;
  runs = [run()];
  jobs = [job(1), job(2, "in_progress", null)];
  repo.mockResolvedValue("owner/repo");
  exec.mockImplementation(async (file: string, args: string[]) => ({
    stdout:
      file === "git"
        ? head
        : JSON.stringify(args[3].includes("/jobs?") ? [{ jobs }] : [{ workflow_runs: runs }]),
  }));
});
afterEach(() => {
  for (const stop of stops) stop();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("getGitHubCI", () => {
  it("counts jobs for the exact commit and constructs a trusted GitHub link", async () => {
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      key: `owner/repo:${sha}:10.1`,
      url: "https://github.com/owner/repo/actions/runs/10",
      active: true,
      total: 2,
      completed: 1,
      failed: 0,
      conclusion: null,
    });
    expect(exec.mock.calls[0][1]).toEqual([
      "api",
      "--hostname",
      "github.com",
      `repos/owner/repo/actions/runs?head_sha=${sha}&per_page=100`,
      "--paginate",
      "--slurp",
    ]);
  });

  it("selects the newest run per workflow and counts all job pages for its attempt", async () => {
    runs = [
      run(9, 1, "completed", "failure"),
      { ...run(10), run_attempt: 2 },
      run(11, 2),
      { ...run(12, 3), head_sha: "b".repeat(40) },
    ];
    exec.mockImplementation(async (_file: string, args: string[]) => ({
      stdout: JSON.stringify(
        args[3].includes("/jobs?")
          ? [{ jobs: [job(1)] }, { jobs: [job(2)] }]
          : [{ workflow_runs: runs }],
      ),
    }));
    const ci = await getGitHubCI("owner/repo", sha);
    expect(ci).toMatchObject({ total: 4, completed: 4, failed: 0, active: true });
    expect(ci?.key).toBe(`owner/repo:${sha}:10.2,11.1`);
    expect(exec.mock.calls.map((call) => call[1][3])).toContain(
      "repos/owner/repo/actions/runs/10/attempts/2/jobs?per_page=100",
    );
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not report all-clear while a workflow remains active", async () => {
    runs = [run(10, 1, "completed", "success"), run(11, 2)];
    jobs = [job(1)];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({ active: true, conclusion: null });
  });

  it("reports passing only when every workflow succeeded", async () => {
    runs = [run(10, 1, "completed", "success")];
    jobs = [job(1), job(2, "completed", "skipped")];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      active: false,
      conclusion: "success",
      completed: 2,
    });
  });

  it.each(["failure", "timed_out", "action_required", "startup_failure", null])(
    "reports unsuccessful conclusion %s",
    async (conclusion) => {
      runs = [run(10, 1, "completed", conclusion)];
      jobs = [];
      expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
        active: false,
        conclusion: "failure",
        failed: 1,
      });
    },
  );

  it("reports a job failure before the whole workflow finishes", async () => {
    jobs = [job(1, "completed", "failure"), job(2, "in_progress", null)];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      active: true,
      failed: 1,
      conclusion: null,
    });
  });

  it("does not call cancellation a pass", async () => {
    runs = [run(10, 1, "completed", "cancelled")];
    jobs = [];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      active: false,
      conclusion: "cancelled",
    });
  });

  it("returns no indicator for no workflows and rejects malformed or unavailable evidence", async () => {
    runs = [];
    expect(await getGitHubCI("owner/repo", sha)).toBeNull();
    exec.mockResolvedValue({ stdout: "{}" });
    await expect(getGitHubCI("owner/repo", sha)).rejects.toThrow();
    exec.mockRejectedValue(new Error("offline"));
    await expect(getGitHubCI("owner/repo", sha)).rejects.toThrow("offline");
  });

  it("rejects invalid repository and commit input before invoking gh", async () => {
    await expect(getGitHubCI("owner/repo?redirect=elsewhere", sha)).rejects.toThrow();
    await expect(getGitHubCI("owner/repo", "--help")).rejects.toThrow();
    await expect(getGitHubCI("../repo", sha)).rejects.toThrow();
    await expect(getGitHubCI("owner/..", sha)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("CI polling lifecycle", () => {
  it("polls active runs every 15 seconds, completed runs every minute, and stops cleanly", async () => {
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledTimes(1);
    exec.mockClear();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(exec).not.toHaveBeenCalled();
    runs = [run(10, 1, "completed", "success")];
    jobs = [job(1)];
    await vi.advanceTimersByTimeAsync(1);
    expect(changed.mock.lastCall?.[0].conclusion).toBe("success");
    exec.mockClear();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(exec).not.toHaveBeenCalled();
    poll.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).not.toHaveBeenCalled();
  });

  it("clears old commit state and marks network failures stale instead of passing", async () => {
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    exec.mockImplementation(async (file: string) => {
      if (file === "git") return { stdout: head };
      throw new Error("rate limited");
    });
    await poll.refresh();
    expect(changed.mock.lastCall?.[0].stale).toBe(true);
    head = "b".repeat(40);
    await poll.refresh();
    expect(changed.mock.lastCall?.[0]).toBeNull();
  });

  it("discards results if HEAD changes while a network request is in flight", async () => {
    exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === "git") return { stdout: head };
      if (args[3].includes("/jobs?")) {
        head = "b".repeat(40);
        return { stdout: JSON.stringify([{ jobs }]) };
      }
      return { stdout: JSON.stringify([{ workflow_runs: runs }]) };
    });
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not overlap polls and aborts in-flight requests when stopped", async () => {
    let signal: AbortSignal | undefined;
    exec.mockImplementation((file: string, _args: string[], options: { signal?: AbortSignal }) => {
      if (file === "git") return Promise.resolve({ stdout: head });
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    const calls = exec.mock.calls.length;
    await poll.refresh();
    expect(exec).toHaveBeenCalledTimes(calls);
    expect(signal?.aborted).toBe(false);
    poll.stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).toHaveBeenCalledTimes(calls);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not query GitHub for non-GitHub projects", async () => {
    repo.mockResolvedValue(null);
    const poll = startGitHubCIPoll("/project", vi.fn());
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(exec.mock.calls.every((call) => call[0] === "git")).toBe(true);
  });
});

// Recorded with gh api from supa on 2026-10-30: GitHub refused every job for billing.
describe("CI that GitHub refused to start (recorded supa fixture)", () => {
  type Handler = (endpoint: string) => unknown;
  const refusedRun = 41139224468;
  const endpoints = () =>
    exec.mock.calls.filter((call) => call[0] === "gh").map((call) => call[1][3] as string);
  const recorded: Handler = (endpoint) => {
    const annotation = /check-runs\/(\d+)\/annotations/.exec(endpoint);
    if (annotation) {
      return (supa.annotations as Record<string, unknown>)[annotation[1] ?? ""] ?? [];
    }
    const attempt = /runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(endpoint);
    if (attempt) {
      const page = (supa.jobs as Record<string, unknown>)[`${attempt[1]}.${attempt[2]}`];
      if (!page) throw new Error(`no recorded jobs for ${endpoint}`);
      return [page];
    }
    if (endpoint.includes("head_sha=")) return [supa.runsForSha];
    if (endpoint.includes("status=success")) return supa.lastSuccess;
    if (endpoint.includes("actions/runs?branch=")) return supa.branchRuns;
    if (endpoint === "repos/owner/supa") return { default_branch: supa.defaultBranch };
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const serve = (handler: Handler = recorded) =>
    exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === "git") return { stdout: head };
      return { stdout: JSON.stringify(handler(args[3])) };
    });
  const realFailure = {
    id: 99,
    status: "completed",
    conclusion: "failure",
    runner_id: 7,
    runner_name: "GitHub Actions 7",
    steps: [{ name: "test", conclusion: "failure" }],
  };

  beforeEach(() => {
    head = supa.sha;
    repo.mockResolvedValue(supa.slug);
    serve();
  });

  it("classifies the recorded run as not started, distinct from failure", async () => {
    expect(await getGitHubCI(supa.slug, supa.sha)).toMatchObject({
      url: `https://github.com/owner/supa/actions/runs/${refusedRun}`,
      active: false,
      total: 5,
      failed: 4,
      conclusion: "not_started",
    });
    const annotationCall = exec.mock.calls.find((call) =>
      String(call[1][3]).includes("/annotations"),
    );
    // One bounded, non-paginated annotation request for the run's first non-skipped job.
    expect(annotationCall?.[1].slice(3)).toEqual([
      "repos/owner/supa/check-runs/124349121098/annotations?per_page=10",
    ]);
  });

  it("keeps a real failure in another workflow as failure", async () => {
    const other = { ...supa.runsForSha.workflow_runs[0], id: 500, workflow_id: 2 };
    serve((endpoint) => {
      if (endpoint.includes("head_sha=")) {
        return [{ workflow_runs: [...supa.runsForSha.workflow_runs, other] }];
      }
      if (endpoint.includes("runs/500/attempts/1/jobs")) return [{ jobs: [realFailure] }];
      return recorded(endpoint);
    });
    expect(await getGitHubCI(supa.slug, supa.sha)).toMatchObject({ conclusion: "failure" });
  });

  it("keeps zero-step jobs without GitHub's refusal annotation as failure", async () => {
    const cache: NotStartedCache = new Map();
    serve((endpoint) =>
      endpoint.includes("/annotations")
        ? [{ message: "Process completed with exit code 1." }]
        : recorded(endpoint),
    );
    expect(await getGitHubCI(supa.slug, supa.sha, undefined, cache)).toMatchObject({
      conclusion: "failure",
    });
    expect(cache.get(`${refusedRun}.1`)).toBe(false);
    serve((endpoint) => (endpoint.includes("/annotations") ? [] : recorded(endpoint)));
    expect(await getGitHubCI(supa.slug, supa.sha)).toMatchObject({ conclusion: "failure" });
  });

  it("falls back to failure without caching when the annotation request fails", async () => {
    const cache: NotStartedCache = new Map();
    serve((endpoint) => {
      if (endpoint.includes("/annotations")) throw new Error("HTTP 502");
      return recorded(endpoint);
    });
    expect(await getGitHubCI(supa.slug, supa.sha, undefined, cache)).toMatchObject({
      conclusion: "failure",
    });
    expect(cache.size).toBe(0);
    serve();
    expect(await getGitHubCI(supa.slug, supa.sha, undefined, cache)).toMatchObject({
      conclusion: "not_started",
    });
  });

  it("asks for annotations once per run attempt when given a cache", async () => {
    const cache: NotStartedCache = new Map();
    await getGitHubCI(supa.slug, supa.sha, undefined, cache);
    await getGitHubCI(supa.slug, supa.sha, undefined, cache);
    expect(endpoints().filter((endpoint) => endpoint.includes("/annotations"))).toHaveLength(1);
    expect(cache.get(`${refusedRun}.1`)).toBe(true);
  });

  it("finds the last green default-branch run and the refusal streak", async () => {
    const cache: NotStartedCache = new Map();
    expect(await getGitHubCIHistory(supa.slug, { cache })).toEqual({
      defaultBranch: "main",
      lastSuccessAt: "2026-09-07T14:33:18Z",
      notStartedStreak: 10,
    });
    expect(endpoints()).toEqual(
      expect.arrayContaining([
        "repos/owner/supa",
        "repos/owner/supa/actions/runs?branch=main&status=success&per_page=1",
        "repos/owner/supa/actions/runs?branch=main&per_page=10",
      ]),
    );
    exec.mockClear();
    await getGitHubCIHistory(supa.slug, { cache, defaultBranch: "main" });
    // Cached runs and branch: only the two run lists are requested again.
    expect(endpoints()).toHaveLength(2);
  });

  it("stops the streak at the first run that actually ran", async () => {
    const runs = supa.branchRuns.workflow_runs.map((run, index) =>
      index === 2 ? { ...run, conclusion: "success" } : run,
    );
    serve((endpoint) =>
      endpoint.includes("actions/runs?branch=main&per_page")
        ? { workflow_runs: runs }
        : recorded(endpoint),
    );
    expect(await getGitHubCIHistory(supa.slug)).toMatchObject({ notStartedStreak: 2 });
    serve((endpoint) =>
      endpoint.includes("status=success") ? { workflow_runs: [] } : recorded(endpoint),
    );
    expect(await getGitHubCIHistory(supa.slug)).toMatchObject({ lastSuccessAt: null });
  });

  it("attaches history to a not-started poll and refetches it at most every 10 minutes", async () => {
    let now = Date.parse("2026-10-31T00:00:00Z");
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed, { now: () => now });
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      conclusion: "not_started",
      lastSuccessAt: "2026-09-07T14:33:18Z",
      notStartedStreak: 10,
    });
    const history = () => endpoints().filter((endpoint) => endpoint.includes("status=success"));
    now += 9 * 60_000;
    await poll.refresh();
    expect(history()).toHaveLength(1);
    now += 60_000;
    await poll.refresh();
    expect(history()).toHaveLength(2);
    expect(endpoints().filter((endpoint) => endpoint === "repos/owner/supa")).toHaveLength(1);
  });

  it("fails open when history is unavailable and stays stale on rate limits", async () => {
    serve((endpoint) => {
      if (endpoint.includes("branch=")) throw new Error("HTTP 403: API rate limit exceeded");
      return recorded(endpoint);
    });
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    const ci = changed.mock.lastCall?.[0] as GitHubCI;
    expect(ci.conclusion).toBe("not_started");
    expect(ci).not.toHaveProperty("lastSuccessAt");
    exec.mockImplementation(async (file: string) => {
      if (file === "git") return { stdout: head };
      throw new Error("HTTP 403: API rate limit exceeded");
    });
    await poll.refresh();
    expect(changed.mock.lastCall?.[0]).toMatchObject({ conclusion: "not_started", stale: true });
  });

  it("does not look up history for CI that ran", async () => {
    head = sha;
    repo.mockResolvedValue("owner/repo");
    runs = [run(10, 1, "completed", "failure")];
    jobs = [job(1, "completed", "failure")];
    exec.mockImplementation(async (file: string, args: string[]) => ({
      stdout:
        file === "git"
          ? head
          : JSON.stringify(args[3].includes("/jobs?") ? [{ jobs }] : [{ workflow_runs: runs }]),
    }));
    const changed = vi.fn();
    stops.push(startGitHubCIPoll("/project", changed).stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.lastCall?.[0].conclusion).toBe("failure");
    expect(endpoints().some((endpoint) => endpoint.includes("branch="))).toBe(false);
  });
});

describe("createCINotStartedNotifier", () => {
  const lastGreen = Date.parse("2026-09-07T14:33:18Z");
  const day = 86_400_000;
  const refused = (extra: Partial<GitHubCI> = {}): GitHubCI => ({
    key: "k",
    url: "https://github.com/owner/supa/actions/runs/1",
    total: 5,
    completed: 5,
    failed: 4,
    active: false,
    conclusion: "not_started",
    lastSuccessAt: "2026-09-07T14:33:18Z",
    notStartedStreak: 10,
    ...extra,
  });

  it("stays silent below the 3-day threshold and fires above it", () => {
    const early = createCINotStartedNotifier({ now: () => lastGreen + 2.9 * day });
    expect(early("s", refused())).toBeNull();
    const notice = createCINotStartedNotifier({ now: () => lastGreen + 3.1 * day })("s", refused());
    expect(notice).toContain("since 2026-09-07");
    expect(notice).toContain("the last 10+ runs");
    expect(notice).toMatch(/Status notice only; not verification evidence\.$/);
  });

  it("notifies once per session id", () => {
    const notify = createCINotStartedNotifier({ now: () => lastGreen + 30 * day });
    expect(notify("a", refused())).not.toBeNull();
    expect(notify("a", refused())).toBeNull();
    expect(notify("b", refused())).not.toBeNull();
  });

  it("stays silent while history is unknown, stale, or CI is not refused", () => {
    const notify = createCINotStartedNotifier({ now: () => lastGreen + 30 * day });
    expect(notify("s", refused({ lastSuccessAt: undefined }))).toBeNull();
    expect(notify("s", refused({ stale: true }))).toBeNull();
    expect(notify("s", refused({ conclusion: "failure" }))).toBeNull();
    expect(notify("s", null)).toBeNull();
    // Silence must not use up the session's one notice.
    expect(notify("s", refused())).not.toBeNull();
  });

  it("reports a default branch that never succeeded", () => {
    const notice = createCINotStartedNotifier()(
      "s",
      refused({ lastSuccessAt: null, notStartedStreak: 1 }),
    );
    expect(notice).toContain("no successful run on the default branch");
    expect(notice).toContain("the latest run");
  });
});

describe("createCINotStartedNotify", () => {
  const lastGreen = Date.parse("2026-09-07T14:33:18Z");
  const steady: GitHubCI = {
    key: "k",
    url: "https://github.com/owner/supa/actions/runs/1",
    total: 5,
    completed: 5,
    failed: 5,
    active: false,
    conclusion: "not_started",
    lastSuccessAt: "2026-09-07T14:33:18Z",
    notStartedStreak: 10,
  };

  it("tells a later conversation in the same window once, without repeating the first", () => {
    let sessionId = "first";
    const notify = vi.fn();
    const session = { getConversationIdentity: () => ({ sessionId }), notify };
    const check = createCINotStartedNotify(() => session, {
      now: () => lastGreen + 4 * 86_400_000,
    });

    check(steady); // window open: poll replays the latest value
    check(steady); // first conversation's run
    expect(notify).toHaveBeenCalledTimes(1);

    sessionId = "second"; // new conversation; the poll stays silent
    check(steady);
    check(steady);
    expect(notify.mock.calls.map(([id]) => id)).toEqual([
      "github-ci-not-started",
      "github-ci-not-started",
    ]);
    expect(notify.mock.lastCall?.[1]).toMatch(/Status notice only; not verification evidence\.$/);
  });
});
