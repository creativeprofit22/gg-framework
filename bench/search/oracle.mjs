// Correctness owner: an independent, uncapped reference for grep/find results,
// output parsers, and the comparison of one tool call against the reference.
//
// Independence: the grep oracle walks the directory itself (no fast-glob) and
// reads whole files (no readline). It shares three documented rules with the
// product on purpose, because they ARE the contract being checked: the root
// .gitignore via the `ignore` package, the binary-extension list, and the
// 10 MB skip. Include globs use micromatch (fast-glob's matcher). The find
// oracle is fast-glob uncapped plus its own ignore filtering, so it checks
// truncation and ordering, not glob semantics.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ORACLE_VERSION = 1;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const PREFIX_CHARS = 400;

/** Resolve the matching libraries from a target worktree's ggcoder package. */
export async function loadOracleDeps(worktree) {
  const pkgDir = path.join(worktree, "packages", "ggcoder");
  const require = createRequire(path.join(pkgDir, "package.json"));
  const fastGlobPath = require.resolve("fast-glob");
  const micromatch = createRequire(fastGlobPath)("micromatch");
  const ignore = require("ignore");
  const fg = require("fast-glob");
  const readModule = await import(
    pathToFileURL(path.join(pkgDir, "dist", "tools", "read.js")).href
  );
  return { fg, ignore, micromatch, binaryExtensions: readModule.BINARY_EXTENSIONS };
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export function toPosix(p) {
  return p.replace(/\\/g, "/");
}

function byPathThenLine(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line;
}

export function recordKey(r) {
  return `${r.path}:${r.line}:${r.prefixHash}`;
}

/** Split file text into lines exactly like readline with crlfDelay: Infinity. */
export function splitLines(text) {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/[\r\n]$/.test(text)) lines.pop();
  return lines;
}

async function loadRootIgnore(deps, dir) {
  const ig = deps.ignore();
  try {
    const content = await readFile(path.join(dir, ".gitignore"), "utf8");
    ig.add(
      content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
  } catch {
    // no root .gitignore
  }
  return ig;
}

async function walkFiles(dir) {
  const out = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await readdir(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(child);
      } else if (entry.isFile()) out.push(child);
    }
  }
  await walk("");
  return out;
}

function matchLines(text, regex, displayPath) {
  const matches = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < 5 && line.includes("\0")) break;
    regex.lastIndex = 0;
    if (regex.test(line))
      matches.push({
        path: displayPath,
        line: i + 1,
        prefixHash: sha1(line.slice(0, PREFIX_CHARS)),
      });
  }
  return matches;
}

function buildRegex(pattern, caseInsensitive) {
  const inline = pattern.startsWith("(?i)");
  return new RegExp(inline ? pattern.slice(4) : pattern, caseInsensitive || inline ? "gi" : "g");
}

/**
 * Uncapped grep reference. Returns every match in tool order plus the
 * candidate list, and the matches within the first `candidateCap` candidates
 * (what an uncapped-deadline in-process scan can return).
 */
export async function grepOracle({ cwd, args, deps, candidateCap = 10_000 }) {
  const dir = args.path ? path.resolve(cwd, args.path) : cwd;
  const regex = buildRegex(args.pattern, args.case_insensitive);
  const info = await stat(dir);
  if (info.isFile()) {
    const display = toPosix(path.relative(cwd, dir));
    const text = info.size > MAX_FILE_SIZE ? "" : await readFile(dir, "utf8");
    const matches = matchLines(text, regex, display);
    return {
      matches,
      cappedMatches: matches,
      candidateCount: 1,
      candidateBytes: info.size,
      candidateCapHit: false,
    };
  }
  const ig = await loadRootIgnore(deps, dir);
  const includeGlob = args.include
    ? (() => {
        const n = toPosix(args.include);
        return n.includes("/") ? n : `**/${n}`;
      })()
    : undefined;
  const candidates = (await walkFiles(dir))
    .filter((rel) => !deps.binaryExtensions.has(path.extname(rel).toLowerCase()))
    .filter((rel) => !ig.ignores(rel))
    .filter((rel) => !includeGlob || deps.micromatch.isMatch(rel, includeGlob, { dot: true }))
    .sort();
  const matches = [];
  let cappedMatches;
  let candidateBytes = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (i === candidateCap) cappedMatches = matches.slice();
    const rel = candidates[i];
    const abs = path.join(dir, rel);
    let text;
    try {
      const s = await stat(abs);
      if (s.size > MAX_FILE_SIZE) continue;
      candidateBytes += s.size;
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    matches.push(...matchLines(text, regex, toPosix(path.relative(cwd, abs))));
  }
  return {
    matches,
    cappedMatches: cappedMatches ?? matches,
    candidateCount: candidates.length,
    candidateBytes,
    candidateCapHit: candidates.length > candidateCap,
  };
}

/** Uncapped find reference (fast-glob without the 100-result cap). */
export async function findOracle({ cwd, args, deps }) {
  const dir = args.path ? path.resolve(cwd, args.path) : cwd;
  const ig = await loadRootIgnore(deps, dir);
  const entries = await deps.fg(toPosix(args.pattern), {
    cwd: dir,
    dot: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  return { files: entries.filter((e) => !ig.ignores(e)).sort() };
}

/** Cache oracle results per tree hash + base query (nonce variants share it). */
export async function cachedOracle({ cacheDir, treeHash, kind, args, compute }) {
  const { max_results: _ignored, ...baseArgs } = args;
  const key = sha1(JSON.stringify({ ORACLE_VERSION, treeHash, kind, baseArgs }));
  const file = path.join(cacheDir, treeHash.slice(0, 16), `${kind}-${key}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    const result = await compute();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(result));
    return result;
  }
}

/** Parse grep tool output into records + footer text. */
export function parseGrepOutput(output) {
  if (output.startsWith("No matches found.")) return { records: [], footer: output };
  const split = output.indexOf("\n\n");
  const body = split >= 0 ? output.slice(0, split) : output;
  const footer = split >= 0 ? output.slice(split + 2) : "";
  const records = [];
  const malformed = [];
  for (const raw of body.split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/s.exec(raw);
    if (!m) {
      malformed.push(raw);
      continue;
    }
    const text = m[3].endsWith("…") ? m[3].slice(0, -1) : m[3];
    records.push({
      path: toPosix(m[1]),
      line: Number(m[2]),
      prefixHash: sha1(text.slice(0, PREFIX_CHARS)),
    });
  }
  return { records, footer, malformed };
}

export function parseFindOutput(output) {
  const split = output.indexOf("\n\n");
  const body = split >= 0 ? output.slice(0, split) : output;
  return {
    files: body ? body.split("\n").map(toPosix) : [],
    footer: split >= 0 ? output.slice(split + 2) : "",
  };
}

function sameSequence(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Compare one grep call with the oracle given its outcome classes.
 * - complete: set equality with the reference
 * - result-cap / candidate-cap: exact sequence equality with the reference's first N
 * - deadline: every returned record must exist (precision) and recall is reported
 */
export function compareGrep({ records, oracle, maxResults, partial, engine }) {
  const reference =
    engine === "in-process" && oracle.candidateCapHit ? oracle.cappedMatches : oracle.matches;
  const refKeys = reference.map(recordKey);
  const fullKeys = new Set(oracle.matches.map(recordKey));
  const gotKeys = records.map(recordKey);
  const extra = gotKeys.filter((k) => !fullKeys.has(k)).length;
  const expectedCount = Math.min(oracle.matches.length, maxResults);
  const hits = gotKeys.filter((k) => fullKeys.has(k)).length;
  const recall = expectedCount === 0 ? 1 : Math.min(1, hits / expectedCount);
  if (partial.includes("deadline")) {
    return { check: "subset", pass: extra === 0, recall, extra, returned: records.length };
  }
  const firstN = refKeys.slice(0, maxResults);
  if (partial.includes("result-cap") || partial.includes("candidate-cap")) {
    return {
      check: "first-n",
      pass: sameSequence(gotKeys, firstN),
      recall,
      extra,
      returned: records.length,
    };
  }
  const want = new Set(refKeys);
  const pass = gotKeys.length === want.size && gotKeys.every((k) => want.has(k));
  return { check: "exact", pass, recall, extra, returned: records.length };
}

export function compareFind({ files, oracle, maxResults, truncated }) {
  const expected = truncated ? oracle.files.slice(0, maxResults) : oracle.files;
  const pass = sameSequence(files, expected);
  const full = new Set(oracle.files);
  return {
    check: truncated ? "first-n" : "exact",
    pass,
    recall:
      oracle.files.length === 0
        ? 1
        : files.filter((f) => full.has(f)).length / Math.min(oracle.files.length, maxResults),
    extra: files.filter((f) => !full.has(f)).length,
    returned: files.length,
  };
}
