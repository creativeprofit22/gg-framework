import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { spawnSync } from "node:child_process";

import { closeLogger, openLog } from "@kenkaiiii/gg-core";

import { LspManager } from "./manager.js";
import { removeWhenReleased } from "./test-support.js";
import { normalizeUri } from "./client.js";
import { LSP_SERVER_CATALOG, findExecutable, serverForFile } from "./servers.js";

/**
 * REAL Windows LSP diagnostics — runs only on an actual Windows host (the CI
 * `windows-latest` matrix leg), skipped everywhere else.
 *
 * Unlike `integration.test.ts` (opt-in, npm-installs its own server), this uses
 * the `typescript-language-server` + `typescript` that ship as ggcoder
 * dependencies, so it runs unattended on CI with no network.
 *
 * Why a Windows-specific test: diagnostics are cached in a Map keyed by
 * `file://` URI, so our string and the server's must match EXACTLY. Two Windows
 * facts break that, and BOTH had to be fixed (see `normalizeUri` and
 * `canonicalPath` in client.ts): the drive letter's case, and the fact that
 * TypeScript realpaths every path it loads — which on Windows expands 8.3 short
 * names, so `C:\Users\RUNNER~1\…` (exactly what CI's TEMP is) comes back as
 * `C:\Users\runneradmin\…`. Neither is reproducible on a POSIX host.
 *
 * This is the regression guard for both. If it ever returns "" again, inline
 * diagnostics have silently stopped working for every Windows user.
 */
describe.skipIf(process.platform !== "win32")("LSP diagnostics on a real C:\\ path", () => {
  let tmpDir: string;
  let manager: LspManager;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-lsp-win-"));
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
        },
        include: ["src"],
      }),
    );
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    // First touch is slow (server boot + project load); budget generously so a
    // cold CI runner reports a real result instead of a timeout.
    manager = new LspManager(tmpDir, { firstBudgetMs: 60_000, warmBudgetMs: 20_000 });
  });

  afterAll(async () => {
    manager?.shutdownAll();
    // Windows won't rmdir while the server still holds handles; retry instead
    // of failing the suite in teardown after every assertion has passed.
    await removeWhenReleased(tmpDir);
  });

  it("resolves the language server AND spawns it successfully", () => {
    // Resolving the file is not the same as being able to RUN it: on Windows
    // `findExecutable` happily returns a `.cmd` shim that Node then refuses to
    // spawn (EINVAL, post-CVE-2024-27980). So assert on the command we would
    // actually execute, and prove it starts.
    expect(tmpDir).toMatch(/^[A-Za-z]:\\/);
    expect(findExecutable("typescript-language-server", tmpDir)).not.toBeNull();

    const spec = serverForFile(path.join(tmpDir, "src", "main.ts"), LSP_SERVER_CATALOG);
    expect(spec).not.toBeNull();
    const resolved = spec!.resolveCommand(tmpDir);
    expect(resolved).not.toBeNull();

    // A Node-based server must run via process.execPath + a real script, never
    // a shim — that is the rule this repo already documents for LSP + MCP.
    expect(resolved!.command).toBe(process.execPath);
    expect(resolved!.args[0]).toMatch(/\.(m?js|cjs)$/);
    expect(fsSync.existsSync(resolved!.args[0]!)).toBe(true);

    const probe = spawnSync(resolved!.command, [...resolved!.args, "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    expect(probe.error).toBeUndefined();
  }, 90_000);

  it("reports a type error for a file on a drive-letter path, then clears it", async () => {
    const filePath = path.join(tmpDir, "src", "main.ts");

    const ours = pathToFileURL(filePath).href;
    expect(ours).toMatch(/^file:\/\/\/[A-Za-z]:/);
    expect(normalizeUri(ours)).toMatch(/^file:\/\/\/[a-z]:/);

    const broken = 'export const n: number = "not a number";\n';
    await fs.writeFile(filePath, broken);

    // Use the DETAILED outcome, not the string wrapper. `diagnosticsAfterWrite`
    // collapses timeout / unavailable / server_failed / clean all to "", which
    // is exactly why this failure was uninformative: the assertion could only
    // ever say 'expected "" to contain ...'. The outcome kind names the cause,
    // so a CI log tells us WHICH of those it is instead of us guessing.
    const outcome = await manager.diagnosticsAfterWriteDetailed(filePath, broken);
    expect(outcome.kind).toBe("diagnostics");
    expect(outcome.kind === "diagnostics" && outcome.formatted).toMatch(
      /not assignable to type 'number'/,
    );

    const fixed = "export const n: number = 42;\n";
    await fs.writeFile(filePath, fixed);
    expect(await manager.diagnosticsAfterWrite(filePath, fixed)).toBe("");
  }, 120_000);

  it("reports diagnostics for a path containing a space", async () => {
    // `C:\Users\<name>\…` and `C:\Program Files\…` routinely contain spaces,
    // which percent-encode in a file:// URI — another way the two sides can
    // disagree about the same file.
    const dir = path.join(tmpDir, "src", "with space");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "spaced.ts");

    const broken = "export const s: string = 123;\n";
    await fs.writeFile(filePath, broken);
    const outcome = await manager.diagnosticsAfterWriteDetailed(filePath, broken);
    expect(outcome.kind).toBe("diagnostics");
    expect(outcome.kind === "diagnostics" && outcome.formatted).toMatch(
      /not assignable to type 'string'/,
    );
  }, 120_000);
});

/**
 * Isolates WHY Windows diagnostics time out, by changing exactly one variable.
 *
 * The suite above uses a bare project with no local `typescript`, so
 * `resolveCommand` takes the BUNDLED-tsserver fallback and passes ggcoder's own
 * copy via `initializationOptions.tsserver.path`. On Windows that timed out
 * (measured: the full 60s budget) even though the language server resolves to
 * `process.execPath` + a real script and starts in ~100ms — so the failure is
 * downstream of spawning, and `initialize` itself succeeded (a failure there
 * would surface as `server_failed`, not `timeout`).
 *
 * The one remaining difference from a real user's project is that local
 * `typescript`. Give the project its own copy — a junction, which needs no
 * privileges on Windows — and the two outcomes are diagnostic:
 *
 *   passes here + times out above → the bundled-tsserver fallback is the bug,
 *     and it hits real users whose project has no local typescript.
 *   times out here too            → tsserver itself can't produce diagnostics
 *     in this environment, and the fallback is exonerated.
 *
 * Runs on POSIX too (symlink), where it must pass — that keeps the control arm
 * honest instead of only ever observing the broken platform.
 */
describe("LSP diagnostics with the project's OWN typescript (control arm)", () => {
  let tmpDir: string;
  let manager: LspManager | undefined;
  let linked = false;
  let traceLog = "";
  let traceOpen = false;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-lsp-own-ts-"));

    // Turn on JSON-RPC wire tracing and give it somewhere to land. The tracer
    // writes via the shared debug logger, which DISCARDS everything until a log
    // file is open (`fd === null` → return), so without this the trace would
    // silently produce nothing — the same class of silent-degradation that made
    // this bug hard in the first place.
    process.env.GG_LSP_TRACE = "1";
    traceLog = path.join(tmpDir, "lsp-trace.log");
    traceOpen = openLog(traceLog, "ggcoder-test");
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
        },
        include: ["src"],
      }),
    );
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });

    // Link ggcoder's own typescript in as if the project installed it.
    const ours = findUpNodeModulesDir("typescript");
    if (ours) {
      await fs.mkdir(path.join(tmpDir, "node_modules"), { recursive: true });
      await fs.symlink(ours, path.join(tmpDir, "node_modules", "typescript"), "junction");
      linked = true;
    }
    manager = new LspManager(tmpDir, { firstBudgetMs: 60_000, warmBudgetMs: 20_000 });
  });

  afterAll(async () => {
    manager?.shutdownAll();
    delete process.env.GG_LSP_TRACE;
    if (traceOpen) closeLogger();
    await removeWhenReleased(tmpDir);
  });

  it("produces diagnostics when typescript is resolvable inside the project", async () => {
    expect(linked).toBe(true);
    // Prove we are NOT on the bundled-tsserver code path any more.
    expect(
      fsSync.existsSync(path.join(tmpDir, "node_modules", "typescript", "lib", "tsserver.js")),
    ).toBe(true);

    const filePath = path.join(tmpDir, "src", "main.ts");
    const broken = 'export const n: number = "not a number";\n';
    await fs.writeFile(filePath, broken);

    const started = Date.now();
    const outcome = await manager!.diagnosticsAfterWriteDetailed(filePath, broken);
    // Everything the CI log needs to name the cause without another round-trip:
    // the outcome kind, the server's own stderr (previously discarded), and the
    // JSON-RPC wire — which is the only thing that distinguishes "our didOpen
    // never went out" from "the server never answered" from "it answered about
    // a URI we weren't watching".

    console.log(
      `[control arm] outcome=${outcome.kind} in ${Date.now() - started}ms\n` +
        `[control arm] server stderr: ${(await serverStderr(manager!)) || "(none)"}\n` +
        `[control arm] wire:\n${readTrace(traceLog, traceOpen)}`,
    );

    expect(outcome.kind).toBe("diagnostics");
    expect(outcome.kind === "diagnostics" && outcome.formatted).toMatch(
      /not assignable to type 'number'/,
    );
  }, 120_000);
});

/**
 * The JSON-RPC trace for this run, trimmed to the LSP lines and capped so a
 * chatty server can't bury the CI log.
 */
function readTrace(traceLog: string, traceOpen: boolean): string {
  if (!traceOpen) return "(trace log unavailable — a logger was already open)";
  let raw: string;
  try {
    raw = fsSync.readFileSync(traceLog, "utf8");
  } catch {
    return "(trace log unreadable)";
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.includes("[lsp]"));
  if (lines.length === 0) return "(no rpc lines — tracer never fired)";
  const head = lines.slice(0, 40);
  const tail = lines.length > 60 ? lines.slice(-20) : [];
  return [...head, ...(tail.length ? [`  … ${lines.length - 60} more …`] : []), ...tail].join("\n");
}

/**
 * The pooled client's retained stderr, for the log line above. Reaches into the
 * private pool deliberately: this is a diagnostic probe, and widening the public
 * API just to print stderr in one test isn't worth the surface area.
 */
async function serverStderr(manager: LspManager): Promise<string> {
  // The pool stores PROMISES of resolutions, so these must be awaited — reading
  // `.client` off the promise itself silently yields nothing.
  const clients = (manager as unknown as { clients: Map<string, Promise<unknown>> }).clients;
  for (const [, pending] of clients) {
    const resolution = (await pending) as { client?: { stderrTail(): string } };
    if (resolution?.client) return resolution.client.stderrTail();
  }
  return "";
}

/** Nearest `node_modules/<name>` walking up from this test file. */
function findUpNodeModulesDir(name: string): string | null {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  if (process.platform === "win32" && /^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fsSync.existsSync(candidate)) return fsSync.realpathSync.native(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
