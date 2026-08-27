import { mkdtemp, mkdir, cp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverTauriPackages } from "./discover.js";
import { createTestSymlink } from "../../test-utils/symlink.js";
import { detectHostTarget } from "./paths.js";

const fixture = path.join(import.meta.dirname, "__fixtures__", "valid");
const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gg-tauri-discover-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  await installCli(root, "apps/desktop");
  await writeSidecar(root, "apps/desktop");
  return root;
}

async function installCli(root: string, packageRoot: string): Promise<void> {
  const cli = path.join(root, packageRoot, "node_modules", "@tauri-apps", "cli");
  await mkdir(cli, { recursive: true });
  await writeFile(
    path.join(cli, "package.json"),
    `${JSON.stringify({ name: "@tauri-apps/cli", version: "2.11.2", bin: { tauri: "./tauri.js" } }, null, 2)}\n`,
  );
  await writeFile(path.join(cli, "tauri.js"), "module.exports = {};\n");
}

async function writeSidecar(root: string, packageRoot: string): Promise<void> {
  const host = detectHostTarget();
  const extension = host.platform === "win32" ? ".exe" : "";
  const directory = path.join(root, packageRoot, "src-tauri", "binaries");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `helper-${host.rust_triple}${extension}`), "fake binary\n");
}

async function config(root: string, transform: (value: Record<string, unknown>) => void): Promise<void> {
  const configPath = path.join(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  transform(parsed);
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("discoverTauriPackages", () => {
  it("returns stable evidence for one valid pnpm Tauri v2 JSON workspace", async () => {
    const root = await repository();
    const first = await discoverTauriPackages(root);
    const second = await discoverTauriPackages(root);

    expect(first).toEqual(second);
    expect(first.targets).toHaveLength(1);
    expect(first.targets[0]).toMatchObject({
      package_root: "apps/desktop",
      cli_version: "2.11.2",
      resources: [{ source: "apps/desktop/src-tauri/resources/data.txt", kind: "file" }],
    });
    expect(first.evidence.sources.map((source) => source.path)).toEqual(
      [...first.evidence.sources.map((source) => source.path)].sort(),
    );
  });

  it("orders non-ASCII evidence paths by code units", async () => {
    const root = await repository();
    const resources = path.join(root, "apps/desktop/src-tauri/resources");
    await writeFile(path.join(resources, "z.txt"), "z\n");
    await writeFile(path.join(resources, "ä.txt"), "a\n");
    await config(root, (value) => {
      (value.bundle as Record<string, unknown>).resources = {
        "resources/ä.txt": "ä.txt",
        "resources/z.txt": "z.txt",
      };
    });

    const result = await discoverTauriPackages(root);

    expect(result.evidence.sources.filter((source) => source.role === "resource").map((source) => source.path)).toEqual([
      "apps/desktop/src-tauri/resources/z.txt",
      "apps/desktop/src-tauri/resources/ä.txt",
    ]);
  });

  it("returns multiple candidates without choosing one", async () => {
    const root = await repository();
    await cp(path.join(root, "apps", "desktop"), path.join(root, "apps", "second"), { recursive: true });
    const secondPackage = path.join(root, "apps", "second", "package.json");
    await writeFile(secondPackage, (await readFile(secondPackage, "utf8")).replace("fixture-desktop", "fixture-second"));

    const result = await discoverTauriPackages(root);

    expect(result.targets).toHaveLength(2);
    expect(result.summary).toContain("choose an explicit target ID");
  });

  it.each([
    ["missing Cargo proof", async (root: string) => rm(path.join(root, "apps/desktop/src-tauri/Cargo.toml")), "missing-proof"],
    ["missing config proof", async (root: string) => rm(path.join(root, "apps/desktop/src-tauri/tauri.conf.json")), "missing-proof"],
    ["Tauri v1", async (root: string) => writeFile(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), "[build-dependencies]\ntauri-build = \"1\"\n[dependencies]\ntauri = \"1\"\n"), "unsupported-tauri-version"],
    ["JSON5", async (root: string) => { const source = path.join(root, "apps/desktop/src-tauri/tauri.conf.json"); await writeFile(`${source}5`, "{}\n"); await rm(source); }, "unsupported-config-format"],
    ["TOML", async (root: string) => { await rm(path.join(root, "apps/desktop/src-tauri/tauri.conf.json")); await writeFile(path.join(root, "apps/desktop/src-tauri/tauri.conf.toml"), "productName = 'x'\n"); }, "unsupported-config-format"],
    ["cross-target", async (root: string) => config(root, (value) => { value.build = { target: "aarch64-apple-darwin" }; }), "unsupported-cross-target"],
    ["glob resource", async (root: string) => config(root, (value) => { (value.bundle as Record<string, unknown>).resources = ["resources/*"]; }), "unsupported-glob"],
    ["missing CLI", async (root: string) => rm(path.join(root, "apps/desktop/node_modules"), { recursive: true }), "missing-cli"],
  ])("rejects %s deterministically", async (_name, mutate, code) => {
    const root = await repository();
    await mutate(root);

    const result = await discoverTauriPackages(root);

    expect(result.targets).toEqual([]);
    expect(result.evidence.issues.map((issue) => issue.code)).toContain(code);
  });

  it.each([
    ["traversal", "../outside", "invalid-path"],
    ["absolute", "/outside", "invalid-path"],
    ["mixed separators", "resources\\data.txt", "invalid-path"],
  ])("rejects %s resource paths", async (_name, resource, code) => {
    const root = await repository();
    await config(root, (value) => { (value.bundle as Record<string, unknown>).resources = [resource]; });

    const result = await discoverTauriPackages(root);

    expect(result.targets).toEqual([]);
    expect(result.evidence.issues.map((issue) => issue.code)).toContain(code);
  });

  it("rejects links and case-colliding resource paths", async () => {
    const root = await repository();
    const resources = path.join(root, "apps/desktop/src-tauri/resources");
    await createTestSymlink(resources, path.join(root, "apps/desktop/src-tauri/linked-resources"), "dir");
    await config(root, (value) => { (value.bundle as Record<string, unknown>).resources = ["linked-resources/data.txt"]; });
    const linked = await discoverTauriPackages(root);
    expect(linked.evidence.issues.map((issue) => issue.code)).toContain("link-rejected");

    await rm(path.join(root, "apps/desktop/src-tauri/linked-resources"));
    await writeFile(path.join(resources, "Case.txt"), "case\n");
    await config(root, (value) => { (value.bundle as Record<string, unknown>).resources = ["resources/Case.txt", "resources/case.txt"]; });
    const collision = await discoverTauriPackages(root);
    expect(collision.evidence.issues.map((issue) => issue.code)).toContain("case-collision");
  });

  it("does not inspect packages outside declared workspace roots", async () => {
    const root = await repository();
    await cp(path.join(root, "apps", "desktop"), path.join(root, "undeclared"), { recursive: true });

    const result = await discoverTauriPackages(root);

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.package_root).toBe("apps/desktop");
  });

  it("changes evidence when a source changes", async () => {
    const root = await repository();
    const before = await discoverTauriPackages(root);
    await writeFile(path.join(root, "apps/desktop/src-tauri/resources/data.txt"), "changed\n");
    const after = await discoverTauriPackages(root);

    expect(after.evidence_sha256).not.toBe(before.evidence_sha256);
    expect(after.targets[0]!.target_id).toBe(before.targets[0]!.target_id);
  });
});
