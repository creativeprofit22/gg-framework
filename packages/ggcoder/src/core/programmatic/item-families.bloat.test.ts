import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFile(new URL(name, import.meta.url), "utf8");

describe("item families touched-files bloat audit", () => {
  it("keeps the detector pure, path-only, language-agnostic, and single-owner", async () => {
    const families = await read("./item-families.ts");
    const imports = [...families.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

    expect([...new Set(imports)].sort()).toEqual(["../tauri-package/paths.js", "./contracts.js"]);
    expect(families.match(/^export /gm)).toHaveLength(5);
    expect(families).toMatch(
      /export function detectProgrammaticItemFamilies\(inventory: InventoryV1\): ProgrammaticItemFamiliesV1/,
    );
    expect(families).not.toMatch(
      /node:|\breadFile\b|\breaddir\b|\bstat\s*\(|\bspawn\b|(?<!\.)\bexec(?:File|Sync)?\b|child_process|\bfetch\s*\(|https?:\/\//,
    );
    expect(families).not.toMatch(
      /fast-glob|minimatch|gitignore|\bignore\(|sourceContent|levenshtein|minhash|shingle|tf-?idf|embedding/i,
    );
    // No language or framework allowlist: no extension literals or ecosystem names.
    const body = families.replace(/^import .*$/gm, "");
    expect(body).not.toMatch(
      /"[^"]*\.(?:py|rs|tsx?|jsx?|go|java|rb|md|json|toml|ya?ml)"|python|\brust\b|cargo|\bnpm\b|node_modules|vendor/i,
    );

    const directory = new URL("./", import.meta.url);
    const sources = (await fs.readdir(directory)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const definitions = await Promise.all(
      sources.map(async (name) => ({
        name,
        text: await read(`./${name}`),
      })),
    );
    expect(
      definitions
        .filter(({ text }) => /function detectProgrammaticItemFamilies\b/.test(text))
        .map(({ name }) => name),
    ).toEqual(["item-families.ts"]);

    // Advisory only: never feeds scanner findings, routes, lifecycle or inventory/fingerprints.
    for (const name of ["opportunities.ts", "routes.ts", "lifecycle.ts", "inventory.ts"]) {
      expect(await read(`./${name}`)).not.toMatch(/item-families|detectProgrammaticItemFamilies/);
    }
  });
});
