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

test("ggcoder programmatic lint remains a non-mutating CI gate", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../packages/ggcoder/package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["lint:programmatic"],
    'eslint "src/core/programmatic/*.ts" src/core/prompt-commands.ts src/core/prompt-commands.test.ts "src/tools/programmatic-*.ts" src/tools/index.ts src/tools/prompt-hints.ts src/tools/tool-tiers.ts',
  );

  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lintStep = workflow.match(
    /      - name: Lint ggcoder programmatic sources\r?\n[\s\S]*?(?=\r?\n      - name:)/,
  )?.[0];
  assert.ok(lintStep);
  assert.match(lintStep, /shell: bash/);
  assert.match(lintStep, /pnpm --filter @kenkaiiii\/ggcoder lint:programmatic/);
  assert.doesNotMatch(lintStep, /--fix/);
});

test("command discovery and desktop refresh lint is a mandatory non-mutating CI gate", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lintCommand = packageJson.scripts["lint:command-discovery"];
  assert.equal(lintCommand, [
    "eslint",
    "packages/ggcoder/src/core/command-discovery.ts",
    "packages/ggcoder/src/tools/command-information.ts",
    "packages/gg-core/src/referenced-files.ts",
    "gg-app/src/ReferencedFiles.tsx",
    "gg-app/src/AgentPane.tsx",
    "gg-app/src/agent.ts",
    "gg-app/src/useAgentEvents.ts",
  ].join(" "));
  assert.doesNotMatch(lintCommand, /--fix|--max-warnings/);

  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const testJob = workflow.split("\n  test:")[1].split("\n  app:")[0];
  const lintStep = testJob.match(
    /      - name: Lint command discovery and desktop refresh\r?\n[\s\S]*?(?=\r?\n      - name:)/,
  )?.[0];
  assert.ok(lintStep);
  assert.match(lintStep, /^        shell: bash\r?$/m);
  assert.match(lintStep, /^        run: pnpm lint:command-discovery\r?$/m);
  assert.doesNotMatch(lintStep, /--fix|--max-warnings|continue-on-error|\|\|/);
  assert.doesNotMatch(lintStep, /^\s*if:/m);
  assert.doesNotMatch(testJob, /^\s*continue-on-error:/m);
  assert.doesNotMatch(testJob, /^    if:/m);
  const aggregate = workflow.split("\n  release-gate:")[1];
  assert.match(aggregate, /needs: \[test, app\]/);
  assert.match(aggregate, /if: always\(\)/);
  assert.ok(aggregate.includes('[[ "$TEST_RESULT" == "success" ]]'));
});

test("desktop lint and format checks are mandatory non-mutating app gates", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../gg-app/package.json", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(packageJson.scripts.lint, /--fix/);
  assert.match(packageJson.scripts["format:check"], /^prettier --check /);

  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const appJob = workflow.split("\n  app:")[1].split("\n  release-gate:")[0];
  const step = (name) =>
    appJob.match(new RegExp(`      - name: ${name}\\r?\\n[\\s\\S]*?(?=\\r?\\n      - name:)`))?.[0];
  const expected = [
    ["Frontend format check", "pnpm --filter gg-app format:check"],
    ["Frontend lint", "pnpm --filter gg-app lint"],
  ];
  for (const [name, command] of expected) {
    const gate = step(name);
    assert.ok(gate, name);
    assert.match(gate, /^        shell: bash\r?$/m);
    assert.ok(gate.includes(`        run: ${command}`), name);
    assert.doesNotMatch(gate, /--fix|--write|continue-on-error|\|\||^\s*if:/m);
  }
  assert.doesNotMatch(appJob, /lint:fix|prettier --write|gg-app format\r?$/m);
  const buildIndex = appJob.indexOf("      - name: Frontend build + initial JavaScript size gate");
  const frameworkIndex = appJob.indexOf("      - name: Build framework packages");
  assert.ok(buildIndex > 0 && frameworkIndex > 0);
  assert.ok(appJob.indexOf("      - name: Frontend format check") < frameworkIndex);
  assert.ok(appJob.indexOf("      - name: Frontend lint") > frameworkIndex);
  assert.ok(appJob.indexOf("      - name: Frontend lint") < buildIndex);
});

test("tasks actions browser smoke is a blocking cross-platform app gate", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../gg-app/package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["smoke:tasks-actions"],
    "node scripts/tasks-actions-dev-smoke.mjs",
  );

  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const app = workflow.split("\n  app:")[1].split("\n  release-gate:")[0];
  const smoke = app.match(
    /      - name: Tasks actions browser smoke\r?\n[\s\S]*?(?=\r?\n      - name:)/,
  )?.[0];
  assert.ok(smoke);
  assert.match(smoke, /^        shell: bash\r?$/m);
  assert.ok(smoke.includes("        run: pnpm --filter gg-app smoke:tasks-actions"));
  assert.doesNotMatch(smoke, /continue-on-error|\|\||^\s*if:|--origin/m);
  const chromium = app.indexOf("pnpm exec playwright install --with-deps chromium");
  assert.ok(chromium > 0 && app.indexOf("      - name: Tasks actions browser smoke") > chromium);
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

test("pane swaps are a serial blocking Windows native gate with sanitized failure and cleanup evidence", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const workflow = read("../.github/workflows/ci.yml");
  const app = workflow.split("\n  app:")[1].split("\n  release-gate:")[0];
  const smoke = app.match(/      - name: Pane swaps native smoke\r?\n[\s\S]*?(?=      - name:)/)?.[0];
  assert.ok(smoke);
  for (const text of ["id: pane_swaps_smoke", "if: runner.os == 'Windows'", "shell: bash", "timeout-minutes: 15", "set -euo pipefail", 'mkdir -p "$TEMP" "$GG_PANE_SWAPS_EVIDENCE"', "node gg-app/scripts/pane-swaps-dev-smoke.mjs", "CARGO_NET_OFFLINE: 'true'", "COREPACK_ENABLE_NETWORK: '0'"]) assert.ok(smoke.includes(text), text);
  for (const variable of ["TEMP", "TMP"]) assert.ok(smoke.includes(`${variable}: \${{ runner.temp }}/pane-swaps-dev-smoke`));
  assert.ok(smoke.includes("GG_PANE_SWAPS_EVIDENCE: ${{ runner.temp }}/pane-swaps-evidence"));
  assert.doesNotMatch(smoke, /continue-on-error|\|\||--reuse|--visual|--preflight|&\s*$/m);
  assert.doesNotMatch(app, /continue-on-error/);
  assert.match(app, /timeout-minutes: 60/);
  const ordered = ["uses: Swatinem/rust-cache@v2", "- name: Build framework packages", "- name: Rust unit tests", "- name: Cross-pane project isolation native smoke", "- name: Pane swaps native smoke", "- name: Upload failed pane swaps evidence", "- name: Programmatic execution native smoke"].map(text => app.indexOf(text));
  assert.ok(ordered.every((position, index) => position >= 0 && (index === 0 || position > ordered[index - 1])));
  const upload = app.match(/      - name: Upload failed pane swaps evidence\r?\n[\s\S]*?(?=      - name:)/)?.[0];
  assert.ok(upload);
  assert.match(upload, /if: failure\(\) && runner\.os == 'Windows' && steps\.pane_swaps_smoke\.outcome == 'failure'/);
  assert.match(upload, /uses: actions\/upload-artifact@v7/);
  assert.match(upload, /if-no-files-found: error/);
  assert.match(upload, /retention-days: 7/);
  assert.deepEqual(upload.split("\n").map(line => line.trim()).filter(line => line.startsWith("${{ runner.temp }}")), [
    "result.json", "native-workspace.png", "native-failure.png", "native-center-1280.png", "native-center-390.png",
  ].map(name => `\${{ runner.temp }}/pane-swaps-evidence/${name}`));
  const runner = read("../gg-app/scripts/pane-swaps-dev-smoke.mjs");
  for (const text of ['runCrossPaneProjectIsolationSmoke({ identity: "com.ggcoder.local-fork", verifyWorkspace', 'onCleanup: (cleanup) => { evidence.cleanup = cleanup; }', 'assert.equal(evidence.cleanup.status, "passed")', 'process.exitCode = 1', 'evidence.status = "failed"', 'resolve(out, "result.json")', 'resolve(out, "native-failure.png")', 'process.env.GG_PANE_SWAPS_EVIDENCE', 'type: "mousePressed"', 'type: "mouseReleased"', '"Input.dispatchKeyEvent"', '["Enter", "Enter", 13]', '[" ", "Space", 32]', 'await key("Tab", "Tab", 9)', 'document.elementFromPoint(x, y)', 'same-center-direction focus', 'data-swap-keyboard-focus', 's.outlineWidth', 'width: 390, height: 844', 'width: 1280, height: 800', 'events.every(event => event.trusted)', 'entry.action === "session-created" || entry.action === "session-disposed"']) assert.ok(runner.includes(text), text);
  assert.doesNotMatch(runner, /\.click\(|reuseDevServer: true|evidence\.error = error|console\.(?:error|log)\(error/);
  const fixture = read("../gg-app/scripts/cross-pane-project-isolation-dev-smoke.mjs");
  for (const text of ['await verifyWorkspace?.(', 'await terminateProcessTree(child.pid)', 'survivingProcessIds(processIdentities, await readProcessTable())', 'cleanup.status = "passed"', 'cleanup.status = "failed"', 'cleanup.survivors = survivors', 'onCleanup?.(cleanup)', 'if (failure) {', 'throw new Error(']) assert.ok(fixture.includes(text), text);
  assert.ok(fixture.indexOf('onCleanup?.(cleanup)') > fixture.indexOf('await terminateProcessTree(child.pid)'));
});

test("appearance is a serial blocking Windows native gate with allowlisted evidence", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const workflow = read("../.github/workflows/ci.yml");
  const app = workflow.split("\n  app:")[1].split("\n  release-gate:")[0];
  const smoke = app.match(/      - name: Appearance native smoke\r?\n[\s\S]*?(?=      - name:)/)?.[0];
  assert.ok(smoke);
  for (const text of ["id: appearance_smoke", "if: runner.os == 'Windows'", "shell: bash", "timeout-minutes: 30", "set -euo pipefail", 'mkdir -p "$TEMP"', "pnpm --filter gg-app smoke:appearance", "CARGO_NET_OFFLINE: 'true'", "COREPACK_ENABLE_NETWORK: '0'", "UIMAXXXING_EYES_NO_INSTALL: '1'"]) assert.ok(smoke.includes(text), text);
  for (const variable of ["TEMP", "TMP"]) assert.ok(smoke.includes(`${variable}: \${{ runner.temp }}/appearance-dev-smoke`));
  assert.doesNotMatch(app, /continue-on-error/);
  assert.doesNotMatch(smoke, /\|\||&\s*$|GG_CHAT_DESIGN_PREVIEW|playwright install|pnpm install/m);
  const ordered = ["uses: Swatinem/rust-cache@v2", "- name: Build framework packages", "- name: Install Playwright browser", "- name: Rust unit tests", "- name: Cross-pane project isolation native smoke", "- name: Pane swaps native smoke", "- name: Appearance native smoke", "- name: Upload failed appearance evidence", "- name: Programmatic execution native smoke"].map(text => app.indexOf(text));
  assert.ok(ordered.every((position, index) => position >= 0 && (index === 0 || position > ordered[index - 1])));
  const upload = app.match(/      - name: Upload failed appearance evidence\r?\n[\s\S]*?(?=      - name:)/)?.[0];
  assert.ok(upload);
  assert.match(upload, /if: failure\(\) && runner\.os == 'Windows' && steps\.appearance_smoke\.outcome == 'failure'/);
  for (const text of ["uses: actions/upload-artifact@v7", "include-hidden-files: true", "if-no-files-found: error", "retention-days: 7"]) assert.ok(upload.includes(text), text);
  assert.deepEqual(upload.match(/          path: \|\r?\n((?:            .+\r?\n)+)/)[1].trim().split(/\r?\n/).map(line => line.trim()), [
    ".gg/eyes/out/appearance-native/fixture-*/result.json",
    ".gg/eyes/out/appearance-native/fixture-*/*.png",
  ]);
  const pkg = JSON.parse(read("../gg-app/package.json"));
  assert.equal(pkg.scripts["smoke:appearance"], "node scripts/appearance-dev-smoke.mjs");
  const runner = read("../gg-app/scripts/appearance-dev-smoke.mjs");
  for (const text of ['identity: "com.ggcoder.local-fork"', 'await ensureAppearanceDebugBuild(nativeEnv, config, scope)', 'onCleanup: result => { evidence.cleanup = result; }', 'evidence.cleanupError =', 'resolve(out, "result.json")', 'process.exitCode=1', "invoke('appearance_background_probe')", 'assertNativeBackground(']) assert.ok(runner.includes(text), text);
  const fixture = read("../gg-app/scripts/cross-pane-project-isolation-dev-smoke.mjs");
  assert.ok(fixture.indexOf('if (beforeNativeStart) await beforeNativeStart(') < fixture.indexOf('{ timeoutMs: 300_000 }'));
});

test("programmatic execution is a bounded blocking Windows app gate with failure evidence", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const appJob = workflow.split("\n  app:")[1].split("\n  release-gate:")[0];
  const smoke = appJob.match(/      - name: Programmatic execution native smoke\r?\n[\s\S]*?(?=      - name:)/)?.[0];
  assert.ok(smoke);
  assert.match(smoke, /id: programmatic_execution_smoke/);
  assert.match(smoke, /if: runner\.os == 'Windows'\r?\n/);
  assert.match(smoke, /shell: bash/);
  assert.match(smoke, /timeout-minutes: 15/);
  assert.match(smoke, /set -euo pipefail/);
  assert.match(smoke, /mkdir -p "\$TEMP"/);
  assert.match(smoke, /node gg-app\/scripts\/programmatic-execution-dev-smoke\.mjs --identity com\.ggcoder\.local-fork 2>&1 \| tee "\$TEMP\/console\.log"/);
  assert.doesNotMatch(appJob, /continue-on-error/);
  assert.doesNotMatch(smoke, /\|\| true|--visual|--preflight|--reuse-built-dev|--allow-normal-window/);
  for (const variable of ["TEMP", "TMP"]) {
    assert.ok(smoke.includes(`${variable}: \${{ runner.temp }}/programmatic-execution-dev-smoke`));
  }
  const ordered = [
    "uses: Swatinem/rust-cache@v2",
    "- name: Build framework packages",
    "pnpm --filter @kenkaiiii/gg-ai build",
    "pnpm --filter @kenkaiiii/gg-agent build",
    "pnpm --filter @kenkaiiii/gg-core build",
    "pnpm --filter @kenkaiiii/ggcoder build",
    "- name: Stage node runtime + bundle sidecar",
    "- name: Install Playwright browser",
    "- name: Roadmap reliability native smoke",
    "- name: Rust unit tests",
    "- name: Cross-pane project isolation native smoke",
    "- name: Programmatic execution native smoke",
    "- name: Upload failed programmatic execution evidence",
    "- name: Packaged app smoke",
  ].map((needle) => appJob.indexOf(needle));
  assert.ok(ordered.every((position, index) => position >= 0 && (index === 0 || position > ordered[index - 1])));
  assert.match(appJob, /timeout-minutes: 60/);
  assert.match(appJob, /workspaces: gg-app\/src-tauri/);
  const upload = appJob.match(/      - name: Upload failed programmatic execution evidence\r?\n[\s\S]*?(?=      - name:)/)?.[0];
  assert.ok(upload);
  assert.match(upload, /if: failure\(\) && runner\.os == 'Windows' && steps\.programmatic_execution_smoke\.outcome == 'failure'/);
  assert.match(upload, /uses: actions\/upload-artifact@v7/);
  assert.match(upload, /if-no-files-found: error/);
  assert.match(upload, /retention-days: 7/);
  const evidencePaths = upload.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("${{ runner.temp }}"));
  const root = "${{ runner.temp }}/programmatic-execution-dev-smoke";
  assert.deepEqual(evidencePaths, [
    `${root}/console.log`,
    ...["result.json", "failure.json", "cleanup.json", "developer.log", "native-minimized.json"].map((name) => `${root}/gg-programmatic-execution-*/audit/${name}`),
  ]);
  const fixture = readFileSync(new URL("../gg-app/scripts/programmatic-execution-dev-smoke.mjs", import.meta.url), "utf8");
  assert.match(fixture, /mkdtempSync\(join\(tmpdir\(\), "gg-programmatic-execution-"\)\)/);
  const lifecycle = readFileSync(new URL("../gg-app/scripts/programmatic-smoke-lifecycle.mjs", import.meta.url), "utf8");
  assert.match(fixture, /const result = await runSmokeLifecycle\(\{\s*audit,\s*workflow,/);
  assert.match(fixture, /beforeCleanup: async \(\) => \{ await observeMinimized\?\.\("before-cleanup"\); \}/);
  assert.match(fixture, /if \(!visual && !discoveryOnly\) validateNativeSmokeEvidence\(paths.audit, result, \{ driftOnly, integratedRecovery, extendedWorkflow, allowNormalWindow \}\)/);
  assert.match(fixture, /if \(!visual && discoveryOnly\) \{\s*const observations = JSON\.parse\(readFileSync\(join\(paths.audit, "native-minimized.json"\), "utf8"\)\);\s*assert\.ok\(observations.samples.length >= 3 && observations.samples.every\(\(sample\) => sample.verified && sample.minimized\)\);\s*result.minimized = true;/);
  assert.match(fixture, /const extendedWorkflow = process\.argv\.includes\("--extended-workflow"\)/);
  assert.match(fixture, /!extendedWorkflow \|\| \(!driftOnly && !integratedRecovery\)/);
  assert.match(fixture, /!extendedWorkflow \|\| !allowNormalWindow/);
  assert.match(fixture, /requests\.length < \(discoveryOnly \? discoveryRequestCount : extendedWorkflow \? extendedRequestCount : 3\)/);
  assert.match(fixture, /extendedWorkflowStep\(requests\.length, body\)/);
  assert.doesNotMatch(smoke, /--extended-workflow/);
  assert.match(lifecycle, /writeFileSync\(join\(audit, "failure.json"\)/);
  assert.match(fixture, /const visual = process\.argv\.includes\("--visual"\)/);
  assert.match(fixture, /GG_APP_DEV_SMOKE_WINDOW: visual \? "visible" : "minimized"/);
  assert.match(fixture, /assert\.deepEqual\(process\.argv\.slice\(2\),/);
  assert.match(fixture, /if \(reuseBuiltDev\) \{\s*assert\.match\(process\.env\.GG_PROGRAMMATIC_BUILT_DEV_SHA256/);
  assert.match(fixture, /assert\.equal\(createHash\("sha256"\)\.update\(readFileSync\(builtDev\)\)\.digest\("hex"\), process\.env\.GG_PROGRAMMATIC_BUILT_DEV_SHA256/);
  assert.match(fixture, /const native = reuseBuiltDev\s*\? spawn\(builtDev, \[\],[^\n]+\s*: spawn\(process\.env\.ComSpec \?\? "cmd.exe", \["\/d", "\/s", "\/c", nativeCommand\]/);
  assert.match(fixture, /const nativeCommand = `pnpm exec tauri dev --config/);
  assert.match(fixture, /const sample = \{ boundary, timestamp:/);
  assert.match(lifecycle, /const expectedLabels = \["native-ready", "approved-scanned-selected"/);
  assert.match(lifecycle, /observations\.samples\.map\(\(sample\) => sample\.boundary\), expectedLabels/);
  assert.match(fixture, /!integratedRecovery \|\| \(!driftOnly && !visual\)/);
  assert.match(fixture, /assert\.equal\(parentState\.provider, "azure"\)/);
  assert.match(fixture, /assert\.equal\(parentState\.model, "azure:fixture"\)/);
  for (const field of ["provider", "model", "sessionId"]) {
    assert.ok(fixture.includes(`assert.equal(finalParent.${field}, parentState.${field})`));
  }
  // Explicit assessment turns now belong to the parent transcript. Require the
  // accounting and both final checks, rather than the obsolete zero-growth rule.
  assert.ok(fixture.includes("let assessmentMessageDelta = 0;"));
  assert.ok(fixture.includes("entry.messageDelta = after.messageCount - before.messageCount;"));
  assert.ok(fixture.includes("assessmentMessageDelta += entry.messageDelta;"));
  assert.ok(fixture.includes('if (extendedWorkflow) assert.ok(finalParent.messageCount > parentState.messageCount, "Only explicit parent turns extend its transcript")'));
  assert.ok(fixture.includes('else assert.equal(finalParent.messageCount, parentState.messageCount + assessmentMessageDelta, "Only explicit assessments may extend the parent transcript")'));
  for (const field of ["provider", "model", "sessionId", "messageCount"]) {
    assert.ok(fixture.includes(`${field}: parentState.${field}`));
    assert.ok(fixture.includes(`${field}: finalParent.${field}`));
  }
  const vite = readFileSync(new URL("../gg-app/vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /port: 1420,\s*strictPort: true/);
});

test("desktop CI installs full Chromium on every OS for workspace extension tests", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const installStep = workflow.match(
    /      - name: Install Playwright browser\r?\n[\s\S]*?(?=\r?\n      - name:)/,
  )?.[0];
  assert.ok(installStep);
  assert.match(installStep, /run: pnpm exec playwright install --with-deps chromium/);
  assert.doesNotMatch(installStep, /--only-shell|\bif:/);
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
