// @ts-check
// Manual adapter: numbers measured outside the kit (a phone, a lab rig, a
// vendor dashboard). The file lives in the frozen workload, so it is hashed
// into the protocol like any other input, and `provenance` must say who
// measured what, how. Values are reported as `reported.<metric>`.
//
// CSV:  candidate,item,repeat,<metric>,<metric>...   (an empty cell = not measured)
// JSON: [{ "candidate": "engine-b", "item": "clip-4k", "repeat": 0, "values": { "export_seconds": 41.2 } }]
//
// Every measured slot needs its row; a missing row is an errored sample, never
// a silent zero. Warm-up slots return nothing (manual data has no warm-up).
import { readFile } from "node:fs/promises";
import path from "node:path";

import { done, fail, isContainedRelative, isObject } from "./common.mjs";

/** @param {any} a @returns {string[]} */
export function validate(a) {
  /** @type {string[]} */
  const e = [];
  if (!isContainedRelative(a.file)) e.push("file: expected a path inside the workload folder");
  else if (
    a.format === undefined &&
    ![".csv", ".json"].includes(path.extname(a.file).toLowerCase())
  )
    e.push("file: expected .csv or .json (or set format)");
  if (a.format !== undefined && a.format !== "csv" && a.format !== "json")
    e.push("format: expected csv or json");
  if (!(typeof a.provenance === "string" && a.provenance.trim().length >= 10))
    e.push("provenance: say who measured these numbers, how and when (at least 10 characters)");
  return e;
}

/**
 * Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF or LF).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Parse a manual file into rows `{ candidate, item, repeat, values }`.
 * @param {string} text
 * @param {"csv" | "json"} format
 * @returns {import("../result.mjs").Result<{ candidate: string, item: string, repeat: number, values: Record<string, number> }[]>}
 */
export function parseManual(text, format) {
  /** @type {{ candidate: string, item: string, repeat: number, values: Record<string, number> }[]} */
  const rows = [];
  /** @param {string} message */
  const bad = (message) =>
    /** @type {const} */ ({ ok: false, error: { code: "MANUAL_INVALID", message } });
  if (format === "json") {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return bad(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(data)) return bad("expected an array of rows");
    for (const [i, r] of data.entries()) {
      if (
        !isObject(r) ||
        typeof r.candidate !== "string" ||
        typeof r.item !== "string" ||
        !Number.isInteger(r.repeat) ||
        !isObject(r.values)
      )
        return bad(`row ${i}: expected { candidate, item, repeat, values }`);
      for (const [k, v] of Object.entries(r.values))
        if (typeof v !== "number" || !Number.isFinite(v))
          return bad(`row ${i}: ${k} is not a number`);
      rows.push({
        candidate: r.candidate,
        item: r.item,
        repeat: r.repeat,
        values: { ...r.values },
      });
    }
    return { ok: true, value: rows };
  }
  const [header, ...body] = parseCsv(text);
  if (!header) return bad("empty file");
  const cols = header.map((h) => h.trim());
  for (const need of ["candidate", "item", "repeat"])
    if (!cols.includes(need)) return bad(`header needs a ${need} column`);
  const metricCols = cols.filter((c) => !["candidate", "item", "repeat"].includes(c));
  for (const [i, cells] of body.entries()) {
    /** @param {string} name */
    const cell = (name) => (cells[cols.indexOf(name)] ?? "").trim();
    const repeat = Number(cell("repeat"));
    if (!Number.isInteger(repeat)) return bad(`line ${i + 2}: repeat is not an integer`);
    /** @type {Record<string, number>} */
    const values = {};
    for (const m of metricCols) {
      const raw = cell(m);
      if (raw === "") continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) return bad(`line ${i + 2}: ${m} is not a number ("${raw}")`);
      values[m] = v;
    }
    rows.push({ candidate: cell("candidate"), item: cell("item"), repeat, values });
  }
  return { ok: true, value: rows };
}

/**
 * @param {import("./common.mjs").AdapterJob} job
 * @returns {Promise<import("./common.mjs").SampleResult>}
 */
export async function runSample(job) {
  const a = job.adapter;
  if (job.phase === "warmup") return done({}, { note: "manual data has no warm-up" });
  const file = path.join(job.workloadDir, a.file);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return fail(
      "MANUAL_MISSING",
      `cannot read ${a.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const format = a.format ?? (path.extname(a.file).toLowerCase() === ".json" ? "json" : "csv");
  const parsed = parseManual(text, format);
  if (!parsed.ok) return fail(parsed.error.code, `${a.file}: ${parsed.error.message}`);
  const matches = parsed.value.filter(
    (r) => r.candidate === job.candidate.id && r.item === job.item.id && r.repeat === job.repeat,
  );
  if (matches.length === 0)
    return fail(
      "MANUAL_MISSING",
      `${a.file} has no row for ${job.candidate.id} / ${job.item.id} / repeat ${job.repeat}`,
    );
  if (matches.length > 1)
    return fail(
      "MANUAL_DUPLICATE",
      `${a.file} has ${matches.length} rows for ${job.candidate.id} / ${job.item.id} / repeat ${job.repeat}`,
    );
  const values = /** @type {(typeof matches)[number]} */ (matches[0]).values;
  /** @type {Record<string, number>} */
  const metrics = {};
  for (const k of Object.keys(values).sort())
    metrics[`reported.${k}`] = /** @type {number} */ (values[k]);
  return done(metrics, {
    provenance: a.provenance,
    source: `${a.file} (measured outside the kit)`,
  });
}
