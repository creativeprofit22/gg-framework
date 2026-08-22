import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface ResolvePathOpts {
  /** Injected for testability; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * MSYS drive path → native Windows path, e.g. `/c/Users/x` → `C:\Users\x`.
 *
 * On Windows our bash tool runs Git Bash (see core/shell.ts), an MSYS2
 * environment, so command output is full of `/c/...`, `//c/...` and
 * `/cygdrive/c/...` paths. The model reads those out of bash output and hands
 * them straight back to the file tools; `path.resolve` then turns `/c/Users/x`
 * into `C:\c\Users\x`, which never exists, so every such call fails and the
 * agent burns turns guessing.
 *
 * Deliberate non-goals:
 *   - Non-Windows platforms are left completely alone: `/c/foo` is a perfectly
 *     legitimate POSIX path on macOS/Linux and rewriting it would be a
 *     data-corrupting regression. Hence the strict platform gate.
 *   - MSYS virtual mounts (`/tmp`, `/usr`, `/home`, `/bin`) are NOT translated.
 *     They live under the Git-Bash install root, which we cannot determine
 *     cheaply or deterministically here, and a wrong guess silently reads or
 *     writes the wrong file — far worse than a clear ENOENT.
 *   - We do NOT shell out to `cygpath`: this sits on the hot path of every
 *     single file tool call, so it would cost a process spawn per call, and
 *     `cygpath` is not always on PATH anyway. Pure string manipulation only.
 */
export function msysToWindowsPath(filePath: string, opts: ResolvePathOpts = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return filePath;
  // `//c/x` (MSYS's own drive spelling) and `/cygdrive/c/x` mean exactly the
  // same as `/c/x`. The drive must be a single letter and must be followed by a
  // separator or end-of-string, so `/config` and `/cygdrive` stay untouched.
  //
  // `//c/x` is formally ambiguous with a UNC path whose HOST is one character.
  // Single-letter hostnames don't exist in practice and Git Bash really does
  // emit this form for drives, so translating is the right bet.
  const match = /^(?:\/\/|\/cygdrive\/|\/)([A-Za-z])(?:\/(.*))?$/.exec(filePath);
  if (!match) return filePath;
  const drive = match[1].toUpperCase();
  const rest = match[2] ?? "";
  // Always keep the trailing separator: bare `C:` is drive-RELATIVE on Windows
  // (the cwd of that drive), which is not what `/c` means.
  return `${drive}:\\${rest.replaceAll("/", "\\")}`;
}

export function resolvePath(cwd: string, filePath: string, opts: ResolvePathOpts = {}): string {
  if (filePath.startsWith("~")) {
    filePath = path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(cwd, msysToWindowsPath(filePath, opts));
}

/**
 * Check if a path is a symlink. Used by file tools to prevent symlink-based
 * attacks that could read/write sensitive files outside the working directory.
 */
export async function rejectSymlink(resolved: string): Promise<void> {
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink: ${resolved}`);
    }
  } catch (err) {
    // Re-throw our own error; swallow ENOENT (file doesn't exist yet, e.g. write/new file)
    if (err instanceof Error && err.message.startsWith("Refusing to follow")) throw err;
  }
}

/**
 * A relative path as the AGENT should see it: always forward slashes.
 *
 * Every path the model reads or writes — tool results, review messages, code
 * search headers, its own `edit`/`read` arguments — is forward-slashed, because
 * that is what the training data and every other tool use. Emitting a native
 * `src\a.ts` on Windows makes the model's own echo of that path a different
 * string from ours, which breaks anything that matches on it (review coverage
 * did exactly this), and makes output gratuitously OS-dependent.
 *
 * Windows APIs accept forward slashes, so this is display/matching only and is
 * safe to feed back into `path.resolve`. Do NOT use it for paths handed to a
 * shell or written into a file that Windows tooling will parse.
 */
export function toPosixPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}
