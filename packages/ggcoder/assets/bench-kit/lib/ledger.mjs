// @ts-check
// Verdict ledger: verdict.json per study plus one entry per study and
// protocol version in bench/RESULTS.md. Entries sit between markers so a
// re-report replaces its own entry and never touches anyone's prose.
import path from "node:path";

import { candidateName } from "./explain.mjs";
import { jsonText, readOptional, writeAtomic } from "./files.mjs";
import { err, ok } from "./result.mjs";

export const VERDICT_FILE = "verdict.json";
export const VERDICT_SCHEMA = 1;

export const LEDGER_HEADER = `# Bench results

Verdict ledger for this project's benchmark studies. Entries are written by \`node bench/kit/cli.mjs report\`; write your own notes outside the entry markers.

- **WIN**: a candidate cleared the rule written down before the run, against the reference, beyond the noise.
- **TIE**: within the noise of each other; choose by the declared tie-break, otherwise keep the reference. A tie is not a win.
- **NO-WIN**: no candidate cleared the rule; the reference stays.
- **INCONCLUSIVE**: the data cannot settle it yet (range too wide, too many errors, a check could not run, or the noise check failed).
- **GATED-OUT**: a candidate failed a yes/no gate and was ruled out, whatever its numbers.
`;

/**
 * @param {{
 *   study: any,
 *   decision: any,
 *   explained: { verdict: { headline: string, meaning: string } },
 *   protocol: { version: number, digest: string },
 *   runIds: string[],
 *   excludedRunIds?: string[],
 *   generatedAt: string,
 * }} input
 */
export function buildVerdict({
  study,
  decision,
  explained,
  protocol,
  runIds,
  excludedRunIds = [],
  generatedAt,
}) {
  /** @type {Record<string, unknown>} */
  const candidates = {};
  for (const c of study.candidates ?? []) {
    const e = decision.candidates?.[c.id] ?? {};
    const ci = e.primary?.ci;
    candidates[c.id] = {
      verdict: e.verdict,
      reasons: e.reasons ?? [],
      errorRate: e.errorRate ?? 0,
      ...(e.counts ? { counts: e.counts } : {}),
      ...(ci
        ? {
            primary: {
              metric: e.primary.metric,
              point: ci.point,
              lower: ci.lower,
              upper: ci.upper,
              level: ci.level,
              classification: e.primary.classification,
            },
          }
        : {}),
      ...(c.synthetic === true ? { synthetic: true } : {}),
    };
  }
  return {
    schema: VERDICT_SCHEMA,
    study: study.id,
    title: study.title,
    question: study.question,
    protocolVersion: protocol.version,
    protocolDigest: protocol.digest,
    runs: [...runIds].sort(),
    ...(excludedRunIds.length ? { excludedRuns: [...excludedRunIds].sort() } : {}),
    verdict: decision.verdict,
    ...(decision.winner ? { winner: decision.winner } : {}),
    keep: decision.keep,
    reference: decision.reference,
    tieBreak: decision.tieBreak ?? [],
    rule: decision.rule,
    reasons: decision.reasons ?? [],
    rank: decision.rank ?? {},
    candidates,
    ...(Array.isArray(study.unmeasured) && study.unmeasured.length
      ? {
          unmeasured: study.unmeasured.map(
            (/** @type {{ what: string, how?: string }} */ { what, how }) => ({
              what,
              ...(how ? { how } : {}),
            }),
          ),
        }
      : {}),
    headline: explained.verdict.headline,
    meaning: explained.verdict.meaning,
    generatedAt,
  };
}

/** @param {string} studyDir @param {ReturnType<typeof buildVerdict>} verdict */
export const writeVerdict = (studyDir, verdict) =>
  writeAtomic(path.join(studyDir, VERDICT_FILE), jsonText(verdict));

/** @param {string} id @param {number} version */
const startMarker = (id, version) => `<!-- bench:start ${id} v${version} -->`;
const END_MARKER = "<!-- bench:end -->";

/**
 * One RESULTS.md entry.
 * @param {ReturnType<typeof buildVerdict>} verdict
 * @param {any} study
 */
export function ledgerEntry(verdict, study) {
  const outcome =
    verdict.verdict === "WIN" && verdict.winner
      ? `WIN: ${verdict.winner}`
      : String(verdict.verdict);
  const gated = Object.entries(verdict.candidates)
    .filter(([, c]) => /** @type {any} */ (c).verdict === "GATED-OUT")
    .map(([id, c]) => `${candidateName(study, id)} (${/** @type {any} */ (c).reasons.join("; ")})`);
  const lines = [
    startMarker(verdict.study, verdict.protocolVersion),
    `### ${verdict.generatedAt.slice(0, 10)} · ${verdict.study} (protocol v${verdict.protocolVersion}) · ${outcome}`,
    "",
    `- Question: ${verdict.question}`,
    `- Verdict: ${verdict.headline}`,
    `- Keep: ${candidateName(study, verdict.keep)}`,
  ];
  if (gated.length) lines.push(`- Gated out: ${gated.join("; ")}`);
  lines.push(
    `- Runs: ${verdict.runs.join(", ")} · protocol ${verdict.protocolDigest.slice(0, 12)}`,
    `- Report: studies/${verdict.study}/report.md`,
    END_MARKER,
  );
  return lines.join("\n");
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Add or replace this study version's entry in RESULTS.md.
 * @param {string} resultsFile
 * @param {ReturnType<typeof buildVerdict>} verdict
 * @param {any} study
 * @returns {Promise<import("./result.mjs").Result<{ file: string, action: "created" | "added" | "replaced" }>>}
 */
export async function updateLedger(resultsFile, verdict, study) {
  const current = await readOptional(resultsFile);
  if (!current.ok) return current;
  if (current.value?.includes("\r"))
    return err(
      "LEDGER_CRLF",
      `${resultsFile} has Windows (CRLF) line endings; convert it to LF before the kit edits it`,
    );
  const entry = ledgerEntry(verdict, study);
  /** @type {"created" | "added" | "replaced"} */
  let action;
  let text;
  if (current.value === undefined) {
    action = "created";
    text = `${LEDGER_HEADER}\n${entry}\n`;
  } else {
    const block = new RegExp(
      `${escapeRe(startMarker(verdict.study, verdict.protocolVersion))}[\\s\\S]*?${escapeRe(END_MARKER)}`,
    );
    if (block.test(current.value)) {
      action = "replaced";
      text = current.value.replace(block, () => entry);
    } else {
      action = "added";
      text = `${current.value.replace(/\n*$/, "")}\n\n${entry}\n`;
    }
  }
  const written = await writeAtomic(resultsFile, text);
  return written.ok ? ok({ file: resultsFile, action }) : written;
}
