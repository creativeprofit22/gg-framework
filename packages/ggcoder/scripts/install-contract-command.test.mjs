import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalContractCommandPath,
  installContractCommand,
  resolveContractCommandTarget,
} from "./install-contract-command.mjs";

const command = await readFile(canonicalContractCommandPath, "utf8");

test("contract preserves the previous audit workflow and local evidence boundary", () => {
  assert.match(command, /Follow real imports — do not guess/i);
  assert.match(command, /Trace deeper before calling anything ignored/i);
  assert.match(command, /Avoid false positives/i);
  assert.match(command, /Pre-bake the fix recipe/i);
  assert.match(command, /skim|inspect 2–3 real examples/i);
  assert.match(command, /prefer repos active in 2026\. Skip stale ones/i);
  assert.match(
    command,
    /Local declarations, consumers, tests, and runtime evidence are authoritative/i,
  );
  assert.match(command, /cannot prove local deadness, reachability, correctness, or business intent/i);
});

test("contract uses concrete Steroids operations", () => {
  assert.match(command, /`action: "search"`/i);
  assert.match(command, /`action: "show"`/i);
  assert.match(command, /repeat `search` and `show`/i);
});

test("contract discovers corpus gaps but gates repository additions", () => {
  assert.match(command, /If Steroids reports a real corpus gap, call `discover`/i);
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
});

test("contract preserves previous policy outside the semantic migration", () => {
  assert.match(
    command,
    /allowed-tools: tasks, Bash, Read, Write, Edit, Grep, Glob, steroids, ask_user/,
  );
  assert.match(command, /Do not edit any files/i);
  assert.doesNotMatch(command, /untrusted evidence/i);
  assert.doesNotMatch(command, /official documentation or installed source/i);
  assert.doesNotMatch(command, /repository revision, path, line range, and immutable URL/i);
  assert.doesNotMatch(command, /only permitted state changes/i);
});

test("contract removes deprecated research tools", () => {
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
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-contract-command-"));
  try {
    const result = await installContractCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "contract.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalContractCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveContractCommandTarget("relative/.gg"), /must be absolute/);
});
