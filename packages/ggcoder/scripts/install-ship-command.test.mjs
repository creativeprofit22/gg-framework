import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalShipCommandPath,
  installShipCommand,
  resolveShipCommandTarget,
} from "./install-ship-command.mjs";

const command = await readFile(canonicalShipCommandPath, "utf8");

test("ship preserves release gates, Git restrictions, and verification rules", () => {
  assert.match(command, /Do not edit project files/i);
  assert.match(command, /Do not mutate the project unless the user explicitly approves/i);
  assert.match(command, /git status --short/);
  assert.match(command, /git diff --name-only HEAD~1 HEAD/);
  assert.match(command, /Ask before running:[\s\S]*installs or downloads/i);
  assert.match(command, /If a command fails, read the failure and classify it/i);
  assert.match(command, /Programmatic failures become ship blockers only after you read enough output/i);
  assert.match(command, /Local build, test, runtime, repository, and configuration evidence remains authoritative/i);
});

test("ship preserves release lanes, classifications, task policy, and report format", () => {
  for (const preserved of [
    "Build and runtime readiness",
    "Trace-style wiring risk",
    "Parity-style frontend/backend risk",
    "Regression blast radius",
    "BUILD-BLOCKER",
    "GATE-RISK",
    "PARITY-BLOCKER",
    "UNTESTED-BLAST-RADIUS",
    "add one task to the task pane",
    "Do not create vague tasks",
    "Ship scope: <resolved scope>",
    "Ship status: <BLOCKED|VERIFY FIRST|TRACK ITEMS|CLEAR>",
    "Tasks created. Press CTRL + T to open the task pane and run them.",
  ]) {
    assert.match(command, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("ship searches and shows curated Steroids evidence", () => {
  assert.match(command, /Search the curated Steroids corpus first/i);
  assert.match(command, /`action: "search"`/i);
  assert.match(command, /`action: "show"`/i);
  assert.match(command, /literal imports, build keys, route APIs, migration calls, middleware symbols/i);
  assert.match(command, /Whether Steroids grounding was used and what external pattern it informed/i);
});

test("ship automatically discovers corpus gaps but gates repository additions", () => {
  assert.match(command, /If Steroids reports a real corpus gap, automatically call `discover`/i);
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(command, /After approval, add only the selected repositories/i);
});

test("ship keeps external evidence below local release authority", () => {
  assert.match(command, /External evidence cannot prove local release behavior, business rules, readiness, or safety/i);
  assert.match(command, /Bake verified external patterns into tasks only when they inform a concrete fix/i);
});

test("ship removes deprecated research tools", () => {
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

test("installer atomically propagates canonical bytes to the global command path", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-ship-command-"));
  try {
    const result = await installShipCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "ship.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalShipCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveShipCommandTarget("relative/.gg"), /must be absolute/);
});
