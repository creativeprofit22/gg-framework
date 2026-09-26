import { spawnSync } from "node:child_process";

const packageManagerCli = process.env.npm_execpath;
if (!packageManagerCli) {
  throw new Error("run-tests.mjs must be started from a package-manager script");
}

const testScripts =
  process.platform === "win32" ? ["test:parallel", "test:windows-serial"] : ["vitest"];

for (const testScript of testScripts) {
  const args = testScript === "vitest" ? ["exec", "vitest", "run"] : ["run", testScript];
  const result = spawnSync(process.execPath, [packageManagerCli, ...args], {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
