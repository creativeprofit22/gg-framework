import fs from "node:fs";
import path from "node:path";

// Local Fork: upstream 0.96.2's one-command change rule names `python3`. On
// Windows that name is often only the Microsoft Store placeholder under
// `...\Microsoft\WindowsApps`, which exits 49 without running anything, so the
// first scripted edit fails. Filesystem-only, like platform-clis: nothing is spawned.

export interface PythonLookup {
  platform: NodeJS.Platform;
  pathEnv: string;
  pathExt?: string;
}

/**
 * `python` when `python3` would hit the Store placeholder and a real `python`
 * is on PATH; `null` when `python3` is fine or nothing better is known.
 */
export function pythonInsteadOfPython3(lookup: PythonLookup): "python" | null {
  if (lookup.platform !== "win32") return null;
  const exts = (lookup.pathExt ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  const dirs = lookup.pathEnv.split(";").filter(Boolean);
  const python3 = firstOnPath("python3", dirs, exts);
  if (python3 !== null && !isStoreAlias(python3)) return null;
  const realDirs = dirs.filter((dir) => !isStoreAlias(dir));
  return firstOnPath("python", realDirs, exts) !== null ? "python" : null;
}

function isStoreAlias(dir: string): boolean {
  return /[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(dir);
}

/** Directory holding the first match, in PATH order. */
function firstOnPath(
  binary: string,
  dirs: readonly string[],
  exts: readonly string[],
): string | null {
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        fs.statSync(path.win32.join(dir, binary + ext));
        return dir;
      } catch {
        // not here
      }
    }
  }
  return null;
}
