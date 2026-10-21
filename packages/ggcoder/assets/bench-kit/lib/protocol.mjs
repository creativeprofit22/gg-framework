// @ts-check
// Protocol freezing. The first run freezes what is being compared: the bytes
// of study.json, every workload file, the vendored kit, candidate provenance
// and the seed. Any later change produces a new protocol version, and results
// from different versions are never pooled.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { err, ok } from "./result.mjs";
import { loadStudy } from "./study.mjs";

export const PROTOCOL_SCHEMA = 1;
export const PROTOCOL_FILE = "protocol.json";

/** Extensions treated as text; these must use LF so their hashes are stable across OSes. */
const TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".sh",
  ".srt",
  ".vtt",
  ".ini",
  ".env",
]);

/** @param {Uint8Array | string} bytes */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @param {string} file */
export const isTextFile = (file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());

/**
 * Deterministic JSON: object keys sorted at every level.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash every file under `dir` (posix relative paths, sorted). Text files with
 * CR bytes are rejected. A missing directory hashes as an empty tree.
 * @param {string} dir
 * @param {{ exclude?: (relPath: string) => boolean }} [options]
 * @returns {Promise<import("./result.mjs").Result<{ digest: string, files: { path: string, sha256: string, bytes: number }[] }>>}
 */
export async function hashTree(dir, { exclude = () => false } = {}) {
  /** @type {{ path: string, sha256: string, bytes: number }[]} */
  const files = [];
  /** @type {string[]} */
  const crlf = [];
  /** @param {string} abs @param {string} rel */
  const walk = async (abs, rel) => {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" && rel === "") return;
      throw error;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (exclude(childRel)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (entry.isFile()) {
        const bytes = await readFile(childAbs);
        if (isTextFile(entry.name) && bytes.includes(13)) crlf.push(childRel);
        files.push({ path: childRel, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  try {
    await walk(dir, "");
  } catch (error) {
    return err("HASH_READ", `cannot read ${dir}: ${/** @type {Error} */ (error).message}`);
  }
  if (crlf.length)
    return err(
      "HASH_CRLF",
      `text files with CR line endings (save them with LF): ${crlf.sort().join(", ")}`,
      crlf.sort(),
    );
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ok({ digest: sha256(files.map((f) => `${f.path}\t${f.sha256}\n`).join("")), files });
}

/** Environment facts recorded alongside a protocol or run (not part of the digest). */
export function captureEnvironment() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

/**
 * @typedef {{
 *   studyId: string,
 *   studyHash: string,
 *   workloadHash: string,
 *   workloadFiles: number,
 *   kitHash: string,
 *   seed: number,
 *   candidates: Record<string, unknown>,
 * }} Fingerprint
 * @typedef {Fingerprint & { version: number, digest: string, frozenAt: string, environment?: unknown }} ProtocolVersion
 * @typedef {{ schema: number, studyId: string, current: number, versions: ProtocolVersion[] }} ProtocolFile
 */

/**
 * Compute the current fingerprint of a study folder.
 * @param {string} studyDir
 * @param {{ kitDir: string, provenance?: Record<string, unknown>, registries?: import("./study.mjs").Registries }} options
 * @returns {Promise<import("./result.mjs").Result<{ fingerprint: Fingerprint, digest: string, study: any }>>}
 */
export async function fingerprintStudy(studyDir, { kitDir, provenance = {}, registries }) {
  const loaded = await loadStudy(studyDir, registries);
  if (!loaded.ok) return loaded;
  const { study, bytes } = loaded.value;
  const workloadDir = path.join(studyDir, study.workload.dir ?? "workload");
  const workload = await hashTree(workloadDir);
  if (!workload.ok) return workload;
  const present = new Set(workload.value.files.map((f) => f.path));
  // An input may be a file or a folder (e.g. an agent task bundle) that holds files.
  const folders = new Set(
    workload.value.files.flatMap((f) =>
      f.path
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  );
  /** @type {string[]} */
  const missing = [];
  for (const item of study.workload.items)
    for (const [key, value] of [
      ["input", item.input],
      ["expectedFile", item.expectedFile],
    ]) {
      if (typeof value !== "string") continue;
      const p = value.replaceAll("\\", "/").replace(/\/+$/, "");
      if (!present.has(p) && !(key === "input" && folders.has(p))) missing.push(p);
    }
  if (missing.length)
    return err(
      "WORKLOAD_MISSING",
      `workload files not found: ${[...new Set(missing)].sort().join(", ")}`,
      missing,
    );
  const kit = await hashTree(kitDir, {
    exclude: (rel) => rel === "node_modules" || rel.endsWith(".log"),
  });
  if (!kit.ok) return kit;
  if (kit.value.files.length === 0) return err("KIT_MISSING", `no kit files found in ${kitDir}`);
  /** @type {Record<string, unknown>} */
  const candidates = {};
  for (const c of [...study.candidates].sort((/** @type {any} */ a, /** @type {any} */ b) =>
    a.id < b.id ? -1 : 1,
  ))
    candidates[c.id] = provenance[c.id] ?? null;
  /** @type {Fingerprint} */
  const fingerprint = {
    studyId: study.id,
    studyHash: sha256(bytes),
    workloadHash: workload.value.digest,
    workloadFiles: workload.value.files.length,
    kitHash: kit.value.digest,
    seed: study.seed,
    candidates,
  };
  return ok({ fingerprint, digest: sha256(canonicalJson(fingerprint)), study });
}

/** @param {string} studyDir @returns {Promise<import("./result.mjs").Result<ProtocolFile | null>>} */
export async function readProtocol(studyDir) {
  const file = path.join(studyDir, PROTOCOL_FILE);
  /** @type {string} */
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return ok(null);
    return err("PROTOCOL_READ", `cannot read ${file}: ${/** @type {Error} */ (error).message}`);
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return err(
      "PROTOCOL_JSON",
      `${file} is not valid JSON: ${/** @type {Error} */ (error).message}`,
    );
  }
  if (
    parsed?.schema !== PROTOCOL_SCHEMA ||
    !Array.isArray(parsed.versions) ||
    parsed.versions.length === 0
  )
    return err("PROTOCOL_INVALID", `${file} is not a protocol file this kit understands`);
  return ok(/** @type {ProtocolFile} */ (parsed));
}

/** @param {ProtocolFile} protocol */
export const currentVersion = (protocol) =>
  /** @type {ProtocolVersion} */ (protocol.versions.find((v) => v.version === protocol.current));

/** @param {string} file @param {string} text */
async function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, text);
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** @param {Fingerprint} a @param {Fingerprint} b */
function changedParts(a, b) {
  /** @type {string[]} */
  const parts = [];
  if (a.studyHash !== b.studyHash) parts.push("study.json");
  if (a.workloadHash !== b.workloadHash) parts.push("workload");
  if (a.kitHash !== b.kitHash) parts.push("kit");
  if (a.seed !== b.seed) parts.push("seed");
  if (canonicalJson(a.candidates) !== canonicalJson(b.candidates))
    parts.push("candidate provenance");
  return parts;
}

/**
 * Freeze the protocol. First call writes version 1; an unchanged study
 * returns the current version; any change appends a new version.
 * @param {string} studyDir
 * @param {{ kitDir: string, provenance?: Record<string, unknown>, registries?: import("./study.mjs").Registries, now?: () => string, environment?: unknown }} options
 * @returns {Promise<import("./result.mjs").Result<{ status: "created" | "unchanged" | "new-version", version: ProtocolVersion, changed: string[] }>>}
 */
export async function freezeProtocol(studyDir, options) {
  const { now = () => new Date().toISOString(), environment = captureEnvironment() } = options;
  const computed = await fingerprintStudy(studyDir, options);
  if (!computed.ok) return computed;
  const existing = await readProtocol(studyDir);
  if (!existing.ok) return existing;
  const { fingerprint, digest } = computed.value;
  const previous = existing.value ? currentVersion(existing.value) : undefined;
  if (existing.value && previous && existing.value.studyId !== fingerprint.studyId)
    return err(
      "PROTOCOL_STUDY_MISMATCH",
      `protocol.json belongs to study "${existing.value.studyId}", not "${fingerprint.studyId}"`,
    );
  if (previous?.digest === digest)
    return ok({ status: "unchanged", version: previous, changed: [] });
  const versions = existing.value?.versions ?? [];
  const number = versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  /** @type {ProtocolVersion} */
  const version = { version: number, digest, frozenAt: now(), ...fingerprint, environment };
  /** @type {ProtocolFile} */
  const protocol = {
    schema: PROTOCOL_SCHEMA,
    studyId: fingerprint.studyId,
    current: number,
    versions: [...versions, version],
  };
  try {
    await writeAtomic(path.join(studyDir, PROTOCOL_FILE), `${JSON.stringify(protocol, null, 2)}\n`);
  } catch (error) {
    return err(
      "PROTOCOL_WRITE",
      `cannot write protocol.json: ${/** @type {Error} */ (error).message}`,
    );
  }
  return ok({
    status: previous ? "new-version" : "created",
    version,
    changed: previous ? changedParts(previous, fingerprint) : [],
  });
}

/**
 * Check the study still matches its frozen protocol (before running or reporting).
 * @param {string} studyDir
 * @param {{ kitDir: string, provenance?: Record<string, unknown>, registries?: import("./study.mjs").Registries }} options
 * @returns {Promise<import("./result.mjs").Result<ProtocolVersion>>}
 */
export async function verifyProtocol(studyDir, options) {
  const existing = await readProtocol(studyDir);
  if (!existing.ok) return existing;
  if (!existing.value)
    return err("PROTOCOL_NOT_FROZEN", "no protocol.json yet; run `freeze` first");
  const computed = await fingerprintStudy(studyDir, options);
  if (!computed.ok) return computed;
  const current = currentVersion(existing.value);
  if (current.digest !== computed.value.digest) {
    const changed = changedParts(current, computed.value.fingerprint);
    return err(
      "PROTOCOL_DRIFT",
      `changed since protocol v${current.version} was frozen: ${changed.join(", ")}; freeze again to start a new version`,
      changed,
    );
  }
  return ok(current);
}

/**
 * Refuse to pool runs from different protocol versions.
 * @param {{ runId: string, protocolVersion: number, protocolDigest: string }[]} runs
 * @returns {import("./result.mjs").Result<{ protocolVersion: number, protocolDigest: string, runIds: string[] }>}
 */
export function assertPoolable(runs) {
  if (runs.length === 0) return err("POOL_EMPTY", "no runs to combine");
  const digests = new Map(runs.map((r) => [r.protocolDigest, r.protocolVersion]));
  if (digests.size > 1) {
    const list = [...digests]
      .map(([d, v]) => `v${v} (${d.slice(0, 8)})`)
      .sort()
      .join(", ");
    return err(
      "POOL_MIXED",
      `runs come from different protocol versions (${list}); results are never pooled across versions`,
      [...digests.keys()].sort(),
    );
  }
  const [first] = runs;
  return ok({
    protocolVersion: /** @type {typeof runs[number]} */ (first).protocolVersion,
    protocolDigest: /** @type {typeof runs[number]} */ (first).protocolDigest,
    runIds: runs.map((r) => r.runId).sort(),
  });
}
