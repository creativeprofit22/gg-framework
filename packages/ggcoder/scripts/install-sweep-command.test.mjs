import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalSweepCommandPath,
  installSweepCommand,
  resolveSweepCommandTarget,
} from "./install-sweep-command.mjs";

const commandBytes = await readFile(canonicalSweepCommandPath);
const command = commandBytes.toString("utf8");
const setupSweep = await readFile(
  new URL("../assets/commands/setup-sweep.md", import.meta.url),
  "utf8",
);

const templateStart = "### Project-local `/sweep` template\n\n````markdown\n";
const templateEnd = "\n````\n\n## Step 6: Verify generated files";
const projectSweep = setupSweep.slice(
  setupSweep.indexOf(templateStart) + templateStart.length,
  setupSweep.indexOf(templateEnd),
);

test("canonical sweep bytes are pinned", () => {
  assert.equal(
    createHash("sha256").update(commandBytes).digest("hex"),
    "aff046c4a2a36e11ff5a45b708fa888464a2ee765b410fbda765b64db8a8cf7d",
  );
  assert.equal(commandBytes.includes(Buffer.from("\r\n")), false);
});

test("standalone sweep preserves its intentional fallback behavior", () => {
  assert.notEqual(command, projectSweep);
  assert.match(command, /This global fallback works in any repo/i);
  assert.match(command, /Continue with baseline no-install sweep now\? \[y\/N\]/i);
  assert.match(command, /Only continue if the user confirms/i);
  assert.match(command, /Mode: <project-config \| baseline fallback>/i);
  assert.doesNotMatch(projectSweep, /Mode: <project-config \| baseline fallback>/i);
});

test("standalone sweep searches curated Steroids evidence before discovery", () => {
  assert.match(
    command,
    /allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user/,
  );
  assert.match(command, /Search the curated corpus first with `action: "search"`/i);
  assert.match(command, /literal imports, APIs, or recognizable implementation anchors/i);
  assert.match(command, /verify selected files with `action: "show"`/i);
  assert.match(command, /If Steroids reports a real corpus gap, automatically call `discover`/i);
});

test("standalone sweep gates repository additions on explicit approval", () => {
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(command, /After approval, add only the selected repositories, repeat `search`/i);
});

test("standalone sweep keeps local evidence authoritative", () => {
  assert.match(
    command,
    /Do not use external evidence to prove deadness\. Deadness is local to this repo/i,
  );
  assert.match(
    command,
    /External evidence cannot establish local business behavior or prove local deadness/i,
  );
  assert.match(command, /external evidence cannot establish local business rules or behavior/i);
  assert.match(command, /Analyzer output is a lead, not a finding by itself/i);
});

test("standalone sweep verifies lane findings and honors skips", () => {
  assert.match(command, /Verify before accepting: re-read the cited lines yourself/i);
  assert.match(command, /silent failure handling/i);
  assert.match(command, /matching a `skip` entry in `\.gg\/sweep\.config\.json`/);
  assert.match(command, /skip if the repo has only one commit/i);
});

test("standalone sweep hands refactor work to the refactoring skill and /commit", () => {
  assert.match(command, /Use the `refactoring` skill's smell catalog and thresholds/);
  assert.match(command, /Follow the refactoring skill: green baseline first/);
  assert.match(command, /Commit first: run \/commit/);
  assert.match(command, /The sweep itself never commits/);
});

test("standalone sweep always tells the user the next step", () => {
  assert.match(command, /Always end with one `Next:` line/);
  assert.match(command, /all area sweeps are done\. Run \/sweep --merge/);
  assert.match(command, /For a whole-codebase pass, run \/sweep --map/);
  assert.match(
    command,
    /For every task, this line: `Before starting, commit any uncommitted changes/,
  );
});

test("standalone sweep maps areas and merges fix tasks across sweeps", () => {
  assert.match(command, /--map \[focus\] \| --merge/);
  assert.match(command, /Give every source file exactly one owning area/);
  assert.match(
    command,
    /Consider only pending tasks titled `Fix \/sweep:`; never touch other tasks/,
  );
  assert.match(command, /already covered by a pending `Fix \/sweep:` task/);
});

test("standalone sweep removes deprecated research tools", () => {
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

test("installer atomically propagates canonical sweep bytes", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-sweep-command-"));
  try {
    const result = await installSweepCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "sweep.md"));
    assert.deepEqual(await readFile(result.target), commandBytes);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveSweepCommandTarget("relative/.gg"), /must be absolute/);
});
