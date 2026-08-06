import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export function resolvePath(cwd: string, filePath: string): string {
  if (filePath.startsWith("~")) {
    filePath = path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(cwd, filePath);
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
