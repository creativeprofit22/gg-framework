import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a dependency-backed stdio MCP server to a direct `node <binScript>`
 * invocation instead of `npx -y <pkg>`.
 *
 * `npx` (= `npm exec`) spawns a full Node "wrapper" process (~100 MB RSS) whose
 * only job is to resolve the package and spawn the REAL server — doubling the
 * memory of every connection. When the package ships as a ggcoder dependency we
 * can skip the wrapper entirely: resolve the package's bin entry script and run
 * it with `process.execPath` (the same Node already running). This mirrors the
 * LSP server resolution in `core/lsp/servers.ts` (`resolveNodeServer`), which
 * spawns Node-based language servers via `process.execPath` + the real bin
 * script, never the `node_modules/.bin` shim (shims need `node` on PATH).
 *
 * Only `npx`/`npm exec` invocations of a known, locally-resolvable package are
 * rewritten. Everything else (other commands, unresolvable packages) passes
 * through unchanged, so behavior degrades gracefully to the original `npx` path.
 */

/** Directory of this module — anchor for resolving ggcoder's own bundled deps. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find a file at `node_modules/<relPath>` walking up from `start`.
 * Deterministic fs checks only — no resolver hooks, no createRequire (whose
 * resolution can be patched by dev runners and global fallback paths). Mirrors
 * `findInNodeModulesUp` in `core/lsp/servers.ts`.
 */
function findInNodeModulesUp(relPath: string, start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "node_modules", relPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve an npm package's bin entry script (the real .js/.mjs file, NOT the
 * `node_modules/.bin` shim). `binName` selects which bin when a package exposes
 * several; defaults to the package's sole/string bin. Returns an absolute path
 * to the script, or null when the package or its bin can't be resolved.
 */
export function findPackageBinScript(
  pkgName: string,
  binName: string,
  start: string = MODULE_DIR,
): string | null {
  const pkgJsonPath = findInNodeModulesUp(path.join(pkgName, "package.json"), start);
  if (!pkgJsonPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
    if (!bin) return null;
    const script = path.join(path.dirname(pkgJsonPath), bin);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Parse an `npx`/`npm exec` command + args into the target package spec, or null
 * when the command isn't an npx/npm-exec invocation. Skips npx flags (`-y`,
 * `--yes`, `-p <pkg>`, `--package <pkg>`, `--`) to find the package positional.
 * The returned `pkg` keeps any leading `@scope/name`; a trailing `@version` is
 * stripped for resolution since the installed copy's version is authoritative.
 */
export function parseNpxPackage(command: string, args: readonly string[]): string | null {
  const base = path.basename(command).toLowerCase();
  let rest: readonly string[];
  if (base === "npx" || base === "npx.cmd") {
    rest = args;
  } else if (base === "npm" || base === "npm.cmd") {
    if (args[0] !== "exec") return null;
    rest = args.slice(1);
  } else {
    return null;
  }

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-y" || a === "--yes" || a === "--prefer-offline" || a === "--prefer-online") {
      continue;
    }
    if (a === "-p" || a === "--package") {
      i++; // skip the package flag's value; the positional (if any) still wins
      continue;
    }
    if (a === "--") continue;
    if (a.startsWith("-")) continue;
    return a; // first non-flag positional is the package spec
  }
  return null;
}

/** Strip a trailing `@version` from a package spec, preserving a leading scope. */
function stripVersion(pkgSpec: string): string {
  if (pkgSpec.startsWith("@")) {
    const slash = pkgSpec.indexOf("/");
    if (slash === -1) return pkgSpec;
    const at = pkgSpec.indexOf("@", slash);
    return at === -1 ? pkgSpec : pkgSpec.slice(0, at);
  }
  const at = pkgSpec.indexOf("@");
  return at === -1 ? pkgSpec : pkgSpec.slice(0, at);
}

/** Derive the conventional bin name from a package name (drop the scope). */
function binNameFor(pkgName: string): string {
  return pkgName.startsWith("@") ? (pkgName.split("/")[1] ?? pkgName) : pkgName;
}

export interface ResolvedStdioCommand {
  command: string;
  args: string[];
}

/**
 * Rewrite a stdio `{ command, args }` to a direct `node <binScript>` invocation
 * when it's an `npx`/`npm exec` of a package whose bin script is resolvable from
 * ggcoder's install. Returns the original `{ command, args }` unchanged
 * otherwise (non-npx command, or the package/bin can't be resolved locally).
 */
export function resolveStdioCommand(
  command: string,
  args: readonly string[] = [],
): ResolvedStdioCommand {
  const passthrough: ResolvedStdioCommand = { command, args: [...args] };

  const pkgSpec = parseNpxPackage(command, args);
  if (!pkgSpec) return passthrough;

  const pkgName = stripVersion(pkgSpec);
  const binScript = findPackageBinScript(pkgName, binNameFor(pkgName));
  if (!binScript) return passthrough;

  // Drop the npx package positional + its flags; forward only the args that
  // come AFTER the package spec (the server's own args, usually after `--`).
  const tail = serverArgsAfterPackage(command, args, pkgSpec);
  return { command: process.execPath, args: [binScript, ...tail] };
}

/**
 * The args intended for the server itself — everything after the package
 * positional in an npx/npm-exec command. `--` separators are dropped.
 */
function serverArgsAfterPackage(
  command: string,
  args: readonly string[],
  pkgSpec: string,
): string[] {
  const base = path.basename(command).toLowerCase();
  const start = base === "npm" || base === "npm.cmd" ? 1 : 0; // skip `exec`
  const idx = args.indexOf(pkgSpec, start);
  if (idx === -1) return [];
  return args.slice(idx + 1).filter((a) => a !== "--");
}
