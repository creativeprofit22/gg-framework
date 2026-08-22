/**
 * Arming refreshes must survive being called BEFORE `initialize()`.
 *
 * `app-sidecar.ts` builds Ken's autopilot reviewer by constructing the session,
 * calling `setIdealReviewSuppressed(true)`, and only THEN awaiting
 * `initialize()` — suppression has to be set before the session can ever run a
 * turn. That setter refreshes hook arming, and every arming predicate reads
 * settings, which do not exist until `initialize()` assigns `settingsManager`.
 *
 * The ideal-review predicate returns early on `idealReviewSuppressed`, so it
 * never noticed. The verification predicate has no such early-return, so once
 * arming started refreshing BOTH, this path threw
 * `Cannot read properties of undefined (reading 'get')` and Ken's autopilot
 * session could never be created — every review failed with an error frame.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentSession } from "./agent-session.js";

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let session: AgentSession | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-preinit-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-preinit-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
});

afterEach(async () => {
  await session?.dispose();
  session = undefined;
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

async function construct(): Promise<AgentSession> {
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient: true,
    systemPrompt: "test",
  });
  return session;
}

describe("arming before initialize()", () => {
  it("suppressing ideal review before initialize does not throw (Ken autopilot boot order)", async () => {
    const ken = await construct();
    expect(() => ken.setIdealReviewSuppressed(true)).not.toThrow();
    await expect(ken.initialize()).resolves.not.toThrow();
  });

  it("un-suppressing before initialize does not throw either", async () => {
    const ken = await construct();
    expect(() => ken.setIdealReviewSuppressed(false)).not.toThrow();
  });
});
