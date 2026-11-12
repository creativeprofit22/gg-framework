import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalUxPlanCommandPath,
  installUxPlanCommand,
  resolveUxPlanCommandTarget,
} from "./install-ux-plan-command.mjs";

const command = await readFile(canonicalUxPlanCommandPath, "utf8");

function assertPreserved(...values) {
  for (const value of values) {
    assert.match(command, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
}

test("ux-plan preserves its one-area audit-before-plan scope", () => {
  assertPreserved(
    "one piece",
    "`/ux-plan` does not do its own audit",
    "No audit doc, no plan",
    "One plan, one area",
    "## Cross-cutting findings",
    "## Per-area audit",
    "## Recommended rebuild order",
    "Every change traces to a finding in the audit",
  );
});

test("ux-plan preserves implementation and local rendered evidence requirements", () => {
  assertPreserved(
    "locate the actual code",
    "pin every change to `file:line`",
    "Read sibling screens too",
    "Local code and locally rendered evidence remain authoritative",
    "eyes screenshot probe",
    "Do not edit source files",
    "The plan doc is the only write",
  );
});

test("ux-plan preserves responsive and accessibility boundaries", () => {
  assertPreserved(
    "Form-factor stance",
    "Desktop-primary / mobile-first / equal",
    "mobile note",
    "External references cannot prove local UI behavior, usability, responsiveness, accessibility, or product requirements",
  );
});

test("ux-plan preserves plan-file, testing, and approval policy", () => {
  assertPreserved(
    ".gg/plans/NN-<slug>.md",
    "The plan doc is the contract for plan-mode execution",
    "No new dependencies",
    "No backend / domain / router changes",
    "Each Vitest/Playwright case names the finding it covers",
    "Review the plan and approve to start execution",
  );
});

test("ux-plan preserves its fixed plan and report formats", () => {
  assertPreserved(
    "## Why this exists",
    "## What it becomes",
    "## Hard constraints",
    "## File-level plan",
    "### Files we DON'T touch (defensive list)",
    "## Tests",
    "## Verification gate",
    "## Risks & mitigations",
    "## Out of scope (explicit)",
    "Single flat numbered list",
    "Audit:       <audit-doc-path>",
    "Findings covered: <N>",
    "Files touched: <N> new, <N> changed, <N> on do-not-touch list",
    "Tests planned: <N> unit, <N> e2e",
  );
});

test("ux-plan searches and shows curated Steroids evidence", () => {
  assert.match(command, /search the curated Steroids corpus first/i);
  assert.match(command, /`action: "search"`/i);
  assert.match(command, /scoped to the cited repository when known/i);
  assert.match(command, /literal component, route, state, or layout anchors/i);
  assert.match(command, /retain its immutable URL/i);
  assert.match(command, /`action: "show"`/i);
  assert.match(command, /same curated-first Steroids `search` and `show` sequence/i);
});

test("ux-plan automatically discovers corpus gaps but gates repository additions", () => {
  assert.match(command, /If Steroids reports a real corpus gap, automatically call `discover`/i);
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(command, /After approval, add only the selected repositories/i);
});

test("ux-plan removes deprecated research tools without changing the cited repository", () => {
  for (const removed of [
    "ken-mcp",
    "kencode-search",
    "referenceSources",
    "discoverRepos",
    "searchCode",
  ]) {
    assert.doesNotMatch(command, new RegExp(removed, "i"));
  }
  assert.match(command, /KenKaiii\/king\/src\/renderer\/src\/pages\/CreateAdsPage\.tsx/);
});

test("installer atomically propagates canonical bytes to the global command path", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-ux-plan-command-"));
  try {
    const result = await installUxPlanCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "ux-plan.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalUxPlanCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveUxPlanCommandTarget("relative/.gg"), /must be absolute/);
});
