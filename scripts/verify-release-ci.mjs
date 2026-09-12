#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const CI_WORKFLOW = "ci.yml";
const CI_WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW}`;
const API_VERSION = "2026-03-10";
const RUNS_PER_PAGE = 100;
const MAX_FILTERED_WORKFLOW_RUNS = 1_000;

export const REQUIRED_CI_JOBS = Object.freeze(["Release CI gate"]);

function fail(message) {
  throw new Error(`release-ci-gate: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`GitHub returned an invalid ${label} response`);
  }
  return value;
}

export function selectExactCiRun(workflowRunsResponse, sha) {
  const response = requireObject(workflowRunsResponse, "workflow-runs");
  if (!Array.isArray(response.workflow_runs)) {
    fail("GitHub workflow-runs response has no workflow_runs array");
  }

  const exactRuns = response.workflow_runs.filter(
    (run) =>
      run?.head_sha === sha &&
      run?.event === "push" &&
      run?.head_branch === "main" &&
      run?.path === CI_WORKFLOW_PATH,
  );

  if (exactRuns.length === 0) {
    fail(`no main-branch push CI run exists for exact release SHA ${sha}`);
  }

  const run = exactRuns.reduce((latest, candidate) =>
    Number(candidate.id) > Number(latest.id) ? candidate : latest,
  );

  if (run.status !== "completed" || run.conclusion !== "success") {
    fail(
      `CI run ${run.id} for ${sha} is ${run.status ?? "unknown"}/${run.conclusion ?? "pending"}; expected completed/success`,
    );
  }
  if (!Number.isInteger(run.run_attempt) || run.run_attempt < 1) {
    fail(`CI run ${run.id} has an invalid run_attempt`);
  }

  return run;
}

export function assertRequiredCiJobs(jobsResponse, { sha, runId, runAttempt }) {
  const response = requireObject(jobsResponse, "workflow-jobs");
  if (!Array.isArray(response.jobs) || !Number.isInteger(response.total_count)) {
    fail("GitHub workflow-jobs response is missing jobs or total_count");
  }
  if (response.total_count > response.jobs.length) {
    fail("workflow-jobs response was truncated; refusing to release without every CI job");
  }

  const jobsByName = new Map();
  for (const job of response.jobs) {
    if (job?.head_sha !== sha || job?.run_id !== runId || job?.run_attempt !== runAttempt) {
      fail(
        `CI job ${job?.name ?? "<unnamed>"} does not belong to the selected exact-SHA run attempt`,
      );
    }
    const namedJobs = jobsByName.get(job.name) ?? [];
    namedJobs.push(job);
    jobsByName.set(job.name, namedJobs);
  }

  for (const requiredName of REQUIRED_CI_JOBS) {
    const matchingJobs = jobsByName.get(requiredName) ?? [];
    if (matchingJobs.length === 0) {
      fail(`required CI job is missing: ${requiredName}`);
    }
    if (matchingJobs.length !== 1) {
      fail(`required CI job is ambiguous (${matchingJobs.length} matches): ${requiredName}`);
    }

    const job = matchingJobs[0];
    if (job.status !== "completed" || job.conclusion !== "success") {
      fail(
        `required CI job ${requiredName} is ${job.status ?? "unknown"}/${job.conclusion ?? "pending"}; expected completed/success`,
      );
    }
  }
}

async function githubJson(url, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`GitHub API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    fail(`GitHub API returned HTTP ${response.status} for ${new URL(url).pathname}`);
  }

  try {
    return await response.json();
  } catch {
    fail(`GitHub API returned non-JSON data for ${new URL(url).pathname}`);
  }
}

export async function verifyReleaseCi({
  apiUrl = "https://api.github.com",
  repository,
  sha,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!/^[^/]+\/[^/]+$/.test(repository ?? "")) fail("GITHUB_REPOSITORY must be owner/repo");
  if (!/^[0-9a-f]{40}$/i.test(sha ?? "")) fail("GITHUB_SHA must be a full 40-character commit SHA");
  if (!token) fail("GITHUB_TOKEN is required");
  if (typeof fetchImpl !== "function") fail("fetch is unavailable");

  const [owner, repo] = repository.split("/").map(encodeURIComponent);
  const base = `${apiUrl.replace(/\/$/, "")}/repos/${owner}/${repo}`;
  const runsUrl = new URL(`${base}/actions/workflows/${CI_WORKFLOW}/runs`);
  runsUrl.searchParams.set("branch", "main");
  runsUrl.searchParams.set("event", "push");
  runsUrl.searchParams.set("head_sha", sha);
  runsUrl.searchParams.set("per_page", String(RUNS_PER_PAGE));

  const workflowRuns = [];
  let expectedRunCount;
  for (let page = 1; ; page += 1) {
    runsUrl.searchParams.set("page", String(page));
    const response = requireObject(
      await githubJson(runsUrl, token, fetchImpl),
      "workflow-runs",
    );
    if (!Number.isInteger(response.total_count) || !Array.isArray(response.workflow_runs)) {
      fail("GitHub workflow-runs response is missing workflow_runs or total_count");
    }
    if (response.total_count > MAX_FILTERED_WORKFLOW_RUNS) {
      fail(
        `GitHub capped the filtered workflow-run search at ${MAX_FILTERED_WORKFLOW_RUNS} results; cannot prove the newest exact-SHA run`,
      );
    }
    if (expectedRunCount === undefined) expectedRunCount = response.total_count;
    if (response.total_count !== expectedRunCount) {
      fail("filtered workflow-run results changed during pagination; retry the release gate");
    }

    workflowRuns.push(...response.workflow_runs);
    if (workflowRuns.length >= expectedRunCount) break;
    if (response.workflow_runs.length !== RUNS_PER_PAGE) {
      fail("workflow-runs response was truncated; cannot prove the newest exact-SHA run");
    }
  }

  if (workflowRuns.length !== expectedRunCount) {
    fail("workflow-runs pagination returned an inconsistent result count");
  }
  const run = selectExactCiRun({ total_count: expectedRunCount, workflow_runs: workflowRuns }, sha);
  const jobsUrl = new URL(`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`);
  jobsUrl.searchParams.set("per_page", "100");
  const jobs = await githubJson(jobsUrl, token, fetchImpl);
  assertRequiredCiJobs(jobs, { sha, runId: run.id, runAttempt: run.run_attempt });

  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    requiredJobCount: REQUIRED_CI_JOBS.length,
  };
}

async function main() {
  const result = await verifyReleaseCi({
    apiUrl: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(
    `release-ci-gate: CI run ${result.runId} attempt ${result.runAttempt} passed all ${result.requiredJobCount} required jobs for ${process.env.GITHUB_SHA}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
