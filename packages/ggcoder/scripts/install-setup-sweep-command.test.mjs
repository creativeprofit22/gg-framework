import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalSetupSweepCommandPath,
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
  assert.equal(bytes.indexOf(startMarker, contentStart), -1, "project sweep template is duplicated");
  return bytes.subarray(contentStart, contentEnd);
}

const projectSweepBytes = extractProjectSweepTemplate(commandBytes);
const projectSweep = projectSweepBytes.toString("utf8");

test("setup-sweep preserves the existing generator workflow and safety policy", () => {
  assert.match(command, /generate a local `.gg\/commands\/sweep.md` and `.gg\/sweep.config.json`/i);
  assert.match(command, /Do \*\*not\*\* install dependencies, download ephemeral tools, or modify package files without explicit user confirmation/i);
  assert.match(command, /three independent audit lanes: Prune, Refactor, Drift/i);
  assert.match(command, /generated `\/sweep` must not edit product code directly/i);
  assert.match(command, /Every generated task must be standalone, file-pinned, evidence-backed, and verifiable/i);
});

test("setup-sweep documents Steroids and approval tools for its generated command", () => {
  assert.match(command, /allowed-tools: Bash, Read, Write, Edit, Grep, Glob, LS, subagent, steroids, ask_user/);
  assert.match(command, /Steroids rule: use curated public code/i);
  assert.match(command, /never use external evidence to prove local deadness or business behavior/i);
  assert.match(projectSweep, /allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user/);
});

test("generated sweep template bytes remain exact and independently writable", async () => {
  assert.equal(
    createHash("sha256").update(projectSweepBytes).digest("hex"),
    "ac58d776744079738f42d7830055e15cc0505ef17338f59247182e0eb77269dd",
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
  assert.match(projectSweep, /If Steroids reports a real corpus gap, automatically call `discover`/i);
});

test("generated sweep gates repository additions on explicit approval", () => {
  assert.match(projectSweep, /use `ask_user` for approval before `add`/i);
  assert.match(projectSweep, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(projectSweep, /After approval, add only the selected repositories, repeat `search`/i);
});

test("generated sweep keeps local evidence authoritative", () => {
  assert.match(projectSweep, /Do not use external evidence to prove deadness\. Deadness is local to this repo/i);
  assert.match(projectSweep, /External evidence cannot establish local business behavior or prove local deadness/i);
  assert.match(projectSweep, /external evidence cannot establish local business rules or behavior/i);
  assert.match(projectSweep, /Do not let analyzer output become findings by itself\. Treat it as leads/i);
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
