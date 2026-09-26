import { defineConfig } from "vitest/config";
import { whatsNewHeadDefines } from "./scripts/whats-new-heads";

// Calendar tests exercise New York's DST gap. Set the timezone in the main
// process before workers start: changing TZ inside a worker thread does not
// update Date's timezone on Windows. Keep all test runs independent of host TZ.
process.env.TZ = "America/New_York";

export default defineConfig({
  define: whatsNewHeadDefines,
  test: {
    globals: true,
    // Windows fork fan-out repeatedly exceeded worker startup limits in the
    // full suite. A single thread worker also avoids competing sidecar fixtures.
    ...(process.platform === "win32" ? { pool: "threads" as const, maxWorkers: 1 } : {}),
    // `scripts/**` covers the pure helpers of the packaged Windows smoke: the
    // smoke itself only runs on Windows, but its MSI-selection and
    // PID-ownership logic is safety-critical and must be verified on every OS.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.mjs",
      "scripts/**/*.test.ts",
    ],
  },
});
