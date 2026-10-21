// @ts-check
// Selftest: proves the vendored kit is intact and works on this machine
// before anyone trusts a number from it. Runs offline in a few seconds:
// Node version, manifest hashes, glossary, sample study, known statistics
// values, the decision rule on synthetic data, the honesty audit, and one
// real worker process.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { decide } from "./compare.mjs";
import { auditDecision, explainDecision, KIT_GLOSSARY, readGlossary } from "./explain.mjs";
import { readJson } from "./files.mjs";
import { registries } from "./pipeline.mjs";
import { sha256 } from "./protocol.mjs";
import { err, ok } from "./result.mjs";
import { forkExecutor } from "./runner.mjs";
import { wilson } from "./stats.mjs";
import { validateStudy } from "./study.mjs";
import { loadTask } from "./task.mjs";
import { KIT_VERSION } from "./version.mjs";
import { claimsPass, parseTranscript } from "./transcript.mjs";

export const MANIFEST_FILE = "manifest.json";
export const MIN_NODE_MAJOR = 22;

/**
 * @typedef {{ name: string, status: "pass" | "fail" | "warn", detail: string }} Check
 */

/**
 * Verify manifest.json: every listed file exists with the listed sha256.
 * @param {string} kitDir
 * @returns {Promise<Check>}
 */
export async function checkManifest(kitDir) {
  const read = await readJson(path.join(kitDir, MANIFEST_FILE));
  if (!read.ok) {
    return read.error.code === "NOT_FOUND"
      ? {
          name: "manifest",
          status: "warn",
          detail: "no manifest.json (a source checkout); file hashes not verified",
        }
      : { name: "manifest", status: "fail", detail: read.error.message };
  }
  const m = /** @type {any} */ (read.value);
  if (!Array.isArray(m?.files) || typeof m.kitVersion !== "string")
    return { name: "manifest", status: "fail", detail: "manifest.json has no kitVersion or files" };
  if (m.kitVersion !== KIT_VERSION)
    return {
      name: "manifest",
      status: "fail",
      detail: `manifest.json is for kit ${m.kitVersion} but the code is kit ${KIT_VERSION}`,
    };
  /** @type {string[]} */
  const bad = [];
  for (const f of m.files) {
    if (typeof f?.path !== "string" || f.path.split("/").includes("..")) {
      bad.push(`invalid entry ${JSON.stringify(f?.path)}`);
      continue;
    }
    try {
      const bytes = await readFile(path.join(kitDir, ...f.path.split("/")));
      if (sha256(bytes) !== f.sha256) bad.push(`${f.path} changed`);
    } catch {
      bad.push(`${f.path} missing`);
    }
  }
  return bad.length
    ? {
        name: "manifest",
        status: "fail",
        detail: `kit files differ from manifest ${m.kitVersion}: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` and ${bad.length - 5} more` : ""}`,
      }
    : {
        name: "manifest",
        status: "pass",
        detail: `kit ${m.kitVersion}: ${m.files.length} files match their hashes`,
      };
}

/** Synthetic study used by the decision checks. */
const SYNTHETIC = Object.freeze({
  schema: 1,
  id: "selftest",
  title: "Selftest",
  question: "Does the decision rule behave?",
  repeats: 6,
  seed: 7,
  candidates: [
    { id: "ref", adapter: { type: "manual" }, synthetic: true },
    { id: "fast", adapter: { type: "manual" }, synthetic: true },
  ],
  workload: { items: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  metrics: [{ id: "ms", type: "wall-time", better: "lower" }],
  decision: { reference: "ref", primary: { metric: "ms", better: "lower", minRatio: 1.3 } },
});

/** @param {number} scale @param {number} jitter */
const synthetic = (scale, jitter) =>
  Object.fromEntries(
    ["a", "b", "c"].map((item, i) => [
      item,
      [0, 1, 2, 3, 4, 5].map(
        (r) => (100 + i * 40) * scale * (1 + jitter * (((r * 7 + i) % 5) - 2)),
      ),
    ]),
  );

/** @returns {Check[]} */
function decisionChecks() {
  /** @type {Check[]} */
  const out = [];
  const twice = synthetic(0.5, 0.01);
  const ref = synthetic(1, 0.01);
  const win = decide({
    study: SYNTHETIC,
    data: { ref: { ms: ref }, fast: { ms: twice } },
    resamples: 2_000,
  });
  const again = decide({
    study: SYNTHETIC,
    data: { ref: { ms: ref }, fast: { ms: twice } },
    resamples: 2_000,
  });
  const same = decide({
    study: SYNTHETIC,
    data: { ref: { ms: ref }, fast: { ms: synthetic(1, 0.012) } },
    resamples: 2_000,
  });
  out.push(
    win.verdict === "WIN" && win.winner === "fast"
      ? { name: "decision-win", status: "pass", detail: "a 2× faster synthetic candidate wins" }
      : {
          name: "decision-win",
          status: "fail",
          detail: `expected WIN for fast, got ${win.verdict}`,
        },
    JSON.stringify(win) === JSON.stringify(again)
      ? { name: "decision-seeded", status: "pass", detail: "the same data gives the same verdict" }
      : {
          name: "decision-seeded",
          status: "fail",
          detail: "the verdict changed between identical runs",
        },
    same.verdict !== "WIN"
      ? {
          name: "decision-same",
          status: "pass",
          detail: `same-vs-same gives ${same.verdict}, not WIN`,
        }
      : { name: "decision-same", status: "fail", detail: "same-vs-same was called a WIN" },
  );
  const problems = [win, same].flatMap((d) =>
    auditDecision(explainDecision(d, SYNTHETIC), SYNTHETIC),
  );
  out.push(
    problems.length === 0
      ? { name: "honesty", status: "pass", detail: "generated wording passes the honesty audit" }
      : { name: "honesty", status: "fail", detail: problems.join("; ") },
  );
  return out;
}

/**
 * Agent lane: both preset transcript formats end where they should, a run
 * with no final event is not "finished", pass claims respect negation, and
 * the sample task bundle loads.
 * @param {string} kitDir
 * @returns {Promise<Check>}
 */
async function agentCheck(kitDir) {
  const gg = parseTranscript(
    [
      '{"type":"text_delta","text":"All tests pass."}',
      '{"type":"agent_done","totalTurns":1,"totalUsage":{"inputTokens":10,"outputTokens":2}}',
    ].join("\n"),
    "ggcoder-json",
  );
  const claude = parseTranscript(
    '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":1}}',
    "claude-stream-json",
  );
  const silent = parseTranscript('{"type":"text_delta","text":"error: failed"}', "ggcoder-json");
  const task = await loadTask(path.join(kitDir, "templates", "task.sample"));
  /** @type {string[]} */
  const bad = [];
  if (gg.terminal.kind !== "done" || gg.usage?.inputTokens !== 10) bad.push("ggcoder --json");
  if (claude.terminal.kind !== "done" || claude.reportedCostUsd !== 0.01)
    bad.push("claude stream-json");
  if (silent.terminal.kind !== "none") bad.push("a run without a final event looked finished");
  if (!claimsPass("Tests passed.").claimed || claimsPass("I am not claiming tests passed.").claimed)
    bad.push("pass-claim check");
  if (!task.ok) bad.push(`sample task: ${task.error.message}`);
  return bad.length
    ? { name: "agent-lane", status: "fail", detail: bad.join("; ") }
    : {
        name: "agent-lane",
        status: "pass",
        detail: "agent transcripts, pass claims and the sample task bundle check out",
      };
}

/** One sample in a real child process, through the worker entry. @returns {Promise<Check>} */
async function workerCheck() {
  const module = `data:text/javascript,${encodeURIComponent(
    "export async function runSample() { return { ok: true, metrics: { answer: 42 } }; }",
  )}`;
  const execute = forkExecutor({
    jobFor: () => ({ adapterModule: module }),
    exposeGc: false,
    graceMs: 1_000,
  });
  const outcome = await execute(
    { index: 0, phase: "measure", repeat: 0, item: "x", candidate: "x", position: 0 },
    { timeoutMs: 20_000 },
  );
  return outcome.status === "ok" && outcome.metrics.answer === 42
    ? { name: "worker", status: "pass", detail: "a fresh worker process ran one sample" }
    : {
        name: "worker",
        status: "fail",
        detail:
          outcome.status === "errored"
            ? `${outcome.error.code}: ${outcome.error.message}`
            : "wrong result",
      };
}

/**
 * Run every check. Fails if any check fails; warnings do not fail.
 * @param {{ kitDir: string, nodeVersion?: string }} options
 */
export async function selftest({ kitDir, nodeVersion = process.versions.node }) {
  /** @type {Check[]} */
  const checks = [];
  const major = Number(nodeVersion.split(".")[0]);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: "node", status: "pass", detail: `Node ${nodeVersion}` }
      : {
          name: "node",
          status: "fail",
          detail: `Node ${nodeVersion}; the kit needs Node ${MIN_NODE_MAJOR} or newer`,
        },
  );
  checks.push(await checkManifest(kitDir));

  const g = await readGlossary(KIT_GLOSSARY);
  checks.push(
    g.ok && Object.keys(g.value.terms).length > 0
      ? {
          name: "glossary",
          status: "pass",
          detail: `${Object.keys(g.value.terms).length} plain-language terms`,
        }
      : { name: "glossary", status: "fail", detail: g.ok ? "glossary is empty" : g.error.message },
  );

  const sample = await readJson(path.join(kitDir, "templates", "study.sample.json"));
  const sampleErrors = sample.ok
    ? validateStudy(sample.value, registries())
    : [sample.error.message];
  checks.push(
    sampleErrors.length === 0
      ? { name: "sample-study", status: "pass", detail: "the sample study validates" }
      : { name: "sample-study", status: "fail", detail: sampleErrors.join("; ") },
  );

  const w = wilson(0, 10);
  const wOk = w.lower === 0 && Math.abs(/** @type {number} */ (w.upper) - 0.2775) < 1e-3;
  checks.push(
    wOk
      ? { name: "statistics", status: "pass", detail: "Wilson interval matches its known value" }
      : { name: "statistics", status: "fail", detail: `wilson(0, 10) = ${JSON.stringify(w)}` },
  );
  checks.push(...decisionChecks());
  checks.push(await agentCheck(kitDir));
  checks.push(await workerCheck());

  const failed = checks.filter((c) => c.status === "fail");
  return failed.length
    ? err(
        "SELFTEST_FAILED",
        `${failed.length} selftest check(s) failed: ${failed.map((c) => c.name).join(", ")}`,
        checks,
      )
    : ok({ kitVersion: KIT_VERSION, checks });
}
