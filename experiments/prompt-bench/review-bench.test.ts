import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  FIXTURES,
  isApproval,
  median,
  permittedPatch,
  replaceOnce,
  staticText,
  trial,
} from "./review-bench.js";
import { parseAutopilotVerdict } from "../../packages/ggcoder/src/core/autopilot-verdict.js";

const exec = promisify(execFile);

test("baseline extraction decodes static strings without executing repository code", () => {
  assert.equal(staticText('("one\\n" + `two\\`three` + "\\u2014");'), "one\ntwo`three—");
  assert.equal(staticText('`say "hi"`'), 'say "hi"');
  assert.equal(staticText(String.raw`"and \\"`), "and \\");
  assert.throws(() => staticText("`hello ${process.env.SECRET}`"));
  assert.throws(() => staticText('"ok" + process.exit()'));
  assert.throws(() => staticText('"\\x41"'));
});

test("baseline replacements fail closed on missing or duplicate sections", () => {
  assert.equal(replaceOnce("before old after", "old", "new"), "before new after");
  assert.throws(() => replaceOnce("no match", "old", "new"));
  assert.throws(() => replaceOnce("old old", "old", "new"));
  assert.throws(() => replaceOnce("anything", "", "new"));
});

test("medians handle even and odd samples without modifying raw observations", () => {
  const values = [12, 1, 8, 3];
  assert.equal(median(values), 5.5);
  assert.deepEqual(values, [12, 1, 8, 3]);
  assert.equal(median([9, 1, 5]), 5);
  assert.throws(() => median([]));
});

test("assessment does not misclassify Markdown failure reports or empty final responses", () => {
  assert.equal(isApproval("ideal", "Verification **failed** — not claiming success."), false);
  assert.equal(isApproval("ideal", "Blocker: required check unavailable."), false);
  assert.equal(isApproval("ideal", ""), false);
  assert.equal(isApproval("ideal", "The updated implementation passes the required checks."), true);
  assert.equal(isApproval("ken", "HUMAN\nThe required check failed."), false);
});

test("a warning in raw Ken output is not proof it survives the production parser", () => {
  const reply = "ALL_CLEAR\nCorpus comparison unavailable; user declined indexing.";
  assert.deepEqual(parseAutopilotVerdict(reply), { kind: "all_clear" });
});

test("model edits can only select the pre-authored safe repair", () => {
  const original = "export function subject(x) { return x || 1000; }";
  const target = "export function subject(x) { return x ?? 1000; }";
  assert.equal(permittedPatch(original, "||", "??", target), target);
  assert.throws(() => permittedPatch(original, "||", "|| 5 ||", target));
  assert.throws(() => permittedPatch(original, "missing", "??", target));
});

for (const fixture of FIXTURES) {
  test(`independent executable oracle: ${fixture.id}`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "gg-study-oracle-test-"));
    const checks =
      "import assert from 'node:assert/strict';\nimport { subject } from './subject.mjs';\n";
    try {
      await writeFile(path.join(cwd, "subject.mjs"), fixture.bad);
      await writeFile(path.join(cwd, "smoke.mjs"), checks + fixture.smoke);
      await writeFile(path.join(cwd, "oracle.mjs"), checks + fixture.oracle);
      const run = async (file: string) => {
        try {
          await exec(process.execPath, [file], { cwd, timeout: 3000, maxBuffer: 8192 });
          return true;
        } catch {
          return false;
        }
      };
      assert.equal(await run("smoke.mjs"), !fixture.checkFails);
      assert.equal(await run("oracle.mjs"), fixture.bad === fixture.good);
      await writeFile(path.join(cwd, "subject.mjs"), fixture.good);
      assert.equal(await run("oracle.mjs"), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("runtime benchmark blocks a real failed check before making any model call", async () => {
  const fixture = FIXTURES.find((f) => f.checkFails)!;
  const sample = await trial(fixture, "current", "ken", 1,
    { system: "test", ideal: "test", ken: "test" },
    { apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1" },
    AbortSignal.timeout(5000), true);
  assert.equal(sample.status, "complete");
  assert.equal(sample.hostBlocked, true);
  assert.equal(sample.approved, false);
  assert.equal(sample.modelCalls, 0);
  assert.equal(sample.inputTokens + sample.outputTokens + sample.cacheReadTokens, 0);
  assert.equal(sample.codeCorrect, true);
  assert.equal(sample.freshVerification, false);
});

test("benchmark subprocess cancellation settles instead of leaving a pending check", async () => {
  const controller = new AbortController();
  const running = exec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
    timeout: 3000,
  });
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
});
