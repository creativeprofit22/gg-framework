import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InventoryV1 } from "./contracts.js";
import { inventoryV1Schema } from "./contracts.js";
import { buildProgrammaticInventory, normalizeInventoryPath } from "./inventory.js";
import type { ItemFamilyV1, ProgrammaticItemFamiliesV1 } from "./item-families.js";
import { detectProgrammaticItemFamilies, ITEM_FAMILY_LIMITS } from "./item-families.js";
import { stableJson } from "../tauri-package/paths.js";

const SETUP_NAMES = new Set(["Cargo.toml", "package.json", "pyproject.toml"]);

/** Setup files are listed by hash (no size), like the real inventory; others by size. */
function inventory(paths: readonly string[]): InventoryV1 {
  return inventoryV1Schema.parse({
    version: 1,
    configurationFingerprint: { version: 1, sha256: "a".repeat(64) },
    scanners: [],
    entries: [...paths]
      .sort()
      .map((entryPath) =>
        SETUP_NAMES.has(entryPath.split("/").at(-1) ?? "")
          ? { path: entryPath, sha256: "b".repeat(64) }
          : { path: entryPath, bytes: entryPath.length },
      ),
  });
}

/** `{name}` in a file template is replaced by the member directory name. */
function tree(parent: string, members: readonly string[], files: readonly string[]): string[] {
  return members.flatMap((member) =>
    files.map((file) => `${parent}/${member}/${file.replaceAll("{name}", member)}`),
  );
}

function letters(index: number): string {
  return String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
}

function only(result: ProgrammaticItemFamiliesV1, kind: ItemFamilyV1["kind"]): ItemFamilyV1[] {
  return result.families.filter((family) => family.kind === kind);
}

function directoryFamily(result: ProgrammaticItemFamiliesV1, parent: string) {
  const family = result.families.find(
    (item) => item.kind === "sibling-directories" && item.parent === parent,
  );
  if (family?.kind !== "sibling-directories") throw new Error(`no family under ${parent}`);
  return family;
}

const PYTHON_PLUGINS = [
  "pyproject.toml",
  "plugins/README.md",
  ...tree(
    "plugins",
    ["paypal", "square", "stripe"],
    ["__init__.py", "client.py", "tests/test_{name}.py"],
  ),
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("detectProgrammaticItemFamilies", () => {
  it("groups Python plugin folders and states shape, thresholds and limits", () => {
    const result = detectProgrammaticItemFamilies(inventory(PYTHON_PLUGINS));

    expect(result).toMatchObject({
      version: 1,
      basis: "observed-paths",
      nameToken: "{name}",
      thresholds: { minMembers: 3, minShapeFiles: 2, minSimilarityPercent: 60 },
      limits: { maxFamilies: 12, maxMembersPerFamily: 12, maxPathChars: 160 },
      omitted: { families: 0, members: 0, longPaths: 0, oversizedMembers: 0, listTruncations: 0 },
    });
    expect(result.families).toHaveLength(1);
    const family = directoryFamily(result, "plugins");
    expect(family.id).toMatch(/^[a-f0-9]{16}$/);
    expect(family.shape).toEqual(["__init__.py", "client.py", "tests/test_{name}.py"]);
    expect(family.shapeFileCount).toBe(3);
    expect(family.members.map((member) => member.path)).toEqual([
      "plugins/paypal",
      "plugins/square",
      "plugins/stripe",
    ]);
    for (const member of family.members) {
      const files = PYTHON_PLUGINS.filter((file) => file.startsWith(`${member.path}/`));
      expect(member).toEqual({
        path: member.path,
        fileCount: 3,
        bytes: files.reduce((total, file) => total + file.length, 0),
        unsizedFiles: 0,
        similarityPercent: 100,
        missing: [],
        missingCount: 0,
        extra: [],
        extraCount: 0,
      });
    }
  });

  it("groups Rust crates, reporting extra files and unsized setup files", () => {
    const result = detectProgrammaticItemFamilies(
      inventory([
        "Cargo.toml",
        ...tree("crates", ["alpha", "beta", "gamma"], ["Cargo.toml", "src/lib.rs", "tests/it.rs"]),
        "crates/gamma/src/extra.rs",
      ]),
    );

    expect(result.families).toHaveLength(1);
    const family = directoryFamily(result, "crates");
    expect(family.shape).toEqual(["Cargo.toml", "src/lib.rs", "tests/it.rs"]);
    const gamma = family.members.find((member) => member.path === "crates/gamma");
    expect(gamma).toMatchObject({
      fileCount: 4,
      unsizedFiles: 1,
      similarityPercent: 75,
      extra: ["src/extra.rs"],
      extraCount: 1,
      missing: [],
    });
    expect(gamma?.bytes).toBe(
      "crates/gamma/src/lib.rs".length +
        "crates/gamma/tests/it.rs".length +
        "crates/gamma/src/extra.rs".length,
    );
  });

  it("finds a numbered Markdown series as a file-name pattern", () => {
    const result = detectProgrammaticItemFamilies(
      inventory([
        "README.md",
        "docs/adr/0001-record-decisions.md",
        "docs/adr/0002-use-pnpm.md",
        "docs/adr/0003-split-daemon.md",
        "docs/adr/README.md",
        "docs/guide.md",
      ]),
    );

    expect(result.families).toEqual([
      {
        id: expect.stringMatching(/^[a-f0-9]{16}$/),
        kind: "file-name-pattern",
        parent: "docs/adr",
        pattern: "#*.md",
        memberCount: 3,
        members: [
          { path: "docs/adr/0001-record-decisions.md", bytes: 33 },
          { path: "docs/adr/0002-use-pnpm.md", bytes: 25 },
          { path: "docs/adr/0003-split-daemon.md", bytes: 29 },
        ],
      },
    ]);
  });

  it("groups JSON config folders and compound-suffix schema files", () => {
    const result = detectProgrammaticItemFamilies(
      inventory([
        ...tree("config", ["dev", "prod", "staging"], ["app.json", "db.json"]),
        "schemas/item.schema.json",
        "schemas/order.schema.json",
        "schemas/user.schema.json",
        "schemas/index.json",
      ]),
    );

    expect(result.families).toHaveLength(2);
    expect(directoryFamily(result, "config")).toMatchObject({
      shape: ["app.json", "db.json"],
      memberCount: 3,
    });
    expect(only(result, "file-name-pattern")).toEqual([
      expect.objectContaining({ parent: "schemas", pattern: "*.schema.json", memberCount: 3 }),
    ]);
  });

  it("separates the matching packages of a mixed monorepo from unrelated ones", () => {
    const result = detectProgrammaticItemFamilies(
      inventory([
        "package.json",
        "pnpm-workspace.yaml",
        ...tree(
          "packages",
          ["api", "cli", "web"],
          ["package.json", "README.md", "src/index.ts", "tsconfig.json"],
        ),
        "packages/docs/package.json",
        "packages/docs/mkdocs.yml",
        "packages/docs/pages/index.md",
        "crates/core/Cargo.toml",
        "crates/core/src/lib.rs",
        "python/pyproject.toml",
        "python/worker.py",
      ]),
    );

    expect(result.families).toHaveLength(1);
    const family = directoryFamily(result, "packages");
    expect(family.members.map((member) => member.path)).toEqual([
      "packages/api",
      "packages/cli",
      "packages/web",
    ]);
    expect(family.shape).toEqual(["README.md", "package.json", "src/index.ts", "tsconfig.json"]);
  });

  it("keeps near-miss members above the threshold and drops chain drift below it", () => {
    const result = detectProgrammaticItemFamilies(
      inventory([
        ...tree("modules", ["alpha", "bravo", "charlie"], ["a.txt", "b.txt", "c.txt"]),
        // 3/5 = 60% of the shape: kept as a near miss.
        ...tree("modules", ["delta"], ["a.txt", "b.txt", "c.txt", "x.txt", "y.txt"]),
        // Similar to delta only (66%), 33% of the shape: dropped after refinement.
        ...tree("modules", ["echo"], ["a.txt", "b.txt", "x.txt", "y.txt", "z.txt"]),
        // Shares one file: never joined.
        ...tree("modules", ["foxtrot"], ["a.txt", "notes.md", "other.md"]),
      ]),
    );

    const family = directoryFamily(result, "modules");
    expect(family.shape).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(family.members.map((member) => member.path)).toEqual([
      "modules/alpha",
      "modules/bravo",
      "modules/charlie",
      "modules/delta",
    ]);
    expect(family.members.at(-1)).toMatchObject({
      similarityPercent: 60,
      extra: ["x.txt", "y.txt"],
      extraCount: 2,
    });
  });

  it("reports missing shape files for a member", () => {
    const result = detectProgrammaticItemFamilies(
      inventory([
        ...tree("services", ["auth", "billing", "search"], ["a.go", "b.go", "c.go", "d.go"]),
        ...tree("services", ["mail"], ["a.go", "b.go", "c.go"]),
      ]),
    );

    const mail = directoryFamily(result, "services").members.find(
      (member) => member.path === "services/mail",
    );
    expect(mail).toMatchObject({ missing: ["d.go"], missingCount: 1, similarityPercent: 75 });
  });

  it("finds no family for a lone item or a two-member near miss", () => {
    expect(
      detectProgrammaticItemFamilies(
        inventory(
          tree("plugins", ["stripe"], ["__init__.py", "client.py", "tests/test_{name}.py"]),
        ),
      ).families,
    ).toEqual([]);
    expect(
      detectProgrammaticItemFamilies(
        inventory([
          ...tree("plugins", ["paypal", "stripe"], ["__init__.py", "client.py"]),
          "src/app.ts",
          "src/main.ts",
          "src/util.ts",
        ]),
      ).families,
    ).toEqual([]);
  });

  it("does not treat ordinary single-extension siblings as a family", () => {
    expect(
      detectProgrammaticItemFamilies(
        inventory(["src/app.ts", "src/main.ts", "src/util.ts", "src/view.ts"]),
      ).families,
    ).toEqual([]);
  });

  it("caps a very large family and counts every omission", () => {
    const shapeFiles = [
      ...Array.from({ length: 30 }, (_, index) => `file-${letters(index)}.ts`),
      `${"long-name-".repeat(17)}.ts`,
    ];
    const members = Array.from({ length: 20 }, (_, index) => `i${String(index).padStart(2, "0")}`);
    const extras = Array.from({ length: 8 }, (_, index) => `extra-${letters(index)}.ts`);
    const result = detectProgrammaticItemFamilies(
      inventory([
        ...tree("integrations", members, shapeFiles),
        ...tree("integrations", ["i00"], extras),
      ]),
    );

    const family = directoryFamily(result, "integrations");
    expect(family.memberCount).toBe(20);
    expect(family.members).toHaveLength(ITEM_FAMILY_LIMITS.maxMembersPerFamily);
    expect(family.shapeFileCount).toBe(31);
    expect(family.shape).toHaveLength(ITEM_FAMILY_LIMITS.maxShapePaths);
    expect(family.shape.every((item) => item.length <= ITEM_FAMILY_LIMITS.maxPathChars)).toBe(true);
    expect(family.members[0]).toMatchObject({
      path: "integrations/i00",
      extra: extras.slice(0, ITEM_FAMILY_LIMITS.maxDiffPathsPerMember),
      extraCount: 8,
      similarityPercent: 79,
    });
    expect(result.omitted).toEqual({
      families: 0,
      members: 8,
      longPaths: 1,
      // The `integrations` folder itself holds 628 files, too many to be a member.
      oversizedMembers: 1,
      listTruncations: 2,
    });
  });

  it("skips oversized directories and caps pattern members", () => {
    const files = Array.from({ length: 257 }, (_, index) => `bulk/data/n${index}.bin`);
    const result = detectProgrammaticItemFamilies(inventory(files));

    expect(result.omitted.oversizedMembers).toBe(2);
    expect(result.families).toHaveLength(1);
    expect(result.families[0]).toMatchObject({
      kind: "file-name-pattern",
      pattern: "n#*.bin",
      memberCount: 257,
    });
    expect(result.families[0]?.members).toHaveLength(ITEM_FAMILY_LIMITS.maxMembersPerFamily);
    expect(result.omitted.members).toBe(257 - ITEM_FAMILY_LIMITS.maxMembersPerFamily);
  });

  it("drops whole lowest-ranked families to stay under the serialized size cap", () => {
    const shapeFiles = Array.from(
      { length: 24 },
      (_, index) => `${"segment-".repeat(17)}${letters(index)}.ts`,
    );
    const parents = Array.from({ length: 15 }, (_, index) => `area-${letters(index)}`);
    const result = detectProgrammaticItemFamilies(
      inventory(parents.flatMap((parent) => tree(parent, ["alpha", "beta", "gamma"], shapeFiles))),
    );

    expect(Buffer.byteLength(stableJson(result))).toBeLessThanOrEqual(
      ITEM_FAMILY_LIMITS.maxSerializedBytes,
    );
    expect(result.families.length).toBeGreaterThan(0);
    expect(result.families.length).toBeLessThan(ITEM_FAMILY_LIMITS.maxFamilies);
    // 15 area families plus one root family of the identically shaped area folders.
    expect(result.omitted.families).toBe(16 - result.families.length);
    // Ranked by member count, then id: the 15-member root family first.
    expect(result.families[0]).toMatchObject({ parent: ".", memberCount: 15 });
    const ids = result.families.slice(1).map((family) => family.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("ignores host programmatic files", () => {
    expect(
      detectProgrammaticItemFamilies(
        inventory(tree(".gg/programmatic", ["one", "two", "six"], ["a.json", "b.json"])),
      ).families,
    ).toEqual([]);
  });

  it("respects inventory ignore and vendor exclusions on a real tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-item-families-"));
    temporaryDirectories.push(root);
    const files = [
      ...tree(
        "plugins",
        ["paypal", "square", "stripe"],
        ["__init__.py", "client.py", "tests/test_{name}.py"],
      ),
      ...tree("node_modules", ["left", "right", "center"], ["index.js", "lib/util.js"]),
      ...tree("vendor", ["left", "right", "center"], ["index.go", "lib/util.go"]),
      ...tree("generated", ["left", "right", "center"], ["index.ts", "lib/util.ts"]),
    ];
    await fs.writeFile(path.join(root, ".gitignore"), "generated/\n");
    for (const file of files) {
      const absolutePath = path.join(root, ...file.split("/"));
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "x\n");
    }

    const { inventory: built } = await buildProgrammaticInventory(root);
    const result = detectProgrammaticItemFamilies(built);

    expect(result.families.map((family) => [family.kind, family.parent])).toEqual([
      ["sibling-directories", "plugins"],
    ]);
  });

  it("gives Windows-separated paths the same result and rejects raw backslash paths", () => {
    const posix = detectProgrammaticItemFamilies(inventory(PYTHON_PLUGINS));
    const windows = detectProgrammaticItemFamilies(
      inventory(
        PYTHON_PLUGINS.map((file) => normalizeInventoryPath(file.replaceAll("/", "\\"), "\\")),
      ),
    );
    expect(stableJson(windows)).toBe(stableJson(posix));

    const raw: InventoryV1 = {
      version: 1,
      configurationFingerprint: { version: 1, sha256: "a".repeat(64) },
      scanners: [],
      entries: [{ path: "plugins\\stripe\\client.py", bytes: 1 }],
    };
    expect(() => detectProgrammaticItemFamilies(raw)).toThrow();
  });

  it("is byte-identical across repeated identical rescans", () => {
    const first = stableJson(detectProgrammaticItemFamilies(inventory(PYTHON_PLUGINS)));
    const second = stableJson(detectProgrammaticItemFamilies(inventory([...PYTHON_PLUGINS])));
    expect(second).toBe(first);
  });

  it("keeps family ids stable when unrelated files change elsewhere", () => {
    const before = directoryFamily(
      detectProgrammaticItemFamilies(inventory(PYTHON_PLUGINS)),
      "plugins",
    );
    const after = detectProgrammaticItemFamilies(
      inventory([
        ...PYTHON_PLUGINS,
        "docs/notes.md",
        ...tree("config", ["dev", "prod", "staging"], ["app.json", "db.json"]),
        ...tree("plugins", ["adyen"], ["__init__.py", "client.py", "tests/test_{name}.py"]),
      ]),
    );
    expect(after.families).toHaveLength(2);
    expect(directoryFamily(after, "plugins").id).toBe(before.id);
    expect(directoryFamily(after, "plugins").memberCount).toBe(4);
  });
});
