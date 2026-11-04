#!/usr/bin/env node
// Sweep ledger: works out which plan.json files and line ranges each sweep helper really read,
// from the helper's saved session (tool calls and results written by the engine), and names a
// cause for everything left unread. Node built-ins only.
//
// Trust: coverage comes only from session files that helpers.json points to and that start with
// a valid session header. The receipt and the helper's own report can lower coverage, never
// raise it. A helper with write access could still fake a session file; ruling that out would
// need engine signing.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import {
  SCHEMA_VERSION,
  TIERS,
  checkCoverage,
  packChunks,
  toPosixRelative,
} from "./sweep-plan.mjs";

export const GENERATED_BY = "sweep-ledger";
// Precedence order: the first cause that applies to an unread range wins.
export const CAUSES = Object.freeze([
  "changed-since-plan",
  "never-assigned",
  "evidence-unreadable",
  "helper-failed",
  "helper-timed-out",
  "helper-skipped",
]);
const MAX_REDIRECT_BYTES = 4096;
const MAX_REDIRECT_HOPS = 4;
const MAX_CHAIN_FILES = 64;
const HEADER_SNIFF_BYTES = 65536;
const DETAIL_MAX_CHARS = 160;
const STORAGE_CUT_PREFIX = "[Session storage truncated this tool result.";
const LOOP_CUT_RE = /^\[\.\.\. \d+ characters (?:omitted|trimmed)/;
const NUMBERED_LINE_RE = /^(?:[0-9a-f]{4}│)?\s*(\d+)\t/;
const OVERSIZED_RE = /^\[Line (\d+) is too long to show/;
const RECEIPT_RE = /^Receipt \(\d+ calls?\):\s*/;
const UNOPENED_PREFIX = "Not opened by this helper:";
const MORE_RE = /^\+\d+ more$/;

const USAGE = `Usage: node sweep-ledger.mjs --plan <plan.json> --helpers <helpers.json>
       [--root <dir>] [--previous <ledger.json> [--previous-plan <old plan.json>]]
       [--automated-tier <tier>]... [--out <path>] [--final]
helpers.json: [{ agentId, chunk, state, error?, receipt?, transcript? }] from wait_agent.
--automated-tier: ranges of this tier (${TIERS.join(", ")}) get automated checks only; they
  are never unread or retried, and count as read only when a helper read them.
--previous-plan: the plan --previous was built for; reads carry only for files whose path,
  sha256 and range are unchanged in the new plan.
Exit codes: 0 every range read or automated, 1 usage, IO or invalid plan, 4 written but some
  ranges unread.`;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const clip = (s, max = DETAIL_MAX_CHARS) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lookup = (store, key) => (store instanceof Map ? store.get(key) : store?.[key]);
const unitKey = (p, start) => `${p}\0${start}`;
const toInt = (v) => {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return Number.isInteger(n) ? n : undefined;
};

// ── Ranges ────────────────────────────────────────────────

/** Sorted, merged copy; touching ranges (1-5, 6-9) join. */
export function mergeRanges(ranges) {
  const sorted = ranges
    .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end >= r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** Parts of start..end that no range covers. */
export function missingRanges(start, end, ranges) {
  const gaps = [];
  let next = start;
  for (const r of mergeRanges(ranges)) {
    if (r.end < next) continue;
    if (r.start > end) break;
    if (r.start > next) gaps.push({ start: next, end: Math.min(r.start - 1, end) });
    next = Math.max(next, r.end + 1);
    if (next > end) break;
  }
  if (next <= end) gaps.push({ start: next, end });
  return gaps;
}

const formatRanges = (ranges) =>
  ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(", ");

// ── Paths ─────────────────────────────────────────────────

/**
 * A tool's file argument as a root-relative POSIX path, or null outside the root. `platform` is
 * injected so Windows rules (drive letters, MSYS paths, any casing) test on every OS.
 */
export function normalizeToolPath(
  raw,
  cwd,
  root,
  platform = process.platform,
  home = os.homedir(),
) {
  if (typeof raw !== "string" || raw.trim() === "" || typeof root !== "string") return null;
  const win = platform === "win32";
  const lib = win ? path.win32 : path.posix;
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/") || (win && p.startsWith("~\\"))) p = home + p.slice(1);
  if (win) {
    const drive = /^(?:\/cygdrive\/|\/\/?)([a-zA-Z])(?=[\\/]|$)/.exec(p);
    if (drive) p = `${drive[1]}:/${p.slice(drive[0].length).replace(/^[\\/]+/, "")}`;
  }
  const base = typeof cwd === "string" && cwd !== "" ? cwd : root;
  const rel = lib.relative(lib.resolve(root), lib.resolve(base, p));
  if (rel === "" || rel === ".." || rel.startsWith(`..${lib.sep}`) || lib.isAbsolute(rel)) {
    return null;
  }
  return toPosixRelative(rel);
}

/** Plan path lookup; Windows matches ignore case. */
export function planPathIndex(plan, platform = process.platform) {
  const fold = platform === "win32" ? (p) => p.toLowerCase() : (p) => p;
  const byFolded = new Map(plan.files.map((f) => [fold(f.path), f.path]));
  return {
    find: (rel) => (typeof rel === "string" ? (byFolded.get(fold(rel)) ?? null) : null),
    endingWith: (tail) => {
      const t = fold(tail);
      return plan.files.map((f) => f.path).filter((p) => fold(p).endsWith(t));
    },
  };
}

// ── Receipt ───────────────────────────────────────────────

/** The read group and "Not opened" paths of an engine receipt. */
export function parseReceipt(text) {
  const result = {
    found: false,
    cutShort: false,
    reads: [],
    unopened: [],
    unopenedCutShort: false,
  };
  if (typeof text !== "string") return result;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const line = lines.find((l) => RECEIPT_RE.test(l));
  if (line === undefined) return result;
  result.found = true;
  const body = line.replace(RECEIPT_RE, "");
  if (body !== "no tool calls") {
    for (const part of body.split(" · ")) {
      if (MORE_RE.test(part)) {
        result.cutShort = true;
        continue;
      }
      const space = part.indexOf(" ");
      if (space === -1 || part.slice(0, space) !== "read") continue;
      for (const raw of part.slice(space + 1).split(", ")) {
        let target = raw.trim().replace(/ ×\d+$/, "");
        let outcome = "ok";
        if (target.endsWith(" ✗")) {
          outcome = "error";
          target = target.slice(0, -2);
        } else if (target.endsWith(" (unfinished)")) {
          outcome = "pending";
          target = target.slice(0, -" (unfinished)".length);
        }
        if (target !== "") result.reads.push({ target, outcome });
      }
    }
  }
  const unopened = lines.find((l) => l.startsWith(UNOPENED_PREFIX));
  if (unopened !== undefined) {
    for (const item of unopened.slice(UNOPENED_PREFIX.length).split(",")) {
      const p = item.trim();
      if (MORE_RE.test(p)) result.unopenedCutShort = true;
      else if (p !== "") result.unopened.push(p);
    }
  }
  return result;
}

// ── Session files ─────────────────────────────────────────

function redirectTarget(buf) {
  try {
    const value = JSON.parse(buf.toString("utf8"));
    const target = value?.target;
    if (value?.type !== "gg_session_redirect" || typeof target !== "string") return null;
    if (target !== path.basename(target) || target.includes("\\") || target.startsWith(".")) {
      return null;
    }
    return /\.jsonl(?:\.gz)?$/.test(target) ? target : null;
  } catch {
    return null;
  }
}

/** Session text after following redirect stubs and unzipping archives. */
function readSessionText(file) {
  let current = path.resolve(file);
  const seen = new Set();
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (seen.has(current)) return { ok: false, error: `session redirect loop at ${file}` };
    seen.add(current);
    let buf;
    try {
      buf = fs.readFileSync(current);
    } catch (error) {
      return { ok: false, error: `cannot read session ${current}: ${error.code ?? error.message}` };
    }
    const target = buf.length <= MAX_REDIRECT_BYTES ? redirectTarget(buf) : null;
    if (target !== null) {
      current = path.join(path.dirname(current), target);
      continue;
    }
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        buf = gunzipSync(buf);
      } catch (error) {
        return { ok: false, error: `cannot unzip session ${current}: ${error.message}` };
      }
    }
    return { ok: true, path: current, text: buf.toString("utf8") };
  }
  return { ok: false, error: `too many session redirects at ${file}` };
}

function validHeader(value) {
  return (
    isObject(value) &&
    value.type === "session" &&
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.cwd === "string"
  );
}

function parseSessionText(text, file) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let header;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    header = null;
  }
  if (!validHeader(header)) return { ok: false, error: `not a session file: ${file}` };
  const entries = [];
  let malformed = 0;
  for (const line of lines.slice(1)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  const problems = malformed > 0 ? [`${malformed} unreadable lines in ${file}`] : [];
  return { ok: true, header, entries, problems };
}

function loadSessionFile(file) {
  const read = readSessionText(file);
  if (!read.ok) return read;
  const parsed = parseSessionText(read.text, read.path);
  return parsed.ok ? { ...parsed, path: read.path } : parsed;
}

/** Header only; plain files read just their first block. */
function sniffHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEADER_SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    const gz = n >= 2 && head[0] === 0x1f && head[1] === 0x8b;
    const nl = head.indexOf(10);
    if (!gz && nl !== -1) {
      const value = JSON.parse(head.subarray(0, nl).toString("utf8"));
      return validHeader(value) ? { header: value, path: path.resolve(file) } : null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const full = loadSessionFile(file);
  return full.ok ? { header: full.header, path: full.path } : null;
}

function findParentFile(dir, parentId, conversationId) {
  const candidates = sessionNames(dir);
  const hint = parentId.slice(0, 8);
  const ordered = [
    ...candidates.filter((n) => n.includes(hint)),
    ...candidates.filter((n) => !n.includes(hint)),
  ];
  for (const name of ordered) {
    const found = sniffHeader(path.join(dir, name));
    if (
      found !== null &&
      found.header.id === parentId &&
      (found.header.conversationId ?? found.header.id) === conversationId
    ) {
      return found.path;
    }
  }
  return null;
}

function sessionNames(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /\.jsonl(?:\.gz)?$/.test(n) && !n.includes(".gg-session-tmp-"))
      .sort(cmp);
  } catch {
    return [];
  }
}

const generationOf = (header) => (Number.isInteger(header.generation) ? header.generation : 0);

/**
 * The newest later checkpoint of the same conversation in `dir`, or null. Compaction writes a
 * new file, but the engine hands out the first one. Ties go to the later sorted file name.
 */
function findNewestCheckpoint(dir, start) {
  const conversationId = start.header.conversationId ?? start.header.id;
  let best = null;
  for (const name of sessionNames(dir)) {
    const found = sniffHeader(path.join(dir, name));
    if (found === null || found.path === start.path || found.header.id === start.header.id) {
      continue;
    }
    if ((found.header.conversationId ?? found.header.id) !== conversationId) continue;
    const generation = generationOf(found.header);
    if (generation <= generationOf(start.header)) continue;
    if (best === null || generation >= best.generation) best = { generation, path: found.path };
  }
  return best === null ? null : best.path;
}

/** `newest` plus the earlier files it compacted from, oldest first. */
function walkBack(newest) {
  const problems = [...newest.problems];
  const conversationId = newest.header.conversationId ?? newest.header.id;
  const chain = [newest];
  const visited = new Set([newest.header.id]);
  let chainBroken = false;
  let current = newest;
  while (typeof current.header.parentSessionId === "string" && current.header.parentSessionId) {
    const parentId = current.header.parentSessionId;
    if (visited.has(parentId) || chain.length >= MAX_CHAIN_FILES) {
      problems.push(`session chain loops or is too long at ${parentId}`);
      chainBroken = true;
      break;
    }
    const parentFile = findParentFile(path.dirname(newest.path), parentId, conversationId);
    const parent = parentFile === null ? null : loadSessionFile(parentFile);
    if (parent === null || !parent.ok) {
      problems.push(
        parent === null
          ? `earlier session file ${parentId} (before compaction) not found`
          : parent.error,
      );
      chainBroken = true;
      break;
    }
    problems.push(...parent.problems);
    visited.add(parentId);
    chain.unshift(parent);
    current = parent;
  }
  return { chain, visited, problems, chainBroken };
}

/**
 * A helper's saved session with every checkpoint of its conversation (same folder), oldest
 * first: later files it compacted into, and earlier files it compacted from. Never throws;
 * problems are reported.
 */
export function loadSessionChain(transcriptPath) {
  const given = loadSessionFile(transcriptPath);
  if (!given.ok) {
    return {
      ok: false,
      header: null,
      entries: [],
      files: [],
      problems: [given.error],
      chainBroken: false,
    };
  }
  let walk = walkBack(given);
  const newerFile = findNewestCheckpoint(path.dirname(given.path), given);
  if (newerFile !== null) {
    const newer = loadSessionFile(newerFile);
    const newerWalk = newer.ok ? walkBack(newer) : null;
    if (newerWalk !== null && newerWalk.visited.has(given.header.id)) {
      walk = newerWalk;
    } else {
      walk.problems.push(
        newer.ok
          ? `later session file ${newerFile} does not lead back to ${given.header.id}`
          : newer.error,
      );
      walk.chainBroken = true;
    }
  }
  const { chain, problems, chainBroken } = walk;
  return {
    ok: true,
    header: chain[chain.length - 1].header,
    entries: chain.flatMap((c) => c.entries),
    files: chain.map((c) => c.path),
    problems,
    chainBroken,
  };
}

// ── Session content ───────────────────────────────────────

function messagesOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => isObject(e) && e.type === "message" && isObject(e.message))
    .map((e) => e.message);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function collectToolCalls(entries) {
  const calls = [];
  const seenIds = new Set();
  const results = new Map();
  for (const message of messagesOf(entries)) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isObject(block) || block.type !== "tool_call" || typeof block.id !== "string")
          continue;
        // A compacted child's newer file can repeat retained calls.
        if (seenIds.has(block.id)) continue;
        seenIds.add(block.id);
        calls.push({
          id: block.id,
          name: block.name,
          args: isObject(block.args) ? block.args : {},
        });
      }
    } else if (message.role === "tool" && Array.isArray(message.content)) {
      for (const result of message.content) {
        if (!isObject(result) || result.type !== "tool_result") continue;
        if (typeof result.toolCallId === "string" && !results.has(result.toolCallId)) {
          results.set(result.toolCallId, result);
        }
      }
    }
  }
  return { calls, results };
}

function trimEdge(lines, fromStart) {
  const out = [...lines];
  const pop = () => (fromStart ? out.shift() : out.pop());
  const peek = () => (fromStart ? out[0] : out[out.length - 1]);
  while (out.length > 0 && peek().trim() === "") pop();
  pop(); // the line the cut went through is only partly shown
  return out;
}

/** Which lines one read result showed the model. */
export function readSeen(text, { offset, capped = false } = {}) {
  const expected = offset !== undefined && offset > 0 ? offset : 1;
  const over = OVERSIZED_RE.exec(text.trimStart());
  if (over) {
    const n = Number(over[1]);
    if (n !== expected) {
      return { status: "failed", detail: `shown line ${n} is not the requested ${expected}` };
    }
    return { status: "ok", seen: [{ start: n, end: n }] };
  }
  const segments = [[]];
  let loopCut = false;
  let storageCut = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(STORAGE_CUT_PREFIX)) {
      storageCut = true;
      segments.push([]);
    } else if (LOOP_CUT_RE.test(line)) {
      loopCut = true;
      segments.push([]);
    } else {
      segments[segments.length - 1].push(line);
    }
  }
  const numbers = [];
  segments.forEach((segment, i) => {
    let lines = segment;
    if (i > 0) lines = trimEdge(lines, true);
    if (i < segments.length - 1) lines = trimEdge(lines, false);
    for (const line of lines) {
      const m = NUMBERED_LINE_RE.exec(line);
      if (m) numbers.push(Number(m[1]));
    }
  });
  if (numbers.length === 0) {
    const first = text.split("\n").find((l) => l.trim() !== "") ?? "empty result";
    return { status: "failed", detail: clip(first.trim()) };
  }
  if (numbers[0] !== expected) {
    return { status: "failed", detail: `shown lines start at ${numbers[0]}, not ${expected}` };
  }
  const runs = [];
  for (const n of numbers) {
    const last = runs[runs.length - 1];
    if (last && n === last.end + 1) last.end = n;
    else runs.push({ start: n, end: n });
  }
  const increasing = numbers.every((n, i) => i === 0 || n > numbers[i - 1]);
  // Storage cuts only shortened the saved copy; the model saw the middle. Loop caps did not.
  const exactRuns = capped || loopCut || !increasing || (runs.length > 1 && !storageCut);
  const seen = exactRuns
    ? mergeRanges(runs)
    : [{ start: numbers[0], end: numbers[numbers.length - 1] }];
  return { status: "ok", seen };
}

/** Every read call with what it showed: status ok, failed or pending. */
export function extractReads(entries) {
  const { calls, results } = collectToolCalls(entries);
  const reads = [];
  for (const call of calls) {
    if (call.name !== "read") continue;
    const filePath = typeof call.args.file_path === "string" ? call.args.file_path : call.args.path;
    const offset = toInt(call.args.offset);
    const limit = toInt(call.args.limit);
    const base = {
      toolCallId: call.id,
      filePath: typeof filePath === "string" ? filePath : null,
      offset: offset ?? null,
      limit: limit ?? null,
    };
    const result = results.get(call.id);
    if (result === undefined) {
      reads.push({ ...base, status: "pending", detail: "read never finished", seen: [] });
      continue;
    }
    const text = textOf(result.content);
    if (result.isError === true) {
      const first = text.split("\n").find((l) => l.trim() !== "") ?? "error";
      reads.push({ ...base, status: "failed", detail: clip(first.trim()), seen: [] });
      continue;
    }
    const shown = readSeen(text, { offset, capped: isObject(result.capped) });
    reads.push({
      ...base,
      status: shown.status,
      detail: shown.detail ?? null,
      seen: shown.seen ?? [],
    });
  }
  return reads;
}

/** First lines of every bash command, for the "used bash, not read" note. */
export function extractBashCommands(entries) {
  return collectToolCalls(entries)
    .calls.filter((c) => c.name === "bash" && typeof c.args.command === "string")
    .map((c) => c.args.command);
}

/** Text of the helper's last assistant message. */
export function finalReport(entries) {
  const messages = messagesOf(entries);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = textOf(m.content);
    if (text.trim() !== "") return text;
  }
  return "";
}

// ── Coverage claims ───────────────────────────────────────

const CLAIM_LINE_RE = /^(covered|checked|reviewed|read|clean)\s*:\s*(.+)$/i;
const CLAIM_ITEM_RE =
  /^(.+?)(?::(\d+)(?:\s*[-–]\s*(\d+))?|\s+\(lines?\s+(\d+)(?:\s*[-–]\s*(\d+))?\))?$/i;
const BLANKET_RES = [
  /\b(?:all|every)\b.*\b(?:files?|chunk|ranges?|pages?)\b.*\b(?:checked|clean|covered|reviewed|read)\b/i,
  /\b(?:checked|reviewed|read|covered)\b.*\b(?:all|every)\b.*\b(?:files?|chunk|ranges?|pages?)\b/i,
];
const NEGATION_RE = /\b(?:not|never|unable|couldn't|could not|didn't|did not|wasn't|weren't)\b/i;

/** Coverage claims in a helper's report: listed paths/ranges and blanket "all files" claims. */
export function parseCoverageClaims(report) {
  const claims = [];
  if (typeof report !== "string") return claims;
  for (const rawLine of report.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (line === "" || NEGATION_RE.test(line)) continue;
    if (BLANKET_RES.some((re) => re.test(line))) {
      claims.push({ kind: "all", text: line });
      continue;
    }
    const m = CLAIM_LINE_RE.exec(line);
    if (!m) continue;
    for (const rawItem of m[2].split(/[,;]\s*/)) {
      const item = rawItem.trim().replace(/[`'"]/g, "").replace(/\.$/, "").trim();
      const parts = CLAIM_ITEM_RE.exec(item);
      if (!parts) continue;
      const p = parts[1].trim();
      if (/\s/.test(p) || !/[./\\]/.test(p)) continue;
      const startText = parts[2] ?? parts[4];
      const endText = parts[3] ?? parts[5];
      const start = startText === undefined ? null : Number(startText);
      const end = start === null ? null : endText === undefined ? start : Number(endText);
      claims.push({ kind: "path", path: p, start, end, text: item });
    }
  }
  return claims;
}

// ── Ledger ────────────────────────────────────────────────

function planUnits(plan) {
  const units = [];
  for (const f of plan.files) {
    if (Array.isArray(f.pages)) {
      for (const pg of f.pages) {
        units.push({ path: f.path, tier: f.tier, start: pg.start, end: pg.end, chunk: pg.chunk });
      }
    } else {
      const start = f.lines === 0 ? 0 : 1;
      units.push({ path: f.path, tier: f.tier, start, end: f.lines, chunk: f.chunk });
    }
  }
  return units;
}

const unitLines = (u) => (u.start === 0 ? 0 : u.end - u.start + 1);
const isTimedOut = (h) => h.state === "timed_out" || /timed out after/i.test(h.error ?? "");

function previousRetryChunks(previous) {
  if (!isObject(previous)) return [];
  const all = [
    ...(Array.isArray(previous.retryHistory) ? previous.retryHistory : []),
    ...(Array.isArray(previous.retry) ? previous.retry : []),
  ];
  const byId = new Map();
  for (const c of all) if (isObject(c) && typeof c.id === "string") byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => cmp(a.id, b.id));
}

function previousReadUnits(previous, previousPlan, plan) {
  const read = new Map();
  if (!isObject(previous) || !Array.isArray(previous.files)) return read;
  // Across plans, only files with the same content hash in both plans can carry a read.
  const oldHashes =
    previousPlan === null
      ? null
      : new Map((previousPlan.files ?? []).map((f) => [f?.path, f?.sha256]));
  const newHashes = new Map(plan.files.map((f) => [f.path, f.sha256]));
  for (const f of previous.files) {
    if (oldHashes !== null) {
      const oldSha = oldHashes.get(f?.path);
      if (typeof oldSha !== "string" || oldSha !== newHashes.get(f?.path)) continue;
    }
    for (const r of Array.isArray(f?.ranges) ? f.ranges : []) {
      if (r?.status === "read")
        read.set(unitKey(f.path, r.start), { end: r.end, evidence: r.evidence });
    }
  }
  return read;
}

function evidenceSort(a, b) {
  return cmp(a.agentId, b.agentId) || cmp(a.toolCallId, b.toolCallId) || a.start - b.start;
}

function dedupeEvidence(list) {
  const seen = new Set();
  const out = [];
  for (const e of list.slice().sort(evidenceSort)) {
    const key = `${e.agentId}\0${e.toolCallId}\0${e.start}\0${e.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ agentId: e.agentId, toolCallId: e.toolCallId, start: e.start, end: e.end });
  }
  return out;
}

/**
 * Pure ledger builder. sessions: Map|object agentId → loadSessionChain result; currentHashes:
 * Map|object path → sha256 (null when the file is gone, missing when unchecked).
 */
export function buildLedger({
  plan,
  helpers = [],
  sessions = new Map(),
  currentHashes = new Map(),
  previous = null,
  previousPlan = null,
  automatedTiers = [],
  final = false,
  platform = process.platform,
  root,
  planSha256 = null,
  home = os.homedir(),
}) {
  const index = planPathIndex(plan, platform);
  const automated = new Set(automatedTiers);
  // Retry chunks of another plan point at its ranges, so they don't carry across plans.
  const retryHistory = previousPlan === null ? previousRetryChunks(previous) : [];
  const chunkEntries = new Map();
  for (const c of [...plan.chunks, ...retryHistory]) {
    if (!chunkEntries.has(c.id)) chunkEntries.set(c.id, c.entries ?? []);
  }
  const units = planUnits(plan);
  const unitByKey = new Map(units.map((u) => [unitKey(u.path, u.start), u]));
  const retriedKeys = new Set();
  for (const c of retryHistory) {
    for (const e of c.entries ?? []) retriedKeys.add(unitKey(e.path, e.start));
  }
  const fileByPath = new Map(plan.files.map((f) => [f.path, f]));
  const carried = previousReadUnits(previous, previousPlan, plan);

  const helperList = (Array.isArray(helpers) ? helpers : [])
    .map((h) => {
      const agentId = String(h.agentId);
      const chunk = String(h.chunk);
      const state = typeof h.state === "string" ? h.state : "unknown";
      const error = typeof h.error === "string" ? h.error : null;
      const session = lookup(sessions, agentId) ?? null;
      const sessionOk = session !== null && session.ok === true;
      const cwd = sessionOk ? session.header.cwd : root;
      const problems = [];
      if (!chunkEntries.has(chunk)) problems.push(`unknown chunk ${chunk}`);
      if (session === null) problems.push("no saved session");
      else problems.push(...(session.problems ?? []));
      const toPlan = (raw) => index.find(normalizeToolPath(raw, cwd, root, platform, home));
      const reads = sessionOk
        ? extractReads(session.entries).map((r) => ({ ...r, planPath: toPlan(r.filePath) }))
        : [];
      const unitKeys = new Set(
        (chunkEntries.get(chunk) ?? [])
          .map((e) => unitKey(e.path, e.start))
          .filter((k) => unitByKey.has(k)),
      );
      return {
        agentId,
        chunk,
        state,
        error,
        session,
        sessionOk,
        cwd,
        problems,
        toPlan,
        reads,
        bash: sessionOk ? extractBashCommands(session.entries) : [],
        report: sessionOk ? finalReport(session.entries) : "",
        receipt: parseReceipt(h.receipt),
        unitKeys,
      };
    })
    .sort((a, b) => cmp(a.agentId, b.agentId) || cmp(a.chunk, b.chunk));

  const receiptMatches = (h, target) =>
    target.startsWith("…") ? index.endingWith(target.slice(1)) : [h.toPlan(target)];
  const receiptNames = (h, p, okOnly) =>
    h.receipt.reads.some(
      (r) => (!okOnly || r.outcome === "ok") && receiptMatches(h, r.target).includes(p),
    );
  const okSeen = (h, p) =>
    h.reads.filter((r) => r.planPath === p && r.status === "ok").flatMap((r) => r.seen);
  const covers = (u, seen, hasOkRead) =>
    u.start === 0 ? hasOkRead : missingRanges(u.start, u.end, seen).length === 0;

  function helperCause(h, u) {
    if (!h.sessionOk) {
      if (h.receipt.found && !h.receipt.cutShort && !receiptNames(h, u.path, false)) {
        if (h.state !== "completed") {
          const detail = clip(`helper ${h.state}${h.error ? `: ${h.error}` : ""}`);
          return { cause: isTimedOut(h) ? "helper-timed-out" : "helper-failed", detail };
        }
        return {
          cause: "helper-skipped",
          detail: "the full receipt shows no read of this file (no saved session)",
        };
      }
      const why = h.session === null ? "no saved session" : (h.session.problems?.[0] ?? "");
      return {
        cause: "evidence-unreadable",
        detail: clip(`${why}; the receipt alone can't show which lines were read`),
      };
    }
    if (h.session.chainBroken) {
      return {
        cause: "evidence-unreadable",
        detail: "an earlier part of the session (before compaction) is missing",
      };
    }
    const fileReads = h.reads.filter((r) => r.planPath === u.path);
    if (fileReads.length === 0 && receiptNames(h, u.path, true)) {
      return {
        cause: "evidence-unreadable",
        detail: "the receipt shows a read of this file that the session doesn't have",
      };
    }
    if (h.state !== "completed") {
      const detail = clip(`helper ${h.state}${h.error ? `: ${h.error}` : ""}`);
      return { cause: isTimedOut(h) ? "helper-timed-out" : "helper-failed", detail };
    }
    const notes = [];
    if (fileReads.length === 0) notes.push("no read of this file");
    else {
      const seen = okSeen(h, u.path);
      if (u.start > 0) {
        const gaps = missingRanges(u.start, u.end, seen);
        if (gaps.length > 0) notes.push(`lines ${formatRanges(gaps)} not shown`);
      }
      const failed = fileReads.find((r) => r.status === "failed");
      if (failed) notes.push(`read failed: ${failed.detail}`);
      if (fileReads.some((r) => r.status === "pending")) notes.push("a read never finished");
    }
    const base = path.posix.basename(u.path);
    if (h.bash.some((c) => c.includes(base))) {
      notes.push("a bash command named this file, but only the read tool counts");
    }
    return { cause: "helper-skipped", detail: clip(notes.join("; ")) };
  }

  const rangesByPath = new Map();
  for (const u of units) {
    const key = unitKey(u.path, u.start);
    const file = fileByPath.get(u.path);
    const current = lookup(currentHashes, u.path);
    const changed = current !== undefined && current !== file.sha256;
    const assigned = helperList.filter((h) => h.unitKeys.has(key));
    const evidence = [];
    let hasOkRead = false;
    for (const h of assigned) {
      if (!h.sessionOk || h.state !== "completed") continue;
      for (const r of h.reads) {
        if (r.planPath !== u.path || r.status !== "ok") continue;
        hasOkRead = true;
        for (const s of r.seen) {
          const start = u.start === 0 ? 0 : Math.max(s.start, u.start);
          const end = u.start === 0 ? 0 : Math.min(s.end, u.end);
          if (start <= end)
            evidence.push({ agentId: h.agentId, toolCallId: r.toolCallId, start, end });
        }
      }
    }
    const prior = carried.get(key);
    const carriedRead = !changed && prior !== undefined && prior.end === u.end;
    if (carriedRead && Array.isArray(prior.evidence)) {
      evidence.push(
        ...prior.evidence.filter(
          (e) => isObject(e) && typeof e.agentId === "string" && typeof e.toolCallId === "string",
        ),
      );
    }
    const range = { start: u.start, end: u.end, chunk: u.chunk, status: "read" };
    const isRead = carriedRead || covers(u, evidence, hasOkRead);
    if (!isRead && automated.has(u.tier)) {
      range.status = "automated";
    } else if (!isRead) {
      range.status = "unread";
      if (changed) {
        range.cause = "changed-since-plan";
        range.detail = current === null ? "file is gone" : "file content changed since the plan";
      } else if (assigned.length === 0) {
        range.cause = "never-assigned";
        range.detail = "no helper was given this range";
      } else {
        const picks = assigned.map((h) => helperCause(h, u));
        picks.sort((a, b) => CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause));
        range.cause = picks[0].cause;
        range.detail = picks[0].detail;
      }
    }
    range.evidence = dedupeEvidence(evidence);
    if (!rangesByPath.has(u.path)) rangesByPath.set(u.path, []);
    rangesByPath.get(u.path).push({ ...range, key, unit: u });
  }

  const files = plan.files.map((f) => {
    const ranges = rangesByPath.get(f.path) ?? [];
    const read = ranges.filter((r) => r.status === "read").length;
    const unreadCount = ranges.filter((r) => r.status === "unread").length;
    let status = "partial";
    if (read === ranges.length) status = "read";
    else if (unreadCount === 0) status = "automated";
    else if (unreadCount === ranges.length) status = "unread";
    return {
      path: f.path,
      tier: f.tier,
      status,
      ranges: ranges.map(({ key: _key, unit: _unit, ...r }) => r),
    };
  });
  const allRanges = [...rangesByPath.values()].flat();

  const unbackedClaims = [];
  const flag = (agentId, claim, reason) => unbackedClaims.push({ agentId, claim, reason });
  for (const h of helperList) {
    for (const p of h.receipt.unopened) {
      flag(h.agentId, p, "named in the report but never opened (engine receipt)");
    }
    if (!h.sessionOk) continue;
    const helperUnits = [...h.unitKeys].map((k) => unitByKey.get(k));
    for (const claim of parseCoverageClaims(h.report)) {
      if (claim.kind === "all") {
        const unread = helperUnits.filter(
          (u) => !covers(u, okSeen(h, u.path), okSeen(h, u.path).length > 0),
        );
        if (unread.length > 0) {
          const shown = unread
            .slice(0, 3)
            .map((u) => `${u.path} ${u.start}-${u.end}`)
            .join(", ");
          const more = unread.length > 3 ? `, +${unread.length - 3} more` : "";
          flag(h.agentId, claim.text, `${unread.length} assigned ranges not read: ${shown}${more}`);
        }
        continue;
      }
      const planPath = h.toPlan(claim.path);
      if (planPath === null) {
        flag(h.agentId, claim.text, "not a file in the sweep plan");
        continue;
      }
      const mine = helperUnits.filter((u) => u.path === planPath);
      const file = fileByPath.get(planPath);
      const seen = okSeen(h, planPath);
      if (claim.start === null) {
        if (mine.length === 0) {
          flag(h.agentId, claim.text, "not assigned to this helper");
          continue;
        }
        const gaps = mine.flatMap((u) =>
          u.start === 0 ? [] : missingRanges(u.start, u.end, seen),
        );
        const emptyUnread = mine.some((u) => u.start === 0 && seen.length === 0);
        if (gaps.length > 0) {
          flag(h.agentId, claim.text, `lines ${formatRanges(gaps)} were not shown to this helper`);
        } else if (emptyUnread) {
          flag(h.agentId, claim.text, "the file was never read");
        }
        continue;
      }
      if (claim.start < 1 || claim.end < claim.start || claim.end > file.lines) {
        flag(h.agentId, claim.text, `not a valid range of this ${file.lines}-line file`);
        continue;
      }
      if (!mine.some((u) => u.start <= claim.end && u.end >= claim.start)) {
        flag(h.agentId, claim.text, "not assigned to this helper");
        continue;
      }
      const gaps = missingRanges(claim.start, claim.end, seen);
      if (gaps.length > 0) {
        flag(h.agentId, claim.text, `lines ${formatRanges(gaps)} were not shown to this helper`);
      }
    }
  }
  const claimKey = (c) => `${c.agentId}\0${c.claim}\0${c.reason}`;
  const uniqueClaims = [...new Map(unbackedClaims.map((c) => [claimKey(c), c])).values()].sort(
    (a, b) => cmp(a.agentId, b.agentId) || cmp(a.claim, b.claim) || cmp(a.reason, b.reason),
  );

  const unread = allRanges.filter((r) => r.status === "unread");
  const toRetry = final
    ? []
    : unread.filter((r) => r.cause !== "changed-since-plan" && !retriedKeys.has(r.key));
  const retryKeys = new Set(toRetry.map((r) => r.key));
  const usedIds = new Set(retryHistory.map((c) => c.id));
  const retry = packChunks(
    toRetry.map((r) => ({ ...r.unit, lines: unitLines(r.unit) })),
    plan.settings,
  ).map((c) => {
    let n = 1;
    let id;
    do {
      id = `retry-${c.tier}-${String(n++).padStart(3, "0")}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return { id, tier: c.tier, lines: c.lines, entries: c.entries };
  });
  const stillUnread = unread
    .filter((r) => !retryKeys.has(r.key))
    .map((r) => ({
      path: r.unit.path,
      start: r.start,
      end: r.end,
      cause: r.cause,
      detail: r.detail,
    }))
    .sort((a, b) => cmp(a.path, b.path) || a.start - b.start);

  const byCause = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  for (const r of unread) byCause[r.cause]++;
  const byTier = Object.fromEntries(
    TIERS.map((t) => [t, { files: 0, read: 0, partial: 0, unread: 0, automated: 0 }]),
  );
  for (const f of files) {
    const row = byTier[f.tier];
    if (row === undefined) continue;
    row.files++;
    row[f.status]++;
  }
  const automatedUnits = allRanges.filter((r) => r.status === "automated").length;
  const counts = {
    files: files.length,
    filesRead: files.filter((f) => f.status === "read").length,
    units: allRanges.length,
    read: allRanges.length - unread.length - automatedUnits,
    unread: unread.length,
    automated: automatedUnits,
    byCause,
    byTier,
  };

  const helperRows = helperList.map((h) => ({
    agentId: h.agentId,
    chunk: h.chunk,
    state: h.state,
    evidence: h.sessionOk ? "session" : h.receipt.found ? "receipt-only" : "none",
    receiptCutShort: h.receipt.cutShort,
    sessionFiles: h.sessionOk ? h.session.files : [],
    problems: h.problems,
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: GENERATED_BY,
    planSha256,
    final,
    counts,
    files,
    helpers: helperRows,
    unbackedClaims: uniqueClaims,
    retry,
    retryHistory,
    stillUnread,
  };
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k]]));
const pickChunk = (c) => ({
  ...pick(c, ["id", "tier", "lines"]),
  entries: (c.entries ?? []).map((e) => pick(e, ["path", "start", "end"])),
});

/** Fixed key order, 2-space JSON, trailing newline. */
export function serializeLedger(ledger) {
  const ordered = {
    ...pick(ledger, ["schemaVersion", "generatedBy", "planSha256", "final"]),
    counts: {
      ...pick(ledger.counts, ["files", "filesRead", "units", "read", "unread", "automated"]),
      byCause: pick(ledger.counts.byCause, CAUSES),
      byTier: Object.fromEntries(
        TIERS.map((t) => [
          t,
          pick(ledger.counts.byTier[t], ["files", "read", "partial", "unread", "automated"]),
        ]),
      ),
    },
    files: ledger.files.map((f) => ({
      ...pick(f, ["path", "tier", "status"]),
      ranges: f.ranges.map((r) => ({
        ...pick(r, ["start", "end", "chunk", "status"]),
        ...(r.cause === undefined ? {} : pick(r, ["cause", "detail"])),
        evidence: r.evidence.map((e) => pick(e, ["agentId", "toolCallId", "start", "end"])),
      })),
    })),
    helpers: ledger.helpers.map((h) =>
      pick(h, [
        "agentId",
        "chunk",
        "state",
        "evidence",
        "receiptCutShort",
        "sessionFiles",
        "problems",
      ]),
    ),
    unbackedClaims: ledger.unbackedClaims.map((c) => pick(c, ["agentId", "claim", "reason"])),
    retry: ledger.retry.map(pickChunk),
    retryHistory: ledger.retryHistory.map(pickChunk),
    stillUnread: ledger.stillUnread.map((s) =>
      pick(s, ["path", "start", "end", "cause", "detail"]),
    ),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ── CLI ───────────────────────────────────────────────────

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function gitTopLevel(start) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return path.resolve(out.trim());
  } catch {
    return null;
  }
}

function validHelpers(value) {
  if (!Array.isArray(value)) return "helpers file must hold a JSON array";
  for (const [i, h] of value.entries()) {
    if (!isObject(h)) return `helper ${i} is not an object`;
    if (typeof h.agentId !== "string" || h.agentId === "") return `helper ${i} has no agentId`;
    if (typeof h.chunk !== "string" || h.chunk === "") return `helper ${i} has no chunk`;
    for (const key of ["state", "error", "receipt", "transcript"]) {
      if (h[key] !== undefined && h[key] !== null && typeof h[key] !== "string") {
        return `helper ${i} ${key} must be a string`;
      }
    }
  }
  return null;
}

/** CLI entry; returns the exit code. */
export function main(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const say = (s) => (io.stdout ?? process.stdout).write(`${s}\n`);
  const fail = (s) => (io.stderr ?? process.stderr).write(`${s}\n`);

  let args;
  try {
    args = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        plan: { type: "string" },
        helpers: { type: "string" },
        root: { type: "string" },
        previous: { type: "string" },
        "previous-plan": { type: "string" },
        "automated-tier": { type: "string", multiple: true },
        out: { type: "string" },
        final: { type: "boolean" },
        help: { type: "boolean" },
      },
    }).values;
  } catch (error) {
    fail(`sweep-ledger: ${error.message}\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.plan === undefined || args.helpers === undefined) {
    fail(`sweep-ledger: --plan and --helpers are required\n${USAGE}`);
    return 1;
  }
  if (args["previous-plan"] !== undefined && args.previous === undefined) {
    fail(`sweep-ledger: --previous-plan needs --previous\n${USAGE}`);
    return 1;
  }
  const automatedTiers = [...new Set(args["automated-tier"] ?? [])];
  const badTier = automatedTiers.find((t) => !TIERS.includes(t));
  if (badTier !== undefined) {
    fail(`sweep-ledger: unknown --automated-tier ${badTier}; expected one of ${TIERS.join(", ")}`);
    return 1;
  }

  const planPath = path.resolve(cwd, args.plan);
  const readJson = (file, what) => {
    try {
      const bytes = fs.readFileSync(file);
      return { ok: true, bytes, value: JSON.parse(bytes.toString("utf8")) };
    } catch (error) {
      fail(`sweep-ledger: cannot read ${what} ${file}: ${error.message}`);
      return { ok: false };
    }
  };
  const planRead = readJson(planPath, "plan");
  if (!planRead.ok) return 1;
  const plan = planRead.value;
  if (plan?.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `sweep-ledger: ${planPath} has schemaVersion ${plan?.schemaVersion}, expected ${SCHEMA_VERSION}`,
    );
    return 1;
  }
  const planProblems = checkCoverage(plan);
  if (planProblems.length > 0) {
    fail(`sweep-ledger: plan fails its coverage check (${planProblems.length} problems):`);
    for (const p of planProblems) fail(`  ${p}`);
    return 1;
  }
  const planSha256 = sha256(planRead.bytes);

  const helpersPath = path.resolve(cwd, args.helpers);
  const helpersRead = readJson(helpersPath, "helpers");
  if (!helpersRead.ok) return 1;
  const helperError = validHelpers(helpersRead.value);
  if (helperError !== null) {
    fail(`sweep-ledger: ${helpersPath}: ${helperError}`);
    return 1;
  }

  let previous = null;
  let previousPlan = null;
  if (args.previous !== undefined) {
    const prevRead = readJson(path.resolve(cwd, args.previous), "previous ledger");
    if (!prevRead.ok) return 1;
    previous = prevRead.value;
    let expectedSha = planSha256;
    if (args["previous-plan"] !== undefined) {
      const oldPlanRead = readJson(path.resolve(cwd, args["previous-plan"]), "previous plan");
      if (!oldPlanRead.ok) return 1;
      const oldPlan = oldPlanRead.value;
      if (oldPlan?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(oldPlan?.files)) {
        fail("sweep-ledger: --previous-plan is not a sweep plan");
        return 1;
      }
      previousPlan = oldPlan;
      expectedSha = sha256(oldPlanRead.bytes);
    }
    if (previous?.generatedBy !== GENERATED_BY || previous?.planSha256 !== expectedSha) {
      fail(
        previousPlan === null
          ? "sweep-ledger: --previous is not a ledger for this plan"
          : "sweep-ledger: --previous is not a ledger for --previous-plan",
      );
      return 1;
    }
  }

  const start = path.resolve(cwd, args.root ?? ".");
  const root = gitTopLevel(start) ?? (args.root !== undefined ? start : null);
  if (root === null) {
    fail(`sweep-ledger: ${start} is not inside a git repository; pass --root`);
    return 1;
  }

  const currentHashes = new Map();
  for (const f of plan.files) {
    try {
      currentHashes.set(f.path, sha256(fs.readFileSync(path.join(root, f.path))));
    } catch {
      currentHashes.set(f.path, null);
    }
  }
  const sessions = new Map();
  for (const h of helpersRead.value) {
    if (typeof h.transcript === "string" && h.transcript !== "") {
      sessions.set(h.agentId, loadSessionChain(path.resolve(cwd, h.transcript)));
    }
  }

  let ledger;
  try {
    ledger = buildLedger({
      plan,
      helpers: helpersRead.value,
      sessions,
      currentHashes,
      previous,
      previousPlan,
      automatedTiers,
      final: args.final === true,
      platform: io.platform ?? process.platform,
      root,
      planSha256,
    });
  } catch (error) {
    fail(`sweep-ledger: ${error.message}`);
    return 1;
  }
  const outPath = args.out
    ? path.resolve(cwd, args.out)
    : path.join(path.dirname(planPath), "ledger.json");
  try {
    writeAtomic(outPath, serializeLedger(ledger));
  } catch (error) {
    fail(`sweep-ledger: cannot write ${outPath}: ${error.message}`);
    return 1;
  }
  const { counts } = ledger;
  const causes = CAUSES.filter((c) => counts.byCause[c] > 0)
    .map((c) => `${c} ${counts.byCause[c]}`)
    .join(", ");
  say(
    `sweep-ledger: ${counts.read}/${counts.units} ranges read (${counts.filesRead}/${counts.files} files)` +
      (counts.automated > 0 ? `; ${counts.automated} automated checks only` : "") +
      (causes ? `; unread: ${causes}` : ""),
  );
  if (ledger.unbackedClaims.length > 0) {
    say(`sweep-ledger: ${ledger.unbackedClaims.length} coverage claims not backed by reads`);
  }
  if (ledger.retry.length > 0) say(`sweep-ledger: ${ledger.retry.length} retry chunks`);
  if (ledger.stillUnread.length > 0)
    say(`sweep-ledger: ${ledger.stillUnread.length} ranges still unread`);
  say(`sweep-ledger: wrote ${outPath}`);
  return counts.unread > 0 ? 4 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = main(process.argv.slice(2));
}
