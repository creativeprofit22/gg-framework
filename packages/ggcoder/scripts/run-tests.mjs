import { runStages, spawnPackageStage } from "../../../scripts/test-support/run-stages.mjs";

const packageManagerCli = process.env.npm_execpath;
if (!packageManagerCli) {
  throw new Error("run-tests.mjs must be started from a package-manager script");
}

const stages =
  process.platform === "win32"
    ? ["run test:parallel", "run test:windows-serial", "run test:daemon-serial", "run test:alone"]
    : ["exec vitest run"];

// Every step runs even after a failure, so one run reports all broken steps.
const { failed } = runStages(stages, (stage) => spawnPackageStage(packageManagerCli, stage));
if (failed.length > 0) {
  console.error(`\nFailed test steps (${failed.length}/${stages.length}):`);
  for (const stage of failed) console.error(`  - ${stage}`);
  process.exit(1);
}
