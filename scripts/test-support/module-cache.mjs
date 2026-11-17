import { homedir as osHomedir } from "node:os";
import path from "node:path";

const ON_VALUES = new Set(["on", "1", "true"]);

function baseDir({ env, platform, homedir }) {
  if (env.GG_VITEST_MODULE_CACHE_DIR) return env.GG_VITEST_MODULE_CACHE_DIR;
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform === "win32") {
    return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "gg-vitest-cache") : undefined;
  }
  const root = env.XDG_CACHE_HOME || (homedir ? join(homedir, ".cache") : undefined);
  return root ? join(root, "gg-vitest-cache") : undefined;
}

// Opt-in: measured 2026-11 as no faster than the uncached baseline (current-status.md).
// Vitest's default cache lives in node_modules (the slow E: drive here), so never fall back to it.
export function moduleCacheSettings({
  env = process.env,
  platform = process.platform,
  homedir = osHomedir(),
  packageName,
} = {}) {
  if (!packageName) throw new Error("moduleCacheSettings needs a packageName");
  const mode = (env.GG_VITEST_MODULE_CACHE ?? "").trim().toLowerCase();
  if (!ON_VALUES.has(mode)) return { fsModuleCache: false };
  const base = baseDir({ env, platform, homedir });
  if (!base) return { fsModuleCache: false };
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return { fsModuleCache: true, fsModuleCachePath: join(base, packageName) };
}
