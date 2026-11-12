import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startRunTemp, stopRunTemp } from "./run-temp.mjs";

// Usage: node scripts/test-support/with-run-temp.mjs node --test <args>
export function runWithRunTemp(argv) {
  const [command, ...args] = argv;
  if (!command) {
    console.error("usage: with-run-temp.mjs <command> [...args]");
    return 2;
  }
  startRunTemp();
  try {
    const result = spawnSync(command === "node" ? process.execPath : command, args, {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      console.error(`[run-temp] could not start ${command}: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  } finally {
    stopRunTemp();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runWithRunTemp(process.argv.slice(2));
}
