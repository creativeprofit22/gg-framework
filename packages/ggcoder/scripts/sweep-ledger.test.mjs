import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  buildLedger,
  extractReads,
  finalReport,
  loadSessionChain,
  main,
  missingRanges,
  normalizeToolPath,
  parseCoverageClaims,
  parseReceipt,
  planPathIndex,
  readSeen,
  serializeLedger,
} from "../assets/scripts/sweep-ledger.mjs";
import { buildPlan, serializePlan } from "../assets/scripts/sweep-plan.mjs";

const ROOT = "/repo";
const lines = (n) => Buffer.from("x\n".repeat(n));
const scope = () => ({
  excludeGlobs: [".gg/**"],
  sourceGlobs: ["**/*.ts"],
  testGlobs: [],
  routeGlobs: [],
  configGlobs: [],
  docsGlobs: ["**/*.md"],
});

function makePlan() {
  const result = buildPlan({
    files: [
      { path: "src/a.ts", content: lines(600) },
      { path: "src/big.ts", content: lines(2000) },
      { path: "docs/guide.md", content: lines(10) },
    ],
    config: { scopeResolution: scope() },
  });
  assert.equal(result.ok, true);
  return result.plan;
}

const numbered = (start, end) =>
  Array.from(
    { length: end - start + 1 },
    (_, i) => `${String(start + i).padStart(6, " ")}\tx`,
  ).join("\n");

/** Engine-shaped entries: one assistant turn of tool calls, their results, then the report. */
function entriesFor(calls, report = "Done.") {
  const msg = (message, i) => ({
    type: "message",
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    timestamp: "2026-11-04T00:00:00.000Z",
    message,
  });
  const out = [];
  for (const c of calls) {
    out.push({
      role: "assistant",
      content: [{ type: "tool_call", id: c.id, name: c.name ?? "read", args: c.args }],
    });
    if (c.result !== undefined) {
      out.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: c.id, ...c.result }],
      });
    }
  }
  out.push({ role: "assistant", content: [{ type: "text", text: report }] });
  return out.map(msg);
}

const session = (calls, report, cwd = ROOT) => ({
  ok: true,
  header: { type: "session", id: "s", cwd },
  entries: entriesFor(calls, report),
  files: ["/sessions/s.jsonl"],
  problems: [],
  chainBroken: false,
});

const read = (id, file, start, end, extra = {}) => ({
  id,
  args: { file_path: file, ...(extra.offset ? { offset: extra.offset } : {}) },
  result: { content: extra.text ?? numbered(start, end) },
});

const fullReads = () => [
  read("r1", "src/a.ts", 1, 600),
  read("r2", "/repo/src/big.ts", 1, 1800, { offset: 1 }),
  read("r3", "src/big.ts", 1801, 2000, { offset: 1801 }),
];

const helper = (over = {}) => ({ agentId: "h1", chunk: "source-001", state: "completed", ...over });

function ledgerFor({ calls, report, helpers = [helper()], sessions, ...rest }) {
  return buildLedger({
    plan: makePlan(),
    helpers,
    sessions: sessions ?? new Map([["h1", session(calls, report)]]),
    platform: "linux",
    root: ROOT,
    ...rest,
  });
}

const rangeOf = (ledger, p, start = 1) =>
  ledger.files.find((f) => f.path === p).ranges.find((r) => r.start === start);

test("a full read of every assigned range counts as read", () => {
  const ledger = ledgerFor({ calls: fullReads() });
  assert.equal(ledger.files.find((f) => f.path === "src/a.ts").status, "read");
  assert.equal(ledger.files.find((f) => f.path === "src/big.ts").status, "read");
  assert.deepEqual(rangeOf(ledger, "src/a.ts").evidence, [
    { agentId: "h1", toolCallId: "r1", start: 1, end: 600 },
  ]);
  assert.equal(rangeOf(ledger, "docs/guide.md").cause, "never-assigned");
  assert.equal(ledger.counts.read, 3);
  assert.equal(ledger.counts.unread, 1);
  assert.equal(ledger.counts.byCause["never-assigned"], 1);
});

test("a partial page read is helper-skipped until another read fills the gap", () => {
  const truncated = `${numbered(1, 1200)}\n[Truncated: showing lines 1-1200 of 2000. Use offset=1201 to read more.]`;
  const calls = [
    read("r1", "src/a.ts", 1, 600),
    read("r2", "src/big.ts", 0, 0, { text: truncated }),
  ];
  const partial = ledgerFor({ calls });
  const page1 = rangeOf(partial, "src/big.ts", 1);
  assert.equal(page1.status, "unread");
  assert.equal(page1.cause, "helper-skipped");
  assert.match(page1.detail, /lines 1201-1800 not shown/);
  assert.deepEqual(page1.evidence, [{ agentId: "h1", toolCallId: "r2", start: 1, end: 1200 }]);
  assert.equal(partial.files.find((f) => f.path === "src/big.ts").status, "unread");

  const filled = ledgerFor({
    calls: [
      ...calls,
      read("r3", "src/big.ts", 1201, 1800, { offset: 1201 }),
      read("r4", "src/big.ts", 1801, 2000, { offset: 1801 }),
    ],
  });
  assert.equal(rangeOf(filled, "src/big.ts", 1).status, "read");
  assert.equal(filled.files.find((f) => f.path === "src/big.ts").status, "read");
});

test("a cut-short receipt falls back to the session", () => {
  const receipt = "Receipt (40 calls): read src/a.ts, …/src/big.ts ×2 · +12 more";
  const ledger = ledgerFor({ calls: fullReads(), helpers: [helper({ receipt })] });
  assert.equal(ledger.helpers[0].receiptCutShort, true);
  assert.equal(ledger.helpers[0].evidence, "session");
  assert.equal(ledger.files.find((f) => f.path === "src/big.ts").status, "read");
  assert.deepEqual(parseReceipt(receipt).reads, [
    { target: "src/a.ts", outcome: "ok" },
    { target: "…/src/big.ts", outcome: "ok" },
  ]);
});

test("a missing session: a full receipt can only show what was not read", () => {
  const receipt = "Receipt (1 call): read src/a.ts";
  const ledger = ledgerFor({ helpers: [helper({ receipt })], sessions: new Map() });
  assert.equal(rangeOf(ledger, "src/a.ts").cause, "evidence-unreadable");
  assert.equal(rangeOf(ledger, "src/big.ts", 1).cause, "helper-skipped");
  assert.equal(rangeOf(ledger, "src/big.ts", 1801).cause, "helper-skipped");
  assert.equal(ledger.helpers[0].evidence, "receipt-only");
  assert.deepEqual(ledger.helpers[0].problems, ["no saved session"]);

  const cut = ledgerFor({
    helpers: [helper({ receipt: "Receipt (30 calls): read src/a.ts · +9 more" })],
    sessions: new Map(),
  });
  assert.equal(rangeOf(cut, "src/big.ts", 1).cause, "evidence-unreadable");

  const none = ledgerFor({ helpers: [helper()], sessions: new Map() });
  assert.equal(none.counts.byCause["evidence-unreadable"], 3);
  assert.equal(none.helpers[0].evidence, "none");
});

test("failed and unfinished reads never count", () => {
  const calls = [
    {
      id: "r1",
      args: { file_path: "src/a.ts" },
      result: { content: "File not found: /repo/src/a.ts" },
    },
    {
      id: "r2",
      args: { file_path: "src/big.ts" },
      result: { content: numbered(1, 1800), isError: true },
    },
    { id: "r3", args: { file_path: "src/big.ts", offset: 1801 } },
  ];
  const reads = extractReads(entriesFor(calls));
  assert.deepEqual(
    reads.map((r) => r.status),
    ["failed", "failed", "pending"],
  );
  const ledger = ledgerFor({ calls });
  assert.equal(rangeOf(ledger, "src/a.ts").cause, "helper-skipped");
  assert.match(rangeOf(ledger, "src/a.ts").detail, /read failed: File not found/);
  assert.match(rangeOf(ledger, "src/big.ts", 1801).detail, /a read never finished/);
  assert.equal(ledger.counts.read, 0);
});

test("a file changed after planning is not retried and stays unread", () => {
  const plan = makePlan();
  const ledger = ledgerFor({
    calls: [
      read("r2", "src/big.ts", 1, 1800),
      read("r3", "src/big.ts", 1801, 2000, { offset: 1801 }),
    ],
    currentHashes: new Map([
      ["src/a.ts", "0".repeat(64)],
      ["src/big.ts", plan.files.find((f) => f.path === "src/big.ts").sha256],
      ["docs/guide.md", null],
    ]),
  });
  assert.equal(rangeOf(ledger, "src/a.ts").cause, "changed-since-plan");
  assert.equal(rangeOf(ledger, "docs/guide.md").cause, "changed-since-plan");
  assert.equal(rangeOf(ledger, "docs/guide.md").detail, "file is gone");
  assert.equal(rangeOf(ledger, "src/big.ts", 1).status, "read");
  assert.deepEqual(ledger.retry, []);
  assert.deepEqual(
    ledger.stillUnread.map((s) => `${s.path}:${s.cause}`),
    ["docs/guide.md:changed-since-plan", "src/a.ts:changed-since-plan"],
  );
});

test("coverage claims the reads don't back are flagged", () => {
  const report = [
    "Findings: none.",
    "- Checked: src/a.ts:1-500, src/a.ts:1-100",
    "Reviewed: `src/other.ts`",
    "Read: docs/guide.md",
    "All files in this chunk are clean.",
  ].join("\n");
  const receipt = "Receipt (1 call): read src/a.ts\nNot opened by this helper: src/ghost.ts";
  const ledger = ledgerFor({
    calls: [read("r1", "src/a.ts", 1, 200, { text: numbered(1, 200) })],
    report,
    helpers: [helper({ receipt })],
  });
  const flags = ledger.unbackedClaims.map((c) => `${c.claim} | ${c.reason}`);
  assert.ok(flags.includes("src/a.ts:1-500 | lines 201-500 were not shown to this helper"));
  assert.ok(flags.includes("src/other.ts | not a file in the sweep plan"));
  assert.ok(flags.includes("docs/guide.md | not assigned to this helper"));
  assert.ok(
    flags.some((f) =>
      f.startsWith("All files in this chunk are clean. | 3 assigned ranges not read"),
    ),
  );
  assert.ok(flags.includes("src/ghost.ts | named in the report but never opened (engine receipt)"));
  assert.ok(!flags.some((f) => f.startsWith("src/a.ts:1-100")));
  // Flags never change coverage.
  assert.equal(rangeOf(ledger, "src/a.ts").status, "unread");

  assert.deepEqual(parseCoverageClaims("Checked: src/x.ts (lines 12-40)"), [
    { kind: "path", path: "src/x.ts", start: 12, end: 40, text: "src/x.ts (lines 12-40)" },
  ]);
  assert.deepEqual(parseCoverageClaims("I could not check all files in this chunk."), []);
});

test("Windows paths in every spelling map to the plan file", () => {
  const root = "E:\\repo";
  const norm = (raw, cwd = root) => normalizeToolPath(raw, cwd, root, "win32", "C:\\Users\\me");
  for (const raw of [
    "E:\\repo\\src\\A.ts",
    "e:/repo/src/a.ts",
    "/e/repo/src/a.ts",
    "//e/repo/src/a.ts",
    "/cygdrive/e/repo/src/a.ts",
    "src\\a.ts",
  ]) {
    assert.equal(norm(raw)?.toLowerCase(), "src/a.ts", raw);
  }
  assert.equal(norm("..\\a.ts", "E:\\repo\\src"), "a.ts");
  assert.equal(norm("D:\\repo\\src\\a.ts"), null);
  assert.equal(norm("E:\\other\\a.ts"), null);
  assert.equal(
    normalizeToolPath("~/repo/a.ts", "/x", "/home/me/repo", "linux", "/home/me"),
    "a.ts",
  );
  assert.equal(planPathIndex(makePlan(), "win32").find("SRC/A.TS"), "src/a.ts");
  assert.equal(planPathIndex(makePlan(), "linux").find("SRC/A.TS"), null);

  const ledger = buildLedger({
    plan: makePlan(),
    helpers: [helper()],
    sessions: new Map([
      [
        "h1",
        session(
          [
            read("r1", "/e/repo/src/A.ts", 1, 600),
            read("r2", "E:\\REPO\\src\\big.ts", 1, 1800),
            read("r3", "src\\big.ts", 1801, 2000, { offset: 1801 }),
          ],
          "Done.",
          "e:\\repo",
        ),
      ],
    ]),
    platform: "win32",
    root,
  });
  assert.equal(ledger.files.find((f) => f.path === "src/a.ts").status, "read");
  assert.equal(ledger.files.find((f) => f.path === "src/big.ts").status, "read");
});

test("capped results count only the line runs actually shown", () => {
  const capped = `${numbered(1, 250)}\n\n[... 9000 characters omitted ...]\n\n${numbered(400, 600)}`;
  assert.deepEqual(readSeen(capped, { capped: true }).seen, [
    { start: 1, end: 249 },
    { start: 401, end: 600 },
  ]);
  const stored = `${numbered(1, 250)}\n\n[Session storage truncated this tool result. Re-run the tool.]\n\n${numbered(400, 600)}`;
  assert.deepEqual(readSeen(stored, {}).seen, [{ start: 1, end: 600 }]);
  assert.deepEqual(
    readSeen("[Line 7 is too long to show (90000 bytes). Use bash]", { offset: 7 }).seen,
    [{ start: 7, end: 7 }],
  );
  assert.equal(readSeen(numbered(5, 9), {}).status, "failed");
  assert.deepEqual(missingRanges(1, 10, [{ start: 3, end: 4 }]), [
    { start: 1, end: 2 },
    { start: 5, end: 10 },
  ]);

  const ledger = ledgerFor({
    calls: [
      {
        id: "r1",
        args: { file_path: "src/a.ts" },
        result: {
          content: capped,
          capped: { originalChars: 1, keptChars: 1, scope: "per-result" },
        },
      },
    ],
  });
  assert.match(rangeOf(ledger, "src/a.ts").detail, /lines 250-400 not shown/);
});

test("a timed-out helper's reads don't count", () => {
  const ledger = ledgerFor({
    calls: fullReads(),
    helpers: [helper({ state: "failed", error: "Timed out after 30 minutes" })],
  });
  assert.equal(rangeOf(ledger, "src/a.ts").cause, "helper-timed-out");
  const failed = ledgerFor({ calls: fullReads(), helpers: [helper({ state: "interrupted" })] });
  assert.equal(rangeOf(failed, "src/a.ts").cause, "helper-failed");
  const unknown = ledgerFor({ calls: fullReads(), helpers: [helper({ chunk: "nope-001" })] });
  assert.deepEqual(unknown.helpers[0].problems.slice(0, 1), ["unknown chunk nope-001"]);
  assert.equal(rangeOf(unknown, "src/a.ts").cause, "never-assigned");
});

test("a retry round, then what stays unread", () => {
  const first = ledgerFor({ calls: [read("r1", "src/a.ts", 1, 600)] });
  assert.deepEqual(
    first.retry.map((c) => [c.id, c.entries.map((e) => `${e.path}:${e.start}`)]),
    [
      ["retry-source-001", ["src/big.ts:1", "src/big.ts:1801"]],
      ["retry-docs-001", ["docs/guide.md:1"]],
    ],
  );
  assert.deepEqual(first.stillUnread, []);

  const second = ledgerFor({
    calls: [read("q1", "src/big.ts", 1, 1800)],
    helpers: [helper({ agentId: "h2", chunk: "retry-source-001" })],
    sessions: new Map([["h2", session([read("q1", "src/big.ts", 1, 1800)])]]),
    previous: first,
  });
  assert.equal(rangeOf(second, "src/a.ts").status, "read");
  assert.equal(rangeOf(second, "src/big.ts", 1).status, "read");
  assert.deepEqual(second.retry, []);
  assert.deepEqual(
    second.stillUnread.map((s) => `${s.path}:${s.start}:${s.cause}`),
    ["docs/guide.md:1:never-assigned", "src/big.ts:1801:helper-skipped"],
  );
  assert.deepEqual(
    second.retryHistory.map((c) => c.id),
    ["retry-docs-001", "retry-source-001"],
  );

  const final = ledgerFor({ calls: [read("r1", "src/a.ts", 1, 600)], final: true });
  assert.deepEqual(final.retry, []);
  assert.equal(final.stillUnread.length, 3);
});

test("same input gives the same bytes, whatever the helper order", () => {
  const helpers = [helper(), helper({ agentId: "h0", chunk: "docs-001" })];
  const sessions = new Map([
    ["h1", session(fullReads())],
    ["h0", session([read("d1", "docs/guide.md", 1, 10)])],
  ]);
  const a = serializeLedger(ledgerFor({ helpers, sessions }));
  const b = serializeLedger(ledgerFor({ helpers: [...helpers].reverse(), sessions }));
  assert.equal(a, b);
  assert.ok(a.endsWith("}\n"));
  assert.equal(JSON.parse(a).counts.unread, 0);
});

// ── Files on disk ─────────────────────────────────────────

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "sweep-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function sessionText(header, calls, report) {
  const head = {
    type: "session",
    version: 2,
    timestamp: "2026-11-04T00:00:00.000Z",
    provider: "anthropic",
    model: "m",
    leafId: null,
    ...header,
  };
  return [head, ...entriesFor(calls, report)].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

test("a compacted child's later file is found from the first one, through gzip and redirects", async (t) => {
  const dir = await tempDir(t);
  const firstId = "aaaaaaaa-0000-0000-0000-000000000000";
  const newestId = "bbbbbbbb-0000-0000-0000-000000000000";
  const firstName = `t0_${firstId.slice(0, 8)}.jsonl.gz`;
  const firstText = sessionText(
    { id: firstId, conversationId: firstId, generation: 0, cwd: ROOT },
    [read("r1", "src/a.ts", 1, 600)],
    "Halfway.",
  );
  await writeFile(path.join(dir, firstName), gzipSync(firstText));
  await writeFile(
    path.join(dir, "zz_unrelated.jsonl"),
    sessionText({ id: "other", cwd: ROOT }, [], "x"),
  );
  const newestName = `t1_${newestId.slice(0, 8)}.jsonl`;
  await writeFile(
    path.join(dir, newestName),
    sessionText(
      {
        id: newestId,
        conversationId: firstId,
        generation: 1,
        parentSessionId: firstId,
        cwd: ROOT,
      },
      [read("r2", "src/big.ts", 1, 1800), read("r3", "src/big.ts", 1801, 2000, { offset: 1801 })],
      "Checked: src/a.ts, src/big.ts",
    ),
  );
  // The engine's `transcript` is the child's first file, which may since be archived.
  const stub = path.join(dir, "stub.jsonl");
  await writeFile(
    stub,
    JSON.stringify({ type: "gg_session_redirect", version: 1, target: firstName }),
  );

  for (const start of [stub, path.join(dir, newestName)]) {
    const chain = loadSessionChain(start);
    assert.equal(chain.ok, true);
    assert.deepEqual(chain.files, [path.join(dir, firstName), path.join(dir, newestName)]);
    assert.equal(chain.chainBroken, false);
    assert.equal(chain.header.id, newestId);
    assert.equal(finalReport(chain.entries), "Checked: src/a.ts, src/big.ts");
    const ledger = ledgerFor({ sessions: new Map([["h1", chain]]) });
    assert.equal(ledger.files.find((f) => f.path === "src/a.ts").status, "read");
    assert.equal(ledger.files.find((f) => f.path === "src/big.ts").status, "read");
    assert.deepEqual(ledger.unbackedClaims, []);
  }

  await rm(path.join(dir, firstName));
  const broken = loadSessionChain(path.join(dir, newestName));
  assert.equal(broken.chainBroken, true);
  const brokenLedger = ledgerFor({ sessions: new Map([["h1", broken]]) });
  assert.equal(rangeOf(brokenLedger, "src/a.ts").cause, "evidence-unreadable");
  assert.equal(rangeOf(brokenLedger, "src/big.ts").status, "read");

  await writeFile(path.join(dir, "bad.jsonl"), '{"type":"message"}\n');
  assert.equal(loadSessionChain(path.join(dir, "bad.jsonl")).ok, false);
  assert.equal(loadSessionChain(path.join(dir, "missing.jsonl")).ok, false);
});

test("later files of another conversation, or not linked back, add no coverage", async (t) => {
  const dir = await tempDir(t);
  const firstId = "aaaaaaaa-0000-0000-0000-000000000000";
  const first = path.join(dir, "t0_aaaaaaaa.jsonl");
  await writeFile(
    first,
    sessionText(
      { id: firstId, conversationId: firstId, generation: 0, cwd: ROOT },
      [read("r1", "src/a.ts", 1, 600)],
      "Checked: src/a.ts",
    ),
  );
  const bigReads = [
    read("r2", "src/big.ts", 1, 1800),
    read("r3", "src/big.ts", 1801, 2000, { offset: 1801 }),
  ];
  await writeFile(
    path.join(dir, "t1_cccccccc.jsonl"),
    sessionText(
      {
        id: "cccccccc-0000-0000-0000-000000000000",
        conversationId: "cccccccc-0000-0000-0000-000000000000",
        generation: 3,
        parentSessionId: firstId,
        cwd: ROOT,
      },
      bigReads,
      "Checked: src/big.ts",
    ),
  );

  const own = loadSessionChain(first);
  assert.deepEqual(own.files, [first]);
  assert.equal(own.chainBroken, false);
  assert.deepEqual(own.problems, []);
  assert.equal(finalReport(own.entries), "Checked: src/a.ts");
  const ownLedger = ledgerFor({ sessions: new Map([["h1", own]]) });
  assert.equal(ownLedger.files.find((f) => f.path === "src/a.ts").status, "read");
  assert.notEqual(rangeOf(ownLedger, "src/big.ts").status, "read");

  // Same conversation, but its chain never reaches the given file.
  await writeFile(
    path.join(dir, "t2_dddddddd.jsonl"),
    sessionText(
      {
        id: "dddddddd-0000-0000-0000-000000000000",
        conversationId: firstId,
        generation: 2,
        cwd: ROOT,
      },
      bigReads,
      "Checked: src/big.ts",
    ),
  );
  const stray = loadSessionChain(first);
  assert.deepEqual(stray.files, [first]);
  assert.equal(stray.chainBroken, true);
  assert.match(stray.problems.join("\n"), /does not lead back/);
  assert.equal(finalReport(stray.entries), "Checked: src/a.ts");
  const strayLedger = ledgerFor({ sessions: new Map([["h1", stray]]) });
  assert.notEqual(rangeOf(strayLedger, "src/big.ts").status, "read");
});

function io() {
  const out = [];
  const err = [];
  return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
}

test("CLI writes ledger.json and exits 4 while ranges are unread, 0 when all are read", async (t) => {
  const dir = await tempDir(t);
  const root = path.join(dir, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), lines(600));
  await writeFile(path.join(root, "src", "big.ts"), lines(2000));
  await writeFile(path.join(root, "docs", "guide.md"), lines(10));
  const planFile = path.join(dir, "plan.json");
  await writeFile(planFile, serializePlan(makePlan()));
  const s1 = path.join(dir, "h1.jsonl");
  const cliReads = [
    read("r1", "src/a.ts", 1, 600),
    read("r2", path.join(root, "src", "big.ts"), 1, 1800),
    read("r3", "src/big.ts", 1801, 2000, { offset: 1801 }),
  ];
  await writeFile(s1, sessionText({ id: "s1", cwd: root }, cliReads, "Done."));
  const s0 = path.join(dir, "h0.jsonl");
  await writeFile(
    s0,
    sessionText({ id: "s0", cwd: root }, [read("d1", "docs/guide.md", 1, 10)], "Done."),
  );
  const helpersFile = path.join(dir, "helpers.json");
  await writeFile(helpersFile, JSON.stringify([helper({ transcript: s1 })]));

  const run = (extra = []) => {
    const out = io();
    const code = main(
      ["--plan", planFile, "--helpers", helpersFile, "--root", root, ...extra],
      out,
    );
    return { code, ...out };
  };
  const partial = run();
  assert.equal(partial.code, 4, partial.err.join(""));
  const ledger = JSON.parse(await readFile(path.join(dir, "ledger.json"), "utf8"));
  assert.equal(ledger.counts.unread, 1);
  assert.equal(ledger.retry.length, 1);

  await writeFile(
    helpersFile,
    JSON.stringify([
      helper({ transcript: s1 }),
      helper({ agentId: "h0", chunk: "docs-001", transcript: s0 }),
    ]),
  );
  const out = path.join(dir, "out", "l.json");
  const all = run(["--out", out]);
  assert.equal(all.code, 0, all.err.join(""));
  assert.equal(JSON.parse(await readFile(out, "utf8")).counts.unread, 0);

  assert.equal(run(["--previous", planFile]).code, 1);
  assert.equal(main(["--plan", planFile], io()), 1);
  const badPlan = path.join(dir, "bad-plan.json");
  await writeFile(badPlan, JSON.stringify({ ...makePlan(), chunks: [] }));
  assert.equal(main(["--plan", badPlan, "--helpers", helpersFile, "--root", root], io()), 1);
  await writeFile(helpersFile, JSON.stringify([{ chunk: "source-001" }]));
  assert.equal(run().code, 1);
});

// ── Automated tiers, tier counts, carrying reads across plans ─────────────

test("an automated tier is neither unread nor retried, and shows in byTier", () => {
  const ledger = ledgerFor({ calls: fullReads(), automatedTiers: ["docs"] });
  const guide = ledger.files.find((f) => f.path === "docs/guide.md");
  assert.equal(guide.status, "automated");
  assert.equal(guide.ranges[0].status, "automated");
  assert.equal(guide.ranges[0].cause, undefined);
  assert.equal(ledger.counts.unread, 0);
  assert.equal(ledger.counts.automated, 1);
  assert.equal(ledger.counts.read, 3);
  assert.equal(ledger.counts.byCause["never-assigned"], 0);
  assert.deepEqual(ledger.retry, []);
  assert.deepEqual(ledger.stillUnread, []);
  assert.deepEqual(ledger.counts.byTier.docs, {
    files: 1,
    read: 0,
    partial: 0,
    unread: 0,
    automated: 1,
  });
  const serialized = JSON.parse(serializeLedger(ledger));
  assert.equal(serialized.counts.automated, 1);
  assert.deepEqual(Object.keys(serialized.counts.byTier), [
    "source",
    "test",
    "docs",
    "config",
    "generated",
  ]);

  // A helper that did read an automated-tier file still gets the read counted.
  const helpers = [helper(), helper({ agentId: "h0", chunk: "docs-001" })];
  const sessions = new Map([
    ["h1", session(fullReads())],
    ["h0", session([read("d1", "docs/guide.md", 1, 10)])],
  ]);
  const readAnyway = ledgerFor({ helpers, sessions, automatedTiers: ["docs"] });
  assert.equal(readAnyway.files.find((f) => f.path === "docs/guide.md").status, "read");
  assert.equal(readAnyway.counts.automated, 0);
});

test("byTier splits file counts into read, partial and unread per tier", () => {
  const calls = [read("r1", "src/a.ts", 1, 600), read("r2", "src/big.ts", 1, 1800)];
  const ledger = ledgerFor({ calls });
  assert.equal(ledger.files.find((f) => f.path === "src/big.ts").status, "partial");
  assert.deepEqual(ledger.counts.byTier.source, {
    files: 2,
    read: 1,
    partial: 1,
    unread: 0,
    automated: 0,
  });
  assert.deepEqual(ledger.counts.byTier.docs, {
    files: 1,
    read: 0,
    partial: 0,
    unread: 1,
    automated: 0,
  });
  assert.deepEqual(ledger.counts.byTier.test, {
    files: 0,
    read: 0,
    partial: 0,
    unread: 0,
    automated: 0,
  });
});

test("--previous-plan carries reads only for files unchanged between plans", () => {
  const oldPlan = makePlan();
  const previous = JSON.parse(serializeLedger(ledgerFor({ calls: fullReads() })));
  assert.equal(previous.retry.length, 1);
  const changed = buildPlan({
    files: [
      { path: "src/a.ts", content: lines(600) },
      { path: "src/big.ts", content: Buffer.from("y\n".repeat(2000)) },
      { path: "docs/guide.md", content: lines(10) },
    ],
    config: { scopeResolution: scope() },
  });
  assert.equal(changed.ok, true);
  const ledger = buildLedger({
    plan: changed.plan,
    helpers: [],
    previous,
    previousPlan: oldPlan,
    platform: "linux",
    root: ROOT,
  });
  assert.equal(ledger.files.find((f) => f.path === "src/a.ts").status, "read");
  assert.deepEqual(rangeOf(ledger, "src/a.ts").evidence, [
    { agentId: "h1", toolCallId: "r1", start: 1, end: 600 },
  ]);
  assert.equal(ledger.files.find((f) => f.path === "src/big.ts").status, "unread");
  assert.equal(ledger.files.find((f) => f.path === "docs/guide.md").status, "unread");
  // The old plan's retry chunks point at its ranges, so they are dropped, not counted as tried.
  assert.deepEqual(ledger.retryHistory, []);
  assert.ok(ledger.retry.some((c) => c.entries.some((e) => e.path === "src/big.ts")));
  assert.ok(ledger.retry.some((c) => c.entries.some((e) => e.path === "docs/guide.md")));
});

test("CLI checks --previous-plan against the previous ledger and validates --automated-tier", async (t) => {
  const dir = await tempDir(t);
  const root = path.join(dir, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), lines(600));
  await writeFile(path.join(root, "src", "big.ts"), lines(2000));
  await writeFile(path.join(root, "docs", "guide.md"), lines(10));
  const planFile = path.join(dir, "plan.json");
  await writeFile(planFile, serializePlan(makePlan()));
  const s1 = path.join(dir, "h1.jsonl");
  const cliReads = [
    read("r1", "src/a.ts", 1, 600),
    read("r2", "src/big.ts", 1, 1800),
    read("r3", "src/big.ts", 1801, 2000, { offset: 1801 }),
  ];
  await writeFile(s1, sessionText({ id: "s1", cwd: root }, cliReads, "Done."));
  const helpersFile = path.join(dir, "helpers.json");
  await writeFile(helpersFile, JSON.stringify([helper({ transcript: s1 })]));
  const run = (extra) => {
    const out = io();
    const code = main(
      ["--plan", planFile, "--helpers", helpersFile, "--root", root, ...extra],
      out,
    );
    return { code, ...out };
  };

  const automated = run(["--automated-tier", "docs"]);
  assert.equal(automated.code, 0, automated.err.join(""));
  assert.match(automated.out.join(""), /1 automated checks only/);
  const ledgerFile = path.join(dir, "ledger.json");
  assert.equal(JSON.parse(await readFile(ledgerFile, "utf8")).counts.automated, 1);

  const bogus = run(["--automated-tier", "vendor"]);
  assert.equal(bogus.code, 1);
  assert.match(bogus.err.join(""), /unknown --automated-tier vendor/);

  assert.equal(run(["--previous-plan", planFile]).code, 1);

  const prev = path.join(dir, "ledger.prev.json");
  await writeFile(prev, await readFile(ledgerFile));
  const oldPlan = path.join(dir, "plan.prev.json");
  await writeFile(oldPlan, await readFile(planFile));
  const carried = run(["--previous", prev, "--previous-plan", oldPlan, "--final"]);
  assert.equal(carried.code, 4, carried.err.join(""));

  await writeFile(oldPlan, `${(await readFile(planFile, "utf8")).trimEnd()}\n\n`);
  const mismatch = run(["--previous", prev, "--previous-plan", oldPlan]);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.err.join(""), /not a ledger for --previous-plan/);
});
