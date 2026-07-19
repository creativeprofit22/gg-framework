import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../core/process-manager.js";
import { resolveShell } from "../core/shell.js";
import { killProcessTree } from "../utils/process.js";
import { createBashTool, executeForegroundCommand } from "./bash.js";
import { localOperations, type ToolOperations } from "./operations.js";

type ProbeName = "cpu" | "silent" | "nested";

interface FixtureEvidence {
  role: string;
  pid: number;
  ppid: number;
}

type SupervisorOutcome = "child_closed" | "child_error" | "hard_deadline";

interface SupervisedProbeResult {
  probe: ProbeName;
  childPid: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  outerDeadlineFired: boolean;
  supervisorOutcome: SupervisorOutcome;
  roles: FixtureEvidence[];
  timeoutLine: string | null;
  outputTail: string;
}

interface SupervisionOptions {
  deadlineMs?: number;
  postTerminationDeadlineMs?: number;
  childArguments?: string[];
  terminate?: (pid: number) => void;
}

const PROBE_ENV = "GG_BASH_TIMEOUT_PROBE";
const EVIDENCE_ENV = "GG_BASH_TIMEOUT_EVIDENCE_FILE";
const SUPERVISOR_DEADLINE_MS = 12_000;
const POST_TERMINATION_DEADLINE_MS = 2_000;
const MAX_OUTPUT_TAIL = 32 * 1024;
const TEST_FILE = fileURLToPath(import.meta.url);
const VITEST_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
  "vitest.mjs",
);

function quotePathForShell(value: string, isCmdFallback: boolean): string {
  return isCmdFallback ? `"${value}"` : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  return (current + chunk.toString("utf8")).slice(-MAX_OUTPUT_TAIL);
}

async function readFixtureEvidence(evidenceFile: string): Promise<FixtureEvidence[]> {
  const text = await fs.readFile(evidenceFile, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as Partial<FixtureEvidence>;
        return typeof value.role === "string" &&
          Number.isInteger(value.pid) &&
          Number.isInteger(value.ppid)
          ? [value as FixtureEvidence]
          : [];
      } catch {
        return [];
      }
    });
}

function terminateSupervisedTree(pid: number): void {
  killProcessTree(pid);
}

async function superviseProbe(
  probe: ProbeName,
  evidenceFile: string,
  options: SupervisionOptions = {},
): Promise<SupervisedProbeResult> {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    options.childArguments ?? [VITEST_ENTRY, "run", TEST_FILE, "--reporter=verbose"],
    {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        [PROBE_ENV]: probe,
        [EVIDENCE_ENV]: evidenceFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const childPid = child.pid ?? -1;
  const terminate = options.terminate ?? terminateSupervisedTree;
  const deadlineMs = options.deadlineMs ?? SUPERVISOR_DEADLINE_MS;
  const postTerminationDeadlineMs =
    options.postTerminationDeadlineMs ?? POST_TERMINATION_DEADLINE_MS;
  let outputTail = "";
  let outerDeadlineFired = false;
  let deadline: NodeJS.Timeout | undefined;
  let hardDeadline: NodeJS.Timeout | undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    outputTail = appendBounded(outputTail, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    outputTail = appendBounded(outputTail, chunk);
  });

  const settled = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    supervisorOutcome: SupervisorOutcome;
  }>((resolve) => {
    let resolved = false;
    const settle = (result: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      supervisorOutcome: SupervisorOutcome;
    }): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    child.once("error", () => {
      settle({ exitCode: null, signal: null, supervisorOutcome: "child_error" });
    });
    child.once("close", (exitCode, signal) => {
      settle({ exitCode, signal, supervisorOutcome: "child_closed" });
    });

    deadline = setTimeout(() => {
      outerDeadlineFired = true;
      if (childPid > 0) terminate(childPid);
      hardDeadline = setTimeout(() => {
        if (childPid > 0) terminate(childPid);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle({ exitCode: null, signal: null, supervisorOutcome: "hard_deadline" });
      }, postTerminationDeadlineMs);
    }, deadlineMs);
  });

  const { exitCode, signal, supervisorOutcome } = await settled.finally(() => {
    if (deadline) clearTimeout(deadline);
    if (hardDeadline) clearTimeout(hardDeadline);
  });
  const roles = await readFixtureEvidence(evidenceFile);
  const timeoutLine = outputTail.match(/Exit code: TIMEOUT \(\d+ms\)/)?.[0] ?? null;

  return {
    probe,
    childPid,
    exitCode,
    signal,
    elapsedMs: Date.now() - startedAt,
    outerDeadlineFired,
    supervisorOutcome,
    roles,
    timeoutLine,
    outputTail,
  };
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
}

async function cleanupRecordedPids(evidenceFile: string): Promise<void> {
  const roles = await readFixtureEvidence(evidenceFile);
  for (const { pid } of roles.reverse()) {
    if (isAlive(pid)) terminateSupervisedTree(pid);
  }
}

async function runProbe(probe: ProbeName, evidenceFile: string): Promise<void> {
  const manager = new ProcessManager();
  const fixtureArguments: Record<ProbeName, string[]> = {
    cpu: [process.execPath, fixturePath("bash-timeout-cpu.mjs"), evidenceFile],
    silent: [process.execPath, fixturePath("bash-timeout-silent.mjs"), evidenceFile],
    nested: [
      process.execPath,
      fixturePath("bash-timeout-package-manager-shim.mjs"),
      evidenceFile,
      fixturePath("bash-timeout-launcher.mjs"),
      fixturePath("bash-timeout-worker.mjs"),
    ],
  };
  const { isCmdFallback } = resolveShell("");
  const command = fixtureArguments[probe]
    .map((value) => quotePathForShell(value, isCmdFallback))
    .join(" ");
  const startedAt = Date.now();

  try {
    const result = await createBashTool(process.cwd(), manager).execute(
      { command, timeout: 1_000 },
      { signal: new AbortController().signal, toolCallId: `bash-timeout-${probe}` },
    );
    if (typeof result !== "string") throw new Error("Expected bash timeout text output");
    const elapsedMs = Date.now() - startedAt;
    const roles = await readFixtureEvidence(evidenceFile);
    const timeoutLine = result.match(/Exit code: TIMEOUT \(\d+ms\)/)?.[0] ?? null;

    console.log(
      `PROBE_RESULT=${JSON.stringify({
        probe,
        elapsedMs,
        timeoutLine,
        outputTail: result.slice(-4_096),
      })}`,
    );

    expect(roles.map(({ role }) => role)).toContain(probe === "nested" ? "worker" : probe);
    expect(timeoutLine).toBe("Exit code: TIMEOUT (1000ms)");
    expect(elapsedMs).toBeGreaterThanOrEqual(750);
    expect(elapsedMs).toBeLessThan(10_000);

    if (probe === "cpu") {
      expect(result).toMatch(/FIXTURE_ROLE=cpu PID=\d+ PPID=\d+/);
    }
    if (probe === "silent") {
      expect(result).not.toContain("FIXTURE_ROLE=silent");
    }
    if (probe === "nested") {
      const byRole = new Map(roles.map((role) => [role.role, role]));
      const shim = byRole.get("package-manager-shim");
      const launcher = byRole.get("launcher");
      const worker = byRole.get("worker");
      expect(shim?.ppid).toBeGreaterThan(0);
      expect(launcher?.ppid).toBe(shim?.pid);
      expect(worker?.ppid).toBe(launcher?.pid);
    }
  } finally {
    manager.shutdownAll();
    await cleanupRecordedPids(evidenceFile);
  }
}

async function assertSupervisedProbe(probe: ProbeName): Promise<void> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg bash-timeout 'phase01'-"));
  const evidenceFile = path.join(tempDirectory, `${probe} evidence 'roles'.jsonl`);

  try {
    const result = await superviseProbe(probe, evidenceFile);
    const rootPid =
      probe === "nested"
        ? result.roles.find(({ role }) => role === "package-manager-shim")?.ppid
        : result.roles.find(({ role }) => role === probe)?.ppid;
    console.log(`PHASE01_EVIDENCE=${JSON.stringify({ ...result, rootPid })}`);

    expect(result.roles.map(({ role }) => role)).toContain(probe === "nested" ? "worker" : probe);
    expect(result.elapsedMs).toBeLessThan(
      SUPERVISOR_DEADLINE_MS + POST_TERMINATION_DEADLINE_MS + 3_000,
    );
    expect(result.outerDeadlineFired).toBe(false);
    expect(result.supervisorOutcome).toBe("child_closed");
    expect(result.exitCode).toBe(0);
    expect(result.timeoutLine).toBe("Exit code: TIMEOUT (1000ms)");

    if (probe === "nested") {
      const byRole = new Map(result.roles.map((role) => [role.role, role]));
      expect(rootPid).toBeGreaterThan(0);
      expect(byRole.get("launcher")?.ppid).toBe(byRole.get("package-manager-shim")?.pid);
      expect(byRole.get("worker")?.ppid).toBe(byRole.get("launcher")?.pid);
    }
  } finally {
    await cleanupRecordedPids(evidenceFile);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

interface FakeChildHarness {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  emitClose(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
}

function createFakeChild(pid = 2_000_000_000): FakeChildHarness {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, { pid, stdout, stderr }) as unknown as ChildProcess;
  return {
    child,
    stdout,
    stderr,
    emitClose(code, signal = null) {
      emitter.emit("close", code, signal);
    },
    emitError(error) {
      emitter.emit("error", error);
    },
  };
}

function operationsFor(child: ChildProcess): ToolOperations {
  return { ...localOperations, spawn: () => child };
}

function foregroundExecution(
  fake: FakeChildHarness,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onUpdate?: (output: string, totalBytes: number) => void;
  } = {},
) {
  return executeForegroundCommand({
    command: "fixture command",
    cwd: process.cwd(),
    timeoutMs: options.timeoutMs ?? 5_000,
    signal: options.signal ?? new AbortController().signal,
    ops: operationsFor(fake.child),
    onUpdate: options.onUpdate,
  });
}

async function executeRendered(
  fake: FakeChildHarness,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const tool = createBashTool(process.cwd(), new ProcessManager(), operationsFor(fake.child));
  const result = await tool.execute(
    { command: "fixture command", timeout: options.timeoutMs ?? 5_000 },
    { signal: options.signal ?? new AbortController().signal, toolCallId: "bash-render" },
  );
  if (typeof result !== "string") throw new Error("Expected rendered bash output");
  return result;
}

afterEach(() => {
  vi.useRealTimers();
});

const selectedProbe = process.env[PROBE_ENV];
const knownProbes: ProbeName[] = ["cpu", "silent", "nested"];

if (selectedProbe !== undefined) {
  if (!knownProbes.includes(selectedProbe as ProbeName)) {
    throw new Error(`Unknown ${PROBE_ENV} value: ${selectedProbe}`);
  }
  const evidenceFile = process.env[EVIDENCE_ENV];
  if (!evidenceFile) throw new Error(`${EVIDENCE_ENV} is required for a probe process`);

  it(`runs the ${selectedProbe} timeout probe`, async () => {
    await runProbe(selectedProbe as ProbeName, evidenceFile);
  }, 60_000);
} else {
  describe("foreground execution outcomes", () => {
    it("records completed metadata independently", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const fake = createFakeChild(2_000_000_001);
      const resultPromise = foregroundExecution(fake);
      vi.advanceTimersByTime(25);
      fake.emitClose(0);

      const { outcome } = await resultPromise;
      expect(outcome).toEqual({
        reason: "completed",
        exitCode: 0,
        signal: null,
        startedAt: 10_000,
        elapsedMs: 25,
        pid: 2_000_000_001,
        error: null,
      });
    });

    it("records a numeric non-zero exit", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      const fake = createFakeChild(2_000_000_002);
      const resultPromise = foregroundExecution(fake);
      fake.emitClose(7);

      expect((await resultPromise).outcome).toEqual({
        reason: "nonZeroExit",
        exitCode: 7,
        signal: null,
        startedAt: 20_000,
        elapsedMs: 0,
        pid: 2_000_000_002,
        error: null,
      });
    });

    it("preserves a signal without fabricating an exit code", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      const fake = createFakeChild(2_000_000_003);
      const resultPromise = foregroundExecution(fake);
      fake.emitClose(null, "SIGTERM");

      expect((await resultPromise).outcome).toEqual({
        reason: "nonZeroExit",
        exitCode: null,
        signal: "SIGTERM",
        startedAt: 30_000,
        elapsedMs: 0,
        pid: 2_000_000_003,
        error: null,
      });
    });

    it("keeps the first emitted spawn error when close races afterward", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(40_000);
      const fake = createFakeChild(2_000_000_004);
      const error = new Error("missing executable");
      const resultPromise = foregroundExecution(fake);
      let fulfillmentCount = 0;
      void resultPromise.then(() => fulfillmentCount++);
      fake.emitError(error);
      fake.emitClose(0);
      fake.emitError(new Error("later error"));

      const { outcome } = await resultPromise;
      await Promise.resolve();
      expect(outcome).toEqual({
        reason: "spawnError",
        exitCode: null,
        signal: null,
        startedAt: 40_000,
        elapsedMs: 0,
        pid: 2_000_000_004,
        error,
      });
      expect(fulfillmentCount).toBe(1);
    });

    it.each(["stdout", "stderr"] as const)(
      "ignores %s pipe errors and settles exactly once from child close",
      async (pipe) => {
        vi.useFakeTimers();
        vi.setSystemTime(45_000);
        const fake = createFakeChild(2_000_000_007);
        const resultPromise = foregroundExecution(fake);
        let fulfillmentCount = 0;
        let fulfilled = false;
        void resultPromise.then(() => {
          fulfillmentCount++;
          fulfilled = true;
        });

        fake[pipe].emit("error", new Error(`${pipe} pipe failed`));
        await Promise.resolve();
        expect(fulfilled).toBe(false);

        vi.advanceTimersByTime(15);
        fake.emitClose(0);
        fake.emitClose(9);
        fake.emitError(new Error("later child error"));

        const { outcome } = await resultPromise;
        await Promise.resolve();
        expect(outcome).toEqual({
          reason: "completed",
          exitCode: 0,
          signal: null,
          startedAt: 45_000,
          elapsedMs: 15,
          pid: 2_000_000_007,
          error: null,
        });
        expect(fulfillmentCount).toBe(1);
      },
    );

    it("preserves split UTF-8 characters in per-stream live updates and raw output", async () => {
      const fake = createFakeChild(2_000_000_008);
      const updates: string[] = [];
      const totals: number[] = [];
      const resultPromise = foregroundExecution(fake, {
        onUpdate(output, totalBytes) {
          updates.push(output);
          totals.push(totalBytes);
        },
      });
      const stdout = Buffer.from("stdout: 😀\n");
      const stderr = Buffer.from("stderr: 界\n");
      const stdoutSplit = stdout.indexOf(Buffer.from("😀")) + 2;
      const stderrSplit = stderr.indexOf(Buffer.from("界")) + 1;

      fake.stdout.write(stdout.subarray(0, stdoutSplit));
      fake.stdout.write(stdout.subarray(stdoutSplit));
      fake.stdout.end();
      fake.stderr.write(stderr.subarray(0, stderrSplit));
      fake.stderr.write(stderr.subarray(stderrSplit));
      fake.stderr.end();
      fake.emitClose(0);

      const result = await resultPromise;
      const expectedOutput = "stdout: 😀\nstderr: 界\n";
      expect(updates.join("")).toBe(expectedOutput);
      expect(updates.join("")).not.toContain("�");
      expect(totals.at(-1)).toBe(Buffer.byteLength(expectedOutput));
      expect(result.rawOutput).toBe(expectedOutput);
    });

    it("converts a synchronous spawn throw into a spawn error outcome", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      const error = new Error("spawn threw");
      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        ops: {
          ...localOperations,
          spawn: () => {
            throw error;
          },
        },
      });

      expect((await execution).outcome).toEqual({
        reason: "spawnError",
        exitCode: null,
        signal: null,
        startedAt: 50_000,
        elapsedMs: 0,
        pid: null,
        error,
      });
    });

    it("records abort before close and settles exactly once", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(60_000);
      const controller = new AbortController();
      const fake = createFakeChild(2_000_000_005);
      const resultPromise = foregroundExecution(fake, { signal: controller.signal });
      let fulfillmentCount = 0;
      void resultPromise.then(() => fulfillmentCount++);
      controller.abort();
      vi.advanceTimersByTime(30);
      fake.emitClose(null, "SIGTERM");
      fake.emitClose(0);
      fake.emitError(new Error("later error"));

      const { outcome } = await resultPromise;
      await Promise.resolve();
      expect(outcome).toEqual({
        reason: "aborted",
        exitCode: null,
        signal: "SIGTERM",
        startedAt: 60_000,
        elapsedMs: 30,
        pid: 2_000_000_005,
        error: null,
      });
      expect(fulfillmentCount).toBe(1);
    });

    it("records timeout metadata but waits for close to settle", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(70_000);
      const fake = createFakeChild(2_000_000_006);
      const resultPromise = foregroundExecution(fake, { timeoutMs: 1_250 });
      let fulfillmentCount = 0;
      let fulfilled = false;
      void resultPromise.then(() => {
        fulfillmentCount++;
        fulfilled = true;
      });
      vi.advanceTimersByTime(1_250);
      await Promise.resolve();
      expect(fulfilled).toBe(false);
      vi.advanceTimersByTime(40);
      fake.emitClose(null, "SIGKILL");
      fake.emitError(new Error("later error"));

      const { outcome } = await resultPromise;
      await Promise.resolve();
      expect(outcome).toEqual({
        reason: "timedOut",
        exitCode: null,
        signal: "SIGKILL",
        startedAt: 70_000,
        elapsedMs: 1_290,
        pid: 2_000_000_006,
        error: null,
      });
      expect(fulfillmentCount).toBe(1);
    });
  });

  describe("foreground result rendering", () => {
    it("keeps numeric non-zero rendering", async () => {
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake);
      fake.emitClose(7);
      await expect(resultPromise).resolves.toContain("Exit code: 7");
    });

    it("renders signal-only termination without inventing code 1", async () => {
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake);
      fake.emitClose(null, "SIGTERM");
      await expect(resultPromise).resolves.toContain("Exit code: SIGNAL (SIGTERM)");
    });

    it("renders abort distinctly", async () => {
      const controller = new AbortController();
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake, { signal: controller.signal });
      controller.abort();
      fake.emitClose(null, "SIGTERM");
      await expect(resultPromise).resolves.toContain("Exit code: ABORTED");
    });

    it("keeps configured timeout rendering and close-dependent settlement", async () => {
      vi.useFakeTimers();
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake, { timeoutMs: 1_750 });
      let fulfilled = false;
      void resultPromise.then(() => {
        fulfilled = true;
      });
      vi.advanceTimersByTime(1_750);
      await Promise.resolve();
      expect(fulfilled).toBe(false);
      fake.emitClose(null, "SIGKILL");
      await expect(resultPromise).resolves.toContain("Exit code: TIMEOUT (1750ms)");
    });

    it("keeps the friendly emitted spawn failure message", async () => {
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake);
      fake.emitError(new Error("not found"));
      fake.emitClose(1);
      await expect(resultPromise).resolves.toBe("Exit code: 1\nFailed to spawn: not found");
    });

    it("keeps the friendly synchronous spawn failure message", async () => {
      const tool = createBashTool(process.cwd(), new ProcessManager(), {
        ...localOperations,
        spawn: () => {
          throw new Error("sync not found");
        },
      });
      await expect(
        tool.execute(
          { command: "fixture command" },
          { signal: new AbortController().signal, toolCallId: "bash-sync-spawn" },
        ),
      ).resolves.toBe("Exit code: 1\nFailed to spawn: sync not found");
    });
  });

  it.each(knownProbes)(
    "bounds the %s foreground timeout probe",
    async (probe) => {
      await assertSupervisedProbe(probe);
    },
    20_000,
  );

  it("settles on its own hard deadline when termination cannot close the child", async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg bash-supervisor-"));
    const evidenceFile = path.join(tempDirectory, "non-closing.jsonl");
    const terminationAttempts: number[] = [];
    let childPid = -1;

    try {
      const result = await superviseProbe("silent", evidenceFile, {
        deadlineMs: 100,
        postTerminationDeadlineMs: 150,
        childArguments: [
          "-e",
          'process.stdout.write("SUPERVISOR_FIXTURE_READY\\n"); setInterval(() => {}, 1_000)',
        ],
        terminate(pid) {
          terminationAttempts.push(pid);
        },
      });
      childPid = result.childPid;
      console.log(`PHASE01_EVIDENCE=${JSON.stringify(result)}`);

      expect(result.supervisorOutcome).toBe("hard_deadline");
      expect(result.outerDeadlineFired).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.outputTail).toContain("SUPERVISOR_FIXTURE_READY");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
      expect(result.elapsedMs).toBeLessThan(1_000);
      expect(terminationAttempts).toEqual([result.childPid, result.childPid]);
    } finally {
      if (childPid > 0) terminateSupervisedTree(childPid);
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }, 5_000);
}
