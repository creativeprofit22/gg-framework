import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("opportunity discovery touched-files bloat audit", () => {
  it("keeps discovery pure, fixed, dependency-free, and prompt-free", async () => {
    const [contracts, opportunities] = await Promise.all([
      fs.readFile(new URL("./contracts.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./opportunities.ts", import.meta.url), "utf8"),
    ]);
    const imports = [...`${contracts}\n${opportunities}`.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1]!,
    );

    expect(
      imports.filter((specifier) => !specifier.startsWith(".") && specifier !== "node:path"),
    ).toEqual(["zod"]);
    expect(opportunities).toContain("GENERATED_PATHS");
    expect(
      opportunities.match(/^function detect(?:CanonicalTauri|UnsupportedTauriConfig)\(/gm),
    ).toHaveLength(2);
    expect(opportunities).toContain(
      "const PATH_FACT_DETECTORS = [\n  detectCanonicalTauri,\n  detectUnsupportedTauriConfig,\n] as const",
    );
    expect(opportunities.match(/^export /gm)).toHaveLength(1);
    expect(opportunities).toMatch(
      /discoverProgrammaticOpportunities\(\s*inventory: InventoryV1,\s*\): OpportunityDiscoveryResultV1/,
    );
    expect(opportunities).not.toMatch(
      /node:fs|node:child_process|\breadFile\b|\bwriteFile\b|\bappendFile\b|\bspawn\b|\bexec(?:File|Sync)?\b|\bfetch\s*\(|https?:\/\//,
    );
    expect(opportunities).not.toMatch(
      /\bprompt\b|implementationPrompt|\bmodel\b|roadmap|\btasks?\b|register|plugin|userProvided|sourceContent/i,
    );
    expect(opportunities).not.toMatch(
      /CONFIG_FILE_NAMES|CONFIG_FILE_PATTERN|FIXED_EXCLUSIONS|fast-glob|gitignore|InventoryOperations/,
    );
    expect(`${contracts}\n${opportunities}`).not.toMatch(/from\s+"(?:axios|execa|glob|openai)"/);
  });
});
