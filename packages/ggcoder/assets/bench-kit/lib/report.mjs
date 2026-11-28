// @ts-check
// report.md: tables plus a plain "what this means for you" line for every
// result. Every sentence comes from explain.mjs; this module only lays them
// out. Unmeasured values are printed as "not measured", never as 0.
import path from "node:path";

import {
  auditDecision,
  auditWording,
  candidateName,
  explainCounts,
  explainDecision,
  explainMetricResult,
  explainRule,
  formatPercent,
  formatQuantity,
  metricInfo,
} from "./explain.mjs";
import { writeAtomic } from "./files.mjs";
import { summarize } from "./stats.mjs";

export const REPORT_FILE = "report.md";

/**
 * @typedef {{
 *   study: any,
 *   decision: any,
 *   metrics: {
 *     data: Record<string, Record<string, Record<string, number[]>>>,
 *     unmeasured?: Record<string, Record<string, { count: number, reasons: string[] }>>,
 *     labels?: Record<string, string[]>,
 *   },
 *   gates?: Record<string, import("./compare.mjs").GateSummary & { checked?: number }>,
 *   counts?: Record<string, import("./compare.mjs").Counts>,
 *   protocol?: { version: number, digest: string },
 *   runIds?: string[],
 *   excludedRunIds?: string[],
 *   aa?: { passed: boolean, noise?: number, reason?: string },
 *   generatedAt?: string,
 * }} ReportInput
 */

/** Escape a table cell. @param {unknown} v */
const cell = (v) =>
  String(v ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ");

/** @param {string[]} head @param {unknown[][]} rows */
function table(head, rows) {
  return [
    `| ${head.map(cell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** @param {(import("./compare.mjs").GateSummary & { checked?: number }) | undefined} g */
function gateText(g) {
  if (!g) return "no gates";
  const ids = (/** @type {{ gate: string }[]} */ list) =>
    [...new Set(list.map((f) => f.gate))].sort().join(", ");
  switch (g.status) {
    case "pass": {
      const recorded = /** @type {{ recorded?: unknown[] }} */ (g).recorded?.length ?? 0;
      const note = recorded ? `; ${recorded} record-only result(s) not passing` : "";
      return g.checked ? `passed (${g.checked} checks${note})` : "passed";
    }
    case "fail":
      return `failed: ${ids(g.failures ?? [])}`;
    case "errored":
      return `could not check: ${ids(g.errored ?? [])}`;
    default:
      return "not run";
  }
}

/** @param {import("./compare.mjs").Counts | undefined} c */
const samplesText = (c) =>
  c
    ? `${c.completed}/${c.planned} ok${c.errored ? `, ${c.errored} errored` : ""}${c.notRun ? `, ${c.notRun} not run` : ""}`
    : "not recorded";

/**
 * Build report.md. Returns the markdown and any honesty problems found in
 * the generated wording (expected to be empty; the CLI refuses to write a
 * report that has any).
 * @param {ReportInput} input
 * @returns {{ markdown: string, problems: string[], explained: ReturnType<typeof explainDecision> }}
 */
export function buildReport(input) {
  const { study, decision, metrics } = input;
  const extras = { unmeasured: metrics.unmeasured ?? {}, labels: metrics.labels ?? {} };
  const explained = explainDecision(decision, study, extras);
  const problems = auditDecision(explained, study);
  const v = explained.verdict;
  /** @type {string[]} */
  const out = [];
  out.push(`# ${study.title ?? study.id}`, "", `**Question:** ${study.question ?? ""}`, "");

  out.push("## Verdict", "", `**${v.headline}**`, "", `What this means for you: ${v.meaning}`, "");
  if (v.nextSteps.length) out.push("Next steps:", "", ...v.nextSteps.map((s) => `- ${s}`), "");

  out.push("## The rule, written down before the run", "", explainRule(decision, study), "");

  out.push("## Candidates", "");
  out.push(
    table(
      ["Candidate", "Result", "Gates", "Samples"],
      explained.candidates.map((c) => [
        c.name,
        c.verdict,
        gateText(input.gates?.[c.id]),
        samplesText(input.counts?.[c.id] ?? decision.candidates?.[c.id]?.counts),
      ]),
    ),
    "",
  );
  for (const c of explained.candidates) {
    out.push(`### ${c.name}`, "", c.headline, "", `What this means for you: ${c.meaning}`, "");
    const counts = input.counts?.[c.id];
    const details =
      counts && !decision.candidates?.[c.id]?.counts
        ? [explainCounts(counts), ...c.details]
        : c.details;
    if (details.length) out.push(...details.map((d) => `- ${d}`), "");
  }

  out.push("## Measurements", "");
  const metricIds = (study.metrics ?? []).map((/** @type {any} */ m) => String(m.id));
  for (const metricId of metricIds) {
    const m = metricInfo(study, metricId);
    const lines = explainMetricResult({
      study,
      metricId,
      data: metrics.data,
      unmeasured: extras.unmeasured,
      labels: extras.labels,
    });
    out.push(`### ${m.label}`, "", lines[0] ?? "", "");
    const rows = (study.candidates ?? []).map((/** @type {any} */ c) => {
      const byItem = metrics.data?.[c.id]?.[metricId] ?? {};
      const s = summarize(
        Object.keys(byItem)
          .sort()
          .flatMap((k) => byItem[k] ?? []),
      );
      const missing = extras.unmeasured?.[c.id]?.[metricId]?.count ?? 0;
      const q = (/** @type {number | undefined} */ x) =>
        x === undefined ? "not measured" : formatQuantity(x, m.unit);
      return [
        candidateName(study, c.id),
        q(s.p50),
        s.n >= 5 ? q(s.p95) : "too few samples",
        s.n,
        missing ? `${missing} not measured` : "none",
      ];
    });
    out.push(table(["Candidate", "Median", "p95", "Measured samples", "Unmeasured"], rows), "");
    if (lines.length > 1) out.push(...lines.slice(1).map((l) => `- ${l}`), "");
  }

  // Things the study declared important but this run does not measure.
  // Listed in study order and never printed as 0.
  if (Array.isArray(study.unmeasured) && study.unmeasured.length) {
    const notMeasured = study.unmeasured.map(
      (/** @type {{ what: string, how?: string }} */ { what, how }) =>
        `- ${what}: not measured by this run${how ? `; it could be judged by ${how}` : ""}.`,
    );
    const synthetic = (study.candidates ?? [])
      .filter((/** @type {any} */ c) => c.synthetic === true)
      .map((/** @type {any} */ c) => String(c.id));
    problems.push(
      ...auditWording(notMeasured.join("\n"), { verdict: String(decision.verdict), synthetic }),
    );
    out.push("## Not measured", "", ...notMeasured, "");
  }

  const gateRows = [];
  for (const c of study.candidates ?? []) {
    const g = input.gates?.[c.id];
    for (const f of g?.failures ?? [])
      gateRows.push([candidateName(study, c.id), f.gate, f.item ?? "all", "failed", f.reason]);
    for (const f of g?.errored ?? [])
      gateRows.push([
        candidateName(study, c.id),
        f.gate,
        f.item ?? "all",
        "could not be checked",
        f.reason,
      ]);
    for (const f of /** @type {{ recorded?: { gate: string, item?: string, status: string, reason: string }[] }} */ (
      g ?? {}
    ).recorded ?? [])
      gateRows.push([
        candidateName(study, c.id),
        f.gate,
        f.item ?? "all",
        `${f.status === "fail" ? "failed" : "could not be checked"} (recorded, does not rule out)`,
        f.reason,
      ]);
  }
  if (input.gates) {
    out.push("## Gates", "");
    out.push(
      gateRows.length
        ? table(["Candidate", "Gate", "Input", "Status", "Reason"], gateRows)
        : "Every gate that ran passed. Gates are yes/no checks; a candidate that fails one is ruled out.",
      "",
    );
  }

  if (v.details.length) out.push("## Notes", "", ...v.details.map((d) => `- ${d}`), "");

  out.push("## Provenance", "");
  if (input.protocol)
    out.push(
      `- Protocol v${input.protocol.version} (${input.protocol.digest.slice(0, 12)}); results from other versions are never mixed in.`,
    );
  if (input.runIds?.length)
    out.push(
      `- Runs: ${input.runIds.join(", ")}. Raw samples are in runs/<run>/samples.jsonl (not tracked by git).`,
    );
  if (input.excludedRunIds?.length)
    out.push(
      `- Left out by choice: ${input.excludedRunIds.join(", ")}. These full runs belong to this protocol version but were not included; leaving runs out can bias the result, so say why.`,
    );
  if (input.aa)
    out.push(
      input.aa.passed
        ? `- A/A (same-vs-same) check passed; noise floor about ${formatPercent(input.aa.noise ?? 0)}.`
        : `- A/A (same-vs-same) check failed: ${input.aa.reason ?? "the setup is not stable enough to compare"}.`,
    );
  else out.push("- No A/A (same-vs-same) check was run; the default 1% noise floor was used.");
  out.push(
    `- Confidence ${formatPercent(decision.rule?.level ?? 0.95)}, seed ${study.seed}. All numbers were computed by the bench kit, not by hand.`,
  );
  if (input.generatedAt) out.push(`- Generated ${input.generatedAt}.`);
  out.push("");
  return { markdown: out.join("\n"), problems, explained };
}

/**
 * Write report.md atomically.
 * @param {string} studyDir
 * @param {string} markdown
 */
export const writeReport = (studyDir, markdown) =>
  writeAtomic(path.join(studyDir, REPORT_FILE), markdown);
