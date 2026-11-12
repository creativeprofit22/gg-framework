import { readdirSync, readFileSync } from "node:fs";
import { defaultExclude, defineConfig } from "vitest/config";
import { whatsNewHeadDefines } from "./scripts/whats-new-heads";

// Calendar tests exercise New York's DST gap. Set the timezone in the main
// process before workers start: changing TZ inside a worker thread does not
// update Date's timezone on Windows. Keep all test runs independent of host TZ.
process.env.TZ = "America/New_York";

// Pure jsdom UI files reuse one worker across files (vm pool). Files that
// spawn processes, start a real daemon or use worker threads stay in the
// normal pool, where Node built-ins compare equal and nothing leaks.
const NORMAL_POOL_MARKERS = ["withRealSidecar", "node:child_process", "node:worker_threads"];
// Run alone by their own package scripts; `test:parallel` runs only ui + node.
const SERIAL_TEST_FILES = [
  "scripts/install-local-patched.test.mjs",
  "scripts/launch-local-patched.test.mjs",
  "scripts/update-with-local-fixes.test.ts",
  "scripts/workspace-shell-evidence.test.mjs",
];
// Real-daemon and bundling files that time out when run beside the rest of
// the suite on a loaded machine; `test:heavy-serial` runs them one at a time.
const HEAVY_TEST_FILES = [
  "scripts/bundle-sidecar.test.mjs",
  "scripts/roadmap-reliability-dev-smoke.test.mjs",
  "src/AgentPane.continuation.test.tsx",
  "src/AgentPane.lifecycle.test.tsx",
  "src/AgentPane.sessions.test.tsx",
  "src/AgentPane.shell.test.tsx",
  "src/AgentPane.test.tsx",
];
// Pure jsdom files that fail only inside a vm context: ReadableStream is
// missing there, `location` can't be stubbed, and a mocked-module error
// reaches AboutPage's console.warn assertion. They keep the normal pool.
const VM_POOL_EXCLUDED = new Set([
  "src/AboutPage.test.tsx",
  "src/AppErrorBoundary.test.tsx",
  "src/PlanReviewModal.test.tsx",
  "src/ProgrammaticDiscovery.test.tsx",
  "src/progress-cap.test.tsx",
]);
const uiTestFiles = readdirSync("src", { recursive: true, encoding: "utf8" })
  .map((file) => `src/${file.replaceAll("\\", "/")}`)
  .filter((file) => /\.test\.tsx?$/.test(file))
  .filter((file) => !VM_POOL_EXCLUDED.has(file))
  .filter((file) => {
    const source = readFileSync(file, "utf8");
    return (
      source.startsWith("// @vitest-environment jsdom") &&
      !NORMAL_POOL_MARKERS.some((marker) => source.includes(marker))
    );
  })
  .sort();

export default defineConfig({
  define: whatsNewHeadDefines,
  test: {
    globals: true,
    globalSetup: ["../scripts/test-support/run-temp.mjs"],
    // Windows fork fan-out repeatedly exceeded worker startup limits in the
    // full suite, so use threads. One worker made the suite ~4x slower; four
    // keeps the real-sidecar fixtures within their startup budget.
    ...(process.platform === "win32" ? { pool: "threads" as const, maxWorkers: 4 } : {}),
    // Node 25+ ships its own localStorage, which warns without a backing file
    // and shadows jsdom's. Tests use jsdom's (or stub it), so turn Node's off.
    // The flag exists since Node 22.4, CI's floor.
    execArgv: ["--no-experimental-webstorage"],
    // Vitest hands every CSS import back empty unless it's included here. The
    // stylesheet guards (css-loops.test.ts) read sheets as `?raw` text, so let
    // just those through; component CSS stays empty, as jsdom tests expect.
    css: { include: [/\.css\?raw$/] },
    // Tests tagged "alone" are skipped by their file's serial script and run
    // by `test:alone` with nothing else active (tight timing deadlines).
    tags: [{ name: "alone", description: "Timing-sensitive; run by itself via test:alone." }],
    projects: [
      {
        extends: true,
        test: { name: "ui", pool: "vmThreads", include: uiTestFiles },
      },
      {
        extends: true,
        test: {
          name: "node",
          // `scripts/**` covers the pure helpers of the packaged Windows smoke:
          // the smoke itself only runs on Windows, but its MSI-selection and
          // PID-ownership logic is safety-critical and must be verified on every OS.
          include: [
            "src/**/*.test.ts",
            "src/**/*.test.tsx",
            "scripts/**/*.test.mjs",
            "scripts/**/*.test.ts",
          ],
          exclude: [...defaultExclude, ...uiTestFiles, ...SERIAL_TEST_FILES, ...HEAVY_TEST_FILES],
        },
      },
      {
        extends: true,
        test: { name: "serial", include: SERIAL_TEST_FILES },
      },
      {
        extends: true,
        // Phase-1 baseline: slowest default-limit heavy test took 5.15 s (one
        // failure at 5.6 s), so allow ~3x that; hooks get 3x the default.
        test: {
          name: "heavy",
          include: HEAVY_TEST_FILES,
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
