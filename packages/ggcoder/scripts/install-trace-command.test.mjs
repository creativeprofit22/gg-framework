import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalTraceCommandPath,
  installTraceCommand,
  resolveTraceCommandTarget,
} from "./install-trace-command.mjs";

const command = await readFile(canonicalTraceCommandPath, "utf8");

function assertPreserved(...values) {
  for (const value of values) {
    assert.match(command, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
}

test("trace preserves scope resolution, evidence rules, and path tracing", () => {
  assertPreserved(
    "Do not edit project files",
    "Git diff",
    "Active plan",
    "Session context",
    "Build a scope map",
    "Do not install tools, download ephemeral analyzers",
    "Analyzer/search output is a lead, not a finding",
    "Entry Points → Orchestration → Capability Modules → External",
    "Track every layer boundary in a trace matrix",
    "Follow real imports and function calls",
    "React Query invalidation",
  );
});

test("trace preserves gap classifications, task policy, and report format", () => {
  assertPreserved(
    "Dropped config",
    "Silent defaults",
    "Partial wiring",
    "Missing gates",
    "Shape mismatches",
    "VERIFY-FIRST",
    "add one task per accepted gap to the task pane",
    "Do not use the `goals` tool and do not ask for confirmation",
    "Do not create vague tasks",
    "Traced: <capability inferred or provided>",
    "Gaps found: <N> (<N Critical, N High, N Medium, N Low>)",
    "Tasks created. Press CTRL + T to open the task pane and run them.",
  );
});

test("trace searches and shows curated Steroids evidence", () => {
  assert.match(command, /Search the curated Steroids corpus first/i);
  assert.match(command, /`action: "search"`/i);
  assert.match(command, /`action: "show"`/i);
  assert.match(command, /literal routing, server-action, cache, IPC, decorator, ORM, plugin/i);
  assert.match(command, /Whether Steroids grounding affected classification and the exact external\/framework pattern/i);
});

test("trace automatically discovers corpus gaps but gates repository additions", () => {
  assert.match(command, /If Steroids reports a real corpus gap, automatically call `discover`/i);
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(command, /After approval, add only the selected repositories/i);
});

test("trace keeps external evidence below local reachability authority", () => {
  assert.match(command, /Local imports, callers, types, configuration, and runtime wiring remain authoritative/i);
  assert.match(command, /External evidence cannot prove local reachability, local deadness, or business behavior/i);
  assert.match(command, /Use external evidence only to avoid false positives around external conventions/i);
});

test("trace removes deprecated research tools", () => {
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
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-trace-command-"));
  try {
    const result = await installTraceCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "trace.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalTraceCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveTraceCommandTarget("relative/.gg"), /must be absolute/);
});
