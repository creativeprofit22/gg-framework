import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runStages } from "./run-stages.mjs";

const runner = fileURLToPath(new URL("./run-stages.mjs", import.meta.url));

function runCli(stages, { withExecpath = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-stages-"));
  const log = path.join(dir, "calls.log");
  const fake = path.join(dir, "fake-pm.mjs");
  fs.writeFileSync(
    fake,
    [
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + String.fromCharCode(10));`,
      'process.exit(args.includes("fail") ? 3 : 0);',
    ].join("\n"),
  );
  const env = { ...process.env };
  if (withExecpath) env.npm_execpath = fake;
  else delete env.npm_execpath;
  try {
    const result = spawnSync(process.execPath, [runner, ...stages], { encoding: "utf8", env });
    const calls = fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return { result, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("runStages", () => {
  it("keeps running after a failing first stage and lists every failure", () => {
    const ran = [];
    const { failed } = runStages(["a", "b", "c"], (stage) => {
      ran.push(stage);
      if (stage === "c") throw new Error("could not start");
      return stage === "a" ? 1 : 0;
    });
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.deepEqual(failed, ["a", "c"]);
  });

  it("reports nothing when every stage passes", () => {
    assert.deepEqual(runStages(["a", "b"], () => 0).failed, []);
  });
});

describe("run-stages CLI", () => {
  it("runs later stages after a failure, prints the summary and exits non-zero", () => {
    const { result, calls } = runCli(["fail", "--filter pkg   test", "ok"]);
    assert.equal(result.status, 1);
    assert.deepEqual(calls, [["fail"], ["--filter", "pkg", "test"], ["ok"]]);
    assert.match(result.stderr, /Failed stages \(1\/3\):\s+- fail/);
  });

  it("exits 0 when every stage passes", () => {
    const { result, calls } = runCli(["one", "two"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(result.stderr, /Failed stages/);
  });

  it("refuses to run outside a package-manager script or without stages", () => {
    assert.equal(runCli(["one"], { withExecpath: false }).result.status, 2);
    assert.equal(runCli([]).result.status, 2);
  });
});
