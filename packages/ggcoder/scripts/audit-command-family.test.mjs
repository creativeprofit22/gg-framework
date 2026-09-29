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
