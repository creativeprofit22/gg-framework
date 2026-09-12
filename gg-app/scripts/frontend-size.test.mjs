import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root;
let dist;
let manifest;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "gg-frontend-size-"));
  dist = path.join(root, "gg-app/dist");
  mkdirSync(path.join(root, "bench/baseline"), { recursive: true });
  mkdirSync(path.join(dist, ".vite"), { recursive: true });
  copyFileSync(
    new URL("../../bench/size-gate.mjs", import.meta.url),
    path.join(root, "bench/size-gate.mjs"),
  );
  writeFileSync(
    path.join(root, "bench/baseline/sizes.json"),
    JSON.stringify({
      artifacts: { "frontend:initial": { bytes: 35_000 } },
    }),
  );
  manifest = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      imports: ["shared", "bridge"],
      dynamicImports: ["notes"],
    },
    shared: { file: "shared.js", imports: ["index.html"] },
    bridge: { file: "bridge.js", imports: ["shared"] },
    notes: { file: "notes.js" },
  };
  for (const [file, bytes] of Object.entries({
    "entry.js": 10_000,
    "shared.js": 20_000,
    "bridge.js": 5_000,
    "notes.js": 99_000,
  })) {
    writeFileSync(path.join(dist, file), Buffer.alloc(bytes));
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runGate() {
  writeFileSync(path.join(dist, ".vite/manifest.json"), JSON.stringify(manifest));
  return spawnSync(
    process.execPath,
    [path.join(root, "bench/size-gate.mjs"), "--only", "frontend:initial"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("frontend initial-JavaScript budget", () => {
  it("counts shared static chunks once, handles cycles, and excludes lazy notes", () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("34.2KB");
  });

  it("fails if the deferred history becomes eager again", () => {
    manifest["index.html"].imports.push("notes");
    const result = runGate();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL");
  });

  it("fails for an incomplete build instead of reporting a smaller bundle", () => {
    rmSync(path.join(dist, "shared.js"));
    expect(runGate().status).toBe(1);
  });

  it("fails if the manifest has no entry point", () => {
    manifest["index.html"].isEntry = false;
    expect(runGate().status).toBe(1);
  });
});
