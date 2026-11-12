import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globalSetup: ["../../scripts/test-support/run-temp.mjs"],
    // Cap Windows process-fixture contention while preserving parallel coverage.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    // Ink suppresses incremental frame writes when `is-in-ci` detects CI
    // (CI=true on GitHub Actions), which empties every rendered frame and
    // breaks all TUI rendering assertions. Force non-CI inside test workers.
    env: {
      CI: "false",
      CONTINUOUS_INTEGRATION: "false",
    },
    // Keeps fake test edits out of the user's real ~/.gg/edit-quality.jsonl.
    // Set in the worker, where os.tmpdir() is already this run's folder.
    setupFiles: ["./src/test-support/edit-telemetry-setup.ts"],
    // The session/compaction suites persist real sessions and checkpoints to a
    // temp project on disk. Those filesystem round-trips are several times
    // slower on the Windows runner, where cases that finish in ~1s locally have
    // crossed vitest's 5s default and failed the blocking Windows gate. Give
    // them headroom; a genuinely hung test still fails, just later.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Tests tagged "alone" are skipped by test:windows-serial and run by
    // test:alone with nothing else active (cold CLI start under load).
    // Process-kill timing still races a busy Windows host, so these retry; a
    // check that always fails still fails.
    tags: [
      {
        name: "alone",
        description: "Timing-sensitive; run by itself via test:alone.",
        retry: 2,
      },
    ],
  },
});
