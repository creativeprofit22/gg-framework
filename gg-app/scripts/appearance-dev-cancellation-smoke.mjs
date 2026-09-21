// Disposable-process smoke only: no framework/Cargo build, Vite, Tauri, or installed app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appearanceEnvironment, runAppearanceSession } from "./appearance-dev.mjs";
import { createIsolatedProfile } from "./phase-25-windows-smoke-helpers.mjs";
import { readProcessTable, terminateProcessTree } from "./workspace-shell-evidence.mjs";

const paths = createIsolatedProfile(mkdtempSync(join(tmpdir(), "appearance-cancel-smoke-")));
const env = appearanceEnvironment(process.env, paths);
const launched = [];
let descendantPid;
const before = process.listenerCount("SIGINT");
try {
  await runAppearanceSession(env, paths, {}, {
    launchProcess(command) {
      assert.equal(command, "disposable-framework");
      const source = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        process.send({ pid: child.pid });
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ["-e", source], { env, cwd: paths.project, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
      const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      void exited.catch(() => {});
      launched.push(child);
      return { child, exited };
    },
    async ensureFramework(_, scope) {
      const build = scope.launch("disposable-framework", []);
      const [message] = await once(build.child, "message");
      descendantPid = message.pid;
      await scope.sample();
      // Exercise the launcher's actual registered handler. Windows process.kill(SIGINT)
      // is forced termination, not catchable console delivery, so do not use it here.
      process.emit("SIGINT");
      await scope.wait(build.exited);
    },
    isListening() { throw new Error("Cancellation must prevent Vite startup"); },
    reservePort() { throw new Error("Cancellation must prevent native startup"); },
  });
  const table = await readProcessTable();
  assert.equal(launched.length, 1);
  assert.ok(descendantPid > 0);
  assert.equal(table.some(row => [launched[0].pid, descendantPid].includes(row.pid)), false);
  assert.equal(process.listenerCount("SIGINT"), before);
  console.log(JSON.stringify({ result: "passed", boundary: "isolated disposable Node build tree; synthetic SIGINT handler delivery, not OS console delivery", profile: paths.root, rootPid: launched[0].pid, descendantPid, survivors: 0, nativeLaunches: 0 }));
} finally {
  // Failure safety: only the exact child handles created here, never a name sweep.
  for (const child of launched) if (child.exitCode === null && !child.signalCode) await terminateProcessTree(child.pid);
}
