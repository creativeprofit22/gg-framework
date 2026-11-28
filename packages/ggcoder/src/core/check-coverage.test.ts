import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { VerifyGate, VerifyPlan } from "@kenkaiiii/gg-core/verify-plan";
import {
  CheckCoverageMemory,
  captureCheckInputs,
  compileCovers,
  formatPriorPassNotice,
  formatProjectReportedPasses,
  scopeAffectedBy,
  toRepoRelative,
  type CaptureCheckInputsArgs,
  type CheckCoverageRecord,
} from "./check-coverage.js";

const rustGate: VerifyGate = {
  id: "rust-test",
  argv: ["cargo", "test"],
  cwd: ".",
  covers: ["crates/**", "Cargo.toml"],
  fingerprint: null,
  quietBudgetSeconds: null,
  protectedPaths: [],
};

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-check-coverage-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await fs.mkdir(path.join(root, "crates/core/src"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "target/\n");
  await fs.writeFile(path.join(root, "Cargo.toml"), "[workspace]\n");
  await fs.writeFile(path.join(root, "crates/core/src/lib.rs"), "pub fn a() {}\n");
  await fs.writeFile(path.join(root, "src/app.ts"), "export const a = 1;\n");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function args(overrides: Partial<CaptureCheckInputsArgs> = {}): CaptureCheckInputsArgs {
  return {
    cwd: root,
    command: "cargo test",
    shellPath: "bash",
    env: { PATH: "/bin" },
    ...overrides,
  };
}

function record(overrides: Partial<CheckCoverageRecord> = {}): CheckCoverageRecord {
  return {
    fingerprint: "a".repeat(64),
    status: "passed",
    command: "cargo test",
    executionId: "exec-1",
    run: 3,
    observedAt: "2026-10-30T01:12:04.123Z",
    ...overrides,
  };
}

describe("captureCheckInputs", () => {
  it("keeps a plan-scoped fingerprint across an edit outside its covers", async () => {
    const before = await captureCheckInputs(args({ gate: rustGate }));
    expect(before?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(before?.scope).toMatchObject({ kind: "plan", gateId: "rust-test" });
    await fs.writeFile(path.join(root, "src/app.ts"), "export const a = 2;\n");
    await fs.writeFile(path.join(root, "src/new.ts"), "export {};\n");
    expect((await captureCheckInputs(args({ gate: rustGate })))?.fingerprint).toBe(
      before?.fingerprint,
    );
    await fs.writeFile(path.join(root, "crates/core/src/lib.rs"), "pub fn b() {}\n");
    expect((await captureCheckInputs(args({ gate: rustGate })))?.fingerprint).not.toBe(
      before?.fingerprint,
    );
  });

  it("falls back to the whole tree without a gate or with empty covers", async () => {
    const before = await captureCheckInputs(args());
    expect(before?.scope.kind).toBe("tree");
    expect(
      (await captureCheckInputs(args({ gate: { ...rustGate, covers: [] } })))?.scope.kind,
    ).toBe("tree");
    await fs.mkdir(path.join(root, "target"));
    await fs.writeFile(path.join(root, "target/out"), "ignored build output");
    expect((await captureCheckInputs(args()))?.fingerprint).toBe(before?.fingerprint);
    await fs.writeFile(path.join(root, "src/app.ts"), "export const a = 2;\n");
    expect((await captureCheckInputs(args()))?.fingerprint).not.toBe(before?.fingerprint);
  });

  it("changes with argv, env, cwd and HEAD", async () => {
    const base = await captureCheckInputs(args());
    expect(base).not.toBeNull();
    const fingerprintOf = async (overrides: Partial<CaptureCheckInputsArgs>) =>
      (await captureCheckInputs(args(overrides)))?.fingerprint;
    expect(await fingerprintOf({ command: "cargo test --release" })).not.toBe(base?.fingerprint);
    expect(await fingerprintOf({ shellPath: "pwsh" })).not.toBe(base?.fingerprint);
    expect(await fingerprintOf({ env: { PATH: "/usr/bin" } })).not.toBe(base?.fingerprint);
    expect(await fingerprintOf({ env: { PATH: "/bin", CARGO_HOME: "x" } })).not.toBe(
      base?.fingerprint,
    );
    expect(await fingerprintOf({ cwd: path.join(root, "src") })).not.toBe(base?.fingerprint);
    const gated = await fingerprintOf({ gate: rustGate });
    expect(await fingerprintOf({ gate: { ...rustGate, argv: ["cargo", "test", "-q"] } })).not.toBe(
      gated,
    );
    expect(await fingerprintOf({})).toBe(base?.fingerprint);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"],
      { cwd: root },
    );
    // Same content, new HEAD.
    expect(await fingerprintOf({})).not.toBe(base?.fingerprint);
  });

  it("returns null outside Git and on caps instead of throwing", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gg-check-coverage-nogit-"));
    try {
      expect(await captureCheckInputs(args({ cwd: outside }))).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
    const handle = await fs.open(path.join(root, "large.bin"), "w");
    await handle.truncate(129 * 1024 * 1024);
    await handle.close();
    expect(await captureCheckInputs(args())).toBeNull();
    // A plan scope that excludes the oversized file still works.
    expect(await captureCheckInputs(args({ gate: rustGate }))).not.toBeNull();
  });

  it("returns null for a covered symlink", async (context) => {
    try {
      await fs.symlink(
        path.join(root, "Cargo.toml"),
        path.join(root, "crates/core/link.toml"),
        "file",
      );
    } catch {
      context.skip();
    }
    expect(await captureCheckInputs(args({ gate: rustGate }))).toBeNull();
  });
});

describe("toRepoRelative and scopeAffectedBy", () => {
  it("normalises Windows paths, drive-letter case and outside-root edits", () => {
    const win = path.win32;
    expect(toRepoRelative("C:\\Repo", "C:\\Repo\\src", "app.ts", win)).toBe("src/app.ts");
    expect(toRepoRelative("C:\\Repo", "D:\\elsewhere", "c:\\repo\\crates\\a.rs", win)).toBe(
      "crates/a.rs",
    );
    expect(toRepoRelative("C:\\Repo", "C:\\Repo", "C:/Repo/src/x.ts", win)).toBe("src/x.ts");
    expect(toRepoRelative("C:\\Repo", "C:\\Repo", "..\\other\\x.ts", win)).toBeNull();
    expect(toRepoRelative("C:\\Repo", "C:\\Repo", "D:\\Repo\\x.ts", win)).toBeNull();
    expect(toRepoRelative("/repo", "/repo/src", "../crates/a.rs", path.posix)).toBe("crates/a.rs");
    expect(toRepoRelative("/repo", "/repo", "/elsewhere/a.rs", path.posix)).toBeNull();
  });

  it("places edits made through an alias of the canonical root", async () => {
    const realRoot = await fs.realpath(root);
    const alias = `${root}-alias`;
    await fs.symlink(realRoot, alias, "junction");
    try {
      expect(toRepoRelative(realRoot, alias, path.join(alias, "crates/core/src/lib.rs"))).toBe(
        "crates/core/src/lib.rs",
      );
      // A file that does not exist yet resolves through its nearest existing ancestor.
      expect(toRepoRelative(realRoot, alias, "src/new-dir/new.ts")).toBe("src/new-dir/new.ts");
      const plan = { kind: "plan" as const, root: realRoot, gateId: "rust", covers: ["crates/**"] };
      expect(scopeAffectedBy(plan, [path.join(alias, "src/app.ts")], alias)).toBe(false);
      expect(scopeAffectedBy(plan, [path.join(alias, "crates/a.rs")], alias)).toBe(true);
      expect(toRepoRelative(realRoot, alias, path.join(os.tmpdir(), "elsewhere.ts"))).toBeNull();
    } finally {
      await fs.unlink(alias);
    }
  });

  it("only plan scopes survive known edits outside their covers", () => {
    const plan = {
      kind: "plan" as const,
      root: "C:\\Repo",
      gateId: "rust-test",
      covers: ["crates/**", "Cargo.toml"],
    };
    const win = path.win32;
    expect(scopeAffectedBy(plan, ["src\\app.ts"], "C:\\Repo", win)).toBe(false);
    expect(scopeAffectedBy(plan, ["crates\\core\\lib.rs"], "C:\\Repo", win)).toBe(true);
    expect(scopeAffectedBy(plan, ["CARGO.TOML"], "c:\\repo", win)).toBe(true);
    expect(scopeAffectedBy(plan, ["..\\outside.rs"], "C:\\Repo", win)).toBe(true);
    expect(scopeAffectedBy(plan, null, "C:\\Repo", win)).toBe(true);
    expect(scopeAffectedBy({ kind: "tree", root: "C:\\Repo" }, [], "C:\\Repo", win)).toBe(true);
  });
});

describe("compileCovers", () => {
  it("supports the contract glob subset and descendants of plain paths", () => {
    const match = compileCovers([
      "crates",
      "src/**/*.rs",
      "*.{toml,lock}",
      "build/?.sh",
      "./docs/",
    ]);
    expect(match("crates")).toBe(true);
    expect(match("crates/core/src/lib.rs")).toBe(true);
    expect(match("cratesx/lib.rs")).toBe(false);
    expect(match("src/lib.rs")).toBe(true);
    expect(match("src/a/b/lib.rs")).toBe(true);
    expect(match("src/a/b/lib.ts")).toBe(false);
    expect(match("Cargo.toml")).toBe(true);
    expect(match("Cargo.lock")).toBe(true);
    expect(match("Cargo.json")).toBe(false);
    expect(match("nested/Cargo.toml")).toBe(false);
    expect(match("build/a.sh")).toBe(true);
    expect(match("build/ab.sh")).toBe(false);
    expect(match("docs/guide.md")).toBe(true);
    expect(compileCovers(["."])("anything/at/all")).toBe(true);
    expect(compileCovers(["a+b(c)"])("a+b(c)/x")).toBe(true);
    expect(compileCovers(["a+b(c)"])("aab(c)")).toBe(false);
  });
});

describe("CheckCoverageMemory", () => {
  it("keeps at most 100 conclusive records, evicting the oldest", () => {
    const memory = new CheckCoverageMemory();
    for (let index = 0; index < 150; index++) {
      memory.remember(record({ fingerprint: `fp-${index}`, executionId: `exec-${index}` }));
    }
    expect(memory.size).toBe(100);
    expect(memory.lookup("fp-49")).toBeNull();
    expect(memory.lookup("fp-50")?.executionId).toBe("exec-50");
    expect(memory.lookup("fp-149")?.executionId).toBe("exec-149");
  });

  it("ignores inconclusive outcomes and lets a later failure replace a pass", () => {
    const memory = new CheckCoverageMemory();
    memory.remember({ ...record(), status: "unknown" as unknown as "passed" });
    expect(memory.lookup("a".repeat(64))).toBeNull();
    memory.remember(record());
    memory.remember(record({ status: "failed", executionId: "exec-2" }));
    expect(memory.lookup("a".repeat(64))).toMatchObject({
      status: "failed",
      executionId: "exec-2",
    });
    memory.clear();
    expect(memory.size).toBe(0);
  });

  it("settles a hand-off only when inputs did not move during the run", async () => {
    const memory = new CheckCoverageMemory();
    const before = await captureCheckInputs(args({ gate: rustGate }));
    if (!before) throw new Error("expected inputs");
    memory.trackHandoff("task-stable", before, args({ gate: rustGate }));
    memory.trackHandoff("task-moved", before, args({ gate: rustGate }));
    expect(await memory.settleHandoff("task-stable")).toMatchObject({
      fingerprint: before.fingerprint,
      scope: { kind: "plan" },
    });
    expect(memory.hasHandoff("task-stable")).toBe(false);
    await fs.writeFile(path.join(root, "crates/core/src/lib.rs"), "pub fn changed() {}\n");
    expect(await memory.settleHandoff("task-moved")).toBeNull();
    expect(await memory.settleHandoff("unknown")).toBeNull();
  });

  it("bounds pending hand-offs at 100", () => {
    const memory = new CheckCoverageMemory({ capture: async () => null });
    const inputs = { fingerprint: "f", contentHash: "h", scope: { kind: "tree" as const, root } };
    for (let index = 0; index < 120; index++) memory.trackHandoff(`t-${index}`, inputs, args());
    expect(memory.hasHandoff("t-19")).toBe(false);
    expect(memory.hasHandoff("t-20")).toBe(true);
  });
});

describe("notices", () => {
  it("prints one line with run, time and execution", () => {
    const current = formatPriorPassNotice(record(), true);
    expect(current).toBe(
      "[Same check passed with identical inputs in run 3 at 2026-10-30T01:12:04Z (exec exec-1); it is still current evidence, so this re-run is optional.]",
    );
    const stale = formatPriorPassNotice(record({ executionId: "a\nb" }), false);
    expect(stale).not.toContain("\n");
    expect(stale).toContain("this run records fresh evidence");
  });

  it("labels project-reported passes and caps the list", () => {
    const plan: VerifyPlan = {
      version: 1,
      mode: "changed",
      gates: [],
      advice: Array.from({ length: 7 }, (_, index) => ({
        gateId: `gate-${index}`,
        kind: "reused-pass" as const,
        reason: "unchanged",
        lastRun: index === 0 ? "2026-10-30T00:00:00Z" : null,
      })),
    };
    const line = formatProjectReportedPasses(plan);
    expect(line).toBe(
      "[Passes reused by the project: gate-0 (last run 2026-10-30T00:00:00Z), gate-1, gate-2, gate-3, gate-4 +2 more; reported by the project, not harness evidence.]",
    );
    expect(formatProjectReportedPasses({ ...plan, advice: [] })).toBeNull();
    expect(formatProjectReportedPasses(null)).toBeNull();
  });
});
