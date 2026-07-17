import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ProcessManager } from "../core/process-manager.js";
import { createBashTool } from "./bash.js";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it("times out a CPU-bound foreground process and kills the fixture", async () => {
  const fixture = fileURLToPath(new URL("./__fixtures__/bash-timeout-cpu.mjs", import.meta.url));
  const pidFile =
    process.env.GG_SUBPHASE0B_PID_FILE ??
    path.join(os.tmpdir(), `ggcoder-bash-timeout-${process.pid}-${Date.now()}.pid`);
  const manager = new ProcessManager();
  const controller = new AbortController();
  let fixturePid: number | undefined;

  try {
    const command = [process.execPath, fixture, pidFile]
      .map((value) => JSON.stringify(value))
      .join(" ");
    const startedAt = Date.now();
    const result = await createBashTool(process.cwd(), manager).execute(
      { command, timeout: 1_000 },
      { signal: controller.signal, toolCallId: "bash-timeout-cpu" },
    );
    const elapsed = Date.now() - startedAt;

    expect(result).toContain("Exit code: TIMEOUT (1000ms)");
    if (typeof result !== "string") throw new Error("Expected bash timeout text output");
    const marker = result.match(/CPU_FIXTURE_PID=(\d+)/);
    expect(marker).not.toBeNull();
    fixturePid = Number(marker![1]);
    expect(elapsed).toBeGreaterThanOrEqual(750);
    expect(elapsed).toBeLessThan(10_000);

    const deadline = Date.now() + 5_000;
    while (isAlive(fixturePid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isAlive(fixturePid)).toBe(false);
  } finally {
    if (!fixturePid) {
      fixturePid = Number(await fs.readFile(pidFile, "utf8").catch(() => "")) || undefined;
    }
    if (fixturePid && isAlive(fixturePid)) process.kill(fixturePid);
    manager.shutdownAll();
    await fs.rm(pidFile, { force: true });
  }
}, 15_000);
