import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Git and PowerShell integration fixtures contend heavily on Windows.
    // Four workers preserves parallel coverage without violating hard deadlines.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/update-with-local-fixes.test.ts",
      "scripts/build-local-hotfix.test.ts",
      "scripts/smoke-packaged-windows.test.mjs",
      "scripts/workspace-shell-evidence.test.mjs",
    ],
  },
});
