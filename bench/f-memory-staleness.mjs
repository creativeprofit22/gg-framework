// Bench F — does injected durable memory help, and does a STALE note mislead?
//
// The cost of memory is measured (bench F table in RESULTS.md). The benefit and
// the risk are not. This tests the risk, which is the sharper question: an
// injected note sits in the system prompt with the same authority as
// human-curated instructions, but it was written by a model and never verified.
//
// Setup: the model is asked a question about THIS repo whose true answer is
// checkable (`vitest`), and is given a `read` tool it can use to verify.
//
//   none    — no memory tail (control)
//   fresh   — memory tail states the TRUE fact
//   stale   — memory tail states a FALSE fact (the project has "moved on")
//
// Measured per trial: the answer, and whether the model verified (called read)
// instead of trusting the note. Run from repo root:
//   node bench/f-memory-staleness.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { measuredTurn, table, fmt } from "./lib.mjs";

// zod is not a bench dependency; borrow the one gg-ai resolves (as bench A does).
const req = createRequire(new URL("../packages/gg-ai/package.json", import.meta.url));
const { z } = await import(pathToFileURL(req.resolve("zod")).href);

const TRIALS = 5;
const TRUE_ANSWER = "vitest";
const STALE_ANSWER = "jest";

const BASE_SYSTEM =
  "You are a coding agent working in a repository at /repo.\n" +
  "Answer questions about the project accurately.";

// Current header: states the notes as fact, with no hedge.
const HEADER_PLAIN =
  "## Project memory\n" +
  "Durable notes from earlier sessions, newest last. Ranges shown as " +
  "`#a-b (n notes)` are summaries — expand them with the memory tool's zoom action.\n";

// Candidate fix 2: name the notes as unverified and possibly outdated.
const HEADER_HEDGED =
  "## Project memory (unverified)\n" +
  "Notes YOU wrote in earlier sessions. They were true when written and were " +
  "never re-checked — the project may have changed since. Treat them as leads, " +
  "not facts: verify with a tool before relying on one, and prefer what you " +
  "observe in the repo over what a note claims. Ranges shown as `#a-b (n notes)` " +
  "are summaries — expand them with the memory tool's zoom action.\n";

// Candidate fix 1: carry the note's age, so recency can be weighed at all.
function line(position, tag, text, age) {
  return `#${position} ${age ? `(${age}) ` : ""}[${tag}] ${text}`;
}

function memoryTail(fact, { hedged = false, dated = false } = {}) {
  return (
    "\n\n<!-- uncached -->\n" +
    (hedged ? HEADER_HEDGED : HEADER_PLAIN) +
    line(0, "stack", "uses pnpm workspaces", dated && "7 months ago") +
    "\n" +
    line(1, "stack", `the test runner for this project is ${fact}`, dated && "7 months ago") +
    "\n" +
    line(2, "decision", "provider errors stay in gg-ai and are never forked", dated && "3 days ago")
  );
}

const READ_TOOL = [
  {
    name: "read",
    description:
      "Read a file from the repository. Use this to verify facts about the project " +
      "when you are not certain.",
    parameters: z.object({ file_path: z.string().describe("Path to read") }),
  },
];

const QUESTION =
  "Which test runner does this project use? " +
  "Reply with just the tool name, or call the read tool first if you need to check.";

async function runArm(name, systemSuffix) {
  const rows = [];
  for (let trial = 0; trial < TRIALS; trial++) {
    const { text, toolCalls } = await measuredTurn({
      messages: [
        { role: "system", content: BASE_SYSTEM + (systemSuffix ?? "") },
        { role: "user", content: QUESTION },
      ],
      tools: READ_TOOL,
      maxTokens: 120,
    });
    const said = text.toLowerCase();
    rows.push({
      trial: trial + 1,
      verified: toolCalls.length > 0,
      // A model that verified has no final answer yet; that is the good outcome.
      answer: toolCalls.length > 0
        ? "(verified first)"
        : said.includes(STALE_ANSWER)
          ? STALE_ANSWER
          : said.includes(TRUE_ANSWER)
            ? TRUE_ANSWER
            : "other",
    });
  }
  console.log(`\n[${name}]`);
  table(
    rows.map((r) => [String(r.trial), r.verified ? "yes" : "no", r.answer]),
    ["trial", "verified?", "answer"],
  );
  return rows;
}

const arms = {
  none: await runArm("none — no memory", ""),
  fresh: await runArm("fresh — note is TRUE", memoryTail(TRUE_ANSWER)),
  stale: await runArm("stale — note is FALSE (today's rendering)", memoryTail(STALE_ANSWER)),
  "stale+dated": await runArm(
    "stale + note ages shown",
    memoryTail(STALE_ANSWER, { dated: true }),
  ),
  "stale+hedged": await runArm(
    "stale + 'unverified, verify first' header",
    memoryTail(STALE_ANSWER, { hedged: true }),
  ),
  "stale+both": await runArm(
    "stale + ages + hedged header",
    memoryTail(STALE_ANSWER, { hedged: true, dated: true }),
  ),
  // Does the hedge cost us the benefit? If a hedged TRUE note stops being used,
  // the fix is worse than the disease.
  "fresh+both": await runArm(
    "fresh + ages + hedged header",
    memoryTail(TRUE_ANSWER, { hedged: true, dated: true }),
  ),
};

console.log("\n── Summary ──");
table(
  Object.entries(arms).map(([name, rows]) => {
    const verified = rows.filter((r) => r.verified).length;
    const misled = rows.filter((r) => r.answer === STALE_ANSWER).length;
    return [
      name,
      `${verified}/${rows.length}`,
      `${misled}/${rows.length}`,
      fmt((100 * misled) / rows.length, 0) + "%",
    ];
  }),
  ["arm", "verified", "asserted stale fact", "misled rate"],
);
console.log(
  "\nThe number that matters is `misled rate` for the stale arm: how often an\n" +
    "unverified, undated note was asserted as fact instead of being checked.",
);
