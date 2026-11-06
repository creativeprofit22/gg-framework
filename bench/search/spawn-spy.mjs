// Engine attribution without product changes: wrap child_process.spawn so the
// tool's ESM `import { spawn }` binding sees the wrapper, and record every rg
// child against the in-flight call (AsyncLocalStorage). Owner of rg child
// bookkeeping: per-call engine, child counts, kills and leftovers.
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const OVERFLOW_BYTES = 8 * 1024 * 1024;

export const callContext = new AsyncLocalStorage();

function isRg(command) {
  return /(^|[\\/])rg(\.exe)?$/i.test(String(command));
}

/** Install once per worker process. Returns the spy's query interface. */
export function installSpawnSpy() {
  const childProcess = require("node:child_process");
  const original = childProcess.spawn;
  const children = [];
  let probe = { seen: false, available: undefined, error: undefined };

  childProcess.spawn = function spySpawn(command, args = [], options) {
    const child = original.call(this, command, args, options);
    if (!isRg(command)) return child;
    const isProbe = Array.isArray(args) && args[0] === "--version";
    const record = {
      callId: callContext.getStore()?.callId,
      probe: isProbe,
      args: Array.isArray(args) ? [...args] : [],
      pid: child.pid,
      startedAt: performance.now(),
      closedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      spawnError: undefined,
      killedAt: undefined,
      stdoutBytes: 0,
    };
    children.push(record);
    child.stdout?.on("data", (chunk) => {
      record.stdoutBytes += chunk.length;
    });
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      record.killedAt ??= performance.now();
      return kill(signal);
    };
    child.once("error", (error) => {
      record.spawnError = error.code ?? error.message;
      record.closedAt ??= performance.now();
      if (isProbe) probe = { seen: true, available: false, error: record.spawnError };
    });
    child.once("close", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.closedAt ??= performance.now();
      if (isProbe && !record.spawnError)
        probe = { seen: true, available: code === 0, error: undefined };
    });
    return child;
  };
  syncBuiltinESMExports();

  return {
    get probe() {
      return probe;
    },
    childrenFor(callId) {
      return children.filter((c) => c.callId === callId && !c.probe);
    },
    liveChildren() {
      return children.filter((c) => c.closedAt === undefined);
    },
    all() {
      return children.slice();
    },
    restore() {
      childProcess.spawn = original;
      syncBuiltinESMExports();
    },
  };
}

/**
 * Decide which engine produced a call's result from its rg children.
 * Mirrors grep.ts: an rg exit of 0/1 or a deadline kill returns rg output;
 * a spawn error, other exit code or output-overflow kill falls back in-process.
 */
export function attributeEngine(rgChildren) {
  if (rgChildren.length === 0) return { engine: "in-process", fallback: undefined };
  const last = rgChildren[rgChildren.length - 1];
  if (last.spawnError)
    return { engine: "in-process", fallback: `rg-fallback:spawn:${last.spawnError}` };
  if (last.killedAt !== undefined) {
    if (last.stdoutBytes > OVERFLOW_BYTES)
      return { engine: "in-process", fallback: "rg-fallback:overflow" };
    return { engine: "rg", fallback: undefined, rgKilledByDeadline: true };
  }
  if (last.exitCode === 0 || last.exitCode === 1) return { engine: "rg", fallback: undefined };
  return { engine: "in-process", fallback: `rg-fallback:exit:${last.exitCode}` };
}
