import { spawn } from "node:child_process";
import fs from "node:fs";

const [evidenceFile, workerFixture] = process.argv.slice(2);
if (!evidenceFile || !workerFixture) {
  throw new Error("Evidence file and worker fixture are required");
}

const evidence = { role: "launcher", pid: process.pid, ppid: process.ppid };
fs.appendFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`);
console.log(`FIXTURE_ROLE=launcher PID=${process.pid} PPID=${process.ppid}`);

const worker = spawn(process.execPath, [workerFixture, evidenceFile], {
  stdio: ["ignore", "inherit", "inherit"],
});
worker.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
worker.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
