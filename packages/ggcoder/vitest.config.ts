import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Cap Windows process-fixture contention while preserving parallel coverage.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    // Ink suppresses incremental frame writes when `is-in-ci` detects CI
    // (CI=true on GitHub Actions), which empties every rendered frame and
    // breaks all TUI rendering assertions. Force non-CI inside test workers.
    env: {
      CI: "false",
      CONTINUOUS_INTEGRATION: "false",
    },
    // The session/compaction suites persist real sessions and checkpoints to a
    // temp project on disk. Those filesystem round-trips are several times
    // slower on the Windows runner, where cases that finish in ~1s locally have
    // crossed vitest's 5s default and failed the blocking Windows gate. Give
    // them headroom; a genuinely hung test still fails, just later.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
