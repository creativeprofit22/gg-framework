import { describe, expect, it } from "vitest";
import type { InventoryV1 } from "./contracts.js";
import { inventoryV1Schema } from "./contracts.js";
import { normalizeInventoryPath } from "./inventory.js";
import {
  AREA_MAP_LIMITS,
  assignProgrammaticAreas,
  buildProgrammaticAreaMap,
  type AreaManifestFacts,
  type ProgrammaticAreaMapV1,
} from "./area-map.js";
import { stableJson } from "../tauri-package/paths.js";

const SETUP_NAMES = new Set([
  "Cargo.toml",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "pnpm-workspace.yaml",
]);

function inventory(paths: readonly string[]): InventoryV1 {
  return inventoryV1Schema.parse({
    version: 1,
    configurationFingerprint: { version: 1, sha256: "a".repeat(64) },
    scanners: [],
    entries: [...new Set(paths)]
      .sort()
      .map((entryPath) =>
        SETUP_NAMES.has(entryPath.split("/").at(-1) ?? "")
          ? { path: entryPath, sha256: "b".repeat(64) }
          : { path: entryPath, bytes: entryPath.length },
      ),
  });
}

function files(dir: string, count: number, name = (index: number) => `f${index}.ts`): string[] {
  return Array.from({ length: count }, (_, index) => `${dir}/${name(index)}`);
}

function manifest(path: string, facts: Partial<AreaManifestFacts> = {}): AreaManifestFacts {
  return {
    path,
    scriptNames: [],
    dependencyNames: [],
    scriptText: "",
    workspacePatterns: [],
    ...facts,
  };
}

function areaFor(map: ProgrammaticAreaMapV1, path: string) {
  const id = assignProgrammaticAreas(map, [path]).get(path);
  return map.areas.find((area) => area.id === id);
}

/** Every inventory file resolves to exactly one existing area and counts add up. */
function expectPartition(map: ProgrammaticAreaMapV1, paths: readonly string[]) {
  const assigned = assignProgrammaticAreas(map, paths);
  const ids = new Set(map.areas.map((area) => area.id));
  const counts = new Map<string, number>();
  for (const id of assigned.values()) {
    expect(id).not.toBeNull();
    expect(ids.has(id ?? "")).toBe(true);
    counts.set(id ?? "", (counts.get(id ?? "") ?? 0) + 1);
  }
  for (const area of map.areas)
    if (area.kind !== "cross-area") expect(counts.get(area.id)).toBe(area.fileCount);
  expect(map.areas.reduce((sum, area) => sum + area.fileCount, 0)).toBe(paths.length);
  expect(map.fileCount).toBe(paths.length);
  expect(map.areas.filter((area) => area.kind === "cross-area")).toHaveLength(1);
}

function monorepo() {
  const paths = [
    "package.json",
    "pnpm-workspace.yaml",
    "README.md",
    ".github/workflows/ci.yml",
    ".gg/commands/ship.md",
    "packages/core/package.json",
    ...files("packages/core/src", 6),
    "packages/cli/package.json",
    ...files("packages/cli/src", 6),
    "packages/world/package.json",
    ...files("packages/world/src", 6),
    "app/package.json",
    ...files("app/src", 6, (index) => `view${index}.tsx`),
    "app/src-tauri/Cargo.toml",
    ...files("app/src-tauri/src", 6, (index) => `m${index}.rs`),
    "Matey/package.json",
    ...files("Matey/src", 6),
  ];
  const manifests = [
    manifest("package.json", {
      scriptNames: ["build", "test", "lint"],
      scriptText: "pnpm -r build\nvitest\neslint . && node Matey/check.mjs",
    }),
    manifest("pnpm-workspace.yaml", { workspacePatterns: ["packages/*", "app", "Matey"] }),
    manifest("packages/core/package.json", { packageName: "@x/core", scriptNames: ["build"] }),
    manifest("packages/cli/package.json", {
      packageName: "@x/cli",
      scriptNames: ["build"],
      dependencyNames: ["@x/core"],
    }),
    manifest("packages/world/package.json", { packageName: "@x/world" }),
    manifest("app/package.json", {
      packageName: "app",
      scriptNames: ["build", "dev"],
      scriptText: "node ../packages/world/build.mjs && vite build\nvite",
    }),
    manifest("Matey/package.json", { packageName: "matey", scriptNames: ["dev"] }),
  ];
  return { paths, manifests };
}

describe("buildProgrammaticAreaMap", () => {
  it("maps a pnpm monorepo into member, nested package, cross and low-signal areas", () => {
    const { paths, manifests } = monorepo();
    const map = buildProgrammaticAreaMap({
      inventory: inventory(paths),
      manifests,
      workflows: [{ path: ".github/workflows/ci.yml", jobIds: ["test", "build"] }],
    });
    expectPartition(map, paths);
    const cross = map.areas[0];
    expect(cross?.kind).toBe("cross-area");
    expect(cross?.id).toBe("cross-area");
    expect(areaFor(map, "README.md")).toBe(cross);
    expect(areaFor(map, ".gg/commands/ship.md")).toBe(cross);
    expect(cross?.signals.scripts).toEqual(["build", "lint", "test"]);
    expect(cross?.signals.ciJobs).toEqual(["ci.yml:build", "ci.yml:test"]);
    expect(cross?.signals.commandFiles).toBe(1);

    const core = areaFor(map, "packages/core/src/f0.ts");
    expect(core).toMatchObject({
      kind: "workspace-member",
      packageName: "@x/core",
      include: ["packages/core/**"],
      lowSignal: null,
    });
    const tauri = areaFor(map, "app/src-tauri/src/m0.rs");
    expect(tauri).toMatchObject({ kind: "package", include: ["app/src-tauri/**"] });
    const app = areaFor(map, "app/src/view0.tsx");
    expect(app?.exclude).toEqual(["app/src-tauri/**"]);
    expect(areaFor(map, "packages/world/src/f0.ts")?.lowSignal).toBeNull();

    const matey = areaFor(map, "Matey/src/f0.ts");
    expect(matey?.lowSignal?.reason).toMatch(/root scripts alone do not count/);
    expect(map.areas.at(-1)).toBe(matey);
    expect(map.note).toMatch(/not scanner findings, settings or permission/);
    expect(Buffer.byteLength(stableJson(map))).toBeLessThanOrEqual(
      AREA_MAP_LIMITS.maxSerializedBytes,
    );
  });

  it("maps a single package by folders", () => {
    const paths = ["package.json", ...files("src", 10), ...files("test", 6)];
    const map = buildProgrammaticAreaMap({
      inventory: inventory(paths),
      manifests: [manifest("package.json", { packageName: "solo", scriptNames: ["test"] })],
    });
    expectPartition(map, paths);
    expect(areaFor(map, "src/f1.ts")).toMatchObject({ kind: "folder", include: ["src/**"] });
    expect(areaFor(map, "test/f1.ts")).toMatchObject({ kind: "folder", include: ["test/**"] });
    expect(map.areas.every((area) => area.lowSignal === null)).toBe(true);
  });

  it("maps a manifest-free project and merges tiny root folders", () => {
    const paths = [
      "notes.txt",
      ...files("docs", 6, (index) => `d${index}.md`),
      ...files("a", 2),
      ...files("b", 2),
    ];
    const map = buildProgrammaticAreaMap({ inventory: inventory(paths) });
    expectPartition(map, paths);
    expect(areaFor(map, "docs/d0.md")?.kind).toBe("folder");
    const merged = areaFor(map, "a/f0.ts");
    expect(merged).toBe(areaFor(map, "b/f1.ts"));
    expect(merged).toMatchObject({ kind: "merged", include: ["**"] });
  });

  it("recognizes non-JS package manifests", () => {
    const paths = [
      "Cargo.toml",
      "crates/engine/Cargo.toml",
      ...files("crates/engine/src", 6, (index) => `e${index}.rs`),
      "py/pyproject.toml",
      ...files("py/pkg", 6, (index) => `p${index}.py`),
      "svc/go.mod",
      ...files("svc", 6, (index) => `g${index}.go`),
    ];
    const map = buildProgrammaticAreaMap({ inventory: inventory(paths) });
    expectPartition(map, paths);
    for (const [path, root] of [
      ["crates/engine/src/e0.rs", "crates/engine/**"],
      ["py/pkg/p0.py", "py/**"],
      ["svc/g0.go", "svc/**"],
    ] as const)
      expect(areaFor(map, path)).toMatchObject({ kind: "package", include: [root] });
  });

  it("folds a tiny nested package into its parent area", () => {
    const paths = [
      "packages/core/package.json",
      ...files("packages/core/src", 8),
      "packages/core/sub/package.json",
      "packages/core/sub/a.ts",
    ];
    const map = buildProgrammaticAreaMap({ inventory: inventory(paths) });
    expectPartition(map, paths);
    expect(areaFor(map, "packages/core/sub/a.ts")).toBe(areaFor(map, "packages/core/src/f0.ts"));
  });

  it("splits an oversized flat folder into name groups and keeps the remainder", () => {
    const paths = [
      "packages/big/package.json",
      ...files("packages/big/src", 60, (index) => `app-sidecar-${index}.ts`),
      ...files("packages/big/src", 45, (index) => `agent-session-${index}.ts`),
      ...files("packages/big/src", 3, (index) => `misc${index}.ts`),
    ];
    const map = buildProgrammaticAreaMap({ inventory: inventory(paths) });
    expectPartition(map, paths);
    const sidecar = areaFor(map, "packages/big/src/app-sidecar-1.ts");
    const session = areaFor(map, "packages/big/src/agent-session-1.ts");
    expect(sidecar).toMatchObject({ kind: "name-group", fileCount: 60, oversized: false });
    expect(session).toMatchObject({ kind: "name-group", fileCount: 45 });
    expect(sidecar?.label).toBe("packages/big/src/app*");
    expect(areaFor(map, "packages/big/src/misc1.ts")?.kind).not.toBe("name-group");
    expect(map.areas.every((area) => area.sourceFileCount <= 80 || area.oversized)).toBe(true);
  });

  it("marks an unsplittable area oversized", () => {
    const paths = files("flat", 120, (index) => `x${index}.ts`);
    const map = buildProgrammaticAreaMap({ inventory: inventory(paths) });
    expectPartition(map, paths);
    expect(areaFor(map, "flat/x1.ts")).toMatchObject({ oversized: true, sourceFileCount: 120 });
  });

  it("caps the number of areas without losing files", () => {
    const paths = Array.from({ length: 40 }, (_, index) =>
      files(`mod${String(index).padStart(2, "0")}`, 6),
    ).flat();
    const map = buildProgrammaticAreaMap({ inventory: inventory(paths) });
    expect(map.areas.length).toBeLessThanOrEqual(AREA_MAP_LIMITS.maxAreas);
    expectPartition(map, paths);
  });

  it("is deterministic for shuffled manifests, workflows and Windows paths", () => {
    const { paths, manifests } = monorepo();
    const workflows = [
      { path: ".github/workflows/ci.yml", jobIds: ["test"] },
      { path: ".github/workflows/release.yml", jobIds: ["publish"] },
    ];
    const expected = stableJson(
      buildProgrammaticAreaMap({ inventory: inventory(paths), manifests, workflows }),
    );
    const windowsPaths = paths.map((item) =>
      normalizeInventoryPath(item.replaceAll("/", "\\"), "\\"),
    );
    const shuffled = buildProgrammaticAreaMap({
      inventory: inventory([...windowsPaths].reverse()),
      manifests: [...manifests]
        .reverse()
        .map((facts) => ({ ...facts, path: facts.path.replaceAll("/", "\\") })),
      workflows: [...workflows].reverse(),
    });
    expect(stableJson(shuffled)).toBe(expected);
  });

  it("bounds serialized size by trimming lists, never areas", () => {
    const paths = Array.from({ length: 20 }, (_, index) => [
      `p${index}/package.json`,
      ...files(`p${index}/src`, 6),
    ]).flat();
    const manifests = Array.from({ length: 20 }, (_, index) =>
      manifest(`p${index}/package.json`, {
        scriptNames: Array.from({ length: 60 }, (_, script) => `script:${"x".repeat(50)}${script}`),
      }),
    );
    const map = buildProgrammaticAreaMap({ inventory: inventory(paths), manifests });
    expect(Buffer.byteLength(stableJson(map))).toBeLessThanOrEqual(
      AREA_MAP_LIMITS.maxSerializedBytes,
    );
    expectPartition(map, paths);
    const area = areaFor(map, "p0/src/f0.ts");
    expect(area?.signals.scripts.length).toBeLessThanOrEqual(AREA_MAP_LIMITS.maxListItems);
    expect((area?.signals.scripts.length ?? 0) + (area?.omitted.scripts ?? 0)).toBe(60);
  });

  it("drops unsafe script names and counts them", () => {
    const paths = ["package.json", ...files("src", 6)];
    const map = buildProgrammaticAreaMap({
      inventory: inventory(paths),
      manifests: [manifest("package.json", { scriptNames: ["ok", "rm -rf /", "x".repeat(65)] })],
    });
    expect(map.areas[0]?.signals.scripts).toEqual(["ok"]);
    expect(map.areas[0]?.omitted.unsafeNames).toBe(2);
  });

  it("attributes folder history only when one area owns the folder", () => {
    const { paths, manifests } = monorepo();
    const base = { inventory: inventory(paths), manifests };
    const withHistory = buildProgrammaticAreaMap({
      ...base,
      history: {
        status: "ok",
        sinceDays: 90,
        depth: 2,
        commitsRead: 30,
        truncated: false,
        entries: [
          { path: "packages\\core", commits: 7 },
          { path: "app/src", commits: 4 },
          { path: "app", commits: 9 },
          { path: "unknown/x", commits: 2 },
        ],
      },
    });
    expect(areaFor(withHistory, "packages/core/src/f0.ts")?.signals.recentChanges).toEqual({
      folderCommits: 7,
      partial: true,
    });
    expect(areaFor(withHistory, "app/src/view0.tsx")?.signals.recentChanges?.folderCommits).toBe(
      13,
    );
    expect(withHistory.history).toMatchObject({ status: "ok", unattributedFolderCommits: 2 });

    // At depth 1, `app` holds files of two areas (app and its nested src-tauri package).
    const spanning = buildProgrammaticAreaMap({
      ...base,
      history: {
        status: "ok",
        sinceDays: 90,
        depth: 1,
        commitsRead: 9,
        truncated: true,
        entries: [{ path: "app", commits: 9 }],
      },
    });
    expect(areaFor(spanning, "app/src/view0.tsx")?.signals.recentChanges?.folderCommits).toBe(0);
    expect(spanning.history).toMatchObject({ unattributedFolderCommits: 9, truncated: true });

    const unavailable = buildProgrammaticAreaMap({
      ...base,
      history: { status: "unavailable", reason: "not-a-git-repository" },
    });
    expect(unavailable.history).toEqual({ status: "unavailable", reason: "not-a-git-repository" });
    expect(unavailable.areas.every((area) => area.signals.recentChanges === null)).toBe(true);
    expect(
      buildProgrammaticAreaMap({
        ...base,
        history: { status: "unavailable", reason: "Bad Reason!" },
      }).history,
    ).toEqual({ status: "unavailable", reason: "not-requested" });
  });
});
