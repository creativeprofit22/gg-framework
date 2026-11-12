import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("./with-run-temp.mjs", import.meta.url));
const probe = [
  "const os = require('os');",
  "const fs = require('fs');",
  "const path = require('path');",
  "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));",
  "console.log(JSON.stringify({ tmp: os.tmpdir(), run: process.env.GG_TEST_RUN_TEMP,",
  "  base: process.env.GG_TEST_RUN_TEMP_BASE, made: dir }));",
  "process.exit(Number(process.env.PROBE_EXIT || 0));",
].join("\n");

function runWrapped(exitCode) {
  const env = { ...process.env, PROBE_EXIT: String(exitCode) };
  delete env.GG_TEST_RUN_TEMP;
  delete env.GG_TEST_RUN_TEMP_BASE;
  return spawnSync(process.execPath, [wrapper, "node", "-e", probe], { encoding: "utf8", env });
}

describe("with-run-temp", () => {
  it("runs the command inside a fresh run folder and removes it afterwards", () => {
    const result = runWrapped(0);
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(seen.tmp, seen.run);
    assert.match(path.basename(seen.run), /^ggt-/);
    assert.equal(path.dirname(seen.run), seen.base);
    assert.equal(path.dirname(seen.made), seen.run);
    assert.equal(fs.existsSync(seen.run), false, "run folder is removed after the command");
    assert.equal(path.resolve(seen.base), path.resolve(os.tmpdir()));
  });

  it("passes the child's exit code through", () => {
    const result = runWrapped(7);
    assert.equal(result.status, 7, result.stderr);
  });

  it("fails with usage when no command is given", () => {
    const result = spawnSync(process.execPath, [wrapper], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/);
  });
});
