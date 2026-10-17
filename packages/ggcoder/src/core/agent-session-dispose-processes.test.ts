/**
 * Background commands run in their own process group, so nothing but the
 * session's ProcessManager can stop them. Quitting the app gives the daemon a
 * few seconds before it is force-killed; if dispose() awaits anything slow
 * (a post-turn compaction, an MCP server) before stopping them, they outlive
 * the app as orphans. Stopping them must be the first, synchronous step.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useFakeHome } from "../test-support/fake-home.js";
import { keepAliveWhileOwnerLives } from "../test-support/keep-alive.js";
import type { ProcessManager } from "./process-manager.js";

interface DisposeInternals {
  processManager?: ProcessManager;
  postTurnCompaction?: Promise<void>;
}

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let manager: ProcessManager | undefined;
/** Settles the wedged compaction so the pending dispose() can finish. */
let releaseCompaction: (() => void) | undefined;
let pendingDispose: Promise<void> | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-dispose-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-dispose-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  // Let the wedged dispose() run to completion so the session releases every
  // handle it holds in the project dir; otherwise Windows fails the rm (EBUSY).
  releaseCompaction?.();
  await pendingDispose;
  releaseCompaction = undefined;
  pendingDispose = undefined;
  manager?.shutdownAll();
  manager = undefined;
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.rm(tmpProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the OS to actually reap `pid`. The manager marks a process exited the
 * moment it signals it, but on Windows the dying tree still holds handles in its
 * cwd for a while — so the real process table is the only honest signal.
 */
async function waitForProcessGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** PID the fixture reports once it is really running (not just its shell). */
async function waitForWorkerPid(
  bg: ProcessManager,
  id: string,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen += (await bg.readOutput(id)).output;
    const match = /WORKER_READY (\d+)/.exec(seen);
    if (match?.[1]) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Background fixture never reported ready. Saw:\n${seen}`);
}

it("stops background commands before awaiting a slow teardown step", async () => {
  // Arrange: a live session with a long-running background command and a
  // post-turn compaction that does not settle until the test releases it.
  const { AgentSession: Session } = await import("./agent-session.js");
  const session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient: true,
    systemPrompt: "test",
  });
  await session.initialize();
  const internal = session as unknown as DisposeInternals;
  manager = internal.processManager;
  if (!manager) throw new Error("session has no process manager");
  const fixture = path.join(tmpProject, "worker.cjs");
  await fs.writeFile(
    fixture,
    `console.log('WORKER_READY ' + process.pid);\n${keepAliveWhileOwnerLives()}\n`,
  );
  const started = await manager.start(
    `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`,
    tmpProject,
  );
  // On Windows the PID above is the shell; the program it launches is a
  // separate process. Wait until that program is running, otherwise teardown
  // can kill the shell before it has launched anything, and the program
  // starts afterwards with nothing left to stop it.
  const workerPid = await waitForWorkerPid(manager, started.id);
  internal.postTurnCompaction = new Promise<void>((resolve) => {
    releaseCompaction = resolve;
  });

  // Act: dispose without awaiting — it is wedged on the compaction.
  pendingDispose = session.dispose();

  // Assert: the program itself (not just its shell) dies while dispose() is
  // still wedged.
  expect(await waitForProcessGone(workerPid)).toBe(true);
  expect(await waitForProcessGone(started.pid)).toBe(true);
}, 40_000);
