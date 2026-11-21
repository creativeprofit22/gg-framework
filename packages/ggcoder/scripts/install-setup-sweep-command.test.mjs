import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TIERS } from "../assets/scripts/sweep-plan.mjs";
import {
  canonicalSetupSweepCommandPath,
  canonicalSweepScriptPaths,
  installSetupSweepCommand,
  resolveSetupSweepCommandTarget,
} from "./install-setup-sweep-command.mjs";

const commandBytes = await readFile(canonicalSetupSweepCommandPath);
const command = commandBytes.toString("utf8");
const templateStart = "### Project-local `/sweep` template\n\n````markdown\n";
const templateEnd = "\n````\n\n## Step 6: Verify generated files";

function extractProjectSweepTemplate(bytes) {
  const startMarker = Buffer.from(templateStart);
  const endMarker = Buffer.from(templateEnd);
  const markerStart = bytes.indexOf(startMarker);
  assert.notEqual(markerStart, -1, "project sweep template start marker is missing");
  const contentStart = markerStart + startMarker.length;
  const contentEnd = bytes.indexOf(endMarker, contentStart);
  assert.notEqual(contentEnd, -1, "project sweep template end marker is missing");
  assert.equal(
    bytes.indexOf(startMarker, contentStart),
    -1,
    "project sweep template is duplicated",
  );
  return bytes.subarray(contentStart, contentEnd);
}

const projectSweepBytes = extractProjectSweepTemplate(commandBytes);
const projectSweep = projectSweepBytes.toString("utf8");

test("setup-sweep preserves the existing generator workflow and safety policy", () => {
  assert.match(command, /generate a local `.gg\/commands\/sweep.md` and `.gg\/sweep.config.json`/i);
  assert.match(
    command,
    /Do \*\*not\*\* install dependencies, download ephemeral tools, or modify package files without explicit user confirmation/i,
  );
  assert.match(command, /three independent audit lanes: Prune, Refactor, Drift/i);
  assert.match(command, /generated `\/sweep` must not edit product code directly/i);
  assert.match(
    command,
    /Every generated task must be standalone, file-pinned, evidence-backed, and verifiable/i,
  );
});

test("setup-sweep documents Steroids and approval tools for its generated command", () => {
  assert.match(
    command,
    /allowed-tools: Bash, Read, Write, Edit, Grep, Glob, LS, subagent, steroids, ask_user/,
  );
  assert.match(command, /Steroids rule: use curated public code/i);
  assert.match(
    command,
    /never use external evidence to prove local deadness or business behavior/i,
  );
  assert.match(
    projectSweep,
    /allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user/,
  );
});

test("generated sweep template bytes remain exact and independently writable", async () => {
  assert.equal(
    createHash("sha256").update(projectSweepBytes).digest("hex"),
    "8b88bf6dbbdd144ea5c5f08cdc5398826c99b1e401f3ce5030b32158e6f000b6",
  );
  assert.equal(projectSweepBytes.includes(Buffer.from("\r\n")), false);

  const projectDir = await mkdtemp(path.join(tmpdir(), "gg-project-sweep-"));
  const generatedPath = path.join(projectDir, ".gg", "commands", "sweep.md");
  try {
    await mkdir(path.dirname(generatedPath), { recursive: true });
    await writeFile(generatedPath, projectSweepBytes);
    assert.deepEqual(await readFile(generatedPath), projectSweepBytes);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("generated sweep searches curated Steroids evidence before discovery", () => {
  assert.match(projectSweep, /Search the curated corpus first with `action: "search"`/i);
  assert.match(projectSweep, /literal imports, APIs, or recognizable implementation anchors/i);
  assert.match(projectSweep, /verify selected files with `action: "show"`/i);
  assert.match(
    projectSweep,
    /If Steroids reports a real corpus gap, automatically call `discover`/i,
  );
});

test("generated sweep gates repository additions on explicit approval", () => {
  assert.match(projectSweep, /use `ask_user` for approval before `add`/i);
  assert.match(projectSweep, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(
    projectSweep,
    /After approval, add only the selected repositories, repeat `search`/i,
  );
});

test("generated sweep keeps local evidence authoritative", () => {
  assert.match(
    projectSweep,
    /Do not use external evidence to prove deadness\. Deadness is local to this repo/i,
  );
  assert.match(
    projectSweep,
    /External evidence cannot establish local business behavior or prove local deadness/i,
  );
  assert.match(
    projectSweep,
    /external evidence cannot establish local business rules or behavior/i,
  );
  assert.match(
    projectSweep,
    /Do not let analyzer output become findings by itself\. Treat it as leads/i,
  );
});

test("setup-sweep generates scoped, verified analyzers and nested excludes", () => {
  assert.match(command, /"\*\*\/node_modules\/\*\*"/);
  assert.match(command, /"\.gg\/\*\*"/);
  assert.match(command, /"coverage": "files\|package\|repo"/);
  assert.match(command, /"skip": \[\]/);
  assert.match(command, /Never use angle brackets in generated commands/i);
  assert.match(command, /Run each safe analyzer once/i);
  assert.match(command, /A tracing command must find at least one known importer/i);
  assert.match(command, /Never propose fix, format-write, or codegen commands as analyzers/i);
  assert.match(command, /Always pass `--manifest-path`/);
});

test("generated sweep verifies lane findings and honors skips", () => {
  assert.match(projectSweep, /Verify before accepting: re-read the cited lines yourself/i);
  assert.match(
    projectSweep,
    /Assign severity from the scale below, not from the lane's suggestion/i,
  );
  assert.match(projectSweep, /silent failure handling/i);
  assert.match(projectSweep, /matching a `skip` entry in `\.gg\/sweep\.config\.json`/);
  assert.match(projectSweep, /prefer `coverage: files` or `package` commands/i);
  assert.match(projectSweep, /skip if the repo has only one commit/i);
});

test("generated sweep hands refactor work to the refactoring skill and /commit", () => {
  assert.match(projectSweep, /Use the `refactoring` skill's smell catalog and thresholds/);
  assert.match(projectSweep, /Follow the refactoring skill: green baseline first/);
  assert.match(projectSweep, /Rank hotspots/);
  assert.match(projectSweep, /Prune tasks come before Refactor tasks/);
  assert.match(projectSweep, /Commit first: run \/commit/);
  assert.match(projectSweep, /The sweep itself never commits/);
});

test("generated sweep always tells the user the next step", () => {
  assert.match(projectSweep, /Always end with one `Next:` line/);
  assert.match(projectSweep, /When the last one finishes, run \/sweep --merge/);
  assert.match(projectSweep, /all area sweeps are done\. Run \/sweep --merge/);
  assert.match(projectSweep, /For a whole-codebase pass, run \/sweep --map/);
  assert.match(
    projectSweep,
    /For every task, this line: `Before starting, commit any uncommitted changes/,
  );
});

test("generated sweep maps areas and merges fix tasks across sweeps", () => {
  assert.match(projectSweep, /--map \[focus\] \| --merge/);
  assert.match(projectSweep, /Give every source file exactly one owning area/);
  assert.match(projectSweep, /`cross-area contracts`/);
  assert.match(projectSweep, /Title: `Sweep: <area>`/);
  assert.match(
    projectSweep,
    /Consider only pending tasks titled `Fix \/sweep:`; never touch other tasks/,
  );
  assert.match(projectSweep, /already covered by a pending `Fix \/sweep:` task/);
});

test("setup-sweep and generated sweep remove deprecated research tools", () => {
  for (const removed of [
    "ken-mcp",
    "kencode-search",
    "referenceSources",
    "discoverRepos",
    "searchCode",
  ]) {
    assert.doesNotMatch(command, new RegExp(removed, "i"));
  }
});

test("installer atomically propagates canonical bytes without installing global sweep", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-setup-sweep-command-"));
  try {
    const result = await installSetupSweepCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "setup-sweep.md"));
    assert.deepEqual(await readFile(result.target), commandBytes);
    await assert.rejects(readFile(path.join(agentDir, "commands", "sweep.md")), { code: "ENOENT" });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveSetupSweepCommandTarget("relative/.gg"), /must be absolute/);
});

function configExample() {
  const match = /Use this shape:\n\n```json\n([\s\S]*?)\n```/.exec(command);
  assert.ok(match, "config example is missing");
  return JSON.parse(match[1]);
}

test("setup-sweep config gains reading tiers that match the planner", () => {
  const config = configExample();
  assert.deepEqual(Object.keys(config.readingTiers), [...TIERS]);
  for (const depth of Object.values(config.readingTiers)) {
    assert.ok(["full", "light", "automated"].includes(depth), depth);
  }
  assert.equal(config.readingTiers.source, "full");
  assert.equal(config.readingTiers.test, "light");
  assert.equal(config.readingTiers.docs, "light");
  assert.equal(config.readingTiers.config, "light");
  assert.equal(config.readingTiers.generated, "automated");
  assert.ok(Array.isArray(config.scopeResolution.generatedGlobs));
  assert.ok(Array.isArray(config.crossArea.pairs));
  assert.match(
    config.readingDepth.light,
    /^Open every assigned line range with the read tool, but check only this list:/,
  );
  assert.match(config.readingDepth.light, /Skip the Refactor smell review\.$/);
  assert.match(config.readingDepth.full, /all three lanes: Prune, Refactor/);
  assert.match(config.readingDepth.automated, /never as read/);
  assert.match(command, /Data files \(fixtures, i18n, schema or seed data\) go in `configGlobs`/);
  assert.match(command, /any `commands\/\*\.md` \(always source\)/);
});

test("setup-sweep stops when files match no pattern", () => {
  assert.match(command, /## Step 4\.5: Check every file has a tier/);
  assert.match(command, /scripts\/sweep-plan\.mjs" --out \.gg\/sweep\/setup-check\.json/);
  assert.match(command, /Exit 2: \*\*stop\.\*\* The planner lists files that match no pattern/);
  assert.match(
    command,
    /use `ask_user` once per group: source, test, docs, config\/data, generated, or exclude/,
  );
  assert.match(command, /Never guess a tier/);
  assert.match(command, /Planner check: <passed: N files in N chunks \| unavailable: reason>/);
});

test("generated sweep hands out whole-repo chunks in waves of helpers", () => {
  assert.match(projectSweep, /--all \| --resume \|/);
  assert.match(projectSweep, /ask_user, spawn_agent, wait_agent, Write/);
  assert.match(projectSweep, /waves of up to 8 helpers, the engine's `ACTIVE_LIMIT`/);
  assert.match(projectSweep, /`context_files: \["\.gg\/sweep\/notes\.md"\]`/);
  assert.match(projectSweep, /cover Prune, Refactor and Drift for these files only/);
  assert.match(projectSweep, /the whole reply under 30,000 characters/);
  assert.match(projectSweep, /At most 25 findings/);
  assert.match(projectSweep, /END-SWEEP-FINDINGS/);
  assert.match(projectSweep, /Wait with `wait_agent` for one `agent_id` at a time/);
  assert.match(
    projectSweep,
    /A chunk is \*\*partial\*\* when its output contains `\[output truncated at`/,
  );
  assert.match(projectSweep, /only the `read` tool counts as reading/);
});

test("generated sweep runs the ledger and retries unread chunks once", () => {
  assert.match(projectSweep, /--plan \.gg\/sweep\/plan\.json --helpers \.gg\/sweep\/helpers\.json/);
  assert.match(projectSweep, /--automated-tier \{tier\}/);
  assert.match(projectSweep, /hand out the chunks in `ledger\.retry`/);
  assert.match(projectSweep, /\*\*once\*\*, in waves/);
  assert.match(projectSweep, /same flags plus `--final`\. Do not retry again/);
});

test("generated sweep runs one cross-area pass", () => {
  assert.match(projectSweep, /### W7\. Cross-area pass/);
  assert.match(projectSweep, /Rust vs TypeScript types/);
  assert.match(projectSweep, /`generate_handler!` registrations vs frontend `invoke/);
  assert.match(projectSweep, /Lists that must match/);
  assert.match(projectSweep, /Docs vs code/);
  assert.match(projectSweep, /`crossArea\.pairs` from the config/);
});

test("generated sweep reports honest counts instead of files scanned", () => {
  assert.doesNotMatch(projectSweep, /Files scanned:/);
  assert.match(
    projectSweep,
    /^In scope: <N> files \(<source N, test N, docs N, config N, generated N, binary N>/m,
  );
  assert.match(projectSweep, /^Read \(receipt-backed\): <N> files — full: <N>; light: <N>/m);
  assert.match(projectSweep, /^Automated checks only: <N> files/m);
  assert.match(projectSweep, /^Unread: <N> files not fully read \(<cause N, \.\.\.>\)/m);
  assert.match(projectSweep, /^Partial chunks: <N>/m);
  assert.match(
    projectSweep,
    /Unread causes are per file, so they add up to the Unread file count: count each `ledger\.files\[\]` entry whose `status` is `unread` or `partial` once/,
  );
  assert.match(
    projectSweep,
    /comes first in this order: `changed-since-plan`, `never-assigned`, `evidence-unreadable`, `helper-failed`, `helper-timed-out`, `helper-skipped`\. `counts\.byCause` counts unread line ranges, not files; show it only as optional range-level detail/,
  );
  assert.match(
    projectSweep,
    /`counts\.byTier` for files; the Unread causes per file as Step 6 says/,
  );
  assert.match(projectSweep, /Counts must come from evidence, never from the file list alone/);
});

test("generated sweep resumes from plan and ledger without trusting changed files", () => {
  assert.match(projectSweep, /`\.gg\/sweep\/plan\.json`, `\.gg\/sweep\/ledger\.json`/);
  assert.match(projectSweep, /### Resume rules/);
  assert.match(projectSweep, /Never trust an old read of a changed file/);
  assert.match(projectSweep, /Compare `git rev-parse HEAD` with `plan\.gitCommit`/);
  assert.match(projectSweep, /`changed-since-plan`/);
  assert.match(
    projectSweep,
    /--previous \.gg\/sweep\/ledger\.prev\.json --previous-plan \.gg\/sweep\/plan\.prev\.json --final/,
  );
});

test("generated sweep moves a finished run's state to old- before planning again", () => {
  const w1 = projectSweep.slice(
    projectSweep.indexOf("### W1. Start or resume"),
    projectSweep.indexOf("### W2. Plan"),
  );
  assert.match(
    w1,
    /for `--all` when `run\.json` is missing or its stage is `done`: before W2, move any existing `plan\.json`, `ledger\.json`, `helpers\.json`, `run\.json`, `notes\.md`, `analyzers\.md`, `\*\.prev\.json`, `findings\/` and `findings\.prev\/` from `\.gg\/sweep\/` into `\.gg\/sweep\/old-\{YYYYMMDDHHMMSS\}\/`/,
  );
  assert.match(w1, /Leave `setup-check\.json` in place/);
  assert.match(
    projectSweep,
    /`--previous` applies only to a ledger written for the current `plan\.json`/,
  );
});

test("generated sweep keeps every helper attempt's findings instead of overwriting them", () => {
  const section = (start, end) =>
    projectSweep.slice(projectSweep.indexOf(start), projectSweep.indexOf(end));
  assert.doesNotMatch(projectSweep, /findings\/\{chunk\}\.json/);
  assert.doesNotMatch(projectSweep, /findings\/cross-area\.json/);
  assert.match(
    projectSweep,
    /`\.gg\/sweep\/findings\/\{chunk\}--\{agentId\}\.json`: one file per helper reply/,
  );
  assert.match(projectSweep, /Never overwrite a findings file\./);
  assert.match(
    section("### W5. Collect", "### W6."),
    /save its reply to `findings\/\{chunk\}--\{agentId\}\.json`[^\n]*never overwrite or merge into an existing findings file/,
  );
  assert.match(
    section("### W7. Cross-area pass", "### W8."),
    /save its reply to `findings\/cross-area--\{agentId\}\.json`/,
  );
  const w8 = section("### W8. Tasks and report", "### Resume rules");
  assert.match(w8, /Run Steps 4–5 over every file in `findings\/` and `findings\.prev\/`/);
  assert.match(w8, /Step 4's dedupe merges their repeated findings/);
});

test("generated sweep keeps previous-plan findings for unchanged files on resume", () => {
  const resume = projectSweep.slice(
    projectSweep.indexOf("### Resume rules"),
    projectSweep.indexOf("## Step 1: Resolve scope"),
  );
  assert.match(resume, /Move every file in `findings\/` into `findings\.prev\/`/);
  assert.match(
    resume,
    /remove from those moved files the `findings` and `crossArea` entries whose file changed \(`changed-since-plan`\)/,
  );
  assert.match(resume, /findings for unchanged files must not stay in `findings\/`/);
  assert.match(
    projectSweep,
    /`\.gg\/sweep\/findings\.prev\/`: findings from earlier plans of this run/,
  );
});

test("generated sweep keeps narrow scopes with the same honest counts", () => {
  assert.match(
    projectSweep,
    /If `\$ARGUMENTS` is `--all` or `--resume`, follow \*\*Whole-repo run\*\*/,
  );
  assert.match(projectSweep, /## Step 3: Dispatch three audit lanes/);
  assert.match(projectSweep, /Narrow scopes: in scope comes from the scope map and tier globs/);
  assert.match(projectSweep, /a lane's receipt shows an `ok` `read` of it/);
  assert.match(projectSweep, /`lane receipts, file-level`/);
});

test("installer also installs the sweep planner and ledger scripts", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-setup-sweep-scripts-"));
  try {
    const result = await installSetupSweepCommand({ agentDir });
    assert.equal(result.scripts.length, canonicalSweepScriptPaths.length);
    for (const [index, source] of canonicalSweepScriptPaths.entries()) {
      const target = path.join(agentDir, "scripts", path.basename(source));
      const bytes = await readFile(source);
      assert.equal(result.scripts[index].target, target);
      assert.equal(result.scripts[index].sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(await readFile(target), bytes);
      execFileSync(process.execPath, [target, "--help"], { stdio: "pipe" });
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("generated sweep sends a chunk in W4 only when it has no helper record and unread ranges", () => {
  const section = (start, end) =>
    projectSweep.slice(projectSweep.indexOf(start), projectSweep.indexOf(end));
  const w4 = section("### W4. Waves", "### W5. Collect");
  assert.match(
    w4,
    /A chunk is \*\*pending\*\* only when all of these hold: its tier is not marked `automated` in `readingTiers`; it has no record in `helpers\.json`; and, when `ledger\.json` exists for the current `plan\.json`, at least one of its ranges there \(ranges whose `chunk` is its id\) has a status other than `read` or `automated`\./,
  );
  assert.match(w4, /reads carried over by \*\*Resume rules\*\* step 2, is not sent again/);
  assert.match(
    w4,
    /Unread ranges of chunks that already have a `helpers\.json` record go only through W6's single retry, never back through W4\./,
  );
  assert.doesNotMatch(w4, /when resuming: also chunks with unread ranges/);
  assert.match(
    section("### Resume rules", "## Step 1: Resolve scope"),
    /3\. Continue at W4 with the chunks that are \*\*pending\*\* under W4's rule \(no `helpers\.json` record and, in the current `ledger\.json`, at least one range not `read` or `automated`\)/,
  );
});

test("generated sweep always gives the ledger a helpers file", () => {
  const section = (start, end) =>
    projectSweep.slice(projectSweep.indexOf(start), projectSweep.indexOf(end));
  const w2 = section("### W2. Plan", "### W3. Analyzers and shared notes");
  assert.match(
    w2,
    /- Exit 0: continue\.[^\n]*On a fresh run, write `\[\]` to `\.gg\/sweep\/helpers\.json` and set `run\.json` stage to `plan`/,
  );
  assert.ok(
    w2.indexOf("write `[]` to `.gg/sweep/helpers.json`") > w2.indexOf("- Exit 0: continue."),
    "W2 must initialize helpers.json only after the planner exits 0",
  );
  const resume = section("### Resume rules", "## Step 1: Resolve scope");
  assert.match(
    resume,
    /1\. [^\n]*If `helpers\.json` is missing, write `\[\]` to it first\.[^\n]*run the ledger as in W6 \(without `--final`\)[^\n]*Exit 4 is expected here[^\n]*continue\. Exit 1: stop and show the error\./,
  );
  assert.match(
    resume,
    /2\. [^\n]*--final` plus the `--automated-tier` flags\. This `--final` run normally exits 4[^\n]*Exit 1: stop and show the error\./,
  );
});
