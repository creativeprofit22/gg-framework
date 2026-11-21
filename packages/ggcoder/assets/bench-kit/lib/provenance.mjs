// @ts-check
// Provenance: refuse to measure the wrong version of a candidate, and record
// exactly which version was measured. Generalised from bench/search's target
// guard: nothing is hard-coded to one package; each candidate may declare an
// optional `source` in study.json:
//
//   "source": {
//     "worktree": "../engine-b",        // git worktree, relative to the project root
//     "commit": "1a2b3c4",              // expected HEAD prefix (7-40 hex)
//     "allowDirty": false,              // default: uncommitted changes refuse the run
//     "files": ["dist/engine.js"],      // byte hashes recorded (paths inside the worktree)
//     "version": "node dist/engine.js --version"  // first output line recorded
//   }
//
// Recorded facts are stable across machines (no absolute paths, no times), so
// they can feed the protocol fingerprint: a new commit or build output means a
// new protocol version. Commands run without a shell through an injectable
// `exec`, so the guard is unit-testable.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { splitCommand } from "./argv.mjs";
import { err, ok } from "./result.mjs";

/**
 * @typedef {{ ok: boolean, stdout: string, error?: string }} ExecResult
 * @typedef {(command: string, args: string[], options?: { cwd?: string, timeoutMs?: number }) => Promise<ExecResult>} Exec
 * @typedef {{ worktree?: string, commit?: string, allowDirty?: boolean, files?: string[], version?: string | string[] }} Source
 * @typedef {{
 *   worktree?: string,
 *   commit?: string,
 *   expectedCommit?: string,
 *   dirty?: boolean,
 *   statusDigest?: string,
 *   files?: Record<string, string>,
 *   version?: string,
 * }} SourceFacts
 */

/** @param {string | Buffer} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const COMMIT = /^[0-9a-f]{7,40}$/i;
const SOURCE_KEYS = new Set(["worktree", "commit", "allowDirty", "files", "version"]);

/** Default command runner: no shell, hidden window, bounded output and time. @type {Exec} */
export function defaultExec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        windowsHide: true,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "").trim();
        if (!error) return resolve({ ok: true, stdout: out });
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        resolve({
          ok: false,
          stdout: out,
          error: String(code ?? (String(stderr ?? "").trim() || error.message)),
        });
      },
    );
  });
}

/** A relative path that stays inside its base (no absolute paths, no `..`). @param {string} p */
const isContainedRelative = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !path.isAbsolute(p) &&
  !path.win32.isAbsolute(p) &&
  !p.split(/[\\/]/).includes("..");

/**
 * Validate a candidate `source` block. Returns problems as `{ path, message }`.
 * @param {unknown} source
 * @returns {{ path: string, message: string }[]}
 */
export function validateSource(source) {
  /** @type {{ path: string, message: string }[]} */
  const problems = [];
  if (source === null || typeof source !== "object" || Array.isArray(source))
    return [{ path: "", message: "expected an object" }];
  const s = /** @type {Record<string, unknown>} */ (source);
  for (const key of Object.keys(s).sort())
    if (!SOURCE_KEYS.has(key))
      problems.push({
        path: `.${key}`,
        message: `unknown field (allowed: ${[...SOURCE_KEYS].join(", ")})`,
      });
  if (s.worktree !== undefined && (typeof s.worktree !== "string" || s.worktree.length === 0))
    problems.push({ path: ".worktree", message: "expected a path relative to the project root" });
  if (s.commit !== undefined && (typeof s.commit !== "string" || !COMMIT.test(s.commit)))
    problems.push({ path: ".commit", message: "expected 7-40 hex characters" });
  if ((s.commit !== undefined || s.allowDirty !== undefined) && s.worktree === undefined)
    problems.push({ path: ".worktree", message: "commit and allowDirty need a worktree" });
  if (s.allowDirty !== undefined && typeof s.allowDirty !== "boolean")
    problems.push({ path: ".allowDirty", message: "expected true or false" });
  if (s.files !== undefined) {
    if (!Array.isArray(s.files))
      problems.push({ path: ".files", message: "expected an array of relative paths" });
    else
      s.files.forEach((f, i) => {
        if (!isContainedRelative(f))
          problems.push({ path: `.files[${i}]`, message: "expected a relative path without '..'" });
      });
  }
  if (s.version !== undefined) {
    const argv = splitCommand(/** @type {any} */ (s.version));
    if (!argv.ok) problems.push({ path: ".version", message: argv.error.message });
  }
  return problems;
}

/**
 * Check one candidate's source and collect its facts. Never throws for
 * expected refusals: `reasons` lists every problem found.
 * @param {Source} source
 * @param {{ baseDir: string, exec?: Exec }} options
 * @returns {Promise<{ ok: boolean, reasons: string[], facts: SourceFacts }>}
 */
export async function checkSource(source, { baseDir, exec = defaultExec }) {
  /** @type {string[]} */
  const reasons = [];
  /** @type {SourceFacts} */
  const facts = {};
  const root =
    source.worktree === undefined ? path.resolve(baseDir) : path.resolve(baseDir, source.worktree);

  if (source.worktree !== undefined) {
    facts.worktree = source.worktree.replace(/\\/g, "/");
    const head = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    if (!head.ok) {
      reasons.push(`not a git worktree: ${source.worktree}`);
    } else {
      facts.commit = head.stdout.toLowerCase();
      if (source.commit !== undefined) {
        facts.expectedCommit = source.commit.toLowerCase();
        if (!facts.commit.startsWith(facts.expectedCommit))
          reasons.push(
            `commit mismatch: HEAD ${facts.commit} is not the expected ${facts.expectedCommit}`,
          );
      }
      const status = await exec("git", [
        "-C",
        root,
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]);
      facts.dirty = !status.ok || status.stdout.length > 0;
      if (status.ok && facts.dirty) facts.statusDigest = sha256(status.stdout);
      if (!status.ok) reasons.push(`cannot read git status: ${status.error ?? "unknown error"}`);
      else if (facts.dirty && source.allowDirty !== true)
        reasons.push(
          `uncommitted changes (commit them, or set allowDirty): ${status.stdout.split("\n").slice(0, 5).join("; ")}`,
        );
    }
  }

  if (source.files?.length) {
    /** @type {Record<string, string>} */
    const hashes = {};
    for (const file of [...source.files].sort()) {
      try {
        hashes[file.replace(/\\/g, "/")] = sha256(await readFile(path.join(root, file)));
      } catch {
        reasons.push(`missing file: ${file}`);
      }
    }
    facts.files = hashes;
  }

  if (source.version !== undefined) {
    const argv = splitCommand(source.version);
    if (!argv.ok) reasons.push(`version command: ${argv.error.message}`);
    else {
      const [command, ...args] = argv.value;
      const res = await exec(/** @type {string} */ (command), args, { cwd: root });
      const line = res.stdout.split(/\r?\n/)[0]?.trim() ?? "";
      if (res.ok && line) facts.version = line;
      else reasons.push(`version command failed: ${res.error ?? "no output"}`);
    }
  }
  return { ok: reasons.length === 0, reasons, facts };
}

/**
 * Check every candidate that declares a `source`. Candidates without one
 * record `null` (nothing to pin). Refuses with PROVENANCE_REFUSED and the
 * per-candidate reasons when any check fails.
 * @param {{ candidates: { id: string, source?: Source }[] }} study
 * @param {{ baseDir: string, exec?: Exec }} options
 * @returns {Promise<import("./result.mjs").Result<Record<string, SourceFacts | null>>>}
 */
export async function collectProvenance(study, options) {
  /** @type {Record<string, SourceFacts | null>} */
  const byCandidate = {};
  /** @type {Record<string, string[]>} */
  const refused = {};
  for (const candidate of study.candidates) {
    if (!candidate.source) {
      byCandidate[candidate.id] = null;
      continue;
    }
    const check = await checkSource(candidate.source, options);
    byCandidate[candidate.id] = check.facts;
    if (!check.ok) refused[candidate.id] = check.reasons;
  }
  const ids = Object.keys(refused).sort();
  if (ids.length)
    return err(
      "PROVENANCE_REFUSED",
      ids.map((id) => `${id}: ${(refused[id] ?? []).join("; ")}`).join("\n"),
      { refused, facts: byCandidate },
    );
  return ok(byCandidate);
}

/**
 * Record versions of external tools (git, ffmpeg, docker...). Missing or
 * failing tools are labelled "unavailable: <reason>", never guessed.
 * @param {{ name: string, command: string | string[] }[]} tools
 * @param {{ exec?: Exec }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function toolVersions(tools, { exec = defaultExec } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const tool of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const argv = splitCommand(tool.command);
    if (!argv.ok) {
      out[tool.name] = `unavailable: ${argv.error.message}`;
      continue;
    }
    const [command, ...args] = argv.value;
    const res = await exec(/** @type {string} */ (command), args);
    const line = res.stdout.split(/\r?\n/)[0]?.trim() ?? "";
    out[tool.name] = res.ok && line ? line : `unavailable: ${res.error ?? "no output"}`;
  }
  return out;
}
