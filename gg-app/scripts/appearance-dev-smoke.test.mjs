import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ensureNormalServer } from "./appearance-dev.mjs";
import { assertNativeBackground, runAppearanceSmoke } from "./appearance-dev-smoke.mjs";

it("requires OS background pixels from every distinct window, not theme success", () => {
  const sample = { label: "main", rgb: "#fcfbfd" };
  expect(() => assertNativeBackground([sample], "#fcfbfd", 1)).not.toThrow();
  expect(() => assertNativeBackground([{ ...sample, rgb: "#ff00ff" }], "#fcfbfd", 1)).toThrow();
  expect(() => assertNativeBackground([{ label: "main" }], "#fcfbfd", 1)).toThrow();
  expect(() => assertNativeBackground([sample], "#0f1115", 1)).toThrow();
  expect(() => assertNativeBackground([sample], "#fcfbfd", 3)).toThrow();
  expect(() => assertNativeBackground([sample, sample], "#fcfbfd", 2)).toThrow();
});

const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const out = await mkdtemp(join(tmpdir(), "appearance-report-"));
  directories.push(out);
  const options = {
    out, signals: new EventEmitter(),
    ensureServer: vi.fn(async () => {}),
    runFixture: vi.fn(async () => {}),
    processTableReader: vi.fn(async () => []),
    launchProcess: vi.fn(() => { throw new Error("Unexpected real launch"); }),
    terminate: vi.fn(),
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return { options, log, run: () => runAppearanceSmoke(options), receipt: async () => JSON.parse(await readFile(join(out, "result.json"), "utf8")) };
}
it("persists startup rejection and disposes the owned scope", async () => {
  const f = await fixture();
  const error = new Error("server startup failed");
  f.options.ensureServer.mockRejectedValue(error);
  await expect(f.run()).rejects.toBe(error);
  expect(await f.receipt()).toMatchObject({ status: "failed", error: error.message });
  expect(f.options.runFixture).not.toHaveBeenCalled();
  expect(f.options.signals.listenerCount("SIGINT")).toBe(0);
});
it.each([false, true])("preserves cleanup failure with assertion failure=%s", async assertionFails => {
  const f = await fixture();
  const assertion = new Error("workspace assertion failed");
  if (assertionFails) f.options.runFixture.mockRejectedValue(assertion);
  f.options.processTableReader.mockRejectedValue(new Error("owned cleanup failed"));
  const error = await f.run().catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (assertionFails) expect(error.errors[0]).toBe(assertion);
  expect(await f.receipt()).toMatchObject({
    status: "failed", cleanupError: expect.stringContaining("owned cleanup failed"),
    error: expect.stringContaining(assertionFails ? assertion.message : "owned cleanup failed"),
  });
  expect(f.options.signals.listenerCount("SIGTERM")).toBe(0);
});
it("preserves startup and cleanup errors together", async () => {
  const f = await fixture();
  f.options.ensureServer.mockRejectedValue(new Error("startup failed"));
  f.options.processTableReader.mockRejectedValue(new Error("cleanup failed"));
  await expect(f.run()).rejects.toThrow("startup failed");
  expect(await f.receipt()).toMatchObject({ status: "failed", error: "startup failed", cleanupError: expect.stringContaining("cleanup failed") });
});
it("passes without stopping a reused server", async () => {
  const f = await fixture();
  f.options.ensureServer.mockImplementation((env, scope) => ensureNormalServer(env, scope, { isListening: async () => true, verify: async () => {} }));
  f.options.processTableReader.mockResolvedValue([{ pid: 999, ppid: 1, startedAtMs: 1 }]);
  await f.run();
  expect(await f.receipt()).toMatchObject({ status: "passed" });
  expect(f.options.launchProcess).not.toHaveBeenCalled();
  expect(f.options.terminate).not.toHaveBeenCalled();
});
it("reports persistence failure without hiding assertion or cleanup errors or claiming a receipt", async () => {
  const f = await fixture();
  // A directory at the file destination deterministically prevents writing on Windows too.
  await mkdir(join(f.options.out, "result.json"));
  f.options.runFixture.mockRejectedValue(new Error("assertion failed"));
  f.options.processTableReader.mockRejectedValue(new Error("cleanup failed"));
  const error = await f.run().catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.message).toContain("assertion failed");
  expect(error.message).toContain("cleanup failed");
  expect(error.message).toContain("Could not persist appearance smoke evidence");
  expect(f.log).not.toHaveBeenCalled();
});
it("rejects an unavailable evidence directory before starting anything", async () => {
  const f = await fixture();
  const file = join(f.options.out, "not-a-directory");
  await writeFile(file, "occupied");
  f.options.out = join(file, "receipt");
  await expect(f.run()).rejects.toThrow();
  expect(f.options.ensureServer).not.toHaveBeenCalled();
  expect(f.log).not.toHaveBeenCalled();
});
