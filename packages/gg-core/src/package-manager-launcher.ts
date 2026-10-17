import fs from "node:fs";
import path from "node:path";

export type UpdatePackageManager = "npm" | "pnpm" | "yarn";

const CLI_PATHS: Record<UpdatePackageManager, string[]> = {
  npm: ["node_modules/npm/bin/npm-cli.js"],
  pnpm: ["node_modules/pnpm/bin/pnpm.cjs", "node_modules/corepack/dist/pnpm.js"],
  yarn: ["node_modules/yarn/bin/yarn.js", "node_modules/corepack/dist/yarn.js"],
};

/**
 * Windows cannot spawn .cmd shims without a shell. Like ggcoder's MCP launcher,
 * run the known Node CLI behind the shim instead. Never parse shim text or send
 * arguments through cmd.exe. Unsupported layouts fail nonfatally at the caller.
 */
export function resolvePackageManagerLaunch(
  manager: UpdatePackageManager,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync,
): { command: string; args: string[] } {
  if (platform !== "win32") return { command: manager, args: [...args] };

  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
  for (const entry of (pathValue ?? "").split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    // No implicit/relative cwd search: project files must not hijack an update.
    if (!path.win32.isAbsolute(dir)) continue;
    const executable = path.win32.join(dir, `${manager}.exe`);
    if (exists(executable)) return { command: executable, args: [...args] };
    const shim = path.win32.join(dir, `${manager}.cmd`);
    const batch = path.win32.join(dir, `${manager}.bat`);
    if (!exists(shim) && !exists(batch)) continue;
    for (const relative of CLI_PATHS[manager]) {
      const cli = path.win32.join(dir, relative);
      if (exists(cli)) return { command: process.execPath, args: [cli, ...args] };
    }
    // Do not silently select a different installation later on PATH.
    throw new Error(`Unsupported ${manager} launcher`);
  }
  throw new Error(`${manager} launcher not found`);
}
