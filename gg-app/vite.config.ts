import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const configDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(configDir, "..");
const customBuildLabel = "Supah Coder Local Fork";
const localForkBranches = new Set([
  "custom/local-customizations",
  "custom/local-customizations-v2",
]);

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function isLocalForkBranch(branch: string | null): boolean {
  return branch !== null && localForkBranches.has(branch);
}

function isLocalForkCheckout(): boolean {
  const origin = git(["config", "--get", "remote.origin.url"]);
  const branch = git(["branch", "--show-current"]);
  return Boolean(origin?.includes("creativeprofit22/gg-framework") || isLocalForkBranch(branch));
}

export interface LocalForkBuildEnv {
  localPatched?: string;
  sourceRoot?: string;
  label?: string;
  sourceRevision?: string;
}

export function resolveLocalForkBuildEnv(
  env: NodeJS.ProcessEnv,
  detected: boolean,
  deriveGitSha: () => string | null,
): LocalForkBuildEnv {
  const localPatched = env.VITE_GG_LOCAL_PATCHED ?? (detected ? "1" : undefined);
  const envSourceRoot = env.VITE_GG_SOURCE_ROOT ?? (detected ? sourceRoot : undefined);
  const label = env.VITE_GG_CUSTOM_BUILD_LABEL ?? (detected ? customBuildLabel : undefined);
  const explicitGitSha = env.VITE_GG_GIT_SHA?.trim() || undefined;
  const sourceRevision =
    explicitGitSha ?? (localPatched === "1" ? deriveGitSha()?.trim() || undefined : undefined);

  if (localPatched === "1" && !/^[0-9a-f]{40}$/i.test(sourceRevision ?? "")) {
    throw new Error(
      "VITE_GG_GIT_SHA must be the full 40-character source commit SHA for a Local Fork build.",
    );
  }

  return { localPatched, sourceRoot: envSourceRoot, label, sourceRevision };
}

function buildEnvDefines(): Record<string, string> {
  const buildEnv = resolveLocalForkBuildEnv(process.env, isLocalForkCheckout(), () =>
    git(["rev-parse", "HEAD"]),
  );

  return Object.fromEntries(
    Object.entries({
      "import.meta.env.VITE_GG_LOCAL_PATCHED": buildEnv.localPatched,
      "import.meta.env.VITE_GG_SOURCE_ROOT": buildEnv.sourceRoot,
      "import.meta.env.VITE_GG_CUSTOM_BUILD_LABEL": buildEnv.label,
      "import.meta.env.VITE_GG_GIT_SHA": buildEnv.sourceRevision,
    })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, JSON.stringify(value)]),
  );
}

const nodeBuiltinNames = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

export function rejectBrowserNodeBuiltins(): Plugin {
  return {
    name: "reject-browser-node-builtins",
    enforce: "pre",
    resolveId(source, importer) {
      const builtinName = source.replace(/^node:/, "");
      if (importer && nodeBuiltinNames.has(builtinName)) {
        throw new Error(`Node builtin "${source}" reached the browser graph from "${importer}"`);
      }
      return null;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  define: buildEnvDefines(),

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
