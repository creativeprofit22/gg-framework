import { stream, type Message, type Provider, type TextContent } from "@kenkaiiii/gg-ai";

/**
 * One piece of an enhanced prompt. A `text` segment is verbatim prose; a `term`
 * segment is a corrected technical term the model swapped in, carrying the
 * user's `original` phrasing (and an optional `note`) so the UI can teach the
 * difference via a tooltip.
 */
export type { PromptSegment } from "@kenkaiiii/gg-core/desktop-session-ux";
import type { PromptSegment } from "@kenkaiiii/gg-core/desktop-session-ux";

export interface EnhanceResult {
  /** The plain rewritten prompt — exactly what gets sent to the agent. */
  enhanced: string;
  /** The same prompt split into prose + corrected-term segments for the UI. */
  segments: PromptSegment[];
}

// Markers the model wraps each corrected term in. The delimiters are rare
// Unicode (U+27E6 ⟦, U+27E7 ⟧, U+00A6 ¦) — effectively impossible in normal
// prose, so parsing is unambiguous and the agent never sees raw markers (the
// sidecar strips them to plain text before the prompt is sent).
const OPEN = "\u27E6"; // ⟦
const CLOSE = "\u27E7"; // ⟧
const BAR = "\u00A6"; // ¦

export const ENHANCER_SYSTEM_PROMPT = `You rewrite a developer's rough request into a tight, well-structured prompt for a CODING AGENT, and you teach them the correct vocabulary as you go. You only rewrite it — never answer, plan, or implement the request, never ask the user questions, and never add code snippets.

The teaching part: when the user described something in plain or informal words that has a precise, conventional software-engineering name, use that real name AND wrap it so the user learns the term. This highlighting is the main point — using the right term but failing to wrap it is a miss.

Marker format — wrap each introduced technical term EXACTLY like this, with BOTH fields always present:
  ${OPEN}correct term${BAR}the user's own words for it${BAR}short note${CLOSE}
The third field (note) is an optional plain-language gloss and may be omitted: ${OPEN}correct term${BAR}the user's own words${CLOSE}. Never emit a marker without the user's-own-words field (no bare ${OPEN}term${CLOSE}). The user's-own-words field must quote the relevant part of THEIR phrasing, not a paraphrase.

Mark ONLY genuine vocabulary lessons — a real plain-words → established-technical-term upgrade, where the wrapped word is named software/CS jargon (e.g. debounce, throttle, lazy loading, caching, memoization, retry with backoff, concurrency, race, optimistic locking, idempotent, infinite scroll, virtualization, skeleton UI, mock/stub, persistence, WebSocket, cron job, deep copy, hot reload). Usually 0–3 per prompt, and often 0 — many requests have no jargon to teach, and that is fine. Do NOT wrap: plain descriptive English that is not a named technical concept (positions like "to the right of", directions, sizes, colors, "between", "reorder"), ordinary words (updates, changes, loading, bottom, the whole app), terms the user already used correctly, or generic rewording. If the only candidates are plain English, wrap nothing. When in doubt, leave it unwrapped.

Other rules:
- Keep it concise and easy to follow (usually 1–3 sentences). No preamble, no headings, no code fences, no commentary.
- Preserve every concrete detail the user gave (file names, numbers, identifiers, intent) and never invent requirements or scope.
- NEVER ask the user for clarification or more detail, and never replace their request with a question. If the request is too vague or trivial to add real terminology (e.g. "fix the bug", "make the button blue"), return it essentially unchanged with no markers — the result must always read as the user's own instruction to the agent, never a message back to the user.
- Output ONLY the rewritten prompt, with markers inline. Nothing else.`;

/**
 * Parse the model's marker-annotated output into clean segments + a plain
 * enhanced string. Strips code fences and a leading "Here's…" preamble first,
 * then splits on the term markers. Always returns at least one segment, so a
 * model that ignores the format still yields a usable cleaned-up prompt (just
 * with no highlighted terms).
 */
export function parseEnhanced(raw: string): EnhanceResult {
  let cleaned = stripWrapping(raw);
  // Robustness pass: a model may emit a malformed marker — most commonly a bare
  // ⟦term⟧ with no ¦original field (observed from Claude). Unwrap any ⟦…⟧ that
  // contains no ¦ down to its inner text BEFORE the main parse, so the literal
  // brackets never leak into the user-visible prompt (there's no original to
  // teach, so it simply becomes plain text).
  cleaned = cleaned.replace(
    new RegExp(`${OPEN}([^${BAR}${CLOSE}]*)${CLOSE}`, "g"),
    (_full, inner: string) => inner,
  );

  const segments: PromptSegment[] = [];
  // ⟦term¦original¦note⟧ — note (3rd field) optional. Term/original forbid the
  // delimiters so the match can't run past its closing bracket.
  const re = new RegExp(
    `${OPEN}([^${BAR}${CLOSE}]+)${BAR}([^${BAR}${CLOSE}]+)(?:${BAR}([^${CLOSE}]+))?${CLOSE}`,
    "g",
  );
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ kind: "text", text: cleaned.slice(lastIndex, m.index) });
    }
    const term = m[1].trim();
    const original = m[2].trim();
    const note = m[3]?.trim();
    segments.push({ kind: "term", text: term, original, ...(note ? { note } : {}) });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < cleaned.length) {
    segments.push({ kind: "text", text: cleaned.slice(lastIndex) });
  }
  // Final safety net: replace any orphan delimiter glyphs left by a malformed
  // marker with a space (not nothing) so degraded output never surfaces raw
  // ⟦ ⟧ ¦ characters NOR glues adjacent words together ("debounceprevent"),
  // then collapse the resulting double spaces.
  const stripOrphans = (s: string): string =>
    s.replace(new RegExp(`[${OPEN}${CLOSE}${BAR}]`, "g"), " ").replace(/ {2,}/g, " ");
  for (const seg of segments) {
    if (seg.kind === "text") seg.text = stripOrphans(seg.text);
  }
  const trimmed = segments.filter((s) => s.kind !== "text" || s.text.length > 0);
  if (trimmed.length === 0) {
    trimmed.push({ kind: "text", text: stripOrphans(cleaned) });
  }
  const enhanced = trimmed.map((s) => s.text).join("");
  return { enhanced, segments: trimmed };
}

/** Strip Markdown code fences and a leading "Here's…/Sure…" preamble line. */
function stripWrapping(raw: string): string {
  let text = raw.trim();
  // ```lang\n … \n``` → inner content.
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  // Drop a single conversational preamble line if the model added one.
  text = text.replace(/^(?:sure|okay|ok|here(?:'s| is)|here you go)[^\n]*:\s*\n+/i, "");
  return text.trim();
}

/**
 * Makes a one-off LLM call (no agent loop, no tools) to rewrite a draft prompt
 * into a tighter, terminology-correct version. Uses the ACTIVE provider/model
 * so the rewrite benefits from the strongest available terminology — unlike
 * session-title generation, which downshifts to a cheap model.
 */
export async function enhancePrompt(opts: {
  provider: Provider;
  model: string;
  prompt: string;
  /** Short project stack string (e.g. "Next.js, TypeScript, Tailwind CSS") used
   *  to bias terminology toward the user's stack. Omitted when unknown. */
  stack?: string;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  signal?: AbortSignal;
}): Promise<EnhanceResult> {
  // Append a one-line, fact-only stack hint so terminology is idiomatic to the
  // user's project (e.g. "reactive state" for React vs "goroutine" for Go),
  // without giving the enhancer any file/scope context to invent from.
  const system = opts.stack?.trim()
    ? `${ENHANCER_SYSTEM_PROMPT}\n\nProject stack: ${opts.stack.trim()}. Prefer terminology idiomatic to this stack, but never invent stack-specific files, APIs, or scope the user didn't mention.`
    : ENHANCER_SYSTEM_PROMPT;

  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: opts.prompt },
  ];

  const result = stream({
    provider: opts.provider,
    model: opts.model,
    messages,
    maxTokens: 700,
    // No temperature — the enhancer runs on whatever model is active, and some
    // (e.g. OpenAI reasoning models like gpt-5.5) reject the parameter outright.
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    accountId: opts.accountId,
    signal: opts.signal,
  });

  // Attach a no-op catch immediately to prevent Node's unhandled rejection
  // detection from firing in the microtask gap before our await hooks up.
  result.response.catch(() => {});

  const response = await result;
  const msg = response.message;
  const text =
    typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");

  return parseEnhanced(text);
}
