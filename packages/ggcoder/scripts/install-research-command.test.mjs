import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalResearchCommandPath,
  installResearchCommand,
  resolveResearchCommandTarget,
} from "./install-research-command.mjs";

const command = await readFile(canonicalResearchCommandPath, "utf8");

function position(text) {
  const index = command.indexOf(text);
  assert.notEqual(index, -1, `missing contract text: ${text}`);
  return index;
}

function assertOrdered(...parts) {
  const positions = parts.map(position);
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index - 1] < positions[index],
      `${parts[index - 1]} must precede ${parts[index]}`,
    );
  }
}

test("Ken discovery is first, filtered, ordered, and conditionally code-searchable", () => {
  assert.match(
    command,
    /mandatory first-priority external discovery system[\s\S]*First call `mcp__kencode-search__referenceSources`/,
  );
  assert.match(command, /domain, category, stack, style, query, and result-count filters matched/);
  assertOrdered(
    "First call `mcp__kencode-search__referenceSources`",
    "Next call `mcp__kencode-search__discoverRepos`",
    "Use `mcp__kencode-search__searchCode` only when that capability is actually exposed",
    "Only after the applicable Ken MCP calls may you use `tool_search`",
  );
  assert.match(command, /paginate with increasing `offset` values/);
  assert.match(command, /Never invent, rename, or simulate a missing Ken tool/);
});

test("Ken failures require prominent, exact fallback disclosure", () => {
  assert.match(command, /disclose that prominently near the start of the report/);
  assert.match(command, /name the exact fallback used for that capability/);
  assert.match(command, /\*\*Ken MCP status and fallback disclosure\*\*/);
  assert.match(command, /All applicable Ken capabilities succeeded; no fallback used/);
});

test("technical and design branches enforce quality, diversity, and provenance", () => {
  assert.match(command, /### Technical research[\s\S]*official contracts[\s\S]*dependency weight/);
  assert.match(
    command,
    /### Design research[\s\S]*component silhouettes[\s\S]*reduced-motion behavior/,
  );
  assert.match(command, /Western, Asian, and other non-obvious regional sources/);
  assert.match(command, /Do not apply geographic quotas when geography is irrelevant/);
  assert.match(
    command,
    /inspect its real repository files, tests, examples, dependency manifests, maintenance state, and license/,
  );
  assert.match(
    command,
    /deprecated, abandoned, tutorial-only, generated, copied, or legally unclear/,
  );
  assert.match(command, /proprietary or unlicensed visual references as read-only evidence/);
});

test("candidate floors and three-round saturation remain auditable", () => {
  assert.match(
    command,
    /at least eight serious candidates and three materially different pattern families/,
  );
  assert.match(command, /three consecutive rounds produce only repeats/);
  assert.match(command, /Show the final three no-gain rounds as saturation evidence/);
  assert.match(command, /### Query and rejection ledger/);
  assert.match(command, /Log every serious rejected candidate and its concrete rejection reason/);
  assert.match(command, /Never use stars as proof/);
});

test("accepted evidence requires immutable, licensed, transferable citations", () => {
  assert.match(command, /clickable immutable revision URL/);
  assert.match(command, /exact path and line range/);
  assert.match(command, /license and provenance status/);
  assert.match(
    command,
    /https:\/\/github\.com\/<owner>\/<repo>\/blob\/<revision>\/<path>#L<start>-L<end>/,
  );
  assert.match(
    command,
    /never transfer literal code, assets, copy, branding, class names, or identity/,
  );
  assert.match(command, /mutable branch links as final citations/);
});

test("report-only contract prohibits every mutating workflow", () => {
  for (const prohibition of [
    "Never enter plan mode",
    "edit project source",
    "install dependencies",
    "change Git state",
    "create tasks",
    "call roadmap tools",
    "implement recommendations",
  ]) {
    assert.match(command, new RegExp(prohibition, "i"));
  }
  assert.match(command, /Do not call `roadmap_inspect`, `roadmap_phase_draft`, `roadmap_status`/);
  assert.match(
    command,
    /Local inspection and read-only commands are allowed only to gather evidence/,
  );
});

test("installer atomically propagates canonical bytes to the global command path", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "gg-research-command-"));
  try {
    const result = await installResearchCommand({ agentDir });
    assert.equal(result.target, path.join(agentDir, "commands", "research.md"));
    assert.deepEqual(await readFile(result.target), await readFile(canonicalResearchCommandPath));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("installer rejects relative global roots", () => {
  assert.throws(() => resolveResearchCommandTarget("relative/.gg"), /must be absolute/);
});
