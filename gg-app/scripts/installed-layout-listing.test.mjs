import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstalledLayoutListing } from "./installed-layout-listing.mjs";

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-layout-listing-"));
  temporaryDirectories.push(root);
  const packageRoot = join(root, "pkg");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pkg", version: "1.0.0" }),
  );
  writeFileSync(join(packageRoot, "dist", "index.js"), "");
  writeFileSync(join(packageRoot, "dist", "index.js.map"), "");
  const lockfile = join(root, "pnpm-lock.yaml");
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n");
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir);
  const load = (options = {}) =>
    loadInstalledLayoutListing({
      packages: [{ name: "pkg", root: packageRoot }],
      lockfile,
      cacheDir,
      ...options,
    });
  const paths = (listing) => listing.packages[0].entries.map((entry) => entry.path).sort();
  return { packageRoot, lockfile, cacheDir, load, paths };
}

describe("installed layout listing cache", () => {
  it("walks each package and leaves source maps out", () => {
    const { load, paths, cacheDir } = createFixture();
    const listing = load();
    expect(paths(listing)).toEqual(["dist", join("dist", "index.js"), "package.json"]);
    expect(listing.packages[0].entries.find((entry) => entry.path === "dist")).toMatchObject({
      isDirectory: true,
      isFile: false,
    });
    expect(readdirSync(cacheDir)).toEqual([`installed-layout-${listing.key}.json`]);
  });

  it("reuses the saved listing while version and lockfile are unchanged", () => {
    const { load, paths, packageRoot } = createFixture();
    const first = load();
    writeFileSync(join(packageRoot, "added.js"), "");
    const second = load();
    expect(second.key).toBe(first.key);
    expect(paths(second)).not.toContain("added.js");
  });

  it("rebuilds the listing when the package version changes", () => {
    const { load, paths, packageRoot } = createFixture();
    const first = load();
    writeFileSync(join(packageRoot, "added.js"), "");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "pkg", version: "1.0.1" }),
    );
    const second = load();
    expect(second.key).not.toBe(first.key);
    expect(paths(second)).toContain("added.js");
  });

  it("rebuilds the listing when the lockfile changes", () => {
    const { load, paths, packageRoot, lockfile } = createFixture();
    const first = load();
    writeFileSync(join(packageRoot, "added.js"), "");
    writeFileSync(lockfile, "lockfileVersion: '9.0'\n# changed\n");
    const second = load();
    expect(second.key).not.toBe(first.key);
    expect(paths(second)).toContain("added.js");
  });

  it("walks fresh every time without a cache folder", () => {
    const { load, paths, packageRoot, cacheDir } = createFixture();
    load({ cacheDir: undefined });
    writeFileSync(join(packageRoot, "added.js"), "");
    expect(paths(load({ cacheDir: undefined }))).toContain("added.js");
    expect(readdirSync(cacheDir)).toEqual([]);
  });
});
