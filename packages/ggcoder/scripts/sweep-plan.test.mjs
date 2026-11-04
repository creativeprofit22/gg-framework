import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BINARY_EXTENSIONS,
  DEFAULT_SETTINGS,
  READ_LIMITS,
  TURN_TOOL_RESULT_CHAR_CAP,
  TURN_TOOL_RESULT_CHAR_FLOOR,
  buildPlan,
  checkCoverage,
  classify,
  compileScope,
  countLines,
  globToRegExp,
  isBinary,
  main,
  packChunks,
  pageRanges,
  renderedChars,
  resolveSettings,
  serializePlan,
  toPosixRelative,
} from "../assets/scripts/sweep-plan.mjs";

const baseScope = () => ({
  excludeGlobs: [".gg/**", "dist/**", "node_modules/**"],
  sourceGlobs: ["**/*.{ts,tsx,mjs,js}", "**/*.css"],
  testGlobs: ["**/*.test.{ts,mjs}"],
  routeGlobs: [],
  configGlobs: ["**/*.json", "**/*.config.*"],
  docsGlobs: ["**/*.md"],
});

const config = (overrides = {}) => ({ scopeResolution: { ...baseScope(), ...overrides } });
const lines = (n, text = "x") => Buffer.from(`${text}\n`.repeat(n));
const scopeOf = (overrides) => {
  const result = compileScope(config(overrides).scopeResolution);
  assert.equal(result.ok, true);
  return result.scope;
};

function plan(files, cfg = config()) {
  const result = buildPlan({
    files: Object.entries(files).map(([p, content]) => ({ path: p, content })),
    config: cfg,
  });
  assert.equal(result.ok, true, JSON.stringify(result.unmatched ?? result.error));
  return result.plan;
}

function io() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  };
}

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=sweep", "-c", "user.email=sweep@example.invalid", ...args],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

async function makeRepo(t, files, { commit = true, cfg = config() } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sweep-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await mkdir(path.join(root, ".gg"), { recursive: true });
  await writeFile(path.join(root, ".gg", "sweep.config.json"), JSON.stringify(cfg, null, 2));
  if (commit) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "--no-gpg-sign", "-m", "fixture");
  }
  return root;
}

const planPath = (root) => path.join(root, ".gg", "sweep", "plan.json");

test("an unmatched file stops the planner with exit 2 and writes nothing", async (t) => {
  const root = await makeRepo(t, {
    "src/app.ts": "export const a = 1;\n",
    "tools/run.sh": "echo hi\n",
    "styles/site.scss": "a {}\n",
  });
  const cap = io();
  const code = main(["--root", root], { cwd: root, ...cap });
  assert.equal(code, 2);
  const err = cap.err.join("");
  assert.match(err, /2 files match no sweep pattern/);
  assert.match(err, /tools\/run\.sh/);
  assert.match(err, /styles\/site\.scss/);
  assert.doesNotMatch(err, /src\/app\.ts/);
  assert.equal(existsSync(planPath(root)), false);
});

test("commands/*.md counts as source even when docs globs match every .md", () => {
  const scope = scopeOf();
  assert.equal(classify("packages/x/assets/commands/foo.md", scope), "source");
  assert.equal(classify("commands/sweep.md", scope), "source");
  assert.equal(classify("docs/commands-guide.md", scope), "docs");
  assert.equal(classify("commands/nested/deeper.md", scope), "docs");
  assert.equal(classify("src/app.test.ts", scope), "test");
  assert.equal(classify("package.json", scope), "config");
  assert.equal(classify("README.txt", scope), null);
  assert.equal(classify("gen/out.ts", scopeOf({ generatedGlobs: ["gen/**"] })), "generated");
});

test("a file over 2,000 lines is split into pages that cover every line once", () => {
  const p = plan({ "src/big.ts": lines(4500) });
  const [file] = p.files;
  assert.equal(file.lines, 4500);
  assert.equal(file.chunk, undefined);
  assert.deepEqual(
    file.pages.map(({ start, end }) => [start, end]),
    [
      [1, 1800],
      [1801, 3600],
      [3601, 4500],
    ],
  );
  for (const page of file.pages) assert.ok(page.end - page.start + 1 <= 1800);
  assert.deepEqual(checkCoverage(p), []);
  assert.equal(p.counts.paged, 1);
});

test("a file over 50 KB with few lines is split by bytes; one huge line is flagged", () => {
  const wide = Buffer.from(`${"y".repeat(5999)}\n`.repeat(10));
  assert.equal(wide.length, 60000);
  const ranges = pageRanges(wide, 1800, 45000);
  assert.deepEqual(ranges, [
    { start: 1, end: 7 },
    { start: 8, end: 10 },
  ]);
  for (const r of ranges) assert.ok((r.end - r.start + 1) * 6000 <= 45000);

  const single = Buffer.from("z".repeat(60000));
  const p = plan({ "src/wide.ts": wide, "src/one-line.ts": single });
  const oneLine = p.files.find((f) => f.path === "src/one-line.ts");
  assert.equal(oneLine.lines, 1);
  assert.deepEqual(oneLine.pages, [
    { start: 1, end: 1, chars: 200, chunk: oneLine.pages[0].chunk, oversizedLine: true },
  ]);
  assert.equal(p.files.find((f) => f.path === "src/wide.ts").pages.length, 2);
  assert.deepEqual(checkCoverage(p), []);
});

test("folder packing keeps a folder at exactly the budget together and splits one line over", () => {
  const unit = (p, n) => ({ path: p, tier: "source", start: 1, end: n, lines: n });
  const settings = { ...DEFAULT_SETTINGS };

  const exact = packChunks([unit("a/one.ts", 2000), unit("a/two.ts", 2000)], settings);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].lines, 4000);

  const over = packChunks([unit("b/one.ts", 2000), unit("b/two.ts", 2001)], settings);
  assert.deepEqual(
    over.map((c) => c.entries.map((e) => e.path)),
    [["b/one.ts"], ["b/two.ts"]],
  );

  const mixed = packChunks(
    [unit("c/big.ts", 3000), unit("d/one.ts", 600), unit("d/two.ts", 600)],
    settings,
  );
  assert.deepEqual(
    mixed.map((c) => c.entries.map((e) => e.path)),
    [["c/big.ts"], ["d/one.ts", "d/two.ts"]],
  );

  const twoFolders = packChunks([unit("e/a.ts", 3000), unit("f/b.ts", 1000)], settings);
  assert.equal(twoFolders.length, 1);

  const capped = packChunks([unit("g/1.ts", 1), unit("g/2.ts", 1), unit("g/3.ts", 1)], {
    ...settings,
    maxFilesPerChunk: 2,
  });
  assert.deepEqual(
    capped.map((c) => c.id),
    ["source-001", "source-002"],
  );
});

test("chunks never mix tiers and ids follow tier order", () => {
  const p = plan({
    "src/a.ts": lines(3),
    "src/a.test.ts": lines(3),
    "README.md": lines(2),
    "package.json": lines(1),
    "src/empty.ts": Buffer.alloc(0),
  });
  assert.deepEqual(
    p.chunks.map((c) => c.id),
    ["source-001", "test-001", "docs-001", "config-001"],
  );
  const empty = p.files.find((f) => f.path === "src/empty.ts");
  assert.equal(empty.lines, 0);
  assert.equal(empty.chunk, "source-001");
  assert.deepEqual(checkCoverage(p), []);
});

test("the exactly-once check passes a good plan and catches broken ones", () => {
  const good = plan({ "src/big.ts": lines(4500), "src/small.ts": lines(10) });
  assert.deepEqual(checkCoverage(good), []);
  const broken = (edit) => {
    const copy = structuredClone(good);
    edit(copy);
    return checkCoverage(copy);
  };

  const missing = broken((p) => {
    for (const c of p.chunks) c.entries = c.entries.filter((e) => e.path !== "src/small.ts");
    for (const c of p.chunks) c.lines = c.entries.reduce((s, e) => s + e.end - e.start + 1, 0);
  });
  assert.ok(missing.some((m) => m.includes("file is in no chunk: src/small.ts")));

  const gap = broken((p) => {
    const entry = p.chunks.flatMap((c) => c.entries).find((e) => e.start === 1801);
    entry.start = 1802;
  });
  assert.ok(gap.some((m) => m.includes("lines 1801-1801 are in no chunk")));

  const overlap = broken((p) => {
    const entry = p.chunks.flatMap((c) => c.entries).find((e) => e.start === 1801);
    entry.start = 1700;
  });
  assert.ok(overlap.some((m) => m.includes("overlap")));

  const duplicate = broken((p) => {
    const entry = p.chunks[0].entries[0];
    p.chunks[p.chunks.length - 1].entries.push({ ...entry });
  });
  assert.ok(duplicate.some((m) => m.includes("listed twice")));

  const stranger = broken((p) => {
    p.chunks[0].entries.push({ path: "src/ghost.ts", start: 1, end: 1 });
  });
  assert.ok(stranger.some((m) => m.includes("not in the plan: src/ghost.ts")));

  const pastEnd = broken((p) => {
    const entry = p.chunks.flatMap((c) => c.entries).find((e) => e.path === "src/small.ts");
    entry.end = 11;
  });
  assert.ok(pastEnd.some((m) => m.includes("runs past line 10")));
});

test("Windows paths and backslash globs classify and serialise as POSIX", () => {
  assert.equal(toPosixRelative(".\\src\\app\\main.ts"), "src/app/main.ts");
  assert.ok(globToRegExp("src\\**\\*.ts").test("src/app/main.ts"));
  const cfg = config({ sourceGlobs: ["src\\**\\*.ts"], excludeGlobs: ["build\\**"] });
  const p = plan(
    {
      "src\\app\\main.ts": lines(2),
      "build\\out.js": lines(2),
      "docs\\guide.md": lines(1),
      "tools\\commands\\run.md": lines(1),
    },
    cfg,
  );
  assert.deepEqual(
    p.files.map((f) => [f.path, f.tier]),
    [
      ["docs/guide.md", "docs"],
      ["src/app/main.ts", "source"],
      ["tools/commands/run.md", "source"],
    ],
  );
  assert.equal(p.counts.excluded, 1);
  assert.doesNotMatch(serializePlan(p), /\\\\/);
});

test("files and folders with spaces come through git ls-files intact", async (t) => {
  const root = await makeRepo(
    t,
    {
      "my folder/a file.ts": lines(3),
      "café/ünïcode.ts": lines(2),
      "plain.ts": lines(1),
    },
    { commit: false },
  );
  const cap = io();
  assert.equal(main([], { cwd: root, ...cap }), 0, cap.err.join(""));
  const written = JSON.parse(await readFile(planPath(root), "utf8"));
  assert.equal(written.gitCommit, null);
  assert.deepEqual(
    written.files.map((f) => f.path),
    ["café/ünïcode.ts", "my folder/a file.ts", "plain.ts"],
  );
  const verify = io();
  assert.equal(main(["--verify", planPath(root)], { cwd: root, ...verify }), 0);
});

test("repeat runs are byte-identical, excludes drop files and binaries are listed", async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]);
  const root = await makeRepo(t, {
    "src/a.ts": lines(5),
    "src/b/c.ts": lines(7),
    "dist/bundle.js": lines(100),
    "assets/logo.png": png,
    "assets/icon.svg": "<svg/>",
    "src/long.ts": `${"y".repeat(40000)}\n`,
    "README.md": lines(3),
  });
  const first = io();
  assert.equal(main([], { cwd: root, ...first }), 0, first.err.join(""));
  const bytesA = await readFile(planPath(root));
  const second = io();
  assert.equal(main(["--root", root], { cwd: tmpdir(), ...second }), 0, second.err.join(""));
  const bytesB = await readFile(planPath(root));
  assert.equal(Buffer.compare(bytesA, bytesB), 0);

  const written = JSON.parse(bytesA.toString("utf8"));
  assert.match(written.gitCommit, /^[0-9a-f]{40,64}$/);
  assert.match(written.configHash, /^[0-9a-f]{64}$/);
  assert.equal(
    written.files.some((f) => f.path.startsWith("dist/")),
    false,
  );
  assert.equal(
    written.files.some((f) => f.path.startsWith(".gg/")),
    false,
  );
  assert.deepEqual(
    written.binary.map((b) => [b.path, b.bytes]),
    [
      ["assets/icon.svg", 6],
      ["assets/logo.png", 8],
    ],
  );
  assert.equal(written.files.find((f) => f.path === "src/long.ts").chars, 40008);
  assert.ok(written.chunks.every((c) => typeof c.chars === "number"));
  assert.ok(written.files.every((f) => typeof f.chars === "number" || Array.isArray(f.pages)));
  assert.equal(isBinary(png), true);
  assert.deepEqual(checkCoverage(written), []);
  assert.ok(bytesA.toString("utf8").endsWith("}\n"));
});

test("--verify reports a broken plan with exit 3", async (t) => {
  const root = await makeRepo(t, { "src/a.ts": lines(5) });
  assert.equal(main([], { cwd: root, ...io() }), 0);
  const written = JSON.parse(await readFile(planPath(root), "utf8"));
  written.chunks[0].entries = [];
  written.chunks[0].lines = 0;
  const brokenPath = path.join(root, "broken.json");
  await writeFile(brokenPath, JSON.stringify(written));
  const cap = io();
  assert.equal(main(["--verify", brokenPath], { cwd: root, ...cap }), 3);
  assert.match(cap.err.join(""), /file is in no chunk: src\/a\.ts/);
});

test("settings: page size cannot exceed one read, bad flags exit 1", async (t) => {
  assert.equal(resolveSettings({ pageLines: 2001 }).ok, false);
  assert.equal(resolveSettings({ pageBytes: 51201 }).ok, false);
  assert.equal(resolveSettings({ chunkLines: 0 }).ok, false);
  assert.equal(resolveSettings({ bogus: 1 }).ok, false);
  assert.equal(resolveSettings({ chunkLines: 500 }).ok, false);
  assert.equal(resolveSettings({ chunkLines: 500, pageLines: 400 }).ok, true);
  assert.deepEqual(resolveSettings({ chunkLines: 2000 }, { chunkLines: 3000 }).settings, {
    ...DEFAULT_SETTINGS,
    chunkLines: 3000,
  });
  const root = await makeRepo(t, { "src/a.ts": lines(5) });
  assert.equal(main(["--page-lines", "abc"], { cwd: root, ...io() }), 1);
  assert.equal(main(["--page-lines", "2500"], { cwd: root, ...io() }), 1);
  assert.equal(main(["--nope"], { cwd: root, ...io() }), 1);
  const cap = io();
  assert.equal(main(["--chunk-lines", "100"], { cwd: root, ...cap }), 1);
  assert.match(cap.err.join(""), /chunkLines \(100\) must be at least pageLines \(1800\)/);
  assert.equal(existsSync(planPath(root)), false);
});

test("line counting treats CRLF as one break and counts a last line without newline", () => {
  assert.equal(countLines(Buffer.alloc(0)), 0);
  assert.equal(countLines(Buffer.from("a")), 1);
  assert.equal(countLines(Buffer.from("a\r\nb\r\n")), 2);
  assert.equal(countLines(Buffer.from("a\nb")), 2);
});

test("rendered chars match the read tool's numbered lines, CR, non-ASCII and wide numbers", () => {
  const text = ["a\r", "b", "üé😀", "plain"];
  const buf = Buffer.from(text.join("\n") + "\n");
  const shown = text.map((l, i) => `${String(i + 1).padStart(6, " ")}\t${l}`).join("\n");
  // One newline per line, so the last line's newline counts too.
  assert.equal(renderedChars(buf, 1, 4), shown.length + 1);
  assert.equal(renderedChars(buf, 2, 2), 6 + 1 + 1 + 1);
  assert.equal(renderedChars(Buffer.alloc(0), 1, 1), 0);

  const many = lines(1000001);
  // Line 999,999 has a 6-digit prefix; 1,000,000 and 1,000,001 need 7.
  assert.equal(renderedChars(many, 999999, 1000001), 9 + 10 + 10);
});

test("long-line files in one folder split by characters, not lines", () => {
  const files = {};
  for (let i = 1; i <= 6; i++) files[`src/wide/f${i}.ts`] = Buffer.from(`${"y".repeat(40000)}\n`);
  const p = plan(files);
  assert.ok(p.chunks.reduce((sum, c) => sum + c.lines, 0) <= DEFAULT_SETTINGS.chunkLines);
  assert.deepEqual(
    p.chunks.map((c) => c.entries.length),
    [4, 2],
  );
  for (const c of p.chunks) {
    if (c.entries.length > 1) assert.ok(c.chars <= DEFAULT_SETTINGS.chunkChars, c.id);
  }
  assert.equal(p.chunks[0].chars, 4 * 40008);
  assert.deepEqual(checkCoverage(p), []);

  const broken = structuredClone(p);
  broken.chunks[0].chars += 1;
  assert.match(checkCoverage(broken).join("\n"), /says 160033 chars but holds 160032/);
  const over = structuredClone(p);
  over.settings.chunkChars = 100000;
  assert.match(checkCoverage(over).join("\n"), /over chunkChars 100000/);
});

test("character packing keeps a chunk at exactly the budget and splits one char over", () => {
  const unit = (p, chars) => ({ path: p, tier: "source", start: 1, end: 1, lines: 1, chars });
  const settings = { ...DEFAULT_SETTINGS };
  const half = DEFAULT_SETTINGS.chunkChars / 2;

  const exact = packChunks([unit("a/one.ts", half), unit("a/two.ts", half)], settings);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].chars, DEFAULT_SETTINGS.chunkChars);

  const over = packChunks([unit("b/one.ts", half), unit("b/two.ts", half + 1)], settings);
  assert.deepEqual(
    over.map((c) => [c.entries.map((e) => e.path), c.chars]),
    [
      [["b/one.ts"], half],
      [["b/two.ts"], half + 1],
    ],
  );

  // Units from plans written before chunkChars carry no chars and pack by lines alone.
  const legacy = packChunks(
    [
      { path: "c/one.ts", tier: "source", start: 1, end: 1, lines: 1 },
      { path: "c/two.ts", tier: "source", start: 1, end: 1, lines: 1 },
    ],
    { chunkLines: 4000, maxFilesPerChunk: 50 },
  );
  assert.equal(legacy.length, 1);
});

test("settings: chunkChars stays under the per-turn cap and above one page", async (t) => {
  const pageChars = DEFAULT_SETTINGS.pageBytes + DEFAULT_SETTINGS.pageLines * 8;
  assert.equal(resolveSettings({ chunkChars: TURN_TOOL_RESULT_CHAR_CAP + 1 }).ok, false);
  assert.equal(resolveSettings({ chunkChars: TURN_TOOL_RESULT_CHAR_CAP }).ok, true);
  assert.equal(resolveSettings({ chunkChars: pageChars - 1 }).ok, false);
  assert.equal(resolveSettings({ chunkChars: pageChars }).ok, true);

  const root = await makeRepo(t, { "src/a.ts": lines(5) });
  const bad = io();
  assert.equal(main(["--chunk-chars", "240001"], { cwd: root, ...bad }), 1);
  assert.match(bad.err.join(""), /chunkChars must be at most 240000/);
  const good = io();
  assert.equal(main(["--chunk-chars", "200000"], { cwd: root, ...good }), 0, good.err.join(""));
  assert.equal(JSON.parse(await readFile(planPath(root), "utf8")).settings.chunkChars, 200000);
  assert.match(good.out.join(""), /largest chunk 45 chars \(source-001\), per-turn cap 240,000/);
});

test(".svg in any case is planned as binary whatever its content", () => {
  const p = plan(
    { "src/a.ts": lines(2), "src/icon.svg": "<svg/>\n", "src/LOGO.SVG": "<svg/>\n" },
    config({ sourceGlobs: ["**/*.ts", "**/*.svg", "**/*.SVG"] }),
  );
  assert.deepEqual(
    p.binary.map((b) => b.path),
    ["src/LOGO.SVG", "src/icon.svg"],
  );
  assert.deepEqual(
    p.files.map((f) => f.path),
    ["src/a.ts"],
  );
  assert.equal(isBinary(Buffer.from("<svg/>"), "x/y.Svg"), true);
  assert.equal(isBinary(Buffer.from("text"), "x/y.ts"), false);
});

const repoFile = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

function capture(text, re, where) {
  const m = re.exec(text);
  assert.ok(m, `${where}: ${re} not found; re-check the value copied from it`);
  return m;
}

const toNumber = (s) => Number(s.replace(/[_,]/g, ""));

test("engine limits copied into the planner and setup-sweep.md match the engine source", () => {
  const session = repoFile("src/core/agent-session.ts");
  const turn = capture(
    session,
    /Math\.max\(\s*([\d_]+),\s*Math\.min\(\s*Math\.floor\(\s*contextChars \* 0\.15\s*\),\s*([\d_]+)\s*\)\s*\)/,
    "src/core/agent-session.ts",
  );
  const floor = toNumber(turn[1]);
  const cap = toNumber(turn[2]);
  assert.equal(TURN_TOOL_RESULT_CHAR_CAP, cap);
  assert.equal(TURN_TOOL_RESULT_CHAR_FLOOR, floor);
  assert.ok(DEFAULT_SETTINGS.chunkChars + 60000 <= cap, "chunkChars keeps a 60,000 margin");

  const manager = repoFile("src/core/subagent-manager.ts");
  const where = "src/core/subagent-manager.ts";
  const constant = (name) =>
    toNumber(
      capture(manager, new RegExp(`^(?:export )?const ${name} = ([\\d_]+);`, "m"), where)[1],
    );
  const activeLimit = constant("ACTIVE_LIMIT");
  const waitLimit = constant("WAIT_OUTPUT_LIMIT");
  const perAgentLimit = constant("WAIT_OUTPUT_PER_AGENT_LIMIT");

  const truncate = repoFile("src/tools/truncate.ts");
  const maxLines = toNumber(
    capture(truncate, /^export const MAX_LINES = ([\d_]+);/m, "src/tools/truncate.ts")[1],
  );
  const bytes = capture(
    truncate,
    /^export const MAX_BYTES = ([\d_]+)(?:\s*\*\s*([\d_]+))?;/m,
    "src/tools/truncate.ts",
  );
  const maxBytes = toNumber(bytes[1]) * (bytes[2] === undefined ? 1 : toNumber(bytes[2]));
  assert.deepEqual(READ_LIMITS, { lines: maxLines, bytes: maxBytes });

  const readTool = repoFile("src/tools/read.ts");
  capture(readTool, /\btruncateHead\(content\)/, "src/tools/read.ts");
  assert.doesNotMatch(readTool, /\btruncateHead\(content,/, "read.ts overrides truncate limits");
  const set = capture(
    readTool,
    /export const BINARY_EXTENSIONS = new Set\(\[([^\]]*)\]\)/,
    "src/tools/read.ts",
  );
  const engineExts = [...set[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.ok(engineExts.length > 0, "src/tools/read.ts: no BINARY_EXTENSIONS entries found");
  assert.deepEqual([...BINARY_EXTENSIONS], [...new Set(engineExts)]);

  const doc = repoFile("assets/commands/setup-sweep.md");
  const docWhere = "assets/commands/setup-sweep.md";
  const stated = (re) => toNumber(capture(doc, re, docWhere)[1]);
  assert.equal(stated(/waves of up to (\d+) helpers, the engine's `ACTIVE_LIMIT`/), activeLimit);
  assert.equal(stated(/whole reply under ([\d,]+) characters/), perAgentLimit);
  assert.equal(stated(/caps its total output at ([\d,]+) characters/), waitLimit);
  assert.equal(stated(/per-turn tool-result cap of ([\d,]+) characters/), cap);
  assert.equal(stated(/as low as ([\d,]+)/), floor);
  assert.equal(stated(/`chunkChars`, default ([\d,]+)/), DEFAULT_SETTINGS.chunkChars);
});
