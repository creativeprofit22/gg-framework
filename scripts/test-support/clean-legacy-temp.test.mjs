import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  collectRepoPrefixes,
  compilePrefixMatcher,
  extractMkdtempPrefixes,
  findCandidates,
  main,
  summarize,
} from "./clean-legacy-temp.mjs";

const HOUR = 3_600_000;
let base;
let outside;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-clean-legacy-test-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "gg-clean-legacy-outside-"));
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep");
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
});

function makeDir(name, { ageMs = 2 * HOUR, bytes = 10, now = Date.now() } = {}) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "data.bin"), Buffer.alloc(bytes));
  const when = new Date(now - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

function link(target, at) {
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

function runName(startMs, pid) {
  return `ggt-${startMs.toString(36)}-${pid}-Ab12Cd`;
}

describe("extractMkdtempPrefixes", () => {
  it("reads literal tmpdir prefixes in every call form and counts the rest", () => {
    const source = [
      'mkdtempSync(join(tmpdir(), "alpha-one-"));',
      "await fs.mkdtemp(path.join(os.tmpdir(), 'beta-two-'));",
      "nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), `gamma-${name}-`));",
      'mkdtemp(\n  path.join(\n    os.tmpdir(),\n    "delta-four-",\n  ),\n);',
      "mkdtemp(path.join(os.tmpdir(), prefix));",
      'mkdtemp(join(root, "not-temp-"));',
      'mkdtemp(path.join(os.tmpdir(), ""));',
    ].join("\n");
    const { prefixes, unresolved } = extractMkdtempPrefixes(source);
    assert.deepEqual(prefixes.sort(), ["alpha-one-", "beta-two-", "delta-four-", "gamma-${name}-"]);
    assert.equal(unresolved, 3);
  });
});

describe("compilePrefixMatcher", () => {
  const match = compilePrefixMatcher([
    "gg-npx-cache-",
    "gg-phase-binding-${name}-",
    "${short}-",
    "nested/dir-",
  ]);

  it("needs the exact prefix plus a six-character mkdtemp suffix", () => {
    assert.equal(match("gg-npx-cache-Ab12Cd"), "gg-npx-cache-");
    assert.equal(match("gg-npx-cache-Ab12C"), null);
    assert.equal(match("gg-npx-cache-Ab12Cd7"), null);
    assert.equal(match("gg-npx-cache-Ab12C!"), null);
    assert.equal(match("xgg-npx-cache-Ab12Cd"), null);
  });

  it("lets a template placeholder stand for one name segment only", () => {
    assert.equal(match("gg-phase-binding-alpha-Ab12Cd"), "gg-phase-binding-${name}-");
    assert.equal(match("gg-phase-binding-Ab12Cd"), null);
  });

  it("drops prefixes too vague or with a path separator, and knows run folders", () => {
    assert.equal(match("anything-Ab12Cd"), null);
    assert.equal(match("dir-Ab12Cd"), null);
    assert.equal(match(runName(Date.now(), 1)), "ggt-");
  });
});

describe("findCandidates", () => {
  const prefixes = ["gg-npx-cache-", "gg-logger-"];
  const matcher = compilePrefixMatcher(prefixes);

  it("picks only old, real, allowlisted folders and finished run folders", () => {
    const now = Date.now();
    makeDir("gg-npx-cache-Old111", { bytes: 100 });
    const withLink = makeDir("gg-logger-Old222", { bytes: 50 });
    link(outside, path.join(withLink, "escape"));
    fs.utimesSync(withLink, new Date(now - 2 * HOUR), new Date(now - 2 * HOUR));
    makeDir("gg-npx-cache-Young1", { ageMs: 0 });
    makeDir("nemo-Ab12Cd");
    makeDir("gg-npx-cache-TooLong1");
    fs.writeFileSync(path.join(base, "gg-npx-cache-FileAA"), "x");
    link(outside, path.join(base, "gg-npx-cache-LinkAA"));
    makeDir(runName(now - 2 * HOUR, 111));
    makeDir(runName(now - 2 * HOUR, 222));
    makeDir(runName(now - 10_000, 333));

    const candidates = findCandidates({ base, matcher, now, isAlive: (pid) => pid === 222 });
    assert.deepEqual(
      candidates.map((c) => c.name),
      ["gg-logger-Old222", "gg-npx-cache-Old111", runName(now - 2 * HOUR, 111)].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    const sizes = Object.fromEntries(candidates.map((c) => [c.name, c.bytes]));
    assert.equal(sizes["gg-npx-cache-Old111"], 100);
    // The junction inside is not followed, so the outside sentinel isn't counted.
    assert.equal(sizes["gg-logger-Old222"], 50);

    const summary = summarize(candidates);
    assert.equal(summary.count, 3);
    assert.equal(summary.bytes, 160);
    assert.deepEqual(
      summary.rows.map((r) => [r.prefix, r.count]),
      [
        ["gg-npx-cache-", 1],
        ["gg-logger-", 1],
        ["ggt-", 1],
      ],
    );
  });

  it("treats exactly one hour as old and just under as young", () => {
    const now = Date.now();
    makeDir("gg-npx-cache-AtHour", { ageMs: HOUR, now });
    makeDir("gg-npx-cache-Under1", { ageMs: HOUR - 1000, now });
    const names = findCandidates({ base, matcher, now }).map((c) => c.name);
    assert.deepEqual(names, ["gg-npx-cache-AtHour"]);
  });
});

describe("main", () => {
  function fixture() {
    makeDir("gg-npx-cache-Old111", { bytes: 2048 });
    const withLink = makeDir("gg-logger-Old222");
    link(outside, path.join(withLink, "escape"));
    const old = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(withLink, old, old);
    makeDir("gg-npx-cache-Young1", { ageMs: 0 });
    makeDir("nemo-Ab12Cd");
  }

  it("lists without deleting by default", () => {
    fixture();
    const before = fs.readdirSync(base).sort();
    const lines = [];
    assert.equal(main(["--base", base], { log: (line) => lines.push(line) }), 0);
    assert.deepEqual(fs.readdirSync(base).sort(), before);
    const output = lines.join("\n");
    assert.match(output, /gg-npx-cache-\s+1/);
    assert.match(output, /gg-logger-\s+1/);
    assert.match(output, /Total: 2 folders/);
    assert.match(output, /nothing deleted/);
  });

  it("deletes only the listed folders with --apply and never follows links", () => {
    fixture();
    const lines = [];
    assert.equal(main(["--apply", "--base", base], { log: (line) => lines.push(line) }), 0);
    assert.deepEqual(fs.readdirSync(base).sort(), ["gg-npx-cache-Young1", "nemo-Ab12Cd"]);
    assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "keep");
    assert.match(lines.join("\n"), /Removed 2 folders/);
  });

  it("rejects unknown arguments and a missing temp folder with exit code 2", () => {
    const quiet = () => {};
    assert.equal(main(["--force"], { log: quiet }), 2);
    assert.equal(main(["--base", path.join(base, "missing")], { log: quiet }), 2);
    assert.deepEqual(fs.readdirSync(base), []);
  });
});

describe("collectRepoPrefixes", () => {
  it("derives the allowlist from tracked source files", () => {
    const { prefixes, unresolved } = collectRepoPrefixes();
    assert.ok(prefixes.length > 400, `only ${prefixes.length} prefixes`);
    for (const known of ["gg-npx-cache-", "gg-installer-helper-", "gg-logger-"]) {
      assert.ok(prefixes.includes(known), `missing ${known}`);
    }
    assert.ok(unresolved > 0);
  });
});
