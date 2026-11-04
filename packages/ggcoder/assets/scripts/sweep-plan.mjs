#!/usr/bin/env node
// Sweep planner: lists every in-scope file, sorts it into a reading tier, packs it into
// chunks and proves the chunks cover every text file exactly once. Node built-ins only.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SCHEMA_VERSION = 1;
export const GENERATED_BY = "sweep-plan";
// Chunk and counts order; classification precedence lives in classify().
export const TIERS = Object.freeze(["source", "test", "docs", "config", "generated"]);
export const SETTINGS_KEYS = Object.freeze([
  "chunkLines",
  "maxFilesPerChunk",
  "pageLines",
  "pageBytes",
]);
export const DEFAULT_SETTINGS = Object.freeze({
  chunkLines: 4000,
  maxFilesPerChunk: 50,
  pageLines: 1800,
  pageBytes: 45000,
});
// The read tool's limits; a page must never exceed them.
export const READ_LIMITS = Object.freeze({ lines: 2000, bytes: 51200 });
const BINARY_SNIFF_BYTES = 8192;
const GLOB_KEYS = Object.freeze([
  "excludeGlobs",
  "generatedGlobs",
  "testGlobs",
  "configGlobs",
  "docsGlobs",
  "sourceGlobs",
  "routeGlobs",
]);

const USAGE = `Usage: node sweep-plan.mjs [--root <dir>] [--config <path>] [--out <path>]
       [--chunk-lines N] [--max-files N] [--page-lines N] [--page-bytes N]
       node sweep-plan.mjs --verify <plan.json>
Exit codes: 0 ok, 1 usage or IO error, 2 files match no sweep pattern, 3 coverage check failed.`;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** @param {string} p */
export function toPosixRelative(p) {
  return p
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

/** Split on commas that are not inside nested braces. @param {string} body */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(body.slice(last));
  return parts;
}

/** Expand `{a,b}` alternatives (nesting allowed); `{a}` and unbalanced braces stay literal. */
export function expandBraces(glob) {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth !== 0) continue;
      const parts = splitTopLevel(glob.slice(open + 1, i));
      if (parts.length < 2) continue;
      const head = glob.slice(0, open);
      const tail = glob.slice(i + 1);
      return parts.flatMap((part) => expandBraces(head + part + tail));
    }
  }
  return [glob];
}

/** One brace-free alternative to regex source (no anchors). @param {string} g */
function globSource(g) {
  const literal = !/[*?]/.test(g);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A plain path (no wildcards) also matches everything under it.
  return literal ? `${re}(?:/.*)?` : re;
}

/** `**`, `*`, `?` and `{a,b}`; backslashes are treated as folder separators. */
export function globToRegExp(glob) {
  const g = toPosixRelative(glob).replace(/\/+$/, "");
  const alts = expandBraces(g).map(globSource);
  return new RegExp(`^(?:${alts.join("|")})$`);
}

/** @param {readonly string[]} globs @returns {(p: string) => boolean} */
export function compileGlobs(globs) {
  if (globs.length === 0) return () => false;
  const regexes = globs.map(globToRegExp);
  return (p) => regexes.some((re) => re.test(p));
}

/** @param {string} p @param {readonly string[]} globs */
export const matchesAny = (p, globs) => compileGlobs(globs)(toPosixRelative(p));

/** Validate `scopeResolution` and compile its globs. Missing lists are empty. */
export function compileScope(scopeResolution) {
  if (scopeResolution === null || typeof scopeResolution !== "object") {
    return { ok: false, error: "config has no scopeResolution object" };
  }
  const scope = {};
  for (const key of GLOB_KEYS) {
    const value = scopeResolution[key] ?? [];
    if (!Array.isArray(value) || value.some((g) => typeof g !== "string")) {
      return { ok: false, error: `scopeResolution.${key} must be an array of strings` };
    }
    scope[key] = compileGlobs(value);
  }
  return { ok: true, scope };
}

/** Command definitions (`.../commands/<name>.md`) are read as source, not docs. */
export function isCommandDoc(p) {
  const parts = p.split("/");
  return parts.length >= 2 && parts[parts.length - 2] === "commands" && /\.md$/i.test(p);
}

/** First match wins; null means the file matches no tier. */
export function classify(filePath, scope) {
  const p = toPosixRelative(filePath);
  if (scope.generatedGlobs(p)) return "generated";
  if (scope.testGlobs(p)) return "test";
  if (isCommandDoc(p)) return "source";
  if (scope.configGlobs(p)) return "config";
  if (scope.docsGlobs(p)) return "docs";
  if (scope.sourceGlobs(p) || scope.routeGlobs(p)) return "source";
  return null;
}

/** LF-terminated lines; CRLF counts once; a final line without LF still counts. */
export function countLines(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let pos = buf.indexOf(10); pos !== -1; pos = buf.indexOf(10, pos + 1)) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

export function isBinary(buf) {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Consecutive 1-based inclusive line ranges, each within both limits. */
export function pageRanges(buf, pageLines, pageBytes) {
  const pages = [];
  let start = 1;
  let count = 0;
  let size = 0;
  const flush = () => {
    if (count === 0) return;
    pages.push({ start, end: start + count - 1 });
    start += count;
    count = 0;
    size = 0;
  };
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const next = nl === -1 ? buf.length : nl + 1;
    const len = next - pos;
    pos = next;
    if (len > pageBytes) {
      flush();
      pages.push({ start, end: start, oversizedLine: true });
      start += 1;
      continue;
    }
    if (count >= pageLines || size + len > pageBytes) flush();
    count++;
    size += len;
  }
  flush();
  return pages;
}

/** Defaults, then each layer in order. Returns a Result. */
export function resolveSettings(...layers) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;
    if (typeof layer !== "object" || Array.isArray(layer)) {
      return { ok: false, error: "sweepPlan settings must be an object" };
    }
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (!SETTINGS_KEYS.includes(key)) return { ok: false, error: `unknown setting "${key}"` };
      if (!Number.isInteger(value) || value < 1) {
        return { ok: false, error: `${key} must be a positive whole number` };
      }
      settings[key] = value;
    }
  }
  if (settings.pageLines > READ_LIMITS.lines) {
    return { ok: false, error: `pageLines must be at most ${READ_LIMITS.lines}` };
  }
  if (settings.pageBytes > READ_LIMITS.bytes) {
    return { ok: false, error: `pageBytes must be at most ${READ_LIMITS.bytes}` };
  }
  // Files up to pageLines are never paged, so a smaller chunk budget could not be kept.
  if (settings.chunkLines < settings.pageLines) {
    return {
      ok: false,
      error: `chunkLines (${settings.chunkLines}) must be at least pageLines (${settings.pageLines})`,
    };
  }
  return { ok: true, settings };
}

const folderOf = (p) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

/**
 * Pack units ({ path, tier, start, end, lines }) into chunks that never mix tiers.
 * A folder starts a fresh chunk when it misses the space left but fits an empty chunk.
 */
export function packChunks(units, settings) {
  const { chunkLines, maxFilesPerChunk } = settings;
  const chunks = [];
  for (const tier of TIERS) {
    const sorted = units
      .filter((u) => u.tier === tier)
      .map((u) => ({ ...u, folder: folderOf(u.path) }))
      .sort((a, b) => cmp(a.folder, b.folder) || cmp(a.path, b.path) || a.start - b.start);
    const groups = [];
    for (const u of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.folder === u.folder) last.units.push(u);
      else groups.push({ folder: u.folder, units: [u] });
    }
    const tierChunks = [];
    let cur = null;
    const open = () => {
      cur = { id: "", tier, lines: 0, entries: [] };
      tierChunks.push(cur);
    };
    const fits = (lines, count) =>
      cur !== null &&
      cur.lines + lines <= chunkLines &&
      cur.entries.length + count <= maxFilesPerChunk;
    for (const group of groups) {
      const lines = group.units.reduce((sum, u) => sum + u.lines, 0);
      const count = group.units.length;
      const fitsEmpty = lines <= chunkLines && count <= maxFilesPerChunk;
      if (cur !== null && cur.entries.length > 0 && !fits(lines, count) && fitsEmpty) open();
      for (const u of group.units) {
        if (cur === null || (cur.entries.length > 0 && !fits(u.lines, 1))) open();
        cur.entries.push({ path: u.path, start: u.start, end: u.end });
        cur.lines += u.lines;
      }
    }
    tierChunks.forEach((c, i) => {
      c.id = `${tier}-${String(i + 1).padStart(3, "0")}`;
    });
    chunks.push(...tierChunks);
  }
  return chunks;
}

/**
 * Pure planner. files: [{ path, content: Buffer | () => Buffer }]; content is read only for
 * files that are not excluded. Returns { ok: true, plan } or { ok: false, unmatched | error }.
 */
export function buildPlan({ files, config, configHash = null, gitCommit = null, settings }) {
  const scopeResult = compileScope(config?.scopeResolution);
  if (!scopeResult.ok) return scopeResult;
  const { scope } = scopeResult;
  const settingsResult = resolveSettings(settings);
  if (!settingsResult.ok) return settingsResult;
  const resolved = settingsResult.settings;

  const byPath = new Map();
  for (const f of files) {
    const p = toPosixRelative(f.path);
    if (p !== "" && !byPath.has(p)) byPath.set(p, f.content);
  }
  const paths = [...byPath.keys()].sort(cmp);

  let excluded = 0;
  const binary = [];
  const unmatched = [];
  const text = [];
  for (const p of paths) {
    if (scope.excludeGlobs(p)) {
      excluded++;
      continue;
    }
    const raw = byPath.get(p);
    const buf = typeof raw === "function" ? raw() : raw;
    if (isBinary(buf)) {
      binary.push({ path: p, bytes: buf.length, sha256: sha256(buf) });
      continue;
    }
    const tier = classify(p, scope);
    if (tier === null) unmatched.push(p);
    else text.push({ path: p, tier, buf });
  }
  if (unmatched.length > 0) return { ok: false, unmatched };

  const units = [];
  const records = [];
  for (const { path: p, tier, buf } of text) {
    const lines = countLines(buf);
    const paged = lines > resolved.pageLines || buf.length > resolved.pageBytes;
    const record = { path: p, tier, lines, bytes: buf.length, sha256: sha256(buf), ranges: null };
    if (paged) {
      record.ranges = pageRanges(buf, resolved.pageLines, resolved.pageBytes);
      for (const r of record.ranges) {
        units.push({ path: p, tier, start: r.start, end: r.end, lines: r.end - r.start + 1 });
      }
    } else if (lines === 0) {
      units.push({ path: p, tier, start: 0, end: 0, lines: 0 });
    } else {
      units.push({ path: p, tier, start: 1, end: lines, lines });
    }
    records.push(record);
  }

  const chunks = packChunks(units, resolved);
  const owner = new Map();
  for (const c of chunks) for (const e of c.entries) owner.set(`${e.path}\0${e.start}`, c.id);

  const byTier = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const planFiles = records.map((r) => {
    byTier[r.tier]++;
    const base = { path: r.path, tier: r.tier, lines: r.lines, bytes: r.bytes, sha256: r.sha256 };
    if (r.ranges === null) {
      return { ...base, chunk: owner.get(`${r.path}\0${r.lines === 0 ? 0 : 1}`) };
    }
    const pages = r.ranges.map((range) => {
      const chunk = owner.get(`${r.path}\0${range.start}`);
      const page = { start: range.start, end: range.end, chunk };
      return range.oversizedLine ? { ...page, oversizedLine: true } : page;
    });
    return { ...base, pages };
  });

  const plan = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATED_BY,
    gitCommit,
    configHash,
    settings: resolved,
    counts: {
      files: planFiles.length,
      excluded,
      binary: binary.length,
      paged: records.filter((r) => r.ranges !== null).length,
      chunks: chunks.length,
      byTier,
    },
    files: planFiles,
    chunks,
    binary,
  };
  return { ok: true, plan };
}

/** Every problem that breaks "each text file line is in exactly one chunk". */
export function checkCoverage(plan) {
  const problems = [];
  const files = Array.isArray(plan?.files) ? plan.files : [];
  const chunks = Array.isArray(plan?.chunks) ? plan.chunks : [];
  if (!Array.isArray(plan?.files)) problems.push("plan has no files array");
  if (!Array.isArray(plan?.chunks)) problems.push("plan has no chunks array");

  const known = new Map();
  for (const f of files) {
    if (known.has(f.path)) problems.push(`file listed twice: ${f.path}`);
    else known.set(f.path, f);
  }
  const seenIds = new Set();
  const actual = new Map();
  for (const c of chunks) {
    if (seenIds.has(c.id)) problems.push(`chunk id used twice: ${c.id}`);
    seenIds.add(c.id);
    let sum = 0;
    for (const e of Array.isArray(c.entries) ? c.entries : []) {
      const f = known.get(e.path);
      if (!f) {
        problems.push(`chunk ${c.id} lists a file that is not in the plan: ${e.path}`);
        continue;
      }
      if (f.tier !== c.tier) {
        problems.push(`chunk ${c.id} (${c.tier}) holds ${f.tier} file ${e.path}`);
      }
      sum += e.start > 0 && e.end >= e.start ? e.end - e.start + 1 : 0;
      if (!actual.has(e.path)) actual.set(e.path, []);
      actual.get(e.path).push({ start: e.start, end: e.end, chunk: c.id });
    }
    if (sum !== c.lines) problems.push(`chunk ${c.id} says ${c.lines} lines but holds ${sum}`);
  }

  for (const f of known.values()) {
    const ranges = (actual.get(f.path) ?? [])
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);
    if (ranges.length === 0) {
      problems.push(`file is in no chunk: ${f.path}`);
      continue;
    }
    if (f.lines === 0) {
      if (ranges.length !== 1 || ranges[0].start !== 0 || ranges[0].end !== 0) {
        problems.push(`empty file must appear once as 0-0: ${f.path}`);
      }
    } else {
      let next = 1;
      let prev = null;
      for (const r of ranges) {
        if (
          !Number.isInteger(r.start) ||
          !Number.isInteger(r.end) ||
          r.start < 1 ||
          r.end < r.start
        ) {
          problems.push(`bad range ${r.start}-${r.end} in ${r.chunk}: ${f.path}`);
          continue;
        }
        if (prev && prev.start === r.start && prev.end === r.end) {
          problems.push(
            `range ${r.start}-${r.end} listed twice (${prev.chunk}, ${r.chunk}): ${f.path}`,
          );
        } else if (r.start < next) {
          problems.push(
            `lines ${r.start}-${Math.min(r.end, next - 1)} overlap in ${r.chunk}: ${f.path}`,
          );
        } else if (r.start > next) {
          problems.push(`lines ${next}-${r.start - 1} are in no chunk: ${f.path}`);
        }
        if (r.end > f.lines) {
          problems.push(`range ${r.start}-${r.end} runs past line ${f.lines}: ${f.path}`);
        }
        next = Math.max(next, r.end + 1);
        prev = r;
      }
      if (next <= f.lines) problems.push(`lines ${next}-${f.lines} are in no chunk: ${f.path}`);
    }
    const expected = Array.isArray(f.pages)
      ? f.pages.map((pg) => `${pg.chunk}:${pg.start}-${pg.end}`)
      : [`${f.chunk}:${f.lines === 0 ? 0 : 1}-${f.lines}`];
    const got = ranges.map((r) => `${r.chunk}:${r.start}-${r.end}`);
    if (expected.slice().sort(cmp).join("|") !== got.slice().sort(cmp).join("|")) {
      problems.push(`file assignment does not match its chunks: ${f.path}`);
    }
  }
  return problems;
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k]]));

/** Fixed key order, 2-space JSON, trailing newline. */
export function serializePlan(plan) {
  const ordered = {
    schemaVersion: plan.schemaVersion,
    generatedBy: plan.generatedBy,
    gitCommit: plan.gitCommit ?? null,
    configHash: plan.configHash ?? null,
    settings: pick(plan.settings, SETTINGS_KEYS),
    counts: {
      ...pick(plan.counts, ["files", "excluded", "binary", "paged", "chunks"]),
      byTier: pick(plan.counts.byTier, TIERS),
    },
    files: plan.files.map((f) => {
      const base = pick(f, ["path", "tier", "lines", "bytes", "sha256"]);
      if (!Array.isArray(f.pages)) return { ...base, chunk: f.chunk };
      const pages = f.pages.map((pg) =>
        pg.oversizedLine
          ? { ...pick(pg, ["start", "end", "chunk"]), oversizedLine: true }
          : pick(pg, ["start", "end", "chunk"]),
      );
      return { ...base, pages };
    }),
    chunks: plan.chunks.map((c) => ({
      ...pick(c, ["id", "tier", "lines"]),
      entries: c.entries.map((e) => pick(e, ["path", "start", "end"])),
    })),
    binary: plan.binary.map((b) => pick(b, ["path", "bytes", "sha256"])),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Resolve symlinks and short names through the nearest existing ancestor. */
function realPath(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function parseCount(name, value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (!/^\d+$/.test(value)) return { ok: false, error: `--${name} needs a positive whole number` };
  return { ok: true, value: Number(value) };
}

function verifyPlanFile(file, say, fail) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`sweep-plan: cannot read ${file}: ${error.message}`);
    return 1;
  }
  if (plan?.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `sweep-plan: ${file} has schemaVersion ${plan?.schemaVersion}, expected ${SCHEMA_VERSION}`,
    );
    return 1;
  }
  const problems = checkCoverage(plan);
  if (problems.length > 0) {
    fail(`sweep-plan: coverage check failed (${problems.length} problems):`);
    for (const p of problems) fail(`  ${p}`);
    return 3;
  }
  say(
    `sweep-plan: ${file} ok: ${plan.files.length} files in ${plan.chunks.length} chunks, each line once`,
  );
  return 0;
}

/** CLI entry; returns the exit code. */
export function main(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const say = (s) => (io.stdout ?? process.stdout).write(`${s}\n`);
  const fail = (s) => (io.stderr ?? process.stderr).write(`${s}\n`);

  let args;
  try {
    args = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        root: { type: "string" },
        config: { type: "string" },
        out: { type: "string" },
        "chunk-lines": { type: "string" },
        "max-files": { type: "string" },
        "page-lines": { type: "string" },
        "page-bytes": { type: "string" },
        verify: { type: "string" },
        help: { type: "boolean" },
      },
    }).values;
  } catch (error) {
    fail(`sweep-plan: ${error.message}\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.verify !== undefined) return verifyPlanFile(path.resolve(cwd, args.verify), say, fail);

  const flags = {};
  for (const [flag, key] of [
    ["chunk-lines", "chunkLines"],
    ["max-files", "maxFilesPerChunk"],
    ["page-lines", "pageLines"],
    ["page-bytes", "pageBytes"],
  ]) {
    const parsed = parseCount(flag, args[flag]);
    if (!parsed.ok) {
      fail(`sweep-plan: ${parsed.error}`);
      return 1;
    }
    flags[key] = parsed.value;
  }

  const start = path.resolve(cwd, args.root ?? ".");
  let root;
  try {
    root = path.resolve(git(start, ["rev-parse", "--show-toplevel"]).toString("utf8").trim());
  } catch {
    fail(`sweep-plan: ${start} is not inside a git repository`);
    return 1;
  }
  const configPath = args.config
    ? path.resolve(cwd, args.config)
    : path.join(root, ".gg", "sweep.config.json");
  const outPath = args.out
    ? path.resolve(cwd, args.out)
    : path.join(root, ".gg", "sweep", "plan.json");

  let configBytes;
  let config;
  try {
    configBytes = fs.readFileSync(configPath);
    config = JSON.parse(configBytes.toString("utf8"));
  } catch (error) {
    fail(`sweep-plan: cannot read config ${configPath}: ${error.message}`);
    return 1;
  }
  const settings = resolveSettings(config?.sweepPlan, flags);
  if (!settings.ok) {
    fail(`sweep-plan: ${settings.error}`);
    return 1;
  }

  let gitCommit = null;
  try {
    const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).toString("utf8").trim();
    gitCommit = head || null;
  } catch {
    // no commit yet: gitCommit stays null
  }

  let listed;
  try {
    listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    fail(`sweep-plan: git ls-files failed: ${error.message}`);
    return 1;
  }
  // The plan never lists its own output file (real paths: Windows temp dirs may be 8.3 names).
  const outRel = toPosixRelative(path.relative(realPath(root), realPath(outPath)));
  const files = [];
  let skipped = 0;
  for (const rel of [...new Set(listed)]) {
    if (toPosixRelative(rel) === outRel) continue;
    const full = path.join(root, rel);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue; // tracked but deleted from the working tree
    }
    if (!stat.isFile()) {
      skipped++; // symlinks and submodules have no lines to read
      continue;
    }
    files.push({ path: rel, content: () => fs.readFileSync(full) });
  }

  let result;
  try {
    result = buildPlan({
      files,
      config,
      configHash: sha256(configBytes),
      gitCommit,
      settings: settings.settings,
    });
  } catch (error) {
    fail(`sweep-plan: ${error.message}`);
    return 1;
  }
  if (!result.ok && result.unmatched) {
    fail(
      `sweep-plan: ${result.unmatched.length} files match no sweep pattern; add them to a tier glob or to excludeGlobs:`,
    );
    for (const p of result.unmatched) fail(`  ${p}`);
    return 2;
  }
  if (!result.ok) {
    fail(`sweep-plan: ${result.error}`);
    return 1;
  }
  const problems = checkCoverage(result.plan);
  if (problems.length > 0) {
    fail(`sweep-plan: coverage check failed (${problems.length} problems); nothing written:`);
    for (const p of problems) fail(`  ${p}`);
    return 3;
  }
  try {
    writeAtomic(outPath, serializePlan(result.plan));
  } catch (error) {
    fail(`sweep-plan: cannot write ${outPath}: ${error.message}`);
    return 1;
  }
  const { counts } = result.plan;
  const tiers = TIERS.map((t) => `${t} ${counts.byTier[t]}`).join(", ");
  say(
    `sweep-plan: ${counts.files} files (${tiers}), ${counts.chunks} chunks, ${counts.paged} paged, ${counts.binary} binary, ${counts.excluded} excluded`,
  );
  if (skipped > 0) say(`sweep-plan: skipped ${skipped} symlinks or submodules`);
  say(`sweep-plan: wrote ${outPath}`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = main(process.argv.slice(2));
}
