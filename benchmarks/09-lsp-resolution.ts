/**
 * Benchmark 09: LSP Server Resolution — Sync statSync vs Async + Cached
 *
 * Measures: the findExecutable path resolution used by the LSP manager
 * to locate language server binaries. Currently uses synchronous fs.statSync
 * in a loop walking up the directory tree.
 */
import { bench } from "./harness.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Current: synchronous statSync in a loop (exact copy from servers.ts) ──

function isExecutableFileSync(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function binDirsUpFromSync(start: string): string[] {
  const dirs: string[] = [];
  let dir = start;
  for (;;) {
    dirs.push(path.join(dir, "node_modules", ".bin"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function findExecutableSync(name: string, projectRoot: string): string | null {
  const binDirs = binDirsUpFromSync(projectRoot);
  for (const binDir of binDirs) {
    const binPath = path.join(binDir, name);
    if (isExecutableFileSync(binPath)) return binPath;
  }
  // PATH lookup
  const pathEnv = process.env.PATH ?? "";
  for (const pathDir of pathEnv.split(path.delimiter)) {
    if (!pathDir) continue;
    const binPath = path.join(pathDir, name);
    if (isExecutableFileSync(binPath)) return binPath;
  }
  return null;
}

// ── Improved: async stat + result caching ──

const resolutionCache = new Map<string, string | null>();

async function isExecutableAsync(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findExecutableCached(name: string, projectRoot: string): Promise<string | null> {
  const cacheKey = `${name}::${projectRoot}`;
  if (resolutionCache.has(cacheKey)) {
    return resolutionCache.get(cacheKey) ?? null;
  }

  // Parallel stat all candidate paths
  const binDirs = binDirsUpFromSync(projectRoot);
  const candidates = binDirs.map((d) => path.join(d, name));

  // Check all in parallel
  const checks = await Promise.all(candidates.map(async (p) => ({ path: p, exists: await isExecutableAsync(p) })));
  for (const { path: p, exists } of checks) {
    if (exists) {
      resolutionCache.set(cacheKey, p);
      return p;
    }
  }

  // PATH lookup (also parallelized)
  const pathEnv = process.env.PATH ?? "";
  const pathCandidates = pathEnv.split(path.delimiter).filter(Boolean).map((d) => path.join(d, name));
  const pathChecks = await Promise.all(
    pathCandidates.map(async (p) => ({ path: p, exists: await isExecutableAsync(p) })),
  );
  for (const { path: p, exists } of pathChecks) {
    if (exists) {
      resolutionCache.set(cacheKey, p);
      return p;
    }
  }

  resolutionCache.set(cacheKey, null);
  return null;
}

export async function runLspResolutionBench(): Promise<import("./harness.js").BenchResult[]> {
  const results: import("./harness.js").BenchResult[] = [];

  const projectRoot = process.cwd();

  // Cold resolve (no cache) — simulates first edit
  results.push(
    await bench("lsp:resolve-sync-typescript-language-server", () => {
      findExecutableSync("typescript-language-server", projectRoot);
    }, 50),
  );

  results.push(
    await bench("lsp:resolve-async-cold-typescript-language-server", async () => {
      resolutionCache.clear();
      await findExecutableCached("typescript-language-server", projectRoot);
    }, 50),
  );

  // Warm cache hit — subsequent edits
  results.push(
    await bench("lsp:resolve-async-warm-cache", async () => {
      await findExecutableCached("typescript-language-server", projectRoot);
    }, 1000),
  );

  // Resolve multiple servers (simulates touching .ts + .py files)
  results.push(
    await bench("lsp:resolve-sync-multi-server", () => {
      findExecutableSync("typescript-language-server", projectRoot);
      findExecutableSync("pyright-langserver", projectRoot);
      findExecutableSync("gopls", projectRoot);
    }, 30),
  );

  results.push(
    await bench("lsp:resolve-async-cached-multi-server", async () => {
      resolutionCache.clear();
      await Promise.all([
        findExecutableCached("typescript-language-server", projectRoot),
        findExecutableCached("pyright-langserver", projectRoot),
        findExecutableCached("gopls", projectRoot),
      ]);
    }, 30),
  );

  // Warm multi-server
  results.push(
    await bench("lsp:resolve-async-warm-multi-server", async () => {
      await Promise.all([
        findExecutableCached("typescript-language-server", projectRoot),
        findExecutableCached("pyright-langserver", projectRoot),
        findExecutableCached("gopls", projectRoot),
      ]);
    }, 200),
  );

  return results;
}
