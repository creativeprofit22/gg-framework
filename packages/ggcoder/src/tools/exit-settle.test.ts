import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { watchExitSettle, type ExitSettleResult } from "./exit-settle.js";

/** Parent prints its detached grandchild's PID, then exits while the grandchild holds stdout. */
const HOLDER_SCRIPT = `
const { spawn } = require("node:child_process");
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], {
  detached: true,
  stdio: "inherit",
});
holder.unref();
process.stdout.write("holder:" + holder.pid + "\\n", () => process.exit(0));
`;

const leftoverPids: number[] = [];

afterEach(() => {
  for (const pid of leftoverPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
});

describe("watchExitSettle", () => {
  it("settles promptly when a detached grandchild still holds the output pipes", async () => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["-e", HOLDER_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
    });

    const result = await new Promise<ExitSettleResult>((resolve) => {
      watchExitSettle({ child, settleMs: 300, onSettled: resolve });
    });
    const match = /holder:(\d+)/.exec(output);
    if (match?.[1]) leftoverPids.push(Number(match[1]));

    expect(result).toEqual({ code: 0, signal: null, pipesHeld: true });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(child.stdout.destroyed).toBe(true);
  }, 15_000);

  it("reports pipes not held when close arrives within the grace period", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ok')"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    const result = await new Promise<ExitSettleResult>((resolve) => {
      watchExitSettle({ child, settleMs: 5_000, onSettled: resolve });
    });
    expect(result).toEqual({ code: 0, signal: null, pipesHeld: false });
  });

  it("never reports after disposal", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    const settled: ExitSettleResult[] = [];
    const dispose = watchExitSettle({ child, settleMs: 0, onSettled: (r) => settled.push(r) });
    dispose();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(settled).toEqual([]);
  });
});
