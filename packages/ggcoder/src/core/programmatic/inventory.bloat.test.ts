import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("inventory touched-files bloat audit", () => {
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
