import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as ChildProcessModule from "node:child_process";

const spawnMock = vi.hoisted(() => vi.fn());
// Importing `spawn` from the mocked module would hand back the mock itself, so
// delegating to it recurses. Capture the genuine implementation inside the mock
// factory instead.
const actualSpawn = vi.hoisted(() => ({ fn: undefined as unknown }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>("node:child_process");
  actualSpawn.fn = actual.spawn;
  return { ...actual, spawn: spawnMock };
});

const { createGrepTool, detectExternalScanner, resetExternalScannerProbe } =
  await import("./grep.js");

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-spawn-"));
  await fs.writeFile(path.join(tmpDir, "a.ts"), "const marker = 1;\n");
  resetExternalScannerProbe();
  spawnMock.mockReset();
  // Delegate to the genuine spawn so the tool behaves normally; we only assert
  // the options it was handed.
  spawnMock.mockImplementation((...args: unknown[]) =>
    (actualSpawn.fn as (...a: unknown[]) => unknown)(...args),
  );
});

afterEach(async () => {
  resetExternalScannerProbe();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("grep external scanner spawn options", () => {
  it("hides the console window when probing for the scanner", async () => {
    await detectExternalScanner();

    expect(spawnMock).toHaveBeenCalledWith(
      "rg",
      ["--version"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("hides the console window when running a search", async () => {
    const tool = createGrepTool(tmpDir, undefined, { useExternalScanner: () => true });
    await tool.execute({ pattern: "marker" }, context());

    const searchCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && !call[1].includes("--version"),
    );
    // `rg` is optional. When it is absent the in-process path legitimately
    // never spawns — but assert that is the actual reason, so this test can
    // never pass merely because the search silently failed to run.
    if (!searchCall) {
      expect(await detectExternalScanner()).toBeUndefined();
      return;
    }
    expect(searchCall[2]).toEqual(expect.objectContaining({ windowsHide: true }));
    expect(searchCall[2]).toEqual(expect.objectContaining({ cwd: tmpDir }));
  });

  it("never spawns a scan once the budget is already spent", async () => {
    const tool = createGrepTool(tmpDir, undefined, {
      useExternalScanner: () => true,
      deadlineMs: 0,
    });

    const result = String(await tool.execute({ pattern: "marker" }, context()));

    // The child's budget is floored at 1ms, so spawning here would race the
    // scanner: whenever the child won, an expired budget still returned real
    // matches — and only sometimes, which is how it slipped through as a flake.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toContain("No matches found.");
    expect(result).not.toContain("a.ts:1:");
  });
});
