import fs from "node:fs";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("PID-file path is required");

fs.writeFileSync(pidFile, String(process.pid));
console.log(`CPU_FIXTURE_PID=${process.pid}`);
for (;;) {}
