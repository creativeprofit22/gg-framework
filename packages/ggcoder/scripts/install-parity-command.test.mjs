import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalParityCommandPath,
  installParityCommand,
  resolveParityCommandTarget,
} from "./install-parity-command.mjs";

const command = await readFile(canonicalParityCommandPath, "utf8");

test("parity preserves the previous audit workflow and local evidence boundary", () => {
  assert.match(command, /does one side expose, send, return, validate, authorize, cache/i);
  assert.match(command, /Use safe local evidence first/i);
  assert.match(command, /Every mismatch must be confirmed by reading the actual files/i);
  assert.match(command, /Build a parity matrix/i);
  assert.match(
    command,
    /External code cannot establish local business requirements, behavior, or feature parity/i,
  );
});

test("parity searches the curated Steroids corpus with concrete operations", () => {
  assert.match(command, /Search the curated Steroids corpus first/i);
  assert.match(command, /`action: "search"`/i);
  assert.match(command, /`action: "show"`/i);
  assert.match(command, /literal imports, APIs, config keys, hook names, decorators/i);
});

test("parity automatically discovers corpus gaps but gates repository additions", () => {
  assert.match(command, /If Steroids reports a real corpus gap, automatically call `discover`/i);
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(command, /After approval, add only the selected repositories/i);
});

test("parity preserves previous policy outside the semantic migration", () => {
  assert.match(
    command,
    /allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user/,
  );
  assert.match(command, /Do not edit project files/i);
  assert.match(command, /Do not install, download, migrate, generate, or mutate lockfiles/i);
  assert.match(command, /create one task-pane task per gap automatically/i);
  assert.match(command, /Do not create vague tasks/i);
});

test("parity removes deprecated research tools", () => {
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
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-parity-command-"));
  try {
    const result = await installParityCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "parity.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalParityCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveParityCommandTarget("relative/.gg"), /must be absolute/);
});
