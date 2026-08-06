// Shared bench helpers — auth, measured turns, stats.
// Run from repo root: node bench/<script>.mjs
import { randomUUID } from "node:crypto";

const AI = await import("../packages/gg-ai/dist/index.js");
const CORE = await import("../packages/gg-core/dist/index.js");

export const { stream } = AI;

let cachedCreds = null;
export async function openaiCreds() {
  if (cachedCreds) return cachedCreds;
  const auth = new CORE.AuthStorage();
  cachedCreds = await auth.resolveCredentials("openai");
  return cachedCreds;
}

export const MODEL = "gpt-5.5";

export function estTokens(str) {
  return Math.ceil(str.length / 4);
}

export function freshCacheKey() {
  return `bench-${randomUUID()}`;
}

/**
 * One measured LLM turn. Returns { ttftMs, totalMs, text, usage, toolCalls }.
 * Tool calls are recorded but never executed.
 */
export async function measuredTurn({ messages, tools, maxTokens = 80, promptCacheKey, thinking }) {
  const creds = await openaiCreds();
  const t0 = Date.now();
  let ttftMs = 0;
  let text = "";
  const toolCalls = [];
  const s = stream({
    provider: "openai",
    model: MODEL,
    apiKey: creds.accessToken,
    accountId: creds.accountId,
    messages,
    ...(tools ? { tools } : {}),
    maxTokens,
    ...(promptCacheKey ? { promptCacheKey } : {}),
    ...(thinking ? { thinking } : {}),
  });
  for await (const ev of s) {
    if ((ev.type === "text_delta" || ev.type === "thinking_delta") && !ttftMs) {
      ttftMs = Date.now() - t0;
    }
    if (ev.type === "text_delta") text += ev.text;
    // gg-ai emits `toolcall_done` with { id, name, args } inline. This listened
    // for a `toolcall_end` event that does not exist, so `toolCalls` was always
    // empty and any bench measuring tool use silently reported zero.
    if (ev.type === "toolcall_done") toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
  }
  const resp = await s;
  return { ttftMs, totalMs: Date.now() - t0, text, usage: resp.usage ?? {}, toolCalls, response: resp };
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function fmt(n, d = 0) {
  return n.toFixed(d);
}
export function pct(part, whole) {
  return whole > 0 ? (100 * part) / whole : 0;
}

export function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
