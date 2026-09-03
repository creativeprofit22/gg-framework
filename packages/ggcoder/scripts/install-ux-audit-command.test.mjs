import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalUxAuditCommandPath,
  installUxAuditCommand,
  resolveUxAuditCommandTarget,
} from "./install-ux-audit-command.mjs";

const command = await readFile(canonicalUxAuditCommandPath, "utf8");

function assertPreserved(...values) {
  for (const value of values) {
    assert.match(command, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
}

test("ux-audit preserves scope, screen mapping, and four-shape classification", () => {
  assertPreserved(
    "wizard / workbench / worklist / config",
    "Feasibility & scope gate",
    "Persona discovery",
    "desktop-primary",
    "mobile-first",
    "full UI surface audit",
    "build a flat list of every top-level user-facing route",
    "Pin every finding to `file:line`",
  );
});

test("ux-audit preserves local and rendered evidence requirements", () => {
  assertPreserved(
    "UX grounded in code and pixels",
    ".gg/eyes/visual.sh",
    "1400×1800",
    "390×844",
    "static-only mode",
    "Pixel-level findings",
    "Read code before classifying",
    "Do not flag from screenshots alone",
    "Every High/Critical finding cites `file:line` in the audited project",
  );
});

test("ux-audit preserves finding types, accessibility boundary, and severity model", () => {
  assertPreserved(
    "LEAKY-VOCABULARY",
    "WRONG-SHAPE",
    "MISSING-NEXT-ACTION",
    "GLORIFIED-SPREADSHEET",
    "CHATTY-WIZARD",
    "DEAD-END",
    "CONFIG-IN-PRIMARY",
    "DOC-ONLY",
    "MOBILE-BROKEN",
    "MOBILE-CRAMPED",
    "COULD-BE-SIMPLER",
    "Accessibility — that's `/wcag-audit`'s job",
    "Critical",
    "High",
    "Medium",
    "Low",
    "Form-factor stance modulates mobile severity",
  );
});

test("ux-audit preserves task policy and report contract", () => {
  assertPreserved(
    "For every Critical / High / Medium finding, add one task to the task pane",
    "One task per finding",
    "For Low findings (COULD-BE-SIMPLER): do NOT auto-create tasks",
    "If a finding is too ambiguous to write a concrete fix for, mark it Skipped",
    "Do not create vague tasks",
    "Audited: <scope>",
    "Mode: <eyes / static-only>",
    "Routes mapped: <N>",
    "Tasks created: <N> (Critical/High/Medium auto-tasked)",
    "Audit doc: .gg/plans/<filename>.md",
    "Do not edit source files",
  );
});

test("ux-audit searches and shows curated Steroids evidence", () => {
  assert.match(command, /search the curated Steroids corpus first/i);
  assert.match(command, /`action: "search"`/i);
  assert.match(command, /literal component, route, state, or layout anchors/i);
  assert.match(command, /`perRepo: 1`/i);
  assert.match(command, /`action: "show"`/i);
  assert.match(command, /owner\/name`, file path, lines, and the immutable URL retained from `search`/i);
});

test("ux-audit automatically discovers corpus gaps but gates repository additions", () => {
  assert.match(command, /If Steroids reports a real corpus gap, automatically call `discover`/i);
  assert.match(command, /use `ask_user` for approval before `add`/i);
  assert.match(command, /never call `add` or `discover` with `add: true` before approval/i);
  assert.match(command, /After approval, add only the selected repositories/i);
});

test("ux-audit keeps external references below local UI evidence", () => {
  assert.match(command, /Local code and locally rendered evidence remain authoritative/i);
  assert.match(
    command,
    /External references cannot prove local UI behavior, usability, responsiveness, accessibility, or product requirements/i,
  );
  assert.match(command, /downgrade the finding to "needs reference" rather than inventing one/i);
});

test("ux-audit removes deprecated research tools", () => {
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
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-ux-audit-command-"));
  try {
    const result = await installUxAuditCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "ux-audit.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalUxAuditCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveUxAuditCommandTarget("relative/.gg"), /must be absolute/);
});
