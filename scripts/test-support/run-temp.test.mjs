import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  LEFTOVER_AGE_MS,
  RUN_DIR_PATTERN,
  removeRunDir,
  startRunTemp,
  stopRunTemp,
  sweepLeftoverRuns,
} from "./run-temp.mjs";

const T0 = Date.UTC(2026, 0, 1);
const dead = () => false;
const quiet = () => {};
let base;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-run-temp-test-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

function runDirName(startMs, pid = 99999, suffix = "aB3xY9") {
  return `ggt-${startMs.toString(36)}-${pid}-${suffix}`;
}

function makeRunDir(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "file.txt"), "x");
  return dir;
}

function options(extra = {}) {
  return {
    env: { TEMP: "C:\\real", TMP: "C:\\real" },
    tmpdir: () => base,
    now: () => T0,
    pid: 4242,
    isAlive: dead,
    warn: quiet,
    stateHolder: {},
    ...extra,
  };
}

describe("startRunTemp / stopRunTemp", () => {
  it("creates one folder, points temp vars at it, then restores env and removes it", () => {
    const opts = options();
    const before = { ...opts.env };
    const dir = startRunTemp(opts);
    assert.equal(path.dirname(dir), base);
    assert.match(path.basename(dir), RUN_DIR_PATTERN);
    assert.ok(path.basename(dir).startsWith(`ggt-${T0.toString(36)}-4242-`));
    for (const key of ["TEMP", "TMP", "TMPDIR", "GG_TEST_RUN_TEMP"]) {
      assert.equal(opts.env[key], dir, key);
    }
    assert.equal(opts.env.GG_TEST_RUN_TEMP_BASE, base);
    fs.writeFileSync(path.join(dir, "work.txt"), "x");

    assert.deepEqual(stopRunTemp(opts), { dir, removed: true });
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(opts.env, before);
  });

  it("shares one folder across five setups and removes it only after the last teardown", () => {
    const opts = options();
    const dirs = Array.from({ length: 5 }, () => startRunTemp(opts));
    assert.equal(new Set(dirs).size, 1);
    assert.equal(fs.readdirSync(base).length, 1);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(stopRunTemp(opts).removed, false);
      assert.ok(fs.existsSync(dirs[0]));
      assert.equal(opts.env.TEMP, dirs[0]);
    }
    assert.equal(stopRunTemp(opts).removed, true);
    assert.equal(fs.existsSync(dirs[0]), false);
    assert.equal(opts.env.TEMP, "C:\\real");
    assert.deepEqual(stopRunTemp(opts), { dir: null, removed: false });
  });

  it("puts a nested run next to its parent, never inside it, and keeps the parent", () => {
    const outer = options();
    const outerDir = startRunTemp(outer);
    const inner = options({
      env: { ...outer.env },
      tmpdir: () => outerDir,
      now: () => T0 + 2 * LEFTOVER_AGE_MS,
    });
    const innerDir = startRunTemp(inner);
    assert.equal(path.dirname(innerDir), base);
    assert.ok(fs.existsSync(outerDir), "parent run folder is kept");
    stopRunTemp(inner);
    assert.equal(inner.env.TEMP, outerDir);
    stopRunTemp(outer);
    assert.deepEqual(fs.readdirSync(base), []);
  });

  it("sweeps old leftovers when a run starts", () => {
    const leftover = makeRunDir(runDirName(T0 - LEFTOVER_AGE_MS));
    const opts = options();
    const dir = startRunTemp(opts);
    assert.equal(fs.existsSync(leftover), false);
    assert.ok(fs.existsSync(dir));
    stopRunTemp(opts);
  });
});

describe("sweepLeftoverRuns", () => {
  it("keeps a killed run's leftover at 59:59 and removes it at 1:00:00", () => {
    const dir = makeRunDir(runDirName(T0));
    const early = sweepLeftoverRuns({
      base,
      now: T0 + LEFTOVER_AGE_MS - 1000,
      isAlive: dead,
      warn: quiet,
    });
    assert.deepEqual(early, { removed: [], skipped: [{ dir, reason: "recent" }] });
    assert.ok(fs.existsSync(dir));

    const late = sweepLeftoverRuns({ base, now: T0 + LEFTOVER_AGE_MS, isAlive: dead, warn: quiet });
    assert.deepEqual(late, { removed: [dir], skipped: [] });
    assert.equal(fs.existsSync(dir), false);
  });

  it("skips an old folder whose process is still running", () => {
    const dir = makeRunDir(runDirName(T0, 1234));
    const seen = [];
    const result = sweepLeftoverRuns({
      base,
      now: T0 + 10 * LEFTOVER_AGE_MS,
      isAlive: (pid) => {
        seen.push(pid);
        return true;
      },
      warn: quiet,
    });
    assert.deepEqual(seen, [1234]);
    assert.deepEqual(result, { removed: [], skipped: [{ dir, reason: "alive" }] });
    assert.ok(fs.existsSync(dir));
  });

  it("leaves non-run folders, files, symlinks and the current run alone", () => {
    const old = T0 - 10 * LEFTOVER_AGE_MS;
    const others = [
      "gg-other-abc123",
      "ggt-",
      "ggt-zz-12-short",
      "ggt-ABC-12-aB3xY9",
      `x${runDirName(old)}`,
    ];
    for (const name of others) makeRunDir(name);
    const file = path.join(base, runDirName(old, 99998));
    fs.writeFileSync(file, "not a folder");
    const target = makeRunDir("link-target");
    const link = path.join(base, runDirName(old, 99997));
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    const current = makeRunDir(runDirName(old, 99996));

    const result = sweepLeftoverRuns({ base, now: T0, isAlive: dead, keep: current, warn: quiet });
    assert.deepEqual(result, { removed: [], skipped: [{ dir: current, reason: "current" }] });
    for (const name of [...others, "link-target"]) {
      assert.ok(fs.existsSync(path.join(base, name)), name);
    }
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(target, "file.txt")));
    assert.ok(fs.statSync(file).isFile());
    assert.ok(fs.existsSync(current));
  });

  it("returns nothing when the base folder is missing", () => {
    assert.deepEqual(sweepLeftoverRuns({ base: path.join(base, "missing"), now: T0 }), {
      removed: [],
      skipped: [],
    });
  });
});

describe("locked files", () => {
  function lockingFs() {
    let locked = true;
    return {
      fs: {
        ...fs,
        rmSync(target, opts) {
          if (locked) throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
          return fs.rmSync(target, opts);
        },
      },
      release: () => {
        locked = false;
      },
    };
  }

  it("removeRunDir retries with the expected options and warns instead of throwing", () => {
    const calls = [];
    const warnings = [];
    const fakeFs = {
      rmSync: (target, opts) => {
        calls.push([target, opts]);
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    };
    assert.equal(removeRunDir("D:\\x", { fs: fakeFs, warn: (m) => warnings.push(m) }), false);
    assert.deepEqual(calls, [
      ["D:\\x", { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }],
    ]);
    assert.match(warnings[0], /EBUSY/);
  });

  it("teardown leaves a locked folder without failing, and a later sweep removes it", () => {
    const lock = lockingFs();
    const opts = options({ fs: lock.fs });
    const dir = startRunTemp(opts);
    assert.deepEqual(stopRunTemp(opts), { dir, removed: false });
    assert.ok(fs.existsSync(dir));
    assert.equal(opts.env.TEMP, "C:\\real", "env is restored even when removal fails");

    const sweep = () =>
      sweepLeftoverRuns({
        base,
        now: T0 + LEFTOVER_AGE_MS,
        isAlive: dead,
        fs: lock.fs,
        warn: quiet,
      });
    assert.deepEqual(sweep(), { removed: [], skipped: [{ dir, reason: "locked" }] });
    lock.release();
    assert.deepEqual(sweep(), { removed: [dir], skipped: [] });
    assert.equal(fs.existsSync(dir), false);
  });

  it(
    "handles a real Windows file lock",
    { skip: process.platform !== "win32" && "Windows-only lock semantics" },
    async () => {
      const opts = options();
      const dir = startRunTemp(opts);
      const lockedFile = path.join(dir, "locked.bin");
      fs.writeFileSync(lockedFile, "x");
      const script =
        `$f = [IO.File]::Open('${lockedFile.replaceAll("'", "''")}', 'Open', 'ReadWrite', 'None'); ` +
        "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); " +
        "[void][Console]::In.ReadLine(); $f.Close()";
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      });
      const exited = once(child, "exit");
      try {
        await new Promise((resolve, reject) => {
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
            if (output.includes("ready")) resolve();
          });
          child.once("error", reject);
          child.once("exit", () => reject(new Error(`lock holder exited early: ${output}`)));
        });
        assert.deepEqual(stopRunTemp(opts), { dir, removed: false });
        assert.ok(fs.existsSync(lockedFile));
        assert.equal(opts.env.TEMP, "C:\\real");
      } finally {
        child.stdin.end("\n");
        await exited;
      }
      const later = sweepLeftoverRuns({
        base,
        now: T0 + LEFTOVER_AGE_MS,
        isAlive: dead,
        warn: quiet,
      });
      assert.deepEqual(later, { removed: [dir], skipped: [] });
      assert.equal(fs.existsSync(dir), false);
    },
  );
});
