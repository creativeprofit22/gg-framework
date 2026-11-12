// Idle pane cleanup smoke: start the built daemon (packages/ggcoder/dist) with an
// isolated GG_AGENT_DIR whose settings.json sets idleSessionCleanupMinutes: 1.
// Create two sessions, keep an event stream open on one and never DELETE the
// other. Poll until the abandoned one is gone (404 + "session reaped" in the
// log), check the open one still answers /state, then DELETE the reaped id and
// expect a quiet 200. Run after `pnpm --filter @kenkaiiii/ggcoder build`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const daemonEntry = join(repoRoot, "packages", "ggcoder", "dist", "app-sidecar.js");
const daemonAuthToken = "gg-session-reaper-smoke-daemon-token";
// One minute of quiet plus up to one 60 s scan, with margin for a slow boot.
const REAP_DEADLINE_MS = 4 * 60_000;
const POLL_MS = 2_000;

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for GG_APP_LISTENING")),
      120_000,
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const match = out.match(/GG_APP_LISTENING (\d+) (\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), token: match[2] });
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early (code ${code})`));
    });
  });
}

async function main() {
  if (!existsSync(daemonEntry)) fail(`built daemon missing: ${daemonEntry}`);
  const root = mkdtempSync(join(tmpdir(), "gg-session-reaper-smoke-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ idleSessionCleanupMinutes: 1 }),
    "utf8",
  );
  const logFile = join(agentDir, "gg-app-sidecar.log");

  const child = spawn(process.execPath, [daemonEntry], {
    env: {
      ...process.env,
      GG_AGENT_DIR: agentDir,
      GG_APP_PORT: "0",
      GG_APP_CWD: projectDir,
      GG_APP_AUTH_TOKEN: daemonAuthToken,
      GG_APP_SIDECAR_LOG_FILE: "gg-app-sidecar.log",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const events = new AbortController();

  try {
    const { port, token } = await waitForListening(child);
    const base = `http://127.0.0.1:${port}`;
    const headers = (sessionId) => ({
      "x-gg-token": token,
      ...(sessionId ? { "x-gg-session": sessionId } : {}),
    });

    async function createSession() {
      const response = await fetch(`${base}/session`, {
        method: "POST",
        headers: {
          ...headers(),
          "content-type": "application/json",
          "x-gg-daemon-token": daemonAuthToken,
        },
        body: JSON.stringify({ cwd: projectDir }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status !== 200 || !body.sessionId) {
        fail(`POST /session returned ${response.status}: ${JSON.stringify(body)}`);
      }
      return body.sessionId;
    }

    const openId = await createSession();
    const abandonedId = await createSession();
    console.log(`smoke: open ${openId.slice(0, 8)}, abandoned ${abandonedId.slice(0, 8)}`);

    const stream = await fetch(`${base}/events?session=${encodeURIComponent(openId)}`, {
      headers: headers(openId),
      signal: events.signal,
    });
    if (stream.status !== 200 || !stream.body) fail(`GET /events returned ${stream.status}`);
    // Drain the stream so the daemon's writes never back up.
    void (async () => {
      try {
        for await (const _chunk of stream.body) {
          // keep reading
        }
      } catch {
        // aborted at the end of the smoke
      }
    })();

    // Watch the log, not the session: any request to the session counts as activity.
    const reapedLines = () =>
      (existsSync(logFile) ? readFileSync(logFile, "utf8") : "")
        .split("\n")
        .filter((line) => line.includes("session reaped"));
    const createdAt = Date.now();
    while (
      Date.now() - createdAt < REAP_DEADLINE_MS &&
      !reapedLines().some((line) => line.includes(abandonedId))
    ) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (!reapedLines().some((line) => line.includes(abandonedId))) {
      fail(`no 'session reaped' log line for the abandoned session after ${REAP_DEADLINE_MS} ms`);
    }
    const reapedAfterMs = Date.now() - createdAt;
    if (reapedLines().some((line) => line.includes(openId))) fail("open session was reaped");
    const reapedState = await fetch(`${base}/state`, { headers: headers(abandonedId) });
    const reapedBody = await reapedState.text();
    if (reapedState.status !== 404 || !reapedBody.includes("unknown session")) {
      fail(`freed session /state returned ${reapedState.status}: ${reapedBody}`);
    }
    console.log(`smoke: abandoned session freed after ${Math.round(reapedAfterMs / 1000)} s`);

    const openState = await fetch(`${base}/state`, { headers: headers(openId) });
    await openState.arrayBuffer();
    if (openState.status !== 200) fail(`open session /state returned ${openState.status}`);
    console.log("smoke: open session with a listener still answers /state 200");

    const lateDelete = await fetch(`${base}/session/${encodeURIComponent(abandonedId)}`, {
      method: "DELETE",
      headers: headers(),
    });
    const lateBody = await lateDelete.text();
    if (lateDelete.status !== 200) {
      fail(`late DELETE returned ${lateDelete.status}: ${lateBody}`);
    }
    console.log("smoke: late DELETE for the freed session answered 200");
    console.log("SMOKE PASS");
  } finally {
    events.abort();
    child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    await exited;
    clearTimeout(killTimer);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  if (!process.exitCode) console.error(`SMOKE FAIL: ${error.message}`);
  process.exitCode = 1;
});
