// @ts-check
// equals: the candidate's output must match the expected output for the item
// (workload `expectedFile`) or an inline `expected` value.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../protocol.mjs";
import { SOURCES, parseJsonOutput, readSource } from "../sample-io.mjs";
import { errored, failed, pass, scopeOf, unknownKeys } from "./common.mjs";

export const MODES = Object.freeze(["text", "bytes", "json"]);

/** @param {any} g */
export function validate(g) {
  const errors = unknownKeys(g, ["source", "mode", "expected", "trim"]);
  if (scopeOf(g) !== "sample")
    errors.push('scope: an equals gate checks each sample; use "scope": "sample"');
  if (g.source !== undefined && !SOURCES.includes(g.source))
    errors.push(`source: expected one of ${SOURCES.join("|")}`);
  if (g.mode !== undefined && !MODES.includes(g.mode))
    errors.push(`mode: expected one of ${MODES.join("|")}`);
  if (g.trim !== undefined && typeof g.trim !== "boolean")
    errors.push("trim: expected true or false");
  if (g.mode === "bytes" && g.expected !== undefined && typeof g.expected !== "string")
    errors.push("expected: bytes mode compares against a string");
  return errors;
}

/** Text with line endings unified and (by default) outer whitespace trimmed. @param {string} s @param {boolean} trim */
const norm = (s, trim) => {
  const t = s.replace(/\r\n?/g, "\n");
  return trim ? t.trim() : t;
};

/** Where two texts first differ, for a readable reason. @param {string} a @param {string} b */
function firstDifference(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      const show = (/** @type {string | undefined} */ s) =>
        s === undefined ? "(missing)" : JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);
      return `line ${i + 1}: got ${show(al[i])}, expected ${show(bl[i])}`;
    }
  }
  return "outputs differ";
}

/** @param {import("./common.mjs").GateContext} ctx @returns {Promise<import("./common.mjs").GateResult>} */
export async function check(ctx) {
  const g = ctx.gate;
  const mode = g.mode ?? "text";
  const got = await readSource(ctx.sample, ctx.studyDir, g.source ?? "output");
  if (!got.ok) return errored(got.error.message);

  /** @type {Buffer | string | undefined} */
  let want;
  if (g.expected !== undefined)
    want = typeof g.expected === "string" ? g.expected : JSON.stringify(g.expected);
  else if (ctx.item?.expectedFile) {
    try {
      want = await readFile(path.join(ctx.workloadDir, ctx.item.expectedFile));
    } catch {
      return errored(`expected file ${ctx.item.expectedFile} is unreadable`);
    }
  }
  if (want === undefined)
    return errored(
      `item ${ctx.sample?.item} has no expectedFile and the gate has no expected value`,
    );

  if (mode === "bytes") {
    const wantBytes = Buffer.isBuffer(want) ? want : Buffer.from(want, "utf8");
    if (got.value.bytes.equals(wantBytes)) return pass(`${got.value.from} matches byte for byte`);
    return failed(
      `${got.value.from} differs (${got.value.bytes.length} bytes vs ${wantBytes.length} expected)`,
    );
  }
  const gotText = got.value.bytes.toString("utf8");
  const wantText = Buffer.isBuffer(want) ? want.toString("utf8") : want;
  if (mode === "json") {
    const a = parseJsonOutput(gotText);
    if (!a.ok) return failed(`${got.value.from} is not JSON`);
    const b =
      g.expected !== undefined && typeof g.expected !== "string"
        ? { ok: true, value: g.expected }
        : parseJsonOutput(wantText);
    if (!b.ok) return errored("expected value is not JSON");
    return canonicalJson(a.value) === canonicalJson(b.value)
      ? pass(`${got.value.from} has the expected JSON value`)
      : failed(`${got.value.from} JSON differs from the expected value`);
  }
  const trim = g.trim ?? true;
  const a = norm(gotText, trim);
  const b = norm(wantText, trim);
  return a === b
    ? pass(`${got.value.from} matches the expected text`)
    : failed(`${got.value.from} ${firstDifference(a, b)}`);
}
