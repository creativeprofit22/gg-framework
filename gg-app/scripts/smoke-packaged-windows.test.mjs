// Cross-platform unit tests for the PURE helpers of the packaged Windows smoke.
//
// The smoke itself only runs on Windows, but its risky logic — deciding which
// MSI this build produced, deciding which PIDs we are allowed to kill — is pure
// and must be verified everywhere. The PID-ownership rules in particular are
// safety-critical: getting them wrong means taskkill'ing a developer's real
// GG Coder, or an unrelated process that inherited a recycled PID.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupOwnedProcesses,
  collectOwnedProcessIds,
  discoverChangedMsi,
  discoverPackagedLayout,
  removeTemporaryDirectory,
  snapshotMsiArtifacts,
  waitFor,
} from "./smoke-packaged-windows.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "gg-app-packaged-smoke-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged Windows smoke artifact discovery", () => {
  it("selects only the MSI created or replaced by the current build", () => {
    // A stale MSI from an earlier build must never be smoked in place of the
    // one we just produced — that reports a pass for unpackaged code.
    const root = temporaryDirectory();
    writeFileSync(join(root, "stale.msi"), "old");
    const before = snapshotMsiArtifacts(root);
    const current = join(root, "current.msi");
    writeFileSync(current, "new");

    expect(discoverChangedMsi(before, snapshotMsiArtifacts(root))).toBe(current);
  });

  it("rejects ambiguous build output", () => {
    const root = temporaryDirectory();
    const before = snapshotMsiArtifacts(root);
    writeFileSync(join(root, "one.msi"), "one");
    writeFileSync(join(root, "two.msi"), "two");

    expect(() => discoverChangedMsi(before, snapshotMsiArtifacts(root))).toThrow(
      "expected one newly built MSI, found 2",
    );
  });

  it("requires the app, Node runtime, and sidecar in one extracted layout", () => {
    const root = temporaryDirectory();
    const install = join(root, "PFiles64", "GG Coder");
    mkdirSync(join(install, "sidecar"), { recursive: true });
    writeFileSync(join(install, "gg-app.exe"), "app");
    writeFileSync(join(install, "ggnode.exe"), "node");
    writeFileSync(join(install, "sidecar", "app-sidecar.mjs"), "sidecar");

    expect(discoverPackagedLayout(root).installDir).toBe(realpathSync.native(install));
  });

  it("fails when the bundled Node runtime is missing beside the app", () => {
    // The exact shape of "installs fine, does nothing" that this smoke exists
    // to catch: the shell is there but has no runtime to spawn the sidecar.
    const root = temporaryDirectory();
    const install = join(root, "PFiles64", "GG Coder");
    mkdirSync(join(install, "sidecar"), { recursive: true });
    writeFileSync(join(install, "gg-app.exe"), "app");
    writeFileSync(join(install, "sidecar", "app-sidecar.mjs"), "sidecar");

    expect(() => discoverPackagedLayout(root)).toThrow("packaged Node runtime missing");
  });

  it("fails when the sidecar resource did not make it into the package", () => {
    const root = temporaryDirectory();
    const install = join(root, "PFiles64", "GG Coder");
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, "gg-app.exe"), "app");
    writeFileSync(join(install, "ggnode.exe"), "node");

    expect(() => discoverPackagedLayout(root)).toThrow("packaged sidecar resource missing");
  });
});

describe("packaged Windows smoke timeout", () => {
  it("stops polling at the configured deadline with the last probe error", async () => {
    let clock = 0;
    await expect(
      waitFor(
        "runtime evidence",
        () => {
          throw new Error("not ready");
        },
        {
          timeoutMs: 20,
          intervalMs: 5,
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("runtime evidence timed out after 20ms: not ready");
  });
});

describe("packaged Windows smoke cleanup", () => {
  it("launches without inherited pipes and owns only its scoped process tree", () => {
    const source = readFileSync(new URL("./smoke-packaged-windows.mjs", import.meta.url), "utf8");
    expect(source).toContain('stdio: "ignore"');
    expect(source).not.toContain('stdio: ["ignore", "pipe", "pipe"]');

    const processes = [
      { ProcessId: 10, ParentProcessId: 1, ExecutablePath: "C:\\package\\gg-app.exe" },
      { ProcessId: 20, ParentProcessId: 10, ExecutablePath: "C:\\package\\ggnode.exe" },
      { ProcessId: 30, ParentProcessId: 20, ExecutablePath: "C:\\Windows\\helper.exe" },
      { ProcessId: 40, ParentProcessId: 1, CommandLine: "tool C:\\smoke\\sidecar.mjs" },
      // A GG Coder the developer already had open: same exe name, different
      // path, unrelated parent. It must survive.
      { ProcessId: 50, ParentProcessId: 1, ExecutablePath: "C:\\Users\\live\\gg-app.exe" },
    ];

    expect(collectOwnedProcessIds(processes, 10, ["C:\\package", "C:\\smoke"]).sort()).toEqual([
      10, 20, 30, 40,
    ]);
  });

  it("does not trust a reused root PID without temporary-path evidence", () => {
    // Windows recycles PIDs aggressively; "the pid we launched" is not proof of
    // ownership once that process has exited.
    const processes = [
      { ProcessId: 10, ParentProcessId: 1, ExecutablePath: "C:\\Users\\live\\gg-app.exe" },
    ];

    expect(collectOwnedProcessIds(processes, 10, ["C:\\package"])).toEqual([]);
  });

  it("retries temporary-directory removal while WebView handles are releasing", async () => {
    let attempts = 0;
    let present = true;

    await removeTemporaryDirectory("C:\\smoke", {
      remove: () => {
        attempts += 1;
        if (attempts < 3) throw new Error("EBUSY");
        present = false;
      },
      exists: () => present,
      sleep: async () => {},
      attempts: 3,
    });

    expect(attempts).toBe(3);
  });

  it("kills the scoped process tree until no owned process remains", async () => {
    const alive = new Set([10, 20, 50]);
    const killed = [];
    const processes = [
      { ProcessId: 10, ParentProcessId: 1, ExecutablePath: "C:\\package\\gg-app.exe" },
      { ProcessId: 20, ParentProcessId: 10, ExecutablePath: "C:\\package\\ggnode.exe" },
      { ProcessId: 50, ParentProcessId: 1, ExecutablePath: "C:\\Users\\live\\gg-app.exe" },
    ];

    await cleanupOwnedProcesses({
      rootPid: 10,
      ownedRoots: ["C:\\package"],
      snapshot: async () => processes,
      exists: (pid) => alive.has(pid),
      kill: async (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      timeoutMs: 100,
    });

    // Children before parents, and the developer's own app untouched.
    expect(killed).toEqual([20, 10]);
    expect(alive).toEqual(new Set([50]));
  });

  it("reports the survivors when a process refuses to die", async () => {
    await expect(
      cleanupOwnedProcesses({
        rootPid: 10,
        ownedRoots: ["C:\\package"],
        snapshot: async () => [
          { ProcessId: 10, ParentProcessId: 1, ExecutablePath: "C:\\package\\gg-app.exe" },
        ],
        exists: () => true,
        kill: async () => {},
        timeoutMs: 0,
      }),
    ).rejects.toThrow("packaged smoke processes survived cleanup: 10");
  });
});
