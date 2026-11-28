import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Proves the shared run-temp global setup reaches this package's workers.
describe("test run temp folder", () => {
  const runDir = process.env.GG_TEST_RUN_TEMP ?? "";

  it("points the worker's temp folder at this run's folder", () => {
    expect(path.basename(runDir)).toMatch(/^ggt-/);
    expect(path.dirname(runDir)).toBe(process.env.GG_TEST_RUN_TEMP_BASE);
    expect(path.resolve(os.tmpdir())).toBe(path.resolve(runDir));
  });

  it("creates temp folders inside the run folder", () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), "gg-app-run-temp-"));
    try {
      expect(path.dirname(made)).toBe(path.resolve(runDir));
    } finally {
      fs.rmSync(made, { recursive: true, force: true });
    }
  });

  it("passes the run folder on to child processes", () => {
    const child = spawnSync(process.execPath, ["-p", "require('os').tmpdir()"], {
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(path.resolve(child.stdout.trim())).toBe(path.resolve(runDir));
  });
});
