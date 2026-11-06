// Frozen shared search tree: build once (git archive + seeded synthetic files),
// describe it in manifest.json and verify it before every run. Owner of the
// tree's identity; nothing else writes under the tree root.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LARGE_MARKER, NEEDLE, NO_MATCH, NONCE_PREFIX, TREE } from "./spec.mjs";

export const MANIFEST_NAME = "manifest.json";

/** Deterministic 32-bit PRNG (mulberry32). Returns a function yielding [0, 1). */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega vector buffer stream " +
  "handler request response config module export import const value result error token " +
  "search index match pattern scanner worker queue cache store record table column"
).split(" ");

/** Run a command (argument array, no shell); resolve stdout Buffer or reject. */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    const chunks = [];
    let stderr = "";
    child.stdout?.on("data", (c) => chunks.push(c));
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Minimal ustar/pax reader for `git archive` output (files and dirs only). */
export function* parseTar(buffer) {
  let offset = 0;
  let paxPath;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) return;
    const field = (start, len) =>
      header
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      for (const record of body.toString("utf8").split("\n")) {
        const match = /^\d+ path=(.*)$/s.exec(record);
        if (match) paxPath = match[1];
      }
      continue;
    }
    if (type === "g") continue;
    const entryPath = paxPath ?? name;
    paxPath = undefined;
    if (type === "5") yield { type: "dir", path: entryPath };
    else if (type === "0") yield { type: "file", path: entryPath, data: body };
    else yield { type: "other", path: entryPath, tarType: type };
  }
}

function assertContained(root, rel) {
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Archive entry escapes the tree: ${rel}`);
  }
  return target;
}

async function extractRepo(repoRoot, commit, dest) {
  const tar = await run("git", ["-C", repoRoot, "archive", "--format=tar", commit]);
  const skipped = [];
  for (const entry of parseTar(tar)) {
    const target = assertContained(dest, entry.path);
    if (entry.type === "dir") await mkdir(target, { recursive: true });
    else if (entry.type === "file") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.data);
    } else skipped.push(entry.path);
  }
  return skipped;
}

function wordLine(rng, chars) {
  let line = "";
  while (line.length < chars) line += `${WORDS[Math.floor(rng() * WORDS.length)]} `;
  return line.slice(0, chars).trimEnd();
}

async function writeManySmall(dest, rng) {
  const spec = TREE.manySmall;
  for (let d = 0; d < spec.dirs; d++)
    await mkdir(path.join(dest, `d${String(d).padStart(3, "0")}`), { recursive: true });
  for (let i = 0; i < spec.files; i++) {
    const size = spec.minBytes + Math.floor(rng() * (spec.maxBytes - spec.minBytes));
    const lines = [];
    let bytes = 0;
    while (bytes < size) {
      const line = wordLine(rng, 40 + Math.floor(rng() * 60));
      lines.push(line);
      bytes += line.length + 1;
    }
    if (i % spec.needleEvery === 0)
      lines.splice(Math.floor(rng() * lines.length), 0, `found ${NEEDLE} here`);
    const dir = `d${String(i % spec.dirs).padStart(3, "0")}`;
    await writeFile(
      path.join(dest, dir, `f${String(i).padStart(5, "0")}.txt`),
      `${lines.join("\n")}\n`,
    );
  }
}

async function writeLarge(dest, rng) {
  const spec = TREE.large;
  await mkdir(dest, { recursive: true });
  const lineCount = Math.floor(spec.bytes / (spec.lineChars + 1));
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const parts = [];
  for (let i = 0; i < lineCount; i++) {
    let line = i % spec.markerEvery === 0 ? `${LARGE_MARKER} ` : "";
    while (line.length < spec.lineChars) line += letters[Math.floor(rng() * 26)];
    parts.push(line);
  }
  await writeFile(path.join(dest, "large.txt"), `${parts.join("\n")}\n`);
}

/** Sorted relative posix paths of every file under root, excluding the manifest. */
export async function listFiles(root) {
  const out = [];
  async function walk(rel) {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && child !== MANIFEST_NAME) out.push(child);
    }
  }
  await walk("");
  return out.sort();
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => hash.update(c))
      .once("error", reject)
      .once("end", () => resolve(hash.digest("hex")));
  });
}

/** Tokens the harness relies on being absent (nonces) or present (needles). */
export const TRACKED_TOKENS = Object.freeze({
  noncePrefix: NONCE_PREFIX,
  noMatch: NO_MATCH,
  deadlineTail: "zq" + "DEADLINE",
  needle: NEEDLE,
  largeMarker: LARGE_MARKER,
});

export function treeHashOf(files) {
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f.path}\t${f.size}\t${f.sha256}\n`);
  return hash.digest("hex");
}

export async function describeTree(root) {
  const files = [];
  const tokenCounts = Object.fromEntries(Object.keys(TRACKED_TOKENS).map((k) => [k, 0]));
  for (const rel of await listFiles(root)) {
    const abs = path.join(root, rel);
    const info = await stat(abs);
    const sha256 = await sha256File(abs);
    if (info.size <= 16 * 1024 * 1024) {
      const text = await readFile(abs, "latin1");
      for (const [key, token] of Object.entries(TRACKED_TOKENS)) {
        if (text.includes(token)) tokenCounts[key] += 1;
      }
    }
    files.push({ path: rel, size: info.size, mtimeMs: info.mtimeMs, sha256 });
  }
  return { files, treeHash: treeHashOf(files), tokenFileCounts: tokenCounts };
}

/** Build the tree. Refuses to overwrite an existing tree unless `force`. */
export async function buildTree({
  root = TREE.defaultRoot,
  repoRoot,
  commit = TREE.repoCommit,
  force = false,
}) {
  const existing = await stat(path.join(root, MANIFEST_NAME)).catch(() => undefined);
  if (existing && !force)
    throw new Error(`Tree already exists at ${root}; pass --force to rebuild`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const skipped = await extractRepo(repoRoot, commit, path.join(root, "repo"));
  const rng = createRng(TREE.seed);
  await writeManySmall(path.join(root, "synthetic", "many-small"), rng);
  await writeLarge(path.join(root, "synthetic", "large"), rng);
  const description = await describeTree(root);
  const tokens = description.tokenFileCounts;
  if (tokens.noncePrefix || tokens.noMatch || tokens.deadlineTail) {
    throw new Error(`Nonce tokens occur in the tree: ${JSON.stringify(tokens)}`);
  }
  const manifest = {
    specTree: TREE,
    repoCommit: commit,
    builtAt: new Date().toISOString(),
    skippedArchiveEntries: skipped,
    fileCount: description.files.length,
    totalBytes: description.files.reduce((s, f) => s + f.size, 0),
    treeHash: description.treeHash,
    tokenFileCounts: tokens,
    files: description.files,
  };
  await writeFile(path.join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

export async function loadManifest(root = TREE.defaultRoot) {
  return JSON.parse(await readFile(path.join(root, MANIFEST_NAME), "utf8"));
}

/**
 * Manifest-only check for cold sessions: reads the manifest and no tree file,
 * so the cold sample stays cold. Content is verified after the measurement.
 */
export async function manifestCheck(root = TREE.defaultRoot) {
  try {
    const manifest = await loadManifest(root);
    return { ok: true, treeHash: manifest.treeHash, problems: [] };
  } catch (error) {
    return { ok: false, treeHash: undefined, problems: [`manifest unreadable: ${error.message}`] };
  }
}

/**
 * Verify the tree. `full` re-hashes every file; fast mode compares the file
 * list, sizes and mtimes. Returns { ok, treeHash, problems }.
 */
export async function verifyTree(root = TREE.defaultRoot, { full = false } = {}) {
  let manifest;
  try {
    manifest = await loadManifest(root);
  } catch (error) {
    return { ok: false, treeHash: undefined, problems: [`manifest unreadable: ${error.message}`] };
  }
  const problems = [];
  const listed = await listFiles(root);
  const expected = manifest.files.map((f) => f.path);
  if (listed.length !== expected.length || listed.some((p, i) => p !== expected[i])) {
    problems.push(`file list differs (${listed.length} on disk vs ${expected.length} in manifest)`);
    return { ok: false, treeHash: manifest.treeHash, problems };
  }
  const actual = [];
  for (const entry of manifest.files) {
    const abs = path.join(root, entry.path);
    const info = await stat(abs);
    if (info.size !== entry.size) problems.push(`size changed: ${entry.path}`);
    if (!full && info.mtimeMs !== entry.mtimeMs) problems.push(`mtime changed: ${entry.path}`);
    if (full) actual.push({ path: entry.path, size: info.size, sha256: await sha256File(abs) });
    if (problems.length > 20) break;
  }
  if (full && problems.length === 0 && treeHashOf(actual) !== manifest.treeHash) {
    problems.push("content hash differs from manifest");
  }
  return { ok: problems.length === 0, treeHash: manifest.treeHash, problems };
}
