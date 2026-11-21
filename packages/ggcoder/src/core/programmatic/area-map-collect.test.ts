import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectProgrammaticAreaMap,
  packageJsonFacts,
  parseAreaHistory,
  parseWorkflowJobIds,
} from "./area-map-collect.js";
import { assignProgrammaticAreas } from "./area-map.js";
import { buildProgrammaticInventory } from "./inventory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-area-map-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, ...file.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

function many(dir: string, count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${dir}/f${index}.ts`,
      `export const v = ${index};`,
    ]),
  );
}

async function listTree(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

const WORKFLOW = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  test: # unit",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: pnpm test",
  '  "build-app":',
  "    runs-on: windows-latest",
  "env:",
  "  NOT_A_JOB: 1",
].join("\r\n");

describe("collectProgrammaticAreaMap", () => {
  it("collects a monorepo read-only, skipping ignored and vendor folders", async () => {
    const root = await project({
      ".gitignore": "generated/\n",
      "package.json": JSON.stringify({ scripts: { build: "pnpm -r build" } }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      ".github/workflows/ci.yml": WORKFLOW,
      "packages/core/package.json": JSON.stringify({
        name: "@x/core",
        scripts: { test: "vitest" },
      }),
      ...many("packages/core/src", 6),
      "packages/cli/package.json": JSON.stringify({
        name: "@x/cli",
        dependencies: { "@x/core": "workspace:*" },
      }),
      ...many("packages/cli/src", 6),
      ...many("generated", 6),
      ...many("node_modules/dep", 6),
      ...many("vendor/lib", 6),
      ...many("dist", 6),
      ".gg/programmatic/profile.json": "{}",
    });
    const before = await listTree(root);
    const fingerprint = (await buildProgrammaticInventory(root)).inventory.configurationFingerprint;
    const profile = await fs.readFile(path.join(root, ".gg/programmatic/profile.json"));

    const result = await collectProgrammaticAreaMap(root);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const map = result.areaMap;
    const labels = map.areas.map((area) => area.label);
    for (const ignored of ["generated", "node_modules", "vendor", "dist"])
      expect(labels.some((label) => label.startsWith(ignored))).toBe(false);
    const cross = map.areas[0];
    expect(cross?.signals.scripts).toEqual(["build"]);
    expect(cross?.signals.ciJobs).toEqual(["ci.yml:build-app", "ci.yml:test"]);
    const core = map.areas.find((area) => area.label === "packages/core");
    expect(core).toMatchObject({ kind: "workspace-member", packageName: "@x/core" });
    expect(core?.signals.scripts).toEqual(["test"]);
    expect(map.history).toEqual({ status: "unavailable", reason: "not-requested" });
    expect(result.omitted).toEqual({ changedManifests: 0, unparsedManifests: 0, overLimit: 0 });
    const assigned = assignProgrammaticAreas(map, ["packages/cli/src/f0.ts"]);
    expect(
      map.areas.find((area) => area.id === assigned.get("packages/cli/src/f0.ts"))?.label,
    ).toBe("packages/cli");

    expect(await listTree(root)).toEqual(before);
    expect((await buildProgrammaticInventory(root)).inventory.configurationFingerprint).toEqual(
      fingerprint,
    );
    expect(await fs.readFile(path.join(root, ".gg/programmatic/profile.json"))).toEqual(profile);
  });

  it("counts unparsable manifests instead of failing", async () => {
    const root = await project({
      "package.json": "{ not json",
      ...many("src", 6),
    });
    const result = await collectProgrammaticAreaMap(root);
    expect(result).toMatchObject({ status: "ok", omitted: { unparsedManifests: 1 } });
  });

  it("parses and attributes supplied history; bad history becomes unavailable", async () => {
    const root = await project({ "package.json": "{}", ...many("src", 6) });
    const history = JSON.stringify({
      status: "ok",
      action: "change_frequency",
      path: null,
      groupBy: "folder",
      depth: 4,
      window: { sinceDays: 90, since: "x", oldestCommitDate: null },
      commitsRead: 3,
      shallow: false,
      entries: [{ path: "src", commits: 3 }],
      truncated: { commits: false, entries: false, output: false, largeCommitsSkipped: 0 },
      note: "n",
    });
    const ok = await collectProgrammaticAreaMap(root, { history: async () => history });
    expect(
      ok.status === "ok" && ok.areaMap.areas.find((area) => area.label === "src"),
    ).toMatchObject({ signals: { recentChanges: { folderCommits: 3, partial: true } } });
    const failed = await collectProgrammaticAreaMap(root, {
      history: async () => {
        throw new Error("boom");
      },
    });
    expect(failed.status === "ok" && failed.areaMap.history).toEqual({
      status: "unavailable",
      reason: "failed",
    });
  });

  it("reports a missing root as unavailable without paths", async () => {
    const result = await collectProgrammaticAreaMap(
      path.join(os.tmpdir(), "gg-area-map-missing-x"),
    );
    expect(result).toEqual({ status: "unavailable", reason: "unreadable" });
  });

  it("rethrows aborts", async () => {
    const root = await project({ "package.json": "{}" });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(collectProgrammaticAreaMap(root, { signal: controller.signal })).rejects.toThrow(
      "stop",
    );
  });
});

describe("area map collector parsers", () => {
  it("reads CRLF workflow job ids under top-level jobs only", () => {
    expect(parseWorkflowJobIds(WORKFLOW)).toEqual(["build-app", "test"]);
    expect(parseWorkflowJobIds("on: push\n")).toEqual([]);
  });

  it("extracts package facts and root-only workspace patterns", () => {
    const source = JSON.stringify({
      name: "root",
      scripts: { b: "two", a: "one", bad: 3 },
      devDependencies: { vitest: "1" },
      workspaces: ["packages/*"],
    });
    expect(packageJsonFacts("package.json", source)).toEqual({
      path: "package.json",
      packageName: "root",
      scriptNames: ["a", "b"],
      dependencyNames: ["vitest"],
      scriptText: "one\ntwo",
      workspacePatterns: ["packages/*"],
    });
    expect(packageJsonFacts("pkg/package.json", source).workspacePatterns).toEqual([]);
  });

  it("maps history output to fixed outcomes", () => {
    expect(parseAreaHistory("nope")).toEqual({ status: "unavailable", reason: "unparsed" });
    expect(
      parseAreaHistory(JSON.stringify({ status: "unavailable", reason: "no-commits" })),
    ).toEqual({ status: "unavailable", reason: "no-commits" });
    expect(parseAreaHistory("x".repeat(70_000))).toEqual({
      status: "unavailable",
      reason: "output-too-large",
    });
  });
});
