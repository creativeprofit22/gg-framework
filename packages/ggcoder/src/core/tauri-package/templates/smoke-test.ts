export const SMOKE_TEST_TEMPLATE = `/*__GG_MARKER__*/
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { smokeExecutable } from "./smoke-tauri-package.mjs";

test("rejects a crashing executable", async () => {
  const spawnImpl = () => { const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => child.emit("exit", 1, null)); return child; };
  await assert.rejects(smokeExecutable("fixture", { spawnImpl }), /Smoke test failed/);
});

test("kills timed-out executables without passing unrelated environment values", async () => {
  let childEnvironment;
  let killed = false;
  const spawnImpl = (_executable, _args, options) => {
    childEnvironment = options.env;
    const child = new EventEmitter();
    child.kill = () => { killed = true; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; };
    return child;
  };
  await assert.rejects(smokeExecutable("fixture", { env: { PATH: "fixture-path", TEMP: "/tmp/gg-smoke", WEBVIEW2_USER_DATA_FOLDER: "outside", GG_SMOKE_SECRET: "hidden" }, spawnImpl, timeoutMs: 5 }), /timed out/);
  assert.equal(killed, true);
  assert.deepEqual(childEnvironment, { PATH: "fixture-path", TEMP: "/tmp/gg-smoke", WEBVIEW2_USER_DATA_FOLDER: path.join("/tmp/gg-smoke", "webview2") });
});
`;
