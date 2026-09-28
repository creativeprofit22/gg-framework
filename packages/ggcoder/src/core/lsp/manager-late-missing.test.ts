import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LspManager, LspManagerOptions } from "./manager.js";
import { type LspClientPool, missingBinaryEvidence } from "./pool.js";
import type { LspServerSpec } from "./servers.js";
import { createManagerHarness, fakeServerSpec, type ManagerHarness } from "./test-support.js";

const RUSTUP_MISSING =
  "error: Unknown binary 'rust-analyzer.exe' in official toolchain 'stable-x86_64-pc-windows-msvc'.";

let harness: ManagerHarness;
let pool: LspClientPool;

beforeEach(async () => {
  harness = await createManagerHarness("gg-late-missing-");
  pool = harness.pool;
});
afterEach(() => harness.cleanup());

function fakeServer(args: string[]): LspServerSpec {
  return fakeServerSpec("late-fake", args);
}

function manager(spec: LspServerSpec, options: LspManagerOptions = {}): LspManager {
  return harness.manager(spec, { firstBudgetMs: 150, warmBudgetMs: 150, ...options });
}

describe("late diagnostics after the budget", () => {
  it("uses a result that arrives shortly after the budget instead of reporting a timeout", async () => {
    const lsp = manager(fakeServer(["--delay-ms=500"]), { lateGraceMs: 3000 });

    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR introduced\n");
    await lsp.flushDiagnostics();

    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("diagnostics");
    const notice = lsp.drainDiagnostics();
    expect(notice).toContain("fake error");
    expect(notice).not.toContain("not verified");
  });

  it("reports a late clean answer as clean, with no not-verified nag", async () => {
    const lsp = manager(fakeServer(["--delay-ms=500"]), { lateGraceMs: 3000 });

    lsp.queueDiagnosticsAfterWrite("a.fake", "all good\n");
    await lsp.flushDiagnostics();

    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("clean");
    expect(lsp.drainDiagnostics()).toBe("");
  });

  it("keeps the honest not-verified warning when the server never answers", async () => {
    const lsp = manager(fakeServer(["--silent"]), { lateGraceMs: 300 });

    const startedAt = Date.now();
    lsp.queueDiagnosticsAfterWrite("a.fake", "all good\n");
    await lsp.flushDiagnostics();

    // Bounded: budget plus grace, then give up.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("timeout");
    expect(lsp.drainDiagnostics()).toContain("a.fake: diagnostics timeout; not verified");
  });

  it("keeps the honest not-verified warning when the server crashes", async () => {
    const lsp = manager(fakeServer(["--crash-on-open"]), {
      firstBudgetMs: 2000,
      lateGraceMs: 1000,
    });

    lsp.queueDiagnosticsAfterWrite("a.fake", "all good\n");
    await lsp.flushDiagnostics();

    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("server_failed");
    expect(lsp.drainDiagnostics()).toContain("diagnostics server_failed; not verified");
  });

  it("keeps the blocking diagnostics path bounded by the plain budget", async () => {
    const lsp = manager(fakeServer(["--delay-ms=500"]), { lateGraceMs: 3000 });

    const outcome = await lsp.diagnosticsAfterWriteDetailed("a.fake", "ERROR x\n");

    expect(outcome.kind).toBe("timeout");
  });
});

describe("missing language-server binary", () => {
  function missingRustAnalyzer(counter: { spawns: number }): LspServerSpec {
    return {
      id: "rust",
      extensions: [".fake"],
      rootMarkers: ["fake-root.json"],
      languageIdFor: () => "rust",
      installHint: "Install it with `rustup component add rust-analyzer`, then restart GG Coder.",
      resolveCommand: () => {
        counter.spawns += 1;
        // What rustup's proxy does when the component is not installed.
        return {
          command: process.execPath,
          args: [
            "-e",
            `process.stderr.write(${JSON.stringify(`${RUSTUP_MISSING}\n`)}); process.exit(1);`,
          ],
        };
      },
    };
  }

  it("recognises rustup and ENOENT evidence but not ordinary crashes", () => {
    expect(missingBinaryEvidence(undefined, RUSTUP_MISSING)).toContain("Unknown binary");
    expect(missingBinaryEvidence("ENOENT", "")).toContain("ENOENT");
    expect(missingBinaryEvidence(undefined, "panicked at src/main.rs")).toBeNull();
  });

  it("reports once per session with the install hint and never respawns", async () => {
    const counter = { spawns: 0 };
    const spec = missingRustAnalyzer(counter);
    const lsp = manager(spec, { firstBudgetMs: 3000, lateGraceMs: 0 });

    expect(lsp.queueDiagnosticsAfterWrite("a.fake", "x\n")).toContain("Diagnostics queued");
    await lsp.flushDiagnostics();
    const first = lsp.drainDiagnostics();
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("server_missing");
    expect(first).toContain("rust language server is not installed");
    expect(first).toContain("rustup component add rust-analyzer");
    expect(first).not.toContain("server_failed");

    // Later edits in the same session: no queue notice, no repeated nag.
    expect(lsp.queueDiagnosticsAfterWrite("b.fake", "y\n")).toBe("");
    expect(lsp.queueDiagnosticsAfterWrite("a.fake", "z\n")).toBe("");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics()).toBe("");

    // Idle sweeps and a brand-new session still do not respawn the binary.
    pool.sweepNow(Date.now() + 24 * 60 * 60 * 1000);
    const second = manager(spec, { firstBudgetMs: 3000, lateGraceMs: 0 });
    second.queueDiagnosticsAfterWrite("a.fake", "x\n");
    await second.flushDiagnostics();
    expect(second.drainDiagnostics()).toContain("rustup component add rust-analyzer");
    expect(counter.spawns).toBe(1);
  });

  it("delivers the hint once and stops re-queuing even when checks had already passed", async () => {
    const counter = { spawns: 0 };
    const lsp = manager(missingRustAnalyzer(counter), { firstBudgetMs: 3000, lateGraceMs: 0 });

    expect(lsp.queueDiagnosticsAfterWrite("a.fake", "x\n")).toContain("Diagnostics queued");
    await lsp.flushDiagnostics();
    // Verification evidence already passed: unverified nags are suppressed,
    // but install guidance is not a nag.
    const drains = [lsp.drainDiagnostics(false)];

    expect(lsp.queueDiagnosticsAfterWrite("b.fake", "y\n")).toBe("");
    expect(lsp.queueDiagnosticsAfterWrite("a.fake", "z\n")).toBe("");
    await lsp.flushDiagnostics();
    drains.push(lsp.drainDiagnostics(false), lsp.drainDiagnostics(true), lsp.drainDiagnostics());

    const hints = drains.join("\n").match(/rustup component add rust-analyzer/g) ?? [];
    expect(hints).toHaveLength(1);
    expect(drains[0]).toContain("rust language server is not installed");
    expect(counter.spawns).toBe(1);
  });

  it("reports the hint once on the blocking (terminal) path too", async () => {
    const counter = { spawns: 0 };
    const lsp = manager(missingRustAnalyzer(counter), { firstBudgetMs: 3000, lateGraceMs: 0 });

    const first = await lsp.diagnosticsAfterWrite("a.fake", "x\n");
    expect(first).toContain("a.fake: the rust language server is not installed");
    expect(first).toContain("rustup component add rust-analyzer");
    expect(await lsp.diagnosticsAfterWrite("b.fake", "y\n")).toBe("");
    // The later drain must not repeat it either.
    expect(lsp.drainDiagnostics()).not.toContain("rustup component add rust-analyzer");
    expect(counter.spawns).toBe(1);
  });

  it("still delivers the hint once when the first missing outcome was cancelled", async () => {
    const counter = { spawns: 0 };
    const lsp = manager(missingRustAnalyzer(counter), { firstBudgetMs: 3000, lateGraceMs: 0 });

    lsp.queueDiagnosticsAfterWrite("a.fake", "x\n");
    await lsp.flushDiagnostics();
    lsp.clearPendingDiagnostics();

    expect(lsp.queueDiagnosticsAfterWrite("a.fake", "y\n")).toBe("");
    const drains = [lsp.drainDiagnostics(false), lsp.drainDiagnostics()];
    const hints = drains.join("\n").match(/rustup component add rust-analyzer/g) ?? [];
    expect(hints).toHaveLength(1);
  });

  it("explains the missing server to navigation instead of reporting a crash", async () => {
    const counter = { spawns: 0 };
    const lsp = manager(missingRustAnalyzer(counter), { firstBudgetMs: 3000 });

    const outcome = await lsp.hover("a.fake", "x\n", { line: 0, character: 0 });

    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind !== "ok" && outcome.message).toContain(
      "rustup component add rust-analyzer",
    );
  });
});
