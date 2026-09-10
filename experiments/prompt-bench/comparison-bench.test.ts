import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { COMPARISON_FIXTURES } from "./comparison-fixtures.js";
import { ARMS, PROJECT_CONTEXT, buildComparisonPrompts } from "./comparison-prompts.js";
import { containerCheck, fixturePath, grade, makeSandbox, schedule, QUICK_FIXTURES, QUICK_LIMITS, REPEAT20_FIXTURES, REPEAT20_LIMITS, REPEAT20_ORDERS } from "./comparison-bench.js";

async function promptFixture(preserveResponses = false) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-comparison-unit-"));
  try {
    await fs.writeFile(path.join(cwd, "AGENTS.md"), PROJECT_CONTEXT);
    return await buildComparisonPrompts(cwd, preserveResponses);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}
test("216 trials; every fixture has all six arm orders, deterministically", () => {
  const jobs = schedule(6); assert.equal(jobs.length * 3, 216);
  assert.deepEqual(jobs, schedule(6));
  for (const f of COMPARISON_FIXTURES) {
    const blocks = jobs.filter(b => b.fixture.id === f.id);
    assert.equal(new Set(blocks.map(b => b.arms.join())).size, 6);
    for (const a of ARMS) assert.equal(blocks.flatMap(b=>b.arms).filter(x=>x===a).length, 6);
  }
});
test("quick screening has eighteen trials and balanced order within a ten-minute cap", () => {
  const jobs = schedule(QUICK_LIMITS.rounds, QUICK_FIXTURES);
  assert.equal(jobs.length, 6);
  assert.equal(jobs.flatMap(j => j.arms).length, 18);
  assert.equal(new Set(jobs.map(j => j.arms.join())).size, 6);
  for (const arm of ARMS) for (const position of [0, 1, 2])
    assert.equal(jobs.filter(j => j.arms[position] === arm).length, 2);
  assert.equal(QUICK_LIMITS.overallMs, 600_000);
  assert.equal(QUICK_LIMITS.trialMs, 90_000);
});
test("twenty trials per arm have identical task mix and balanced, distinct execution orders", () => {
  const jobs = schedule(REPEAT20_LIMITS.rounds, REPEAT20_FIXTURES, REPEAT20_ORDERS);
  assert.equal(REPEAT20_FIXTURES.length, 10);
  assert.equal(jobs.length, 20);
  assert.deepEqual(jobs, schedule(2, REPEAT20_FIXTURES, REPEAT20_ORDERS));
  assert.equal(new Set(jobs.flatMap(j => j.arms.map(a => `${j.fixture.id}:${j.round}:${a}`))).size, 60);
  for (const arm of ARMS) {
    assert.equal(jobs.flatMap(j => j.arms).filter(a => a === arm).length, 20);
    for (const position of [0, 1, 2]) {
      const count = jobs.filter(j => j.arms[position] === arm).length;
      assert.ok(count === 6 || count === 7);
    }
  }
  for (const fixture of REPEAT20_FIXTURES) {
    const blocks = jobs.filter(j => j.fixture.id === fixture.id);
    assert.equal(blocks.length, 2);
    assert.equal(new Set(blocks.map(j => j.arms.join())).size, 2);
  }
  assert.throws(() => schedule(2, REPEAT20_FIXTURES, [0]));
  assert.throws(() => schedule(2, REPEAT20_FIXTURES, Array(20).fill(6)));
});
test("response-controlled variants preserve talk, reminders and skill bodies exactly", async () => {
  const p = await promptFixture(true);
  const talk = (text: string) => text.split("## How to Talk\n")[1]?.split(/\n## /)[0]?.trim();
  assert.ok(talk(p.current.system));
  for (const arm of ARMS) {
    assert.equal(talk(p[arm].system), talk(p.current.system));
    assert.equal(p[arm].system.split("## How to Talk\n").length, 2);
    assert.equal(p[arm].ideal, p.current.ideal);
    assert.equal(p[arm].drift, p.current.drift);
    assert.deepEqual(p[arm].skills, p.current.skills);
  }
  assert.ok(!p.extreme.system.includes("Expand when requested or necessary for evidence."));
  assert.ok(p.extreme.system.length < p.proposed.system.length);
  assert.ok(p.proposed.system.length < p.current.system.length);
});
test("paths are contained and fixed fixture identities are accepted", () => {
  assert.equal(fixturePath("/workspace/subject.mjs"), "subject.mjs");
  for (const p of ["../secret", "/etc/passwd", "a/../b", "a\\b", "", "a//b"]) assert.throws(() => fixturePath(p));
});
test("variants are concrete, current keeps duplicates, alternatives preserve catalog discovery", async () => {
  const p = await promptFixture();
  assert.ok(p.current.system.includes("nothing is exempt"));
  assert.ok(!p.proposed.system.includes("nothing is exempt"));
  assert.ok(p.current.system.includes("## Skills"));
  assert.ok(!p.proposed.system.includes("## Skills"));
  assert.ok(p.current.skillDescription.includes("Available skills:"));
  assert.ok(p.proposed.skillDescription.includes("Available skills:"));
  assert.ok(p.extreme.skillDescription.includes("Available skills:"));
  assert.ok(!p.extreme.system.includes("## Skills"));
  assert.ok(p.extreme.system.length < p.proposed.system.length * 0.5);
  assert.ok(p.proposed.system.length < p.current.system.length);
  for(const arm of ARMS)assert.equal(p[arm].skills.length, 10);
});
test("sandbox rejects unapproved changes, stale writes, and nonallowlisted shell commands", async () => {
  const p = await promptFixture(); const f = COMPARISON_FIXTURES[0]!; const box = makeSandbox(f,p.current);
  const invoke = async (name:string,args:unknown) => box.tools.find(t=>t.name===name)!.execute(args,{ signal:AbortSignal.timeout(30_000),toolCallId:"unit" });
  await assert.rejects(invoke("write",{file_path:"subject.mjs",content:f.good["subject.mjs"]}));
  await assert.rejects(invoke("write",{file_path:"package.json",content:"{}"}));
  await assert.rejects(invoke("bash",{command:"npm install unrequested-package"}));
  assert.equal(box.files["package.json"],f.files["package.json"]);
  await invoke("read",{file_path:"subject.mjs"});
  await invoke("write",{file_path:"subject.mjs",content:f.good["subject.mjs"]});
  const score = grade(f,box,"Done","complete",true);
  assert.equal(score.verificationEvidence,false,"Correct-looking code does not prove a check ran");
  assert.equal(score.safeEdits,false,"Earlier rejected unsafe attempts remain visible");
});
test("TDD grading rejects test and source edits without a failing test run", async () => {
  const p = await promptFixture();
  const f = COMPARISON_FIXTURES.find(f => f.kind === "tdd")!;
  const box = makeSandbox(f, p.current);
  for (const file of ["subject.test.mjs", "subject.mjs"]) {
    const context = { signal: AbortSignal.timeout(30_000), toolCallId: "unit" };
    await box.tools.find(t => t.name === "read")!.execute({ file_path: file }, context);
    await box.tools.find(t => t.name === "write")!.execute({ file_path: file, content: f.good[file] }, context);
  }
  assert.equal(box.state().sourceEdited, true);
  assert.equal(box.state().redBeforeSource, false);
  assert.equal(grade(f, box, "Done", "complete", true).scopePreserved, false);
});

test("analysis discloses zero-usage provider failures instead of dividing by zero", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-comparison-analysis-"));
  try {
    await fs.writeFile(path.join(cwd, "protocol.json"), JSON.stringify({
      model: "fixture", thinking: "off", jobs: [{ fixture: "failure", round: 0, arms: ARMS }],
    }));
    for (const arm of ARMS) {
      await fs.writeFile(path.join(cwd, `failure-0-${arm}.json`), JSON.stringify({
        fixture: "failure", round: 0, arm, passed: false, score: 0, status: "provider_error",
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: null,
        wallMs: 1, modelTurns: 0, calls: [], researchCalls: 0, checkCalls: 0, redundantChecks: 0,
        unnecessaryQuestions: 0, hookCalls: 0, retries: 0, providerMs: 0, firstResponseMs: null,
        toolMs: 0, checks: { completed: false }, safetyViolations: [],
      }));
    }
    const result = JSON.parse(execFileSync("python3", [
      fileURLToPath(new URL("./comparison-analyze.py", import.meta.url)), cwd,
    ], { encoding: "utf8", timeout: 30_000 }));
    assert.equal(result.trials, 3);
    for (const row of result.summary) {
      assert.equal(row.cacheReadFraction, null);
      assert.equal(row.strictPasses, 0);
      assert.deepEqual(row.statuses, { provider_error: 1 });
      assert.equal(row.failures.length, 1);
    }
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test("hidden graders reject seeded defects and accept independently authored reference solutions", { timeout: 120_000 }, async () => {
  for (const f of COMPARISON_FIXTURES) {
    if (!f.oracle) continue;
    const bad = await containerCheck(f.files,f.oracle);
    assert.equal(bad.passed,f.kind === "explain",`${f.id}: seeded-defect oracle`);
    const good = await containerCheck({...f.files,...f.good},f.oracle);
    assert.equal(good.passed,true,`${f.id}: reference-solution oracle: ${good.output}`);
    const smoke = await containerCheck({...f.files,...f.good},null);
    assert.equal(smoke.passed,true,`${f.id}: positive-control public tests: ${smoke.output}`);
  }
});
test("execution container has no external interface, writable fixture, or GG credentials", { timeout: 30_000 }, async () => {
  const result = await containerCheck({}, `import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os';
assert.ok(Object.values(os.networkInterfaces()).flat().every(x=>x.internal));
assert.throws(()=>fs.writeFileSync('/workspace/unauthorized','x'));
assert.equal(process.env.ZAI_API_KEY,undefined);assert.equal(process.env.GLM_API_KEY,undefined);
assert.equal(fs.existsSync('/root/.gg/auth.json'),false);`);
  assert.equal(result.passed,true,result.output);
});
