import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    globalSetup: ["../scripts/test-support/run-temp.mjs"],
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/renderer/src/test-setup.ts"],
  },
});
