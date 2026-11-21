// @ts-check
// HTTP adapter: one request per sample against a service that is already
// running (the kit never starts or stops services). The base URL comes from
// the adapter (`baseUrl`) or from `.gg/bench.config.json` (`services.<name>`),
// so machine-specific addresses stay out of study.json.
//
//   "adapter": { "type": "http", "service": "engine-b", "method": "POST", "path": "/render?item={item}",
//                "body": "input", "headers": { "content-type": "application/json" } }
//
// The response status is recorded, not judged: gates decide what a bad status
// means. Network failures and timeouts make the sample errored.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { fillSlots } from "../argv.mjs";
import { prepareSample } from "../sandbox/process.mjs";
import { done, fail, isObject, relPosix } from "./common.mjs";

export const METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PATH_SLOTS = Object.freeze(["item", "candidate", "repeat"]);

/** @param {unknown} url */
const isHttpUrl = (url) => {
  try {
    const u = new URL(String(url));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** @param {any} a @returns {string[]} */
export function validate(a) {
  /** @type {string[]} */
  const e = [];
  if (a.baseUrl === undefined && a.service === undefined)
    e.push("baseUrl or service: one is required");
  if (a.baseUrl !== undefined && !isHttpUrl(a.baseUrl)) e.push("baseUrl: expected an http(s) URL");
  if (a.service !== undefined && !(typeof a.service === "string" && a.service.length > 0))
    e.push("service: expected a service name from bench.config.json");
  if (a.method !== undefined && !METHODS.includes(a.method))
    e.push(`method: expected one of ${METHODS.join("|")}`);
  if (a.path !== undefined && !(typeof a.path === "string" && a.path.startsWith("/")))
    e.push("path: expected a path starting with /");
  else if (typeof a.path === "string") {
    const unknown = [...a.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
      .map((m) => m[1])
      .filter((n) => !PATH_SLOTS.includes(/** @type {string} */ (n)));
    if (unknown.length)
      e.push(
        `path: unknown slot(s) ${unknown.map((n) => `{${n}}`).join(", ")} (allowed: {item}, {candidate}, {repeat})`,
      );
  }
  if (a.body !== undefined && a.body !== "none" && a.body !== "input")
    e.push("body: expected none or input");
  if (
    a.headers !== undefined &&
    !(isObject(a.headers) && Object.values(a.headers).every((v) => typeof v === "string"))
  )
    e.push("headers: expected an object of strings");
  return e;
}

/**
 * @param {import("./common.mjs").AdapterJob} job
 * @returns {Promise<import("./common.mjs").SampleResult>}
 */
export async function runSample(job) {
  const a = job.adapter;
  const base = a.baseUrl ?? job.config.services?.[a.service];
  if (!isHttpUrl(base))
    return fail(
      "SERVICE_UNCONFIGURED",
      `no URL for service "${a.service}" in bench.config.json (services.${a.service})`,
    );
  const filled = fillSlots([a.path ?? "/"], {
    item: encodeURIComponent(job.item.id),
    candidate: encodeURIComponent(job.candidate.id),
    repeat: String(job.repeat),
  });
  if (!filled.ok) return fail("SLOT_UNAVAILABLE", filled.error.message);
  const url = new URL(
    /** @type {string} */ (filled.value[0]).replace(/^\//, ""),
    String(base).endsWith("/") ? base : `${base}/`,
  );
  const s = await prepareSample({ sampleDir: job.sampleDir, item: job.item, outputExt: ".body" });
  let body;
  if (a.body === "input") {
    if (!s.inputPath) return fail("INPUT_MISSING", `item ${job.item.id} has no input to send`);
    body = await readFile(s.inputPath);
  }
  const t0 = performance.now();
  let ttfbMs;
  let bytes;
  let response;
  try {
    response = await fetch(url, {
      method: a.method ?? (body ? "POST" : "GET"),
      headers: a.headers,
      body,
      signal: AbortSignal.timeout(job.timeoutMs),
    });
    ttfbMs = performance.now() - t0;
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError")
      return fail("TIMEOUT", `request ran past the ${job.timeoutMs} ms sample limit`);
    const cause = /** @type {any} */ (error)?.cause;
    return fail(
      "HTTP_FAILED",
      `${url.origin}: ${cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))}`,
    );
  }
  const wallMs = performance.now() - t0;
  await writeFile(s.outPath, bytes);
  return done(
    { wallMs, ttfbMs, outputBytes: bytes.length, status: response.status },
    {
      timing: "request start to last body byte",
      status: response.status,
      contentType: response.headers.get("content-type"),
      url: `${url.pathname}${url.search}`,
      peakMemory: { method: "none", label: "unmeasured (the service runs outside the kit)" },
      sampleDir: relPosix(job.studyDir, job.sampleDir),
      outPath: relPosix(job.studyDir, s.outPath),
      outDir: relPosix(job.studyDir, path.dirname(s.outPath)),
    },
  );
}
