import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runReviewDockVisibilityFixture } from "./review-dock-visibility.mjs";

// Self-contained runner for `pnpm test:review-dock`: serves this checkout on a
// private port (never the developer's 1420), runs the real-browser review/dock
// visibility fixture, and always stops the server.
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const url = "http://127.0.0.1:1422";
const viteCli = resolve(appRoot, "node_modules/vite/bin/vite.js");
const server = spawn(
  process.execPath,
  [viteCli, "--host", "127.0.0.1", "--port", "1422", "--strictPort"],
  { cwd: appRoot, stdio: ["ignore", "pipe", "pipe"] },
);
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`Vite exited before the regression test started.\n${serverOutput}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for Vite.\n${serverOutput}`);
}

async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error("Vite did not exit within 10s")), 10_000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
  if (!server.kill()) throw new Error("Failed to stop the Vite regression server");
  await exited;
}

try {
  await waitForServer();
  const result = await runReviewDockVisibilityFixture({ url });
  console.log(
    `Review dock regression passed: ${result.checks} real-browser checks (plan approval, Roadmap draft, Roadmap refresh recovery, update banner; 1280×800, 390×844, 1280×560). Native Tauri WebView not exercised.`,
  );
} finally {
  await stopServer();
}
