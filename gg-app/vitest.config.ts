import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // `scripts/**` covers the pure helpers of the packaged Windows smoke: the
    // smoke itself only runs on Windows, but its MSI-selection and
    // PID-ownership logic is safety-critical and must be verified on every OS.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
  },
});
