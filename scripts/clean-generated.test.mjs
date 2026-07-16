import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanGenerated, parseArgs } from "./clean-generated.mjs";

async function withTempRepo(run) {
  const repoRoot = await mkdtemp(join(tmpdir(), "gg-clean-generated-"));
  await mkdir(join(repoRoot, "packages"), { recursive: true });

  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("parseArgs accepts pnpm separators and dry-run aliases", () => {
  assert.deepEqual(parseArgs(["--", "web", "--dry-run"]), {
    target: "web",
    dryRun: true,
  });
  assert.deepEqual(parseArgs(["cache", "-n"]), { target: "cache", dryRun: true });
  assert.throws(() => parseArgs(["web", "tauri"]), /exactly one cleanup target/);
  assert.throws(() => parseArgs(["--force", "web"]), /Unknown option/);
});

test("web cleanup previews before deleting and preserves .gg", async () => {
  await withTempRepo(async (repoRoot) => {
    const webDist = join(repoRoot, "gg-app", "dist");
    const protectedFile = join(repoRoot, ".gg", "keep.txt");
    await mkdir(webDist, { recursive: true });
    await mkdir(join(repoRoot, ".gg"), { recursive: true });
    await writeFile(join(webDist, "index.html"), "generated");
    await writeFile(protectedFile, "keep");

    const messages = [];
    await cleanGenerated({
      repoRoot,
      target: "web",
      dryRun: true,
      log: (line) => messages.push(line),
    });

    assert.equal(existsSync(webDist), true);
    assert.ok(messages.includes("  - gg-app/dist"));

    await cleanGenerated({ repoRoot, target: "web", log: () => {} });

    assert.equal(existsSync(webDist), false);
    assert.equal(existsSync(protectedFile), true);
  });
});

test("package cleanup removes only package dist directories", async () => {
  await withTempRepo(async (repoRoot) => {
    const packageRoot = join(repoRoot, "packages", "example");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(join(packageRoot, "dist", "index.js"), "generated");
    await writeFile(join(packageRoot, "src", "index.ts"), "source");

    await cleanGenerated({ repoRoot, target: "packages", log: () => {} });

    assert.equal(existsSync(join(packageRoot, "dist")), false);
    assert.equal(existsSync(join(packageRoot, "src", "index.ts")), true);
  });
});
