import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  PROTECTED_RELATIVE_PATHS,
  TARGET_HELP,
  assertProtectedPathsExcluded,
  auditGenerated,
  parseArgs,
  pathsFor,
} from "./audit-generated.mjs";

async function withTempRepo(run) {
  const repoRoot = await mkdtemp(join(tmpdir(), "gg-audit-generated-"));
  await mkdir(join(repoRoot, "packages"), { recursive: true });

  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function createDirectoryLink(target, link) {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("parseArgs accepts exactly one audit target", () => {
  assert.deepEqual(parseArgs(["--", "web"]), { target: "web" });
  assert.throws(() => parseArgs(["web", "tauri"]), /exactly one audit target/);
  assert.throws(() => parseArgs(["web", "--dry-run"]), /Unknown option/);
  assert.throws(() => parseArgs(["web", "--apply"]), /Unknown option/);
});

test("all audit targets exclude protected paths", async () => {
  await withTempRepo(async (repoRoot) => {
    for (const target of TARGET_HELP.keys()) {
      const paths = await pathsFor(repoRoot, target);

      for (const path of paths) {
        for (const protectedPath of PROTECTED_RELATIVE_PATHS) {
          const selected = relative(repoRoot, path).replaceAll("\\", "/");
          assert.notEqual(selected, protectedPath, `${target} selected ${protectedPath}`);
          assert.equal(
            selected.startsWith(`${protectedPath}/`),
            false,
            `${target} selected inside ${protectedPath}`,
          );
        }
      }
    }

    for (const protectedPath of PROTECTED_RELATIVE_PATHS) {
      assert.throws(
        () => assertProtectedPathsExcluded(repoRoot, [join(repoRoot, ...protectedPath.split("/"))]),
        /protected path/,
        `${protectedPath} must be rejected`,
      );
    }

    assert.throws(
      () => assertProtectedPathsExcluded(repoRoot, [join(repoRoot, "gg-app", "src-tauri")]),
      /protected path/,
      "a parent of a protected path must be rejected",
    );
  });
});

test("audit reports generated artifacts and every protected path without mutation", async () => {
  await withTempRepo(async (repoRoot) => {
    const webDist = join(repoRoot, "gg-app", "dist");
    const generatedFile = join(webDist, "index.html");
    await mkdir(webDist, { recursive: true });
    await writeFile(generatedFile, "generated");

    const messages = [];
    await auditGenerated({ repoRoot, target: "web", log: (line) => messages.push(line) });

    assert.equal(existsSync(generatedFile), true);
    assert.ok(messages.includes("Generated-artifact audit:"));
    assert.ok(messages.includes("  - gg-app/dist"));
    for (const protectedPath of PROTECTED_RELATIVE_PATHS) {
      assert.ok(messages.includes(`  - ${protectedPath}`));
    }
  });
});

test("audit reports an outside-repository symlink without following or changing it", async () => {
  const outsideRoot = await mkdtemp(join(tmpdir(), "gg-audit-generated-outside-"));

  try {
    await withTempRepo(async (repoRoot) => {
      const webDist = join(repoRoot, "gg-app", "dist");
      const outsideFile = join(outsideRoot, "keep.txt");
      await mkdir(join(repoRoot, "gg-app"), { recursive: true });
      await writeFile(outsideFile, "keep");
      await createDirectoryLink(outsideRoot, webDist);

      const messages = [];
      await auditGenerated({ repoRoot, target: "web", log: (line) => messages.push(line) });

      assert.ok(messages.includes("  - gg-app/dist"));
      assert.equal(existsSync(webDist), true);
      assert.equal(existsSync(outsideFile), true);
    });
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("Cargo audit selects only the audited debug and release profiles", async () => {
  await withTempRepo(async (repoRoot) => {
    const debug = join(repoRoot, "gg-app", "src-tauri", "target", "debug");
    const release = join(repoRoot, "gg-app", "src-tauri", "target", "release");
    const smokeArtifacts = join(repoRoot, "gg-app", "src-tauri", "target", "smoke-artifacts");
    await mkdir(debug, { recursive: true });
    await mkdir(release, { recursive: true });
    await mkdir(smokeArtifacts, { recursive: true });

    const paths = await pathsFor(repoRoot, "tauri");

    assert.deepEqual(paths, [debug, release]);
    assert.equal(existsSync(smokeArtifacts), true);
  });
});
