import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
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
