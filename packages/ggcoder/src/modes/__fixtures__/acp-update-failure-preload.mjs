// Test-only preload for the real CLI. Never run a global install: intercept the
// updater's detached/ignored child before its first import, then fail it async.
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

// Read-only global-root discovery is mocked too: no package manager is executed.
childProcess.execFileSync = function (_command, args) {
  if (args?.slice(-2).join(" ") === "root -g") {
    return path.join(os.homedir(), "global", "node_modules");
  }
  throw new Error("fixture: unexpected synchronous child");
};

const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (options?.detached && options?.stdio === "ignore") {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    setImmediate(() => {
      process.stderr.write("fixture: asynchronous updater ENOENT\n");
      child.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
    });
    return child;
  }
  // tsx's compiler subprocess is not the updater.
  return originalSpawn.call(this, command, args, options);
};
syncBuiltinESMExports();
// No registry, telemetry, or provider calls are allowed in this startup probe.
globalThis.fetch = async () => { throw new Error("fixture: network disabled"); };
