import { describe, expect, it } from "vitest";
import type { InventoryV1 } from "./contracts.js";
import { inventoryV1Schema, repositoryRelativePathSchema } from "./contracts.js";
import { discoverProgrammaticOpportunities } from "./opportunities.js";
import { GENERATED_PATHS } from "../tauri-package/paths.js";

const CANONICAL_ROOT = ["package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"];
const CANONICAL_APP = CANONICAL_ROOT.map((path) => `apps/desktop/${path}`);
const UNSUPPORTED_APP = [
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/Tauri.toml",
  "apps/desktop/src-tauri/tauri.conf.toml",
];

function inventory(paths: readonly string[], hash = "a"): InventoryV1 {
  return inventoryV1Schema.parse({
    version: 1,
    configurationFingerprint: { version: 1, sha256: hash.repeat(64) },
    scanners: [],
    entries: [...paths]
      .sort()
      .map((path, index) => ({ path, sha256: (index % 2 ? "b" : hash).repeat(64) })),
  });
}

describe("discoverProgrammaticOpportunities", () => {
  it("emits complete routable Tauri packaging evidence", () => {
    const result = discoverProgrammaticOpportunities(inventory(CANONICAL_ROOT));

    expect(result.version).toBe(1);
    expect(result.opportunities).toHaveLength(1);
    const opportunity = result.opportunities[0]!;
    expect(opportunity).toMatchObject({
      version: 1,
      representativeCase: "src-tauri/tauri.conf.json",
      confidence: "medium",
      route: { status: "routable", specialistCommand: "setup-tauri-package" },
      identity: {
        version: 1,
        detectorId: "tauri-package-shape",
        key: "canonical-tauri-package",
        path: "package.json",
      },
    });
    expect(opportunity.identity.id).toMatch(/^[a-f0-9]{64}$/);
    expect(opportunity.repeatableTrigger).toBeTruthy();
    expect(opportunity.currentProcess).toBeTruthy();
    expect(opportunity.expectedOutput).toBeTruthy();
    expect(opportunity.verification).toBeTruthy();
    expect(opportunity.risks.length).toBeGreaterThan(0);
    expect(opportunity.mutationPaths).toEqual([
      ".gg/commands/package-tauri.md",
      "scripts/package-tauri.config.json",
      "scripts/package-tauri.mjs",
      "scripts/package-tauri.test.mjs",
      "scripts/smoke-tauri-package.mjs",
      "scripts/smoke-tauri-package.test.mjs",
    ]);
    expect(opportunity.evidence.items).toHaveLength(3);
    for (const item of opportunity.evidence.items) {
      expect(item.basis).toBe("observed");
      expect(item.location).toBeDefined();
      expect(repositoryRelativePathSchema.safeParse(item.location!.path).success).toBe(true);
    }
  });

  it.each([
    ["repository", [...GENERATED_PATHS]],
    ["app", GENERATED_PATHS.map((path) => `apps/desktop/${path}`)],
  ])("retains %s-root generated path ownership", (_owner, generatedPaths) => {
    const result = discoverProgrammaticOpportunities(
      inventory([...CANONICAL_APP, ...generatedPaths]),
    );

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]!.mutationPaths).toEqual([...generatedPaths].sort());
  });

  it("marks simultaneous repository and app ownership unroutable", () => {
    const appGeneratedPaths = GENERATED_PATHS.map((path) => `apps/desktop/${path}`);
    const result = discoverProgrammaticOpportunities(
      inventory([...CANONICAL_APP, ...GENERATED_PATHS, ...appGeneratedPaths]),
    );

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({ route: { status: "unroutable" } });
    expect(result.opportunities[0]!.mutationPaths).toEqual(
      [...GENERATED_PATHS, ...appGeneratedPaths].sort(),
    );
  });

  it("marks split generated-path ownership unroutable", () => {
    const splitPaths = [
      ...GENERATED_PATHS.slice(0, 3),
      ...GENERATED_PATHS.slice(3).map((path) => `apps/desktop/${path}`),
    ];
    const result = discoverProgrammaticOpportunities(inventory([...CANONICAL_APP, ...splitPaths]));

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({ route: { status: "unroutable" } });
  });

  describe("covers duplicate suppression, weak-evidence rejection, stable IDs, deterministic ordering, and unsupported routes", () => {
    it("marks unsupported candidates unroutable without prompts", () => {
      const result = discoverProgrammaticOpportunities(inventory(UNSUPPORTED_APP));

      expect(result.opportunities).toHaveLength(1);
      expect(result.opportunities[0]).toMatchObject({
        representativeCase: "apps/desktop/src-tauri/Tauri.toml",
        confidence: "low",
        route: { status: "unroutable" },
        identity: {
          detectorId: "unsupported-tauri-config-shape",
          key: "unsupported-tauri-config",
          path: "apps/desktop/package.json",
        },
      });
      expect(
        result.opportunities[0]!.evidence.items.filter(
          ({ code }) => code === "unsupported-tauri-config",
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('"prompt"');
      expect(JSON.stringify(result)).not.toContain("implementationPrompt");
    });

    it.each([
      ["package manifest", CANONICAL_ROOT.filter((path) => path !== "package.json")],
      ["Cargo manifest", CANONICAL_ROOT.filter((path) => path !== "src-tauri/Cargo.toml")],
      ["Tauri configuration", CANONICAL_ROOT.filter((path) => !path.endsWith("tauri.conf.json"))],
      ["explicit Tauri shape", ["package.json", "Cargo.toml", ".github/workflows/ci.yml"]],
    ])("rejects a shape missing %s", (_missing, paths) => {
      expect(discoverProgrammaticOpportunities(inventory(paths)).opportunities).toEqual([]);
    });

    it("keeps IDs and ordering stable across rescans and unrelated changes", () => {
      const baseline = discoverProgrammaticOpportunities(inventory(CANONICAL_ROOT));
      const unrelated = discoverProgrammaticOpportunities(
        inventory([...CANONICAL_ROOT, "README.md", "src/index.ts"], "c"),
      );
      const rescanned = discoverProgrammaticOpportunities(inventory(CANONICAL_ROOT, "d"));
      const mixedPaths = [...CANONICAL_ROOT, ...UNSUPPORTED_APP];
      const mixed = discoverProgrammaticOpportunities(inventory(mixedPaths));
      const mixedRescan = discoverProgrammaticOpportunities(inventory(mixedPaths, "e"));
      const mixedIds = mixed.opportunities.map(({ identity }) => identity.id);

      expect(unrelated.opportunities[0]!.identity.id).toBe(baseline.opportunities[0]!.identity.id);
      expect(rescanned).toEqual(baseline);
      expect(mixedIds).toEqual([...mixedIds].sort());
      expect(mixedRescan.opportunities.map(({ identity }) => identity.id)).toEqual(mixedIds);
    });
  });

  it("serializes no prompts, source contents, inventory hashes, or invented evidence paths", () => {
    const sourceHash = "a".repeat(64);
    const fingerprint = "f".repeat(64);
    const sourceInventory = inventoryV1Schema.parse({
      ...inventory(CANONICAL_ROOT),
      configurationFingerprint: { version: 1, sha256: fingerprint },
      entries: inventory(CANONICAL_ROOT).entries.map((entry) => ({ ...entry, sha256: sourceHash })),
    });
    const result = discoverProgrammaticOpportunities(sourceInventory);
    const serialized = JSON.stringify(result);
    const inventoryPaths = new Set(sourceInventory.entries.map(({ path }) => path));

    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain("implementationPrompt");
    expect(serialized).not.toContain(sourceHash);
    expect(serialized).not.toContain(fingerprint);
    for (const opportunity of result.opportunities) {
      expect(inventoryPaths.has(opportunity.representativeCase)).toBe(true);
      for (const item of opportunity.evidence.items) {
        if (item.location) expect(inventoryPaths.has(item.location.path)).toBe(true);
      }
    }
  });

  it("fails closed for malformed inventories", () => {
    const valid = inventory(CANONICAL_ROOT);
    const malformed = [
      { ...valid, entries: [...valid.entries].reverse() },
      { ...valid, entries: [{ path: "../package.json", sha256: "a".repeat(64) }] },
      { ...valid, entries: [{ ...valid.entries[0], content: "untrusted source" }] },
    ];

    for (const value of malformed) {
      expect(() => discoverProgrammaticOpportunities(value as InventoryV1)).toThrow();
    }
  });
});
