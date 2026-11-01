/**
 * The daemon passes one HeavyCheckSlots to every window's AgentSession; their
 * process managers must share it, with each session as a distinct owner.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useFakeHome } from "../test-support/fake-home.js";
import { HeavyCheckSlots } from "./machine-profile.js";
import type { ProcessManager } from "./process-manager.js";

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
const disposers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-heavy-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-heavy-"));
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
  for (const dispose of disposers.splice(0)) await dispose();
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.rm(tmpProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function windowSession(slots: HeavyCheckSlots): Promise<ProcessManager> {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient: true,
    systemPrompt: "test",
    heavyCheckSlots: slots,
  });
  await session.initialize();
  disposers.push(() => session.dispose());
  const manager = (session as unknown as { processManager?: ProcessManager }).processManager;
  if (!manager) throw new Error("session has no process manager");
  return manager;
}

it("shares the daemon's heavy-check slots across sessions, one owner per session", async () => {
  const slots = new HeavyCheckSlots();
  const first = await windowSession(slots);
  const second = await windowSession(slots);
  // Each session acquires through its own manager; the owner passed by bash is
  // the session's id, so stand in with two distinct ids here.
  const held = await first.acquireHeavySlot("pnpm test", "window-a", 1);
  if (!held.ok) throw new Error("expected a lease");
  expect(slots.held).toBe(1);

  const notices: string[] = [];
  const waiting = second.acquireHeavySlot("pnpm test", "window-b", 1, undefined, (m) =>
    notices.push(m),
  );
  expect(notices).toHaveLength(1);
  held.lease.release();
  const granted = await waiting;
  expect(granted.ok).toBe(true);
  if (granted.ok) granted.lease.release();
  expect(slots.held).toBe(0);
  // Two cold session initialisations; same budget as the dispose-processes test.
}, 40_000);
