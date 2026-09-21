import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePackageManagerLaunch, type UpdatePackageManager } from "./package-manager-launcher.js";

/** Only update the package owned by the selected manager's current global root. */
export function detectGlobalUpdateManager(packageName: string): UpdatePackageManager | null {
  try {
    const paths = process.platform === "win32" ? path.win32 : path.posix;
    const script = fs.realpathSync(process.argv[1] ?? "");
    const normalized = script.replace(/\\/g, "/");
    // Checkouts, bundles, npx and unrelated packages are not global installs.
    if (!paths.isAbsolute(script) || normalized.includes("/_npx/") ||
        !normalized.includes(`/node_modules/${packageName}/`)) return null;

    const managers: UpdatePackageManager[] = normalized.includes("/pnpm/") || normalized.includes("/.pnpm/")
      ? ["pnpm", "npm", "yarn"]
      : normalized.includes("/yarn/") || normalized.includes("/.yarn/")
        ? ["yarn", "npm", "pnpm"]
        : ["npm", "pnpm", "yarn"];
    const within = (parent: string, child: string): boolean => {
      const relative = paths.relative(parent, child);
      return relative !== "" && relative !== ".." &&
        !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
    };

    for (const manager of managers) {
      try {
        const launch = resolvePackageManagerLaunch(manager,
          manager === "yarn" ? ["global", "dir"] : ["root", "-g"]);
        // Read-only discovery: never infer a global destination from argv alone.
        const output = execFileSync(launch.command, launch.args, {
          encoding: "utf8", shell: false, windowsHide: true,
          timeout: 3000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (!paths.isAbsolute(output) || /[\r\n]/.test(output)) continue;
        const root = fs.realpathSync(manager === "yarn" ? paths.join(output, "node_modules") : output);
        const installed = fs.realpathSync(paths.join(root, packageName));
        // Reject globally linked checkouts as well as a different global copy.
        if (within(root, installed) && within(installed, script)) return manager;
      } catch {
        // Missing managers, failed discovery and unresolvable paths fail closed.
      }
    }
  } catch {
    // Unknown/missing entrypoints cannot self-update.
  }
  return null;
}
