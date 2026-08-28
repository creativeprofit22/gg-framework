import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REQUIRED_CI_JOBS,
  assertRequiredCiJobs,
  selectExactCiRun,
  verifyReleaseCi,
} from "./verify-release-ci.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = 4242;
const RUN_ATTEMPT = 2;

function exactRun(overrides = {}) {
  return {
    id: RUN_ID,
    run_attempt: RUN_ATTEMPT,
    head_sha: SHA,
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function requiredJob(overrides = {}) {
  return {
    id: 99,
    name: "Release CI gate",
    head_sha: SHA,
    run_id: RUN_ID,
    run_attempt: RUN_ATTEMPT,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function jobsResponse(jobs = [requiredJob()]) {
  return { total_count: jobs.length, jobs };
}

function expectGateFailure(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.match(error.message, /^release-ci-gate:/);
    assert.match(error.message, pattern);
    return true;
  });
}

test("required check name stays synchronized with the aggregate CI job", () => {
  assert.deepEqual(REQUIRED_CI_JOBS, ["Release CI gate"]);
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /\n  release-gate:\r?\n(?:.|\r?\n)*?    name: Release CI gate\r?\n/);
  assert.match(workflow, /needs: \[test, app\]/);
});

test("roadmap reliability native smoke remains an isolated Windows app gate", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../gg-app/package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["smoke:roadmap-reliability-dev"],
    "node scripts/roadmap-reliability-dev-smoke.mjs --identity com.ggcoder.local-fork",
  );

  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const smokeStep = workflow.match(
    /      - name: Roadmap reliability native smoke\r?\n[\s\S]*?(?=      - name:)/,
  )?.[0];
  assert.ok(smokeStep);
  assert.match(smokeStep, /if: runner\.os == 'Windows'/);
  assert.match(smokeStep, /shell: bash/);
  assert.match(smokeStep, /pnpm smoke:roadmap-reliability-dev/);
  assert.match(smokeStep, /\$\{\{ runner\.temp \}\}\/roadmap-reliability-dev-smoke/);
  assert.match(workflow, /if: failure\(\).*steps\.roadmap_reliability_smoke\.outcome == 'failure'/);
  assert.match(workflow, /uses: actions\/upload-artifact@v7/);
});

test("release workflow wires the exact-SHA verifier ahead of protected preflight", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /\n  ci-gate:\r?\n(?:.|\r?\n)*?      actions: read\r?\n/);
  assert.match(workflow, /run: node scripts\/verify-release-ci\.mjs/);
  assert.match(workflow, /\n  preflight:\r?\n    needs: ci-gate\r?\n/);
});

test("successful exact-SHA main push and required CI job allow release", async () => {
  const requestedUrls = [];
  const responses = [{ total_count: 1, workflow_runs: [exactRun()] }, jobsResponse()];
  const result = await verifyReleaseCi({
    repository: "kenkaiiii/gg-framework",
    sha: SHA,
    token: "test-token",
    fetchImpl: async (url, options) => {
      requestedUrls.push(url.toString());
      assert.equal(options.headers["X-GitHub-Api-Version"], "2026-03-10");
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(result, { runId: RUN_ID, runAttempt: RUN_ATTEMPT, requiredJobCount: 1 });
  assert.match(requestedUrls[0], /actions\/workflows\/ci\.yml\/runs/);
  assert.match(requestedUrls[0], new RegExp(`head_sha=${SHA}`));
  assert.match(requestedUrls[1], /actions\/runs\/4242\/attempts\/2\/jobs/);
});

test("more than 100 filtered runs are fully paginated", async () => {
  const requestedUrls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    exactRun({ id: RUN_ID - index - 1 }),
  );
  const responses = [
    { total_count: 101, workflow_runs: firstPage },
    { total_count: 101, workflow_runs: [exactRun()] },
    jobsResponse(),
  ];

  const result = await verifyReleaseCi({
    repository: "kenkaiiii/gg-framework",
    sha: SHA,
    token: "x",
    fetchImpl: async (url) => {
      requestedUrls.push(url.toString());
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
  });

  assert.equal(result.runId, RUN_ID);
  assert.equal(new URL(requestedUrls[0]).searchParams.get("page"), "1");
  assert.equal(new URL(requestedUrls[1]).searchParams.get("page"), "2");
  assert.match(requestedUrls[2], /actions\/runs\/4242\/attempts\/2\/jobs/);
});

test("newer failed or pending exact-SHA run on a later page stops release", async () => {
  for (const state of [
    { status: "completed", conclusion: "failure" },
    { status: "in_progress", conclusion: null },
  ]) {
    const responses = [
      {
        total_count: 101,
        workflow_runs: Array.from({ length: 100 }, (_, index) =>
          exactRun({ id: RUN_ID - index - 1 }),
        ),
      },
      { total_count: 101, workflow_runs: [exactRun({ id: RUN_ID + 1, ...state })] },
    ];

    await assert.rejects(
      verifyReleaseCi({
        repository: "kenkaiiii/gg-framework",
        sha: SHA,
        token: "x",
        fetchImpl: async () =>
          new Response(JSON.stringify(responses.shift()), { status: 200 }),
      }),
      new RegExp(`${state.status}/${state.conclusion ?? "pending"}`),
    );
  }
});

test("filtered-result cap or truncated pagination stops release", async () => {
  for (const responses of [
    [{ total_count: 1_001, workflow_runs: Array.from({ length: 100 }, () => exactRun()) }],
    [
      { total_count: 101, workflow_runs: Array.from({ length: 100 }, () => exactRun()) },
      { total_count: 101, workflow_runs: [] },
    ],
  ]) {
    await assert.rejects(
      verifyReleaseCi({
        repository: "kenkaiiii/gg-framework",
        sha: SHA,
        token: "x",
        fetchImpl: async () =>
          new Response(JSON.stringify(responses.shift()), { status: 200 }),
      }),
      /(?:capped|truncated).*cannot prove the newest exact-SHA run/,
    );
  }
});

test("missing exact-SHA CI run stops release", () => {
  expectGateFailure(
    () =>
      selectExactCiRun(
        { total_count: 1, workflow_runs: [exactRun({ head_sha: "f".repeat(40) })] },
        SHA,
      ),
    /no main-branch push CI run exists for exact release SHA/,
  );
});

test("PR-only CI success stops release", () => {
  expectGateFailure(
    () =>
      selectExactCiRun(
        { total_count: 1, workflow_runs: [exactRun({ event: "pull_request" })] },
        SHA,
      ),
    /no main-branch push CI run exists/,
  );
});

test("pending CI run stops release", () => {
  expectGateFailure(
    () =>
      selectExactCiRun(
        { total_count: 1, workflow_runs: [exactRun({ status: "in_progress", conclusion: null })] },
        SHA,
      ),
    /in_progress\/pending/,
  );
});

test("failed CI run stops release", () => {
  expectGateFailure(
    () =>
      selectExactCiRun(
        { total_count: 1, workflow_runs: [exactRun({ conclusion: "failure" })] },
        SHA,
      ),
    /completed\/failure/,
  );
});

test("missing, pending, or failed required aggregate job stops release", () => {
  expectGateFailure(
    () =>
      assertRequiredCiJobs(jobsResponse([]), { sha: SHA, runId: RUN_ID, runAttempt: RUN_ATTEMPT }),
    /required CI job is missing: Release CI gate/,
  );
  expectGateFailure(
    () =>
      assertRequiredCiJobs(jobsResponse([requiredJob({ status: "queued", conclusion: null })]), {
        sha: SHA,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }),
    /queued\/pending/,
  );
  expectGateFailure(
    () =>
      assertRequiredCiJobs(jobsResponse([requiredJob({ conclusion: "failure" })]), {
        sha: SHA,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }),
    /completed\/failure/,
  );
});

test("job from another SHA or run attempt stops release", () => {
  expectGateFailure(
    () =>
      assertRequiredCiJobs(jobsResponse([requiredJob({ run_attempt: 1 })]), {
        sha: SHA,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }),
    /does not belong to the selected exact-SHA run attempt/,
  );
});
