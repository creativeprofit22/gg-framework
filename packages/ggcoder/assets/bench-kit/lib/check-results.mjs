// @ts-check
// Read per-test results from a test runner's output, in a declared format:
//
//   tap    TAP 13/14 (node --test --test-reporter=tap, many others). Nested
//          subtests become "suite > test".
//   junit  JUnit XML (node --test-reporter=junit, vitest, jest-junit,
//          pytest --junitxml). Nested <testsuite> names become "suite > test".
//   json   the last JSON object printed: {"tests": {"name": "pass"}} or
//          {"tests": [{"name": "...", "status": "pass"}]}
//
// A test is looked up by its full id first, then by its own name. If one
// name matches several results, every match must pass.
import { parseJsonOutput } from "./sample-io.mjs";
import { err, ok } from "./result.mjs";

/**
 * @typedef {"pass" | "fail" | "skip"} TestStatus
 * @typedef {{ id: string, name: string, status: TestStatus }} TestResult
 */

/** @param {string} s */
const unescapeTap = (s) => s.replace(/\\([\\#])/g, "$1");

/**
 * @param {string} text
 * @returns {TestResult[]}
 */
export function parseTap(text) {
  /** @type {TestResult[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [];
  let yamlIndent = -1;
  for (const raw of text.split(/\r?\n/)) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (yamlIndent >= 0) {
      if (line === "..." && indent <= yamlIndent + 2) yamlIndent = -1;
      continue;
    }
    if (line === "---") {
      yamlIndent = indent;
      continue;
    }
    const level = Math.floor(indent / 4);
    const subtest = /^# Subtest: (.*)$/.exec(line);
    if (subtest) {
      stack.length = level;
      stack[level] = unescapeTap(/** @type {string} */ (subtest[1]));
      continue;
    }
    const m = /^(not ok|ok)\b(?:\s+\d+)?(?:\s+-)?\s*(.*)$/.exec(line);
    if (!m) continue;
    let desc = /** @type {string} */ (m[2]);
    /** @type {string | undefined} */
    let directive;
    const hash = /(^|[^\\])#\s*(SKIP|TODO)\b.*$/i.exec(desc);
    if (hash) {
      directive = /** @type {string} */ (hash[2]).toUpperCase();
      desc = desc.slice(0, hash.index + /** @type {string} */ (hash[1]).length);
    }
    const name = unescapeTap(desc.trim());
    const id = [...stack.slice(0, level), name].join(" > ");
    /** @type {TestStatus} */
    const status = directive ? "skip" : m[1] === "ok" ? "pass" : "fail";
    out.push({ id, name, status });
    stack.length = level;
  }
  return out;
}

/** @param {string} s */
const decodeXml = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** @param {string} attrs @param {string} name */
function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeXml(m[2] ?? m[3] ?? "") : undefined;
}

/**
 * @param {string} xml
 * @returns {TestResult[]}
 */
export function parseJunit(xml) {
  /** @type {TestResult[]} */
  const out = [];
  /** @type {string[]} */
  const suites = [];
  const token =
    /<testsuite\b([^>]*?)(\/?)>|<\/testsuite\s*>|<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g;
  for (const m of xml.matchAll(token)) {
    if (m[0].startsWith("</testsuite")) {
      suites.pop();
      continue;
    }
    if (m[0].startsWith("<testsuite")) {
      if (m[2] !== "/") suites.push(attr(m[1] ?? "", "name") ?? "");
      continue;
    }
    const attrs = m[3] ?? "";
    const name = attr(attrs, "name");
    if (name === undefined) continue;
    const body = m[4] ?? "";
    /** @type {TestStatus} */
    const status = /<(failure|error)\b/.test(body)
      ? "fail"
      : /<skipped\b/.test(body)
        ? "skip"
        : "pass";
    out.push({ id: [...suites.filter(Boolean), name].join(" > "), name, status });
  }
  return out;
}

/** @param {unknown} s @returns {TestStatus | undefined} */
function normalizeStatus(s) {
  const v = String(s).toLowerCase();
  if (["pass", "passed", "ok", "success"].includes(v)) return "pass";
  if (["fail", "failed", "error", "errored"].includes(v)) return "fail";
  if (["skip", "skipped", "todo", "pending"].includes(v)) return "skip";
  return undefined;
}

/**
 * @param {string} text
 * @returns {TestResult[]}
 */
export function parseJsonResults(text) {
  const json = parseJsonOutput(text);
  if (!json.ok) return [];
  const tests = /** @type {any} */ (json.value)?.tests;
  /** @type {TestResult[]} */
  const out = [];
  if (Array.isArray(tests)) {
    for (const t of tests) {
      const status = normalizeStatus(t?.status);
      if (typeof t?.name === "string" && status) out.push({ id: t.name, name: t.name, status });
    }
  } else if (tests && typeof tests === "object") {
    for (const [name, s] of Object.entries(tests)) {
      const status = normalizeStatus(s);
      if (status) out.push({ id: name, name, status });
    }
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} format
 * @returns {import("./result.mjs").Result<TestResult[]>}
 */
export function parseResults(text, format) {
  if (format === "tap") return ok(parseTap(text));
  if (format === "junit") return ok(parseJunit(text));
  if (format === "json") return ok(parseJsonResults(text));
  return err("FORMAT_UNKNOWN", `unknown test result format ${format}`);
}

/**
 * Status of one wanted test: its full id first, then its own name.
 * @param {TestResult[]} results
 * @param {string} wanted
 * @returns {TestStatus | "missing"}
 */
export function statusOf(results, wanted) {
  let hits = results.filter((r) => r.id === wanted);
  if (hits.length === 0) hits = results.filter((r) => r.name === wanted);
  if (hits.length === 0) return "missing";
  if (hits.some((r) => r.status === "fail")) return "fail";
  if (hits.some((r) => r.status === "skip")) return "skip";
  return "pass";
}
