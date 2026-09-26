import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("inventory touched-files bloat audit", () => {
  it("keeps assessment evidence and context read-only and separate from fingerprint/lifecycle owners", async () => {
    const [evidence, context] = await Promise.all([
      fs.readFile(new URL("./assessment-evidence.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./advisory-context.ts", import.meta.url), "utf8"),
    ]);
    expect(evidence).toContain('from "./inventory.js"');
    expect(context).toContain('from "./assessment-evidence.js"');
    for (const source of [evidence, context]) {
      expect(source).not.toMatch(/child_process|\bspawn\b|\bexec(?:File|Sync)?\b|writeFile|appendFile|buildProgrammaticInventory|fingerprintConfigurationSnapshot|reconcileProgrammaticLifecycle|runProgrammaticScan/);
      expect(source).not.toMatch(/from ["'].*(?:profile|lifecycle|agent-session|provider)[^"']*["']/);
    }
  });
  it("reuses existing scan helpers without execution or indexing surfaces", async () => {
    const [source, manifestText] = await Promise.all([
      fs.readFile(new URL("./inventory.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies).toHaveProperty("fast-glob");
    expect(manifest.dependencies).toHaveProperty("ignore");
    expect(source).toContain('from "../tauri-package/paths.js"');
    expect(source).toContain('from "../../tools/gitignore.js"');
    expect(source).not.toMatch(
      /child_process|\bspawn\b|\bexec(?:File|Sync)?\b|writeFile|appendFile|model|opportunit|indexing/,
    );
  });
});
