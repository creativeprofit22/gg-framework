import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalFlowCommandPath,
  installFlowCommand,
  resolveFlowCommandTarget,
} from "./install-flow-command.mjs";

const command = await readFile(canonicalFlowCommandPath, "utf8");

test("flow preserves the previous audit workflow and local evidence boundary", () => {
  assert.match(command, /Use the live driver to actually click through where useful/i);
  assert.match(command, /Follow real imports, real event subscriptions, real route handlers/i);
  assert.match(command, /Avoid false positives/i);
  assert.match(command, /Pre-bake the fix recipe/i);
  assert.match(command, /inspect 2–3 real examples/i);
  assert.match(command, /prefer repos active in 2026 and skip stale ones/i);
  assert.match(
    command,
    /cannot prove local deadness, reachability, correctness, or business intent/i,
  );
});

test("flow searches the curated Steroids corpus with concrete operations", () => {
  assert.match(command, /Search the curated Steroids corpus first/i);
  assert.match(command, /`action: "search"`/i);
  assert.match(command, /`perRepo: 1`/i);
  assert.match(command, /`action: "show"`/i);
  assert.match(command, /Use `repos` to check indexed-repository activity/i);
});

test("flow automatically discovers corpus gaps but gates repository additions", () => {
  assert.match(command, /automatically call `discover`/i);
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(command, /After approval, add only the selected repositories/i);
});

test("flow preserves previous policy outside the semantic migration", () => {
  assert.match(
    command,
    /allowed-tools: tasks, Bash, Read, Write, Edit, Grep, Glob, steroids, ask_user/,
  );
  assert.match(command, /Do not edit any files/i);
  assert.match(command, /Do not guess ports or start servers without explicit confirmation/i);
  assert.match(command, /For Low findings .* do NOT auto-create tasks/i);
  assert.match(command, /Do not create vague tasks/i);
});

test("flow removes deprecated research tools", () => {
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
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-flow-command-"));
  try {
    const result = await installFlowCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "flow.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalFlowCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveFlowCommandTarget("relative/.gg"), /must be absolute/);
});
