import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Runs every stage even after a failure, so one run reports all broken stages.
export function runStages(stages, runStage) {
  const failed = [];
  for (const stage of stages) {
    let ok = false;
    try {
      ok = runStage(stage) === 0;
    } catch (error) {
      console.error(`[run-stages] ${stage}: ${error instanceof Error ? error.message : error}`);
    }
    if (!ok) failed.push(stage);
  }
  return { failed };
}

export function spawnPackageStage(packageManagerCli, stage) {
  // Split on whitespace and skip the shell so Windows quoting can't change the args.
  const args = stage.split(/\s+/).filter(Boolean);
  const result = spawnSync(process.execPath, [packageManagerCli, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Usage (from a package script): node run-stages.mjs test:a "--filter pkg test" ...
export function main(argv, env = process.env) {
  const packageManagerCli = env.npm_execpath;
  if (!packageManagerCli) {
    console.error("run-stages.mjs must be started from a package-manager script");
    return 2;
  }
  if (argv.length === 0) {
    console.error("usage: run-stages.mjs <stage> [...stages]");
    return 2;
  }
  const { failed } = runStages(argv, (stage) => spawnPackageStage(packageManagerCli, stage));
  if (failed.length === 0) return 0;
  console.error(`\nFailed stages (${failed.length}/${argv.length}):`);
  for (const stage of failed) console.error(`  - ${stage}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
