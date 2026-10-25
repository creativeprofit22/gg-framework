import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const commandsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/commands",
);
const family = ["trace", "parity", "contract", "flow", "ship"];

async function readCommand(name) {
  return (await readFile(path.join(commandsDir, `${name}.md`), "utf8")).replace(/\r\n/g, "\n");
}

function familyBlock(text) {
  const start = text.indexOf("## Audit family rules");
  assert.notEqual(start, -1, "missing Audit family rules section");
  const next = text.indexOf("\n## ", start + 1);
  assert.notEqual(next, -1, "Audit family rules section is not followed by a step");
  return text.slice(start, next);
}

test("every audit command carries an identical family rules block", async () => {
  const blocks = await Promise.all(
    family.map(async (name) => familyBlock(await readCommand(name))),
  );
  for (const [index, block] of blocks.entries()) {
    assert.equal(block, blocks[0], `${family[index]}.md family rules drifted from trace.md`);
  }
});

test("family rules define ownership, canonical types, dedupe, and asking", async () => {
  const block = familyBlock(await readCommand("trace"));
  for (const name of family) {
    assert.match(block, new RegExp(`\\| \`/${name}\`\\s+\\|`));
  }
  for (const type of [
    "DROPPED-INPUT",
    "PARTIAL-WIRING",
    "STALE-STATE",
    "RELEASE-BLOCKER",
    "VERIFY-FIRST",
  ]) {
    assert.match(block, new RegExp(`\`${type}\``));
  }
  assert.match(block, /call `tasks` with `action: "list"`/);
  assert.match(block, /Already tracked/);
  assert.match(block, /Every task title must end with ` \[<CANONICAL-TYPE> <file>:<line>\]`/);
  assert.match(block, /bracketed `\[<CANONICAL-TYPE> <file>:<line>\]` title suffix matches/);
  assert.match(block, /Routed/);
  assert.match(block, /Ask every question with `ask_user`, never as plain text/);
  assert.match(block, /at most 6 items in one question/);
});

// Frontmatter check only: custom commands do not enforce `allowed-tools` at
// runtime, so the family rules must say the no-edit rule is instruction-only.
test("audit commands declare no write or edit tools", async () => {
  assert.match(
    familyBlock(await readCommand("trace")),
    /`allowed-tools` frontmatter is advisory[^\n]*enforced by instruction only/,
  );
  for (const name of family) {
    const text = await readCommand(name);
    const tools = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? "";
    assert.doesNotMatch(tools, /\b(Write|Edit)\b/, `${name}.md grants write access`);
  }
});

test("empty scope audits the whole chat and recent narrows to the latest work", async () => {
  const block = familyBlock(await readCommand("trace"));
  assert.match(block, /\*\*Empty \(default\): the whole chat\.\*\*/);
  assert.match(block, /from its first message — not only the latest turn/);
  assert.match(block, /\*\*`recent`: the latest unit of work only\*\*/);
  for (const name of family) {
    const text = await readCommand(name);
    assert.match(text, /If `\$ARGUMENTS` is empty, [^\n]*following the Scope rule above/, name);
    assert.doesNotMatch(text, /If `\$ARGUMENTS` is empty or equals `recent`/, name);
  }
});

test("every task prompt carries a canonical type", async () => {
  for (const name of family) {
    assert.match(await readCommand(name), /Canonical type from the Audit family rules/, name);
  }
});

test("every task title format carries the dedupe suffix", async () => {
  for (const name of family) {
    assert.match(
      await readCommand(name),
      new RegExp(`\`Fix /${name}: <[^>]+> \\[<CANONICAL-TYPE> <file>:<line>\\]\``),
      name,
    );
  }
});

test("ship covers contract and journey lanes and defers to existing audit tasks", async () => {
  const ship = await readCommand("ship");
  assert.match(ship, /### Lane C2 — Contract and journey risk/);
  assert.match(ship, /CONTRACT-BLOCKER/);
  assert.match(ship, /JOURNEY-BLOCKER/);
  assert.match(ship, /verification status handoff/);
  assert.match(ship, /already covers the finding, do not duplicate it/);
});

const mappedGaps = {
  parity: [
    "UI-MISSING",
    "BACKEND-MISSING",
    "SHAPE-MISMATCH",
    "VALIDATION-DRIFT",
    "PERMISSION-DRIFT",
    "ERROR-DRIFT",
    "CACHE-DRIFT",
    "EVENT-DRIFT",
    "DOC-TEST-DRIFT",
    "VERIFY-FIRST",
  ],
  trace: [
    "Dropped config",
    "Silent default",
    "Missing env wiring",
    "Stale wrapper",
    "Partial wiring",
    "Missing gate",
    "Dead export",
    "Shape mismatch",
    "Schema drift",
    "Event drift",
    "Verification gap",
  ],
  contract: ["IGNORED", "PARTIAL", "STUB", "DOCUMENTED-ONLY", "FACADE", "PHANTOM"],
};

function mappingTable(text) {
  const start = text.indexOf("Canonical type mapping. Use the mapped type; never pick another:");
  assert.notEqual(start, -1, "missing canonical type mapping");
  const lines = text.slice(start).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  assert.notEqual(first, -1, "canonical type mapping has no table");
  assert.match(lines[first + 1] ?? "", /^\| -+ \| -+ \|$/, "mapping table separator");
  const rows = new Map();
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) break;
    const [gap, type] = line
      .split("|")
      .slice(1, 3)
      .map((cell) => cell.trim());
    assert.ok(gap && type, `malformed mapping row: ${line}`);
    assert.ok(!rows.has(gap), `duplicate mapping row: ${gap}`);
    rows.set(gap, type);
  }
  return rows;
}

test("each gap-type command maps every own gap to one shared canonical type", async () => {
  const block = familyBlock(await readCommand("trace"));
  for (const [name, gaps] of Object.entries(mappedGaps)) {
    const rows = mappingTable(await readCommand(name));
    assert.deepEqual([...rows.keys()].sort(), [...gaps].sort(), `${name}.md mapping rows`);
    for (const [gap, type] of rows) {
      assert.match(type, /^`[A-Z-]+`$/, `${name}.md ${gap} must map to exactly one type`);
      assert.ok(block.includes(type), `${name}.md maps ${gap} to unknown type ${type}`);
    }
    // Prose next to the table must not override it; that splits dedupe keys.
    const text = await readCommand(name);
    assert.doesNotMatch(text, /maps to `[A-Z-]+` instead/, `${name}.md overrides its mapping`);
  }
});

test("audit commands ask only through ask_user", async () => {
  for (const name of family) {
    assert.doesNotMatch(await readCommand(name), /ask a clarifying question/i, name);
  }
});

test("family rules cap expansion at one hop", async () => {
  assert.match(
    familyBlock(await readCommand("trace")),
    /\*\*Expansion limit\.\*\* Expand at most one hop from in-scope files[^\n]*under `Out of scope`/,
  );
});

test("task prompts name exact test files and filtered commands", async () => {
  for (const name of Object.keys(mappedGaps)) {
    const text = await readCommand(name);
    assert.match(
      text,
      /- Verification: the exact test file\(s\) covering the fix and the filtered command[^\n]*`pnpm --filter <pkg> exec vitest run <file>`[^\n]*Never root `pnpm test`, `lint` or `check`\./,
      name,
    );
    assert.doesNotMatch(text, /Targeted verification command|targeted verification command/, name);
  }
});

test("audits do not run repo-wide checks", async () => {
  for (const name of ["parity", "contract"]) {
    const text = await readCommand(name);
    assert.match(text, /Do not run typecheck, lint or test suites during the audit\./, name);
    assert.doesNotMatch(text, /Examples: `typecheck`, `lint`/, name);
  }
  assert.match(
    await readCommand("trace"),
    /verification commands from project config: list them for task prompts; do not run them/,
  );
});

test("reports stay concise and say N/A when nothing is created", async () => {
  const block = familyBlock(await readCommand("trace"));
  assert.match(block, /\*\*Report\.\*\* Keep the reply as short as possible/);
  assert.match(block, /Leave out summary lines whose value is zero or n\/a/);
  assert.match(block, /`Routed: <N>` and `Already tracked: <N>` only when non-zero/);
  assert.match(
    block,
    /If this run created no tasks, the first line of the reply is exactly `N\/A`[^\n]*otherwise `N\/A` is the whole reply\./,
  );
  assert.match(block, /only for `Routed`, `Needs decision` or `Skipped` entries/);
  assert.ok(block.includes("an `N/A` reply omits it"), "coverage rule must exempt N/A replies");
  for (const name of family) {
    const text = await readCommand(name);
    assert.match(
      text,
      /^Chat work covered: <one short item per area, or n\/a>$/m,
      `${name}.md summary lacks the Chat work covered: line the Coverage rule points to`,
    );
    for (const line of ["Files scanned:", "Scope confidence: <", "Mode: <", "Paths traced:"]) {
      assert.ok(!text.includes(line), `${name}.md report still prints ${line}`);
    }
  }
});
