import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processTreeSnapshot, readProcessTable, survivingProcessIds } from "./workspace-shell-evidence.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One publication point, after cleanup and the final verdict. Keep original Error
// objects for the caller; the artifact contains only bounded messages, not stacks.
export async function runSmokeLifecycle({ audit, workflow, diagnose, beforeCleanup, cleanup, validate }) {
  const failures = [];
  const attempt = async (stage, action) => {
    try { return await action(); }
    catch (error) { failures.push({ stage, error }); }
  };
  let diagnostics = {};
  const result = await attempt("workflow", workflow);
  if (failures.length && diagnose) {
    try { diagnostics = await diagnose(); } catch { /* Original failure remains authoritative. */ }
  }
  await attempt("before-cleanup", beforeCleanup);
  await attempt("cleanup", cleanup);
  if (!failures.length) await attempt("native-verdict", () => validate(result));
  if (!failures.length) await attempt("result-publication", () => {
    const stagedResult = join(audit, "result.pending.json");
    writeFileSync(stagedResult, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    renameSync(stagedResult, join(audit, "result.json"));
  });
  if (!failures.length) return result;

  const errors = [];
  let truncated = false;
  const summarize = (stage, error, depth = 0) => {
    if (errors.length >= 32 || depth > 4) { truncated = true; return; }
    const message = error instanceof Error ? error.message : String(error);
    truncated ||= message.length > 2048;
    errors.push({ stage, error: message.slice(0, 2048) });
    if (error instanceof AggregateError) {
      for (const nested of error.errors) {
        if (errors.length >= 32) { truncated = true; break; }
        summarize(stage, nested, depth + 1);
      }
    }
  };
  for (const { stage, error } of failures) summarize(stage, error);
  try {
    writeFileSync(join(audit, "failure.json"), `${JSON.stringify({ ...diagnostics, error: errors[0].error, errors, truncated }, null, 2)}\n`, { flag: "wx" });
  } catch (error) { failures.push({ stage: "failure-publication", error }); }
  if (failures.length === 1) throw failures[0].error;
  throw new AggregateError(failures.map(({ error }) => error), "Smoke failed; original workflow/finalization errors retained");
}

export function validateNativeSmokeEvidence(audit, result, { driftOnly, integratedRecovery, extendedWorkflow = false, allowNormalWindow }) {
  const observations = JSON.parse(readFileSync(join(audit, "native-minimized.json"), "utf8"));
  const expectedLabels = ["native-ready", "approved-scanned-selected",
    ...(driftOnly ? ["dismissed-exact-drift", "refresh-approved-before-rescan"] : ["task-awaiting-separate-approval", "read-only-task-completed"]),
    ...(integratedRecovery ? ["execution-rescanned", "completed-exact-drift", "refresh-approved-before-rescan"] : []),
    "scenario-rescanned", ...(integratedRecovery ? ["recovered-inspection", "recovered-rescanned"] : []),
    ...(extendedWorkflow ? ["extended-advice-settled", "extended-run-settled"] : []), "before-cleanup"];
  assert.ok(!extendedWorkflow || !allowNormalWindow, "Extended workflow forbids normal-window fallback");
  assert.deepEqual(observations.samples.map((sample) => sample.boundary), expectedLabels, "All ordered native scenario boundaries observed");
  assert.ok(observations.samples.every((sample) => sample.verified === true));
  result.minimized = observations.samples.every((sample) => sample.minimized);
  result.normalWindowFallback = !result.minimized && allowNormalWindow;
}

// Build readiness has no wall-clock deadline. Exit/error wins even over a stuck probe.
export async function waitForLiveProcess(child, label, check) {
  let onExit;
  let onError;
  let stopped = false;
  let timer;
  const ended = new Promise((_, reject) => {
    onExit = (code, signal) => reject(new Error(`${label}: launcher exited (${code ?? signal}); inspect developer.log`));
    onError = (error) => reject(error);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode != null) onExit(child.exitCode, child.signalCode);
  });
  try {
    return await Promise.race([ended, (async () => {
      while (!stopped) {
        try { const result = await check(); if (result) return result; } catch { /* Readiness is retryable only while the owner lives. */ }
        if (!stopped) await new Promise((resolve) => { timer = setTimeout(resolve, 100); });
      }
    })()]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    child.removeListener("exit", onExit);
    child.removeListener("error", onError);
  }
}

async function terminateIdentity(identity) {
  assert.equal(process.platform, "win32", "Native smoke termination is Windows-only");
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
  assert.ok(Number.isSafeInteger(identity.startedAtMs));
  // Pin the process handle, then compare creation time in the same OS operation.
  // Never use taskkill /t: it can include descendants that were not observed as owned.
  const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${identity.pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { try { $handle=$p.Handle; if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -eq ${identity.startedAtMs}) { $p.Kill() } } finally { $p.Dispose() } }`;
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 64 * 1024 });
}

// Retain a bounded union, including descendants whose original root has exited.
export function trackOwnedProcess(child, { read = readProcessTable, terminate = terminateIdentity, sampleMs = 500 } = {}) {
  const identities = new Map();
  const errors = [];
  let timer;
  let stopped = false;
  let pending = Promise.resolve();
  const rememberError = (error) => { if (errors.length < 16) errors.push(error.message); };
  const onError = (error) => rememberError(error);
  child.on("error", onError);
  const observe = () => {
    pending = pending.then(async () => {
      const table = await read();
      const roots = identities.size === 0
        ? (child.exitCode === null && child.signalCode == null ? table.filter((entry) => entry.pid === child.pid) : [])
        : [...identities.values()].filter((identity) => table.some((entry) => entry.pid === identity.pid && entry.startedAtMs === identity.startedAtMs));
      for (const root of roots) {
        for (const identity of processTreeSnapshot(table, root.pid).identities) {
          assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isSafeInteger(identity.startedAtMs), "Owned identity must include creation time");
          const key = `${identity.pid}:${identity.startedAtMs}`;
          assert.ok(identities.has(key) || identities.size < 256, "Owned process identity limit exceeded");
          identities.set(key, identity);
        }
      }
      assert.ok(identities.size > 0, "No owned identity captured; empty snapshot cannot prove cleanup");
    }).catch(rememberError);
    return pending;
  };
  const sample = async () => {
    await observe();
    if (!stopped) timer = setTimeout(sample, sampleMs);
  };
  void sample();
  return {
    observe,
    async cleanup() {
      stopped = true;
      clearTimeout(timer);
      await observe();
      child.removeListener("error", onError);
      // Stop ancestors first to stop new spawning; each exact identity is revalidated.
      for (const identity of identities.values()) {
        try {
          const live = await read();
          if (live.some((entry) => entry.pid === identity.pid && entry.startedAtMs === identity.startedAtMs)) await terminate(identity);
        } catch (error) { rememberError(error); }
      }
      let survivors = [];
      try {
        const deadline = Date.now() + 10_000;
        do {
          survivors = survivingProcessIds([...identities.values()], await read());
          if (survivors.length === 0) break;
          await pause(100);
        } while (Date.now() < deadline);
      } catch (error) { rememberError(error); }
      if (survivors.length) rememberError(new Error(`Owned processes survived: ${survivors.join(",")}`));
      return { identities: [...identities.values()], survivors, errors, stopped: identities.size > 0 && errors.length === 0 && survivors.length === 0 };
    },
  };
}
