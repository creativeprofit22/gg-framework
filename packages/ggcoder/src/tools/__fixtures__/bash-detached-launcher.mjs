import { spawn } from "node:child_process";
import fs from "node:fs";

const [evidenceFile, workerFile, readinessFile, mode] = process.argv.slice(2);
if (!evidenceFile || !workerFile || !readinessFile || !["exit", "hold"].includes(mode)) {
  throw new Error("Expected evidence, worker, readiness, and exit|hold mode arguments");
}

fs.appendFileSync(
  evidenceFile,
  `${JSON.stringify({ role: "detached-launcher", pid: process.pid, ppid: process.ppid })}\n`,
);
const worker = spawn(process.execPath, [workerFile, evidenceFile, readinessFile], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
worker.unref();

const readinessDeadline = Date.now() + 5_000;
const readinessPoll = setInterval(() => {
  if (fs.existsSync(readinessFile)) {
    clearInterval(readinessPoll);
    if (mode === "exit") process.exit(0);
    return;
  }
  if (Date.now() >= readinessDeadline) {
    clearInterval(readinessPoll);
    process.exitCode = 1;
  }
}, 25);

if (mode === "hold") setInterval(() => {}, 1_000);
