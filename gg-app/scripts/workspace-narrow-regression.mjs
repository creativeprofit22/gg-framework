import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkspaceNarrowVisualFixture } from "./workspace-narrow-visual.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const url = "http://127.0.0.1:1421";
const viteCli = resolve(appRoot, "node_modules/vite/bin/vite.js");
const server = spawn(
  process.execPath,
  [viteCli, "--host", "127.0.0.1", "--port", "1421", "--strictPort"],
  {
    cwd: appRoot,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before the regression test started.\n${serverOutput}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for Vite.\n${serverOutput}`);
}
async function stopServer() {
  let result = { code: server.exitCode, signal: server.signalCode };
  if (result.code === null && result.signal === null) {
    const exit = new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(
        () => rejectExit(new Error("Vite did not exit within 10 seconds")),
        10_000,
      );
      server.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    });
    if (!server.kill()) throw new Error("Failed to stop the Vite regression server");
    result = await exit;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
    } catch {
      console.log(
        `Vite fixture server exited cleanly on ${process.platform} (${result.signal ?? result.code}).`,
      );
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Vite still accepts connections at ${url} after exit`);
}

try {
  await waitForServer();
  const result = await runWorkspaceNarrowVisualFixture({ screenshot: false, url });
  console.log(
    `320px workspace regression passed: pane ${result.shell.pane.clientWidth}/${result.shell.pane.scrollWidth}, header ${result.shell.header.clientWidth}/${result.shell.header.scrollWidth}`,
  );
} finally {
  await stopServer();
}
