import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSmokeLifecycle, validateNativeSmokeEvidence, trackOwnedProcess, waitForLiveProcess } from "./programmatic-smoke-lifecycle.mjs";

const child = () => Object.assign(new EventEmitter(), { pid: 41, exitCode: null, signalCode: null });
const processInfo = (pid, ppid, startedAtMs) => ({ pid, ppid, startedAtMs, rssBytes: 0 });
const audits = [];
afterEach(() => {
  vi.useRealTimers();
  for (const audit of audits.splice(0)) rmSync(audit, { recursive: true, force: true });
});

function smokeFixture() {
  const audit = mkdtempSync(join(tmpdir(), "gg-smoke-finalization-test-"));
  audits.push(audit);
  const nativeEvidence = JSON.stringify({ samples: [
    "native-ready", "approved-scanned-selected", "task-awaiting-separate-approval",
    "read-only-task-completed", "scenario-rescanned", "before-cleanup",
  ].map((boundary) => ({ boundary, verified: true, minimized: true })) });
  writeFileSync(join(audit, "native-minimized.json"), nativeEvidence);
  writeFileSync(join(audit, "developer.log"), "original developer diagnostics\n");
  const options = {
    audit,
    workflow: vi.fn(async () => ({ passed: true, minimized: false })),
    beforeCleanup: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    validate: vi.fn((result) => validateNativeSmokeEvidence(audit, result, {})),
  };
  const failure = () => {
    expect(existsSync(join(audit, "result.json"))).toBe(false);
    expect(options.cleanup).toHaveBeenCalledTimes(1);
    expect(options.beforeCleanup).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(audit, "developer.log"), "utf8")).toBe("original developer diagnostics\n");
    return JSON.parse(readFileSync(join(audit, "failure.json"), "utf8"));
  };
  return { audit, options, failure, nativeEvidence };
}

it("requires extended native boundaries and rejects normal-window fallback", () => {
  const { audit, nativeEvidence } = smokeFixture();
  expect(() => validateNativeSmokeEvidence(audit, {}, { extendedWorkflow: true })).toThrow(/ordered native/);
  const evidence = JSON.parse(nativeEvidence);
  evidence.samples.splice(-1, 0, ...["extended-advice-settled", "extended-run-settled"].map((boundary) => ({ boundary, verified: true, minimized: true })));
  writeFileSync(join(audit, "native-minimized.json"), JSON.stringify(evidence));
  const result = {};
  validateNativeSmokeEvidence(audit, result, { extendedWorkflow: true });
  expect(result.minimized).toBe(true);
  expect(() => validateNativeSmokeEvidence(audit, {}, { extendedWorkflow: true, allowNormalWindow: true })).toThrow(/forbids normal-window/);
});

it("publishes final ordered native-verdict failure, not success, without rewriting native diagnostics", async () => {
  const { audit, options, failure } = smokeFixture();
  const original = JSON.stringify({ samples: [{ boundary: "native-ready", verified: true, minimized: true }] });
  writeFileSync(join(audit, "native-minimized.json"), original);
  let verdictError;
  options.validate.mockImplementation((result) => {
    try { validateNativeSmokeEvidence(audit, result, {}); }
    catch (error) { verdictError = error; throw error; }
  });
  const thrown = await runSmokeLifecycle(options).catch((error) => error);
  expect(thrown).toBe(verdictError);
  expect(thrown.message).toContain("All ordered native scenario boundaries observed");
  expect(options.workflow).toHaveReturned();
  const report = failure();
  expect(report.errors[0]).toMatchObject({ stage: "native-verdict", error: expect.stringContaining("All ordered native scenario boundaries observed") });
  expect(readFileSync(join(audit, "native-minimized.json"), "utf8")).toBe(original);
  expect(verdictError.code).toBe("ERR_ASSERTION");
});

it("publishes malformed final evidence errors without altering the evidence", async () => {
  const { audit, options, failure } = smokeFixture();
  writeFileSync(join(audit, "native-minimized.json"), "{invalid evidence");
  await expect(runSmokeLifecycle(options)).rejects.toBeInstanceOf(SyntaxError);
  expect(failure().errors[0].stage).toBe("native-verdict");
  expect(readFileSync(join(audit, "native-minimized.json"), "utf8")).toBe("{invalid evidence");
});

it("records result-publication failure without exposing a successful result", async () => {
  const { options, failure } = smokeFixture();
  const circular = { passed: true };
  circular.self = circular;
  options.workflow.mockResolvedValue(circular);
  await expect(runSmokeLifecycle(options)).rejects.toThrow("circular");
  expect(failure().errors[0].stage).toBe("result-publication");
});

it.each(["before-cleanup", "cleanup", "both"])("retains %s failure after a successful workflow", async (stage) => {
  const { options, failure } = smokeFixture();
  const observationError = new Error("before-cleanup observation failed");
  const cleanupError = new Error("owned cleanup denied");
  if (stage !== "cleanup") options.beforeCleanup.mockRejectedValue(observationError);
  if (stage !== "before-cleanup") options.cleanup.mockRejectedValue(cleanupError);
  const thrown = await runSmokeLifecycle(options).catch((error) => error);
  expect(options.workflow).toHaveReturned();
  expect(options.validate).not.toHaveBeenCalled();
  const expected = stage === "both" ? [observationError, cleanupError] : [stage === "cleanup" ? cleanupError : observationError];
  if (stage === "both") expect(thrown.errors).toEqual(expected);
  else expect(thrown).toBe(expected[0]);
  expect(failure().errors.map((entry) => entry.error)).toEqual(expected.map((error) => error.message));
});

it("preserves the original workflow error and all later observation and cleanup errors", async () => {
  const { options, failure } = smokeFixture();
  const workflowError = new Error("workflow failed first");
  const observationError = new Error("observation failed too");
  const cleanupErrors = [new Error("first owner failed"), new Error("second owner failed")];
  const cleanupError = new AggregateError(cleanupErrors, "Fixture cleanup failed");
  options.workflow.mockRejectedValue(workflowError);
  options.beforeCleanup.mockRejectedValue(observationError);
  options.cleanup.mockRejectedValue(cleanupError);
  options.diagnose = async () => { throw new Error("diagnostic collection failed"); };
  const thrown = await runSmokeLifecycle(options).catch((error) => error);
  expect(thrown.errors).toEqual([workflowError, observationError, cleanupError]);
  expect(thrown.errors[2].errors).toEqual(cleanupErrors);
  expect(failure()).toMatchObject({ error: workflowError.message, errors: [
    { stage: "workflow", error: workflowError.message },
    { stage: "before-cleanup", error: observationError.message },
    { stage: "cleanup", error: cleanupError.message },
    ...cleanupErrors.map((error) => ({ stage: "cleanup", error: error.message })),
  ] });
});

it("bounds aggregate summaries without truncating the thrown original errors", async () => {
  const { options, failure } = smokeFixture();
  const original = new AggregateError(Array.from({ length: 100 }, () => new Error("x".repeat(10_000))), "many failures");
  options.cleanup.mockRejectedValue(original);
  await expect(runSmokeLifecycle(options)).rejects.toBe(original);
  const report = failure();
  expect(report.truncated).toBe(true);
  expect(report.errors).toHaveLength(32);
  expect(report.errors.every((entry) => entry.error.length <= 2048)).toBe(true);
  expect(original.errors).toHaveLength(100);
  expect(original.errors[0].message).toHaveLength(10_000);
});

it("does not mask the original error when failure publication itself fails or overwrite existing diagnostics", async () => {
  const { audit, options, failure } = smokeFixture();
  const original = new Error("original workflow failure");
  options.workflow.mockRejectedValue(original);
  writeFileSync(join(audit, "failure.json"), '{"error":"original retained artifact"}');
  const thrown = await runSmokeLifecycle(options).catch((error) => error);
  expect(thrown.errors[0]).toBe(original);
  expect(thrown.errors[1].code).toBe("EEXIST");
  expect(failure()).toEqual({ error: "original retained artifact" });
});

it("publishes success only after cleanup and the real final native validator pass", async () => {
  const { audit, options, nativeEvidence } = smokeFixture();
  options.validate.mockImplementation((result) => {
    expect(options.cleanup).toHaveBeenCalledTimes(1);
    expect(existsSync(join(audit, "result.json"))).toBe(false);
    validateNativeSmokeEvidence(audit, result, {});
  });
  const result = await runSmokeLifecycle(options);
  expect(result).toEqual({ passed: true, minimized: true, normalWindowFallback: false });
  expect(JSON.parse(readFileSync(join(audit, "result.json"), "utf8"))).toEqual(result);
  expect(existsSync(join(audit, "failure.json"))).toBe(false);
  expect(readFileSync(join(audit, "native-minimized.json"), "utf8")).toBe(nativeEvidence);
});

it("retains exited-root descendants, discovers their children, and refuses reused PIDs", async () => {
  const owner = child();
  let table = [processInfo(41, 1, 100), processInfo(42, 41, 101)];
  const terminated = [];
  const tracker = trackOwnedProcess(owner, { read: async () => table, terminate: async (identity) => {
    terminated.push(identity.pid);
    table = table.filter((entry) => entry.pid !== identity.pid);
  } });
  await tracker.observe();
  owner.exitCode = 0;
  table = [processInfo(41, 1, 200), processInfo(42, 41, 101), processInfo(43, 42, 102), processInfo(99, 41, 201)];
  await tracker.observe();
  const report = await tracker.cleanup();
  expect(report.stopped).toBe(true);
  expect(report.identities).toEqual([{ pid: 41, startedAtMs: 100 }, { pid: 42, startedAtMs: 101 }, { pid: 43, startedAtMs: 102 }]);
  expect(terminated).toEqual([42, 43]);
  expect(table.map((entry) => entry.pid)).toEqual([41, 99]);
});

it("does not certify an empty first snapshot or erase observation errors", async () => {
  const owner = child();
  owner.exitCode = 1;
  const tracker = trackOwnedProcess(owner, { read: async () => [] });
  const report = await tracker.cleanup();
  expect(report.stopped).toBe(false);
  expect(report.errors.join(" ")).toContain("empty snapshot cannot prove cleanup");
});

it("preserves termination failures and survivors in bounded evidence", async () => {
  vi.useFakeTimers();
  const tracker = trackOwnedProcess(child(), { read: async () => [processInfo(41, 1, 100)], terminate: async () => { throw new Error("denied"); } });
  const done = tracker.cleanup();
  await vi.advanceTimersByTimeAsync(10_100);
  const report = await done;
  expect(report).toMatchObject({ stopped: false, survivors: [41] });
  expect(report.errors).toContain("denied");
  expect(vi.getTimerCount()).toBe(0);
});

it("lets a live build exceed five minutes and removes its listeners", async () => {
  vi.useFakeTimers();
  const owner = child();
  const start = Date.now();
  const done = waitForLiveProcess(owner, "compile", async () => Date.now() - start > 301_000 && "ready");
  await vi.advanceTimersByTimeAsync(302_000);
  expect(await done).toBe("ready");
  expect(owner.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("fails on real launcher exit even when a readiness probe never settles", async () => {
  const owner = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  await expect(waitForLiveProcess(owner, "compile", () => new Promise(() => {}))).rejects.toThrow("launcher exited (7)");
  expect(owner.listenerCount("exit")).toBe(0);
  expect(owner.listenerCount("error")).toBe(0);
});

it("fails on real spawn error and already signaled exit", async () => {
  const owner = spawn("gg-nonexistent-fixture-executable", [], { stdio: "ignore" });
  await expect(waitForLiveProcess(owner, "compile", async () => false)).rejects.toThrow("ENOENT");
  const signaled = child();
  signaled.signalCode = "SIGTERM";
  await expect(waitForLiveProcess(signaled, "compile", async () => false)).rejects.toThrow("SIGTERM");
});
