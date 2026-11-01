import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runBackgroundGit } from "../utils/git.js";

export const SNAPSHOT_MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;
export const SNAPSHOT_MAX_MS = 5000;

export type WorkspaceGit = (args: string[]) => Promise<string>;

/** Git runner bounded by one shared deadline. */
export function boundedGit(
  cwd: string,
  deadline: number,
  signal?: AbortSignal,
  maxBuffer = 2 * 1024 * 1024,
): WorkspaceGit {
  return async (args) =>
    (
      await runBackgroundGit(args, {
        cwd,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxBuffer,
        signal,
      })
    ).stdout;
}

/** Canonical Git root of `cwd`. Throws outside Git. */
export async function resolveWorkspaceRoot(git: WorkspaceGit): Promise<string> {
  return fs.realpath((await git(["rev-parse", "--show-toplevel"])).trim());
}

/** Sorted tracked plus untracked, non-ignored files, relative to `root`. */
export async function listWorkspaceFiles(git: WorkspaceGit, root: string): Promise<string[]> {
  return [
    ...new Set(
      (await git(["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
}

/** Caller-owned byte budget shared across {@link hashWorkspaceFile} calls. */
export interface HashBudget {
  bytes: number;
  readonly maxBytes: number;
}

export type WorkspaceFileHash =
  { kind: "missing" } | { kind: "file"; mode: number; digest: Buffer; signature: string };

/** lstat identity used to reuse a file digest while the file is unchanged. */
export function statSignature(stat: {
  size: number;
  mtimeMs: number;
  ino: number;
  mode: number;
}): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}:${stat.mode}`;
}

/**
 * Content hash of one file relative to `root`, or null when a symlink, device
 * file, race, escape, deadline or the byte budget declines it. Throws on
 * unexpected I/O errors.
 */
export async function hashWorkspaceFile(
  root: string,
  file: string,
  deadline: number,
  budget: HashBudget,
): Promise<WorkspaceFileHash | null> {
  if (Date.now() > deadline || path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
    return null;
  const absolute = path.join(root, file);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { kind: "missing" };
  }
  // Do not follow repository-controlled links or read device files.
  if (!stat.isFile()) return null;
  const relative = path.relative(root, await fs.realpath(absolute));
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) return null;
  if (budget.bytes + stat.size > budget.maxBytes) return null;
  const handle = await fs.open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size) return null;
    const fileHash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let fileBytes = 0;
    for (;;) {
      if (Date.now() > deadline) return null;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      budget.bytes += bytesRead;
      fileBytes += bytesRead;
      if (budget.bytes > budget.maxBytes) return null;
      fileHash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      fileBytes !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ino !== stat.ino
    )
      return null;
    return {
      kind: "file",
      mode: stat.mode,
      digest: fileHash.digest(),
      signature: statSignature(stat),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Content hash of `files` (relative to `root`, sorted by the caller), or null
 * when a symlink, device file, race, escape or resource limit declines it.
 * Throws on unexpected I/O errors; callers treat that as null too.
 */
export async function hashWorkspaceFiles(
  root: string,
  files: readonly string[],
  deadline: number,
): Promise<string | null> {
  if (files.length > SNAPSHOT_MAX_FILES) return null;
  const hash = createHash("sha256");
  const budget: HashBudget = { bytes: 0, maxBytes: MAX_BYTES };
  for (const file of files) {
    const entry = await hashWorkspaceFile(root, file, deadline, budget);
    if (entry === null) return null;
    // Byte layout is part of stored fingerprints; keep it stable.
    hash.update(JSON.stringify(file));
    if (entry.kind === "missing") {
      hash.update("missing");
      continue;
    }
    hash.update(String(entry.mode));
    hash.update(entry.digest);
  }
  return hash.digest("hex");
}

/**
 * Bounded, local-only comparison of Git workspace inputs. Ignored build output
 * is excluded, but tracked files and explicitly edited inputs never are.
 * Missing Git, symlinks/submodules, races and resource limits decline the
 * optimization: the caller must require fresh checks instead.
 */
export async function captureVerificationSnapshot(
  cwd: string,
  editedFiles: readonly string[] = [],
): Promise<string | null> {
  const deadline = Date.now() + SNAPSHOT_MAX_MS;
  try {
    const git = boundedGit(cwd, deadline);
    const root = await resolveWorkspaceRoot(git);
    const listed = await listWorkspaceFiles(git, root);
    const explicit: string[] = [];
    for (const file of editedFiles) {
      if (explicit.length >= SNAPSHOT_MAX_FILES || Date.now() > deadline) return null;
      const absolute = path.resolve(cwd, file);
      // Canonicalize the parent, not the file: /var and /private/var alias on
      // macOS, while the final component may legitimately have been deleted.
      const parent = await fs.realpath(path.dirname(absolute));
      explicit.push(path.relative(root, path.join(parent, path.basename(absolute))));
    }
    const files = [...new Set([...listed, ...explicit])].sort();
    const digest = await hashWorkspaceFiles(root, files, deadline);
    if (digest === null) return null;
    if (
      Date.now() > deadline ||
      JSON.stringify(listed) !== JSON.stringify(await listWorkspaceFiles(git, root))
    )
      return null;
    return digest;
  } catch {
    return null;
  }
}
