import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLogger, isLoggerOpen, log, openLog, registerLogCleanup } from "./logger.js";

const dirs: string[] = [];
const originalSecret = process.env.GG_LOGGER_TEST_SECRET;

afterEach(async () => {
  closeLogger({ shutdownLine: false });
  if (originalSecret === undefined) delete process.env.GG_LOGGER_TEST_SECRET;
  else process.env.GG_LOGGER_TEST_SECRET = originalSecret;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("logger rotation", () => {
  it("rotates a log left just under the cap instead of wedging forever", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gg-logger-"));
    dirs.push(dir);
    const file = path.join(dir, "debug.log");

    // The state a capped process leaves behind: it stopped writing a hair BELOW
    // the cap. Rotating only at `size >= MAX_BYTES` wedged the file forever —
    // every later launch reopened it, had no room for a single line, and
    // disabled its own logging, so it could never grow enough to qualify for
    // rotation. The app sidecar lost ~2 weeks of diagnostics that way.
    await writeFile(file, "x".repeat(10 * 1024 * 1024 - 4));

    expect(openLog(file, "test")).toBe(true);
    log("INFO", "test", "line after rotation");
    closeLogger({ shutdownLine: false });

    expect(await readFile(file, "utf-8")).toContain("line after rotation");
    // One generation is retained, not discarded.
    expect((await stat(`${file}.1`)).size).toBe(10 * 1024 * 1024 - 4);
  });
});

describe("logger redaction boundary", () => {
  it("removes canary secrets from messages and success/failure fields", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gg-logger-"));
    dirs.push(dir);
    const file = path.join(dir, "debug.log");
    const canary = "opaque-logger-canary-value-123456";
    process.env.GG_LOGGER_TEST_SECRET = canary;
    expect(openLog(file, "test")).toBe(true);

    log("INFO", "test", `success ${canary}`, {
      apiKey: canary,
      nested: { output: `Bearer ${canary}` },
    });
    log("ERROR", "test", "failed", {
      error: new Error(`provider failed with ${canary}`),
    });
    closeLogger({ shutdownLine: false });

    const persisted = await readFile(file, "utf-8");
    expect(persisted).not.toContain(canary);
    expect(persisted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("hard-caps writes during a noisy long-lived process", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gg-logger-"));
    dirs.push(dir);
    const file = path.join(dir, "debug.log");
    const cleanup = vi.fn();
    expect(openLog(file, "test")).toBe(true);
    registerLogCleanup(cleanup);

    const oneMiB = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) log("DEBUG", "noise", oneMiB);

    expect(isLoggerOpen()).toBe(false);
    expect((await stat(file)).size).toBeLessThanOrEqual(10 * 1024 * 1024);
    // Reopening in the same process cannot bypass the cap.
    expect(openLog(file, "test")).toBe(false);

    closeLogger({ shutdownLine: false });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
