// @ts-check
// Child-process entry: runs exactly one sample in a fresh Node process, so
// one candidate's JIT state, caches and leaks never reach the next sample.
// The parent (runner.forkExecutor) resolves which adapter module to load and
// sends one job over IPC; the worker imports it, calls `runSample(job)` and
// sends back one result. Candidate output on stdout/stderr never mixes with
// the result, because the result travels over the IPC channel.
//
// Adapter module contract:
//   export async function runSample(job) ->
//     { ok: true, metrics: Record<string, number>, info?: object, gates?: object }
//   | { ok: false, error: { code: string, message: string } }
import { pathToFileURL } from "node:url";

/**
 * @typedef {{ ok: true, metrics: Record<string, number>, info?: Record<string, unknown>, gates?: Record<string, unknown> }
 *   | { ok: false, error: { code: string, message: string } }} SampleResult
 * @typedef {{ adapterModule: string, [key: string]: unknown }} WorkerJob
 */

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Run one job (exported for in-process use and tests).
 * @param {WorkerJob} job
 * @returns {Promise<SampleResult>}
 */
export async function runJob(job) {
  let mod;
  try {
    const spec =
      /^[a-z]+:/i.test(job.adapterModule) && !/^[a-z]:[\\/]/i.test(job.adapterModule)
        ? job.adapterModule
        : pathToFileURL(job.adapterModule).href;
    mod = await import(spec);
  } catch (error) {
    return {
      ok: false,
      error: { code: "ADAPTER_LOAD", message: `cannot load adapter: ${message(error)}` },
    };
  }
  if (typeof mod.runSample !== "function")
    return {
      ok: false,
      error: { code: "ADAPTER_INVALID", message: "adapter module has no runSample export" },
    };
  try {
    const result = await mod.runSample(job);
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean")
      return {
        ok: false,
        error: { code: "ADAPTER_RESULT", message: "adapter returned no { ok } result" },
      };
    if (result.ok) {
      const metrics = result.metrics ?? {};
      for (const [k, v] of Object.entries(metrics))
        if (typeof v !== "number" || !Number.isFinite(v))
          return {
            ok: false,
            error: { code: "ADAPTER_RESULT", message: `metric ${k} is not a finite number` },
          };
      return {
        ok: true,
        metrics,
        ...(result.info ? { info: result.info } : {}),
        ...(result.gates ? { gates: result.gates } : {}),
      };
    }
    return {
      ok: false,
      error: {
        code: String(result.error?.code ?? "SAMPLE_FAILED"),
        message: String(result.error?.message ?? "sample failed"),
      },
    };
  } catch (error) {
    return { ok: false, error: { code: "SAMPLE_THREW", message: message(error) } };
  }
}

if (typeof process.send === "function" && process.env.BENCH_KIT_WORKER === "1") {
  process.once("message", async (/** @type {any} */ msg) => {
    const result =
      msg?.type === "job"
        ? await runJob(msg.job)
        : /** @type {SampleResult} */ ({
            ok: false,
            error: { code: "WORKER_PROTOCOL", message: "expected a job message" },
          });
    process.send?.({ type: "result", result }, () => process.disconnect?.());
  });
}
