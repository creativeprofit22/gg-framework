import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe(
  "A touched-files-only bloat audit confirms routing does not duplicate slash parsing, custom loading, or specialist prompt bodies.",
  () => {
  it("keeps one bounded resolver without execution, prompt, loader, dependency, or lifecycle growth", async () => {
    const [routes, profile, lifecycle, names] = await Promise.all([
      fs.readFile(new URL("./routes.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./profile.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./lifecycle.ts", import.meta.url), "utf8"),
      fs.readdir(new URL(".", import.meta.url)),
    ]);
    const externalImports = [...routes.matchAll(/from\s+"([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((specifier) => !specifier.startsWith("."));

    expect(externalImports).toEqual([]);
    expect(routes.match(/loadCustomCommands\(/g)).toHaveLength(1);
    expect(routes.match(/export const SPECIALIST_ROUTES/g)).toHaveLength(1);
    expect(profile.match(/resolveProgrammaticRoutes\(/g)).toHaveLength(1);
    expect(lifecycle.match(/resolveProgrammaticRoutes\(/g)).toHaveLength(1);
    expect(names.filter((name) => /^routes(?:[-_.]v?\d+|[-_]variant)\.ts$/i.test(name))).toEqual([]);
    expect(routes).not.toMatch(
      /node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b|\beval\s*\(|new Function|\bfetch\s*\(/,
    );
    expect(routes).not.toMatch(
      /node:fs|\breadFile\b|\breaddir\b|\.gg[\\/]commands|implementationPrompt|promptTemplate|fallbackPrompt/,
    );
    expect(routes).not.toMatch(
      /programmaticLifecycle|reconcileProgrammaticLifecycle|STATE_PATH|\.lifecycle\b|\bqueued\b|\brunning\b|\bcompleted\b|\bdismissed\b/,
    );
  });
  },
);
