import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { whatsNewHeadDefines } from "./scripts/whats-new-heads";

const configDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(configDir, "..");
const customBuildLabel = "Supah Coder Local Fork";
const localForkBranches = new Set([
  "custom/local-customizations",
  "custom/local-customizations-v2",
]);

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

// Split big libraries so no chunk exceeds Vite's 500 kB advisory. Groups keep
// their dependencies (the default), which avoids circular chunks; react gets
// the highest priority so the lazy 3D groups can't absorb it and drag three.js
// into the startup load. The 3D stack is reached only through the dynamically
// imported background effect. Paths match / and \ (Windows).
const VENDOR_CHUNKS = [
  { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 100 },
  { name: "highlight", test: /node_modules[\\/]highlight\.js[\\/]/, priority: 90 },
  {
    name: "markdown",
    test: /node_modules[\\/](marked|micromark|mdast-|hast-|unist-|unified|remark-|rehype-)/,
    priority: 80,
  },
  { name: "three-core", test: /node_modules[\\/]three[\\/]build[\\/]three\.core/, priority: 30 },
  { name: "three", test: /node_modules[\\/]three[\\/]/, priority: 20 },
  {
    name: "three-fx",
    test: /node_modules[\\/](@react-three|postprocessing|n8ao|maath)[\\/]/,
    priority: 10,
  },
];

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [
    react(),
    ...(command === "serve"
      ? [(await import("./scripts/appearance-dev-identity.mjs")).appearanceDevIdentityPlugin()]
      : []),
    ...(command === "serve" && process.env.GG_CHAT_DESIGN_PREVIEW === "1"
      ? [(await import("./scripts/chat-design-preview/vite-plugin.mjs")).chatDesignPreviewPlugin()]
      : []),
  ],
  define: { ...buildEnvDefines(), ...whatsNewHeadDefines },
  build: {
    manifest: true, // Lets CI budget initial JS separately from lazy chunks.
    rolldownOptions: {
      output: {
        codeSplitting: { groups: VENDOR_CHUNKS },
      },
    },
  },

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
