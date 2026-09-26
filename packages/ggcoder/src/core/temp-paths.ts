import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveShell, type ResolveShellOpts } from "./shell.js";

let cached: { key: string; directory: string | null } | undefined;

/** Ask the selected Windows bash for its mount; never guess an install path. */
export function getMsysTempDir(opts: ResolveShellOpts = {}): string | null {
  if ((opts.platform ?? process.platform) !== "win32") return null;
  const shell = resolveShell("cygpath -aw /tmp", opts);
  if (shell.isCmdFallback) return null;
  const env = opts.env ?? process.env;
  const key = JSON.stringify([shell.file, env.TMPDIR, env.TEMP, env.TMP, env.PATH, env.Path]);
  if (cached?.key === key) return cached.directory;
  let directory: string | null = null;
  try {
    const output = execFileSync(shell.file, shell.args, {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 4096,
      windowsHide: true,
      cwd: os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Reject malformed output and dangerously broad mount roots.
    if (/^[A-Za-z]:[\\/]/.test(output) && !/[\r\n\0]/.test(output)) {
      const normalized = path.win32.normalize(output);
      if (
        normalized !== path.win32.parse(normalized).root &&
        normalized.toLowerCase() !== path.win32.normalize(os.homedir()).toLowerCase()
      ) {
        directory = normalized;
      }
    }
  } catch {
    // A missing/failed translator must not silently target C:\tmp instead.
  }
  cached = { key, directory };
  return directory;
}

/** Shared by file tools and the command sandbox. */
export function getTempRoots(platform: NodeJS.Platform = process.platform): string[] {
  const msys = platform === "win32" ? getMsysTempDir({ platform }) : null;
  return [
    ...new Set([os.tmpdir(), ...(platform === "win32" ? [] : ["/tmp"]), ...(msys ? [msys] : [])]),
  ];
}
