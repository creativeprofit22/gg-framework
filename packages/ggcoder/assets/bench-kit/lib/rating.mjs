// @ts-check
// Blind human A/B rating for things a number cannot capture. Each item's
// outputs are copied under random letters; the letter→candidate key is
// stored outside the pack folder, so the pack can be handed to raters
// without revealing which candidate made what. Scores are imported back
// and unblinded into the same data shape the decision rule uses.
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { jsonText, readJson, writeAtomic } from "./files.mjs";
import { err, ok } from "./result.mjs";
import { makeRng, seedFrom, shuffle } from "./rng.mjs";
import { resolveInside } from "./sample-io.mjs";

export const RATING_SCHEMA = 1;
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Folder of the shareable pack. @param {string} studyDir @param {string} packId */
export const packDirFor = (studyDir, packId) => path.join(studyDir, "ratings", packId);
/** The unblinding key; kept beside, never inside, the pack. @param {string} studyDir @param {string} packId */
export const keyFileFor = (studyDir, packId) =>
  path.join(studyDir, "ratings", `${packId}.key.json`);
/** Imported, unblinded scores. @param {string} studyDir @param {string} packId */
export const scoresFileFor = (studyDir, packId) =>
  path.join(studyDir, "ratings", `${packId}.scores.json`);

/** @param {string} p */
const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Create a blind rating pack.
 * @param {{
 *   studyDir: string,
 *   study: any,
 *   packId: string,
 *   entries: { item: string, outputs: Record<string, string> }[],
 *   seed?: number,
 *   scale?: { min: number, max: number },
 *   prompt?: string,
 * }} input  outputs map candidate id → study-relative path of that candidate's output for the item
 * @returns {Promise<import("./result.mjs").Result<{ packDir: string, keyFile: string, items: number, warnings: string[] }>>}
 */
export async function createRatingPack({
  studyDir,
  study,
  packId,
  entries,
  seed,
  scale = { min: 1, max: 5 },
  prompt,
}) {
  if (typeof packId !== "string" || !ID.test(packId))
    return err("RATING_PACK_ID", "pack id must be letters, digits, '.', '_' or '-' (max 64)");
  if (!(Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.min < scale.max))
    return err("RATING_SCALE", "scale needs min < max");
  if (!Array.isArray(entries) || entries.length === 0)
    return err("RATING_EMPTY", "nothing to rate");
  const known = new Set((study.candidates ?? []).map((/** @type {any} */ c) => c.id));
  const packDir = packDirFor(studyDir, packId);
  const keyFile = keyFileFor(studyDir, packId);
  if ((await exists(packDir)) || (await exists(keyFile)))
    return err(
      "RATING_PACK_EXISTS",
      `rating pack ${packId} already exists; use a new pack id (packs are never overwritten)`,
    );

  const baseSeed = Number.isInteger(seed) ? seed : study.seed;
  /** @type {string[]} */
  const warnings = [];
  /** @type {{ item: string, options: { label: string, file: string, source: string, candidate: string }[] }[]} */
  const plan = [];
  const seen = new Set();
  for (const e of entries) {
    if (typeof e?.item !== "string" || !ID.test(e.item))
      return err("RATING_ITEM", `invalid item id ${JSON.stringify(e?.item)}`);
    if (seen.has(e.item)) return err("RATING_ITEM", `item ${e.item} is listed twice`);
    seen.add(e.item);
    const ids = Object.keys(e.outputs ?? {}).sort();
    if (ids.length < 2)
      return err("RATING_ITEM", `item ${e.item} needs outputs from at least 2 candidates`);
    if (ids.length > LETTERS.length)
      return err("RATING_ITEM", `item ${e.item} has more than ${LETTERS.length} options`);
    const order = shuffle(ids, makeRng(seedFrom(`${baseSeed}:${packId}:${e.item}`)));
    /** @type {{ label: string, file: string, source: string, candidate: string }[]} */
    const options = [];
    for (const [i, candidate] of order.entries()) {
      if (!known.has(candidate))
        return err(
          "RATING_CANDIDATE",
          `item ${e.item}: ${candidate} is not a candidate in this study`,
        );
      const source = resolveInside(studyDir, e.outputs[candidate]);
      if (!source.ok)
        return err("RATING_OUTPUT", `item ${e.item}, ${candidate}: ${source.error.message}`);
      if (!(await exists(source.value)))
        return err(
          "RATING_OUTPUT",
          `item ${e.item}, ${candidate}: output ${e.outputs[candidate]} does not exist`,
        );
      const label = /** @type {string} */ (LETTERS[i]);
      options.push({
        label,
        candidate,
        source: source.value,
        file: `${e.item}/${label}${path.extname(source.value).toLowerCase()}`,
      });
    }
    if (new Set(options.map((o) => path.extname(o.source).toLowerCase())).size > 1)
      warnings.push(
        `item ${e.item}: the options have different file types, so raters may be able to tell them apart`,
      );
    plan.push({ item: e.item, options: options.sort((a, b) => a.label.localeCompare(b.label)) });
  }

  try {
    for (const p of plan) {
      await mkdir(path.join(packDir, p.item), { recursive: true });
      for (const o of p.options) await copyFile(o.source, path.join(packDir, o.file));
    }
  } catch (error) {
    return err(
      "RATING_COPY",
      `cannot build the pack: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const pack = {
    schema: RATING_SCHEMA,
    packId,
    study: study.id,
    prompt: prompt ?? study.question,
    scale,
    items: plan.map((p) => ({
      item: p.item,
      options: p.options.map((o) => ({ label: o.label, file: o.file })),
    })),
  };
  const csv = [
    "rater,item,label,score,notes",
    ...plan.flatMap((p) => p.options.map((o) => `,${p.item},${o.label},,`)),
  ].join("\n");
  const readme = [
    `# Blind rating: ${packId}`,
    "",
    `Question: ${pack.prompt}`,
    "",
    `Each folder is one input. The options inside are labelled with letters in a random order that changes between inputs. Rate every option from ${scale.min} (worst) to ${scale.max} (best) on its own merits; do not try to guess which tool made it.`,
    "",
    "Fill in scores.csv: put your name in the rater column and a score for each row. Leave a row's score empty to skip it. Notes are optional.",
    "",
  ].join("\n");
  const key = {
    schema: RATING_SCHEMA,
    packId,
    study: study.id,
    seed: baseSeed,
    items: Object.fromEntries(
      plan.map((p) => [p.item, Object.fromEntries(p.options.map((o) => [o.label, o.candidate]))]),
    ),
  };
  for (const [file, text] of /** @type {[string, string][]} */ ([
    [path.join(packDir, "pack.json"), jsonText(pack)],
    [path.join(packDir, "scores.csv"), `${csv}\n`],
    [path.join(packDir, "README.md"), readme],
    [keyFile, jsonText(key)],
  ])) {
    const w = await writeAtomic(file, text);
    if (!w.ok) return w;
  }
  return ok({ packDir, keyFile, items: plan.length, warnings });
}

/**
 * Parse CSV (RFC 4180 quoting; LF or CRLF rows, since raters use spreadsheets).
 * @param {string} text
 * @returns {import("./result.mjs").Result<string[][]>}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.replace(/^\uFEFF/, "");
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') quoted = false;
      else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r" && src[i + 1] === "\n") i++;
    } else field += ch;
    i++;
  }
  if (quoted) return err("CSV_UNTERMINATED", "a quoted field is not closed");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return ok(rows.filter((r) => r.some((f) => f.trim() !== "")));
}

/**
 * Import filled-in scores and unblind them with the key.
 * @param {{ studyDir: string, packId: string, scoresFile: string, metric?: string }} input
 * @returns {Promise<import("./result.mjs").Result<{
 *   metric: string,
 *   data: Record<string, Record<string, Record<string, number[]>>>,
 *   raters: string[],
 *   rows: number,
 *   skipped: number,
 *   summary: Record<string, { n: number, mean: number | undefined }>,
 *   file: string,
 * }>>}
 */
export async function importScores({ studyDir, packId, scoresFile, metric = "rating" }) {
  if (typeof packId !== "string" || !ID.test(packId))
    return err("RATING_PACK_ID", "invalid pack id");
  const pack = await readJson(path.join(packDirFor(studyDir, packId), "pack.json"));
  if (!pack.ok) return pack;
  const key = await readJson(keyFileFor(studyDir, packId));
  if (!key.ok) return err("RATING_KEY_MISSING", `cannot unblind: ${key.error.message}`);
  let text;
  try {
    text = await readFile(scoresFile, "utf8");
  } catch (error) {
    return err(
      "RATING_SCORES_UNREADABLE",
      `cannot read ${scoresFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseCsv(text);
  if (!parsed.ok) return parsed;
  const [header, ...body] = parsed.value;
  const cols = (header ?? []).map((h) => h.trim().toLowerCase());
  const at = Object.fromEntries(
    ["rater", "item", "label", "score"].map((c) => [c, cols.indexOf(c)]),
  );
  const missingCols = Object.entries(at)
    .filter(([, i]) => i < 0)
    .map(([c]) => c);
  if (missingCols.length)
    return err(
      "RATING_SCORES_HEADER",
      `scores file needs columns rater,item,label,score (missing ${missingCols.join(", ")})`,
    );

  const { min, max } = pack.value.scale;
  /** @type {Record<string, Record<string, string>>} */
  const items = key.value.items ?? {};
  /** @type {Record<string, Record<string, Record<string, number[]>>>} */
  const data = {};
  const seen = new Set();
  const raters = new Set();
  /** @type {string[]} */
  const problems = [];
  let rows = 0;
  let skipped = 0;
  body.forEach((r, n) => {
    const line = n + 2;
    const get = (/** @type {string} */ c) => (r[/** @type {number} */ (at[c])] ?? "").trim();
    const scoreText = get("score");
    if (scoreText === "") {
      skipped++;
      return;
    }
    const rater = get("rater");
    const item = get("item");
    const label = get("label").toUpperCase();
    const score = Number(scoreText);
    if (!rater) return void problems.push(`line ${line}: rater is empty`);
    const candidate = items[item]?.[label];
    if (!items[item]) return void problems.push(`line ${line}: item ${item} is not in this pack`);
    if (!candidate) return void problems.push(`line ${line}: item ${item} has no option ${label}`);
    if (!Number.isFinite(score) || score < min || score > max)
      return void problems.push(`line ${line}: score ${scoreText} is outside ${min}..${max}`);
    const k = `${rater}\u0000${item}\u0000${label}`;
    if (seen.has(k))
      return void problems.push(`line ${line}: ${rater} rated ${item} option ${label} twice`);
    seen.add(k);
    raters.add(rater);
    rows++;
    (((data[candidate] ??= {})[metric] ??= {})[item] ??= []).push(score);
  });
  if (problems.length)
    return err(
      "RATING_SCORES_INVALID",
      `scores file has problems: ${problems.join("; ")}`,
      problems,
    );
  if (rows === 0) return err("RATING_SCORES_EMPTY", "no scores were filled in");

  /** @type {Record<string, { n: number, mean: number | undefined }>} */
  const summary = {};
  for (const id of Object.keys(data).sort()) {
    const all = Object.values(data[id]?.[metric] ?? {}).flat();
    summary[id] = {
      n: all.length,
      mean: all.length ? all.reduce((s, x) => s + x, 0) / all.length : undefined,
    };
  }
  const file = scoresFileFor(studyDir, packId);
  const result = { metric, data, raters: [...raters].sort(), rows, skipped, summary };
  const w = await writeAtomic(file, jsonText({ schema: RATING_SCHEMA, packId, ...result }));
  if (!w.ok) return w;
  return ok({ ...result, file });
}
