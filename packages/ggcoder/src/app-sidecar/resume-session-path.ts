import fs from "node:fs/promises";

interface ResumeDeps {
  access?: (filePath: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The session file to resume, or undefined to start fresh.
 *
 * A file that is really gone (retention cleaned it up, or its goal was
 * deleted) starts fresh, as upstream intends. But "missing for a moment" is
 * not "gone": when Windows cannot rename over an open session file, the
 * replace deletes the old copy and then renames the new one into place, and a
 * reopen landing in between would otherwise open an empty conversation in
 * place of the saved one. So a missing file is re-checked briefly before
 * giving up, and a locked or pending-replacement file (EPERM/EBUSY/EACCES)
 * still exists and is resumed.
 */
export async function resolveResumeSessionPath(
  sessionPath: string | undefined,
  deps: ResumeDeps = {},
): Promise<string | undefined> {
  if (!sessionPath) return undefined;
  const access = deps.access ?? ((filePath: string) => fs.access(filePath));
  const sleep = deps.sleep ?? delay;
  const attempts = deps.attempts ?? (process.platform === "win32" ? 6 : 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await access(sessionPath);
      return sessionPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return sessionPath;
      if (attempt < attempts) await sleep(attempt * 25);
    }
  }
  return undefined;
}
