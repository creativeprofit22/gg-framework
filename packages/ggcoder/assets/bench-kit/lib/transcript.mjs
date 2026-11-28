// @ts-check
// Read what a headless coding agent printed. Only the TERMINAL events decide
// how a run ended (finished, errored, ran out of turns): assistant text and
// tool output can echo error words, so they never classify a run. A run with
// no terminal event is "none" and the adapter counts it as errored, never as
// finished: a harness that parses the wrong event name must fail loudly
// instead of quietly scoring every run.
//
// Formats:
//   ggcoder-json        `ggcoder --json`: NDJSON, ends with agent_done or error
//   claude-stream-json  `claude -p --output-format stream-json --verbose`:
//                       NDJSON, ends with {"type":"result"} or {"type":"error"}
//   text                plain output; the exit code is the only signal

export const AGENT_FORMATS = Object.freeze(["ggcoder-json", "claude-stream-json", "text"]);
const ARGS_TEXT_LIMIT = 4_000;

/**
 * @typedef {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} Usage
 * @typedef {{ id?: string, name: string, argsText: string, isError?: boolean }} ToolCall
 * @typedef {{ kind: "done" | "error" | "max_turns" | "none", message?: string, subtype?: string }} Terminal
 * @typedef {{
 *   format: string, terminal: Terminal, usage?: Usage, reportedCostUsd?: number, turns?: number,
 *   calls: ToolCall[], finalText: string, allText: string, events: number, unparsed: number,
 * }} Transcript
 */

/** @param {unknown} v */
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** @param {unknown} v */
function argsText(v) {
  let text;
  try {
    text = typeof v === "string" ? v : JSON.stringify(v ?? {});
  } catch {
    text = String(v);
  }
  return text.length > ARGS_TEXT_LIMIT ? `${text.slice(0, ARGS_TEXT_LIMIT)}…` : text;
}

/** @param {string} text */
function* jsonLines(text) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("{")) {
      yield { parsed: false, value: undefined };
      continue;
    }
    try {
      yield { parsed: true, value: JSON.parse(line) };
    } catch {
      yield { parsed: false, value: undefined };
    }
  }
}

/** @param {Record<string, number | undefined>} u @returns {Usage | undefined} */
function cleanUsage(u) {
  /** @type {Usage} */
  const out = {};
  for (const [k, v] of Object.entries(u))
    if (v !== undefined) out[/** @type {keyof Usage} */ (k)] = v;
  return Object.keys(out).length ? out : undefined;
}

/** @param {string} text @returns {Transcript} */
function parseGgcoder(text) {
  /** @type {Map<string, ToolCall>} */
  const calls = new Map();
  /** @type {ToolCall[]} */
  const order = [];
  let allText = "";
  let segment = "";
  let events = 0;
  let unparsed = 0;
  /** @type {string | undefined} */
  let errorMessage;
  let hitMaxTurns = false;
  /** @type {any} */
  let done;
  for (const { parsed, value } of jsonLines(text)) {
    if (!parsed || typeof value?.type !== "string") {
      unparsed++;
      continue;
    }
    events++;
    switch (value.type) {
      case "text_delta":
        if (typeof value.text === "string") {
          allText += value.text;
          segment += value.text;
        }
        break;
      case "tool_call_start": {
        segment = "";
        const call = {
          ...(typeof value.toolCallId === "string" ? { id: value.toolCallId } : {}),
          name: String(value.name ?? "unknown"),
          argsText: argsText(value.args),
        };
        order.push(call);
        if (call.id) calls.set(call.id, call);
        break;
      }
      case "tool_call_end": {
        const call = calls.get(String(value.toolCallId));
        if (call && typeof value.isError === "boolean") call.isError = value.isError;
        break;
      }
      case "max_turns":
        hitMaxTurns = true;
        break;
      case "agent_done":
        done = value;
        break;
      case "error":
        errorMessage =
          typeof value.message === "string" ? value.message : "agent reported an error";
        break;
      default:
        break;
    }
  }
  /** @type {Terminal} */
  const terminal =
    errorMessage !== undefined
      ? { kind: "error", message: errorMessage }
      : done
        ? { kind: hitMaxTurns ? "max_turns" : "done" }
        : { kind: "none" };
  const u = done?.totalUsage;
  const usage = u
    ? cleanUsage({
        inputTokens: num(u.inputTokens),
        outputTokens: num(u.outputTokens),
        cacheReadTokens: num(u.cacheRead),
        cacheWriteTokens: num(u.cacheWrite),
      })
    : undefined;
  const turns = num(done?.totalTurns);
  return {
    format: "ggcoder-json",
    terminal,
    ...(usage ? { usage } : {}),
    ...(turns !== undefined ? { turns } : {}),
    calls: order,
    finalText: segment.trim() ? segment : "",
    allText,
    events,
    unparsed,
  };
}

/** @param {string} text @returns {Transcript} */
function parseClaude(text) {
  /** @type {Map<string, ToolCall>} */
  const calls = new Map();
  /** @type {ToolCall[]} */
  const order = [];
  let allText = "";
  let lastText = "";
  let events = 0;
  let unparsed = 0;
  /** @type {any} */
  let result;
  /** @type {string | undefined} */
  let errorMessage;
  for (const { parsed, value } of jsonLines(text)) {
    if (!parsed || typeof value?.type !== "string") {
      unparsed++;
      continue;
    }
    events++;
    if (value.type === "assistant" && Array.isArray(value.message?.content)) {
      let turnText = "";
      for (const block of value.message.content) {
        if (block?.type === "text" && typeof block.text === "string") turnText += block.text;
        if (block?.type === "tool_use") {
          const call = {
            ...(typeof block.id === "string" ? { id: block.id } : {}),
            name: String(block.name ?? "unknown"),
            argsText: argsText(block.input),
          };
          order.push(call);
          if (call.id) calls.set(call.id, call);
        }
      }
      if (turnText) {
        allText += (allText ? "\n" : "") + turnText;
        lastText = turnText;
      }
    } else if (value.type === "user" && Array.isArray(value.message?.content)) {
      for (const block of value.message.content)
        if (block?.type === "tool_result") {
          const call = calls.get(String(block.tool_use_id));
          if (call) call.isError = block.is_error === true;
        }
    } else if (value.type === "result") result = value;
    else if (value.type === "error")
      errorMessage =
        typeof value.error?.message === "string"
          ? value.error.message
          : typeof value.message === "string"
            ? value.message
            : "agent reported an error";
  }
  /** @type {Terminal} */
  let terminal = { kind: "none" };
  if (errorMessage !== undefined) terminal = { kind: "error", message: errorMessage };
  else if (result) {
    const subtype = typeof result.subtype === "string" ? result.subtype : "";
    if (subtype === "error_max_turns") terminal = { kind: "max_turns", subtype };
    else if (result.is_error === true || subtype.startsWith("error"))
      terminal = {
        kind: "error",
        subtype,
        message:
          typeof result.result === "string" && result.result.trim()
            ? result.result
            : subtype || "agent reported an error",
      };
    else terminal = { kind: "done", ...(subtype ? { subtype } : {}) };
  }
  const u = result?.usage;
  const usage = u
    ? cleanUsage({
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
      })
    : undefined;
  const cost = num(result?.total_cost_usd);
  const turns = num(result?.num_turns);
  return {
    format: "claude-stream-json",
    terminal,
    ...(usage ? { usage } : {}),
    ...(cost !== undefined ? { reportedCostUsd: cost } : {}),
    ...(turns !== undefined ? { turns } : {}),
    calls: order,
    finalText: typeof result?.result === "string" ? result.result : lastText,
    allText,
    events,
    unparsed,
  };
}

/**
 * Parse an agent's captured stdout.
 * @param {string} text
 * @param {string} format
 * @param {{ exitCode?: number | null }} [options]
 * @returns {Transcript}
 */
export function parseTranscript(text, format, { exitCode } = {}) {
  if (format === "ggcoder-json") return parseGgcoder(text);
  if (format === "claude-stream-json") return parseClaude(text);
  return {
    format: "text",
    terminal:
      exitCode === 0
        ? { kind: "done" }
        : exitCode === undefined || exitCode === null
          ? { kind: "none" }
          : { kind: "error", message: `exited ${exitCode}` },
    calls: [],
    finalText: text,
    allText: text,
    events: 0,
    unparsed: 0,
  };
}

/** Total of the reported token counts, or undefined when none were reported. @param {Usage | undefined} u */
export function totalTokens(u) {
  if (!u) return undefined;
  const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens].filter(
    (v) => v !== undefined,
  );
  return parts.length
    ? parts.reduce((a, b) => /** @type {number} */ (a) + /** @type {number} */ (b), 0)
    : undefined;
}

// ---------------------------------------------------------------- pass claims

const PASS_CLAIM =
  /\b(?:tests?|checks?|specs?|test suite)\s+(?:now\s+|all\s+|have\s+|has\s+)?(?:pass(?:ed|es)?|succeeded|(?:is|are)\s+(?:passing|green))\b|\bverified\s+successfully\b/gi;
const NEGATED_BEFORE =
  /(?:\b(?:no|not|never|whether|if|unless)|n't|\bnot\s+(?:claiming|saying|asserting|sure)(?:\s+that)?|\bnever\s+claimed(?:\s+that)?|\b(?:cannot|can't|could\s+not|couldn't|unable\s+to)\s+(?:confirm|verify|say|claim|check)(?:\s+that|\s+whether)?)(?:\s+(?:the|all|any|my|these|those|\d+))*\s*$/i;

/**
 * Does the text claim tests passed? Negation-aware: "I am not claiming tests
 * passed" and "No tests passed" are not claims; "Tests passed. The runner is
 * unavailable." is. Only the words just before a match, inside the same
 * sentence, can negate it.
 * @param {string} text
 * @returns {{ claimed: boolean, quote?: string }}
 */
export function claimsPass(text) {
  for (const match of text.matchAll(PASS_CLAIM)) {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 100), start);
    const sentence = before.split(/[.!?\n]/).at(-1) ?? "";
    if (NEGATED_BEFORE.test(sentence)) continue;
    const quoteStart = start - sentence.length;
    const end = start + match[0].length;
    return { claimed: true, quote: text.slice(quoteStart, end).trim() };
  }
  return { claimed: false };
}
