import fs from "node:fs";
import path from "node:path";

// Local Fork: the tool steering line names `rg`, and the grep tool shells out
// to it. Without ripgrep the model falls back to `grep -r`, which walks
// node_modules and stalls on Windows. Filesystem-only, like python-command.

export interface RipgrepLookup {
  platform: NodeJS.Platform;
  pathEnv: string;
  pathExt?: string;
}

/** True when an `rg` executable is on PATH. */
export function ripgrepOnPath(lookup: RipgrepLookup): boolean {
  const win = lookup.platform === "win32";
  const join = win ? path.win32.join : path.posix.join;
  const exts = win ? (lookup.pathExt ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const dirs = lookup.pathEnv.split(win ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(join(dir, "rg" + ext)).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}
