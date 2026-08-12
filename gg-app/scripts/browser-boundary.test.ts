import { build, mergeConfig } from "vite";
import { describe, expect, it } from "vitest";
import viteConfig, { rejectBrowserNodeBuiltins } from "../vite.config";

describe("browser boundary", () => {
  it(
    "builds the application graph without Node builtins",
    async () => {
      const resolvedConfig = await viteConfig({ command: "build", mode: "test" });

      await expect(
        build(
          mergeConfig(resolvedConfig, {
            configFile: false,
            logLevel: "silent",
            plugins: [rejectBrowserNodeBuiltins()],
            build: {
              write: false,
            },
          }),
        ),
      ).resolves.toBeDefined();
    },
    30_000,
  );
});
