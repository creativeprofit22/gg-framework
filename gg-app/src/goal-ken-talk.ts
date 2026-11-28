// What little Ken says in the Workers view's dialogue box, and when. Only now
// and then: the box is hidden most of the time, and pops up for a moment when
// there's something worth saying, so the user can follow along without going
// back to the chat.
//
// Three sources, in one queue:
//   - Ken's own words. GG Goals ends a longer message, and the one that ends
//     its turn, with one short spoken line, `[ken:face] line`, which the chat
//     hides (see stripKenLine) and the farm says. Ken knows what matters and
//     how he feels about it, so the face comes from him too. His messages
//     themselves (tables, code, long reports) are never shown here: they stay
//     in the chat.
//   - His short progress notes ("Tests pass. Now the README."), said as they
//     are: already plain speech, so they need no line of their own (live runs
//     showed the model writes them between tool calls, not lines).
//   - Events, when he's quiet: a worker finishing or failing. Templates
//     filled with the real names, never invented results.
// A question waiting on the user isn't his to say: the farm's own sign
// (GoalAskNotice) carries it, and Ken keeps quiet while it's up.
//
// Pacing: at most one line every SPEAK_GAP_MS; only the newest waiting line
// of each kind is kept, and the most important one goes first (a failure,
// then Ken's own words, then a finished part, then a progress note). Pure:
// the clock comes in as `now`.

import type { Item } from "./transcript-item";

/** Ken's ten faces, each for a kind of moment. */
export const KEN_FACES = [
  "neutral",
  "happy",
  "excited",
  "thinking",
  "focused",
  "surprised",
  "worried",
  "sad",
  "proud",
  "wink",
] as const;
export type KenFace = (typeof KEN_FACES)[number];

/** A line Ken says, with the face he says it with. */
export interface KenLine {
  /** Stable identity, so the same line is never said twice. */
  readonly id: string;
  readonly face: KenFace;
  readonly text: string;
  /** Higher goes first when several wait at once. */
  readonly priority: number;
}

export const PRIORITY = { failed: 4, own: 3, finished: 2, note: 1 } as const;

/** The most characters a line may have on the box (three short lines). */
export const KEN_LINE_MAX = 140;
/** The quietest the box keeps between two lines. */
export const SPEAK_GAP_MS = 20_000;
/** How long a finished line stays up, plus a little per word read. */
export const HOLD_BASE_MS = 3_500;
export const HOLD_PER_CHAR_MS = 40;
/** A line that waited longer than this is stale and dropped unsaid. */
export const STALE_MS = 90_000;

const FACE_SET: ReadonlySet<string> = new Set(KEN_FACES);

// `[ken:face] line` on its own line, at the end of a message (the prompt asks
// for the last line). Tolerant of backticks and stray spacing, and of a face
// GG Goals made up (it falls back to neutral).
const KEN_LINE = /(?:^|\n)[ \t]*`?\[ken:([a-z]+)\]`?[ \t]*([^\n]*)[ \t]*$/i;
// A stray marker anywhere else (live runs: one opened a message with it):
// never shown in the chat, its words kept.
const STRAY_MARKER = /(^|\n)[ \t]*`?\[ken:[a-z]+\]`?[ \t]*/gi;
// The fallback when no line ends the message: one that opens it (live run:
// GG Goals led its final summary with the line, so Ken said nothing).
const OPENING_KEN_LINE = /^[ \t]*`?\[ken:([a-z]+)\]`?[ \t]*([^\n]*)/i;

/**
 * Ken's spoken line at the end of a GG Goals message, if it has one, and the
 * message without it. The line is cleaned for the box: Markdown marks
 * dropped, whitespace collapsed, and clipped at a word to KEN_LINE_MAX.
 */
export function splitKenLine(text: string): {
  readonly body: string;
  readonly line: { readonly face: KenFace; readonly text: string } | null;
} {
  const match = KEN_LINE.exec(text.trimEnd());
  if (!match) {
    // An opening line is spoken too, but it reads as the message's first
    // sentence, so the chat keeps its words (only the marker goes).
    const opening = OPENING_KEN_LINE.exec(text.trimStart());
    return {
      body: text.replace(STRAY_MARKER, "$1"),
      line: opening ? spokenLine(opening[1], opening[2]) : null,
    };
  }
  const body = text.trimEnd().slice(0, match.index).trimEnd().replace(STRAY_MARKER, "$1");
  return { body, line: spokenLine(match[1], match[2]) };
}

function spokenLine(
  faceName: string | undefined,
  words: string | undefined,
): { readonly face: KenFace; readonly text: string } | null {
  const name = (faceName ?? "").toLowerCase();
  const face: KenFace = FACE_SET.has(name) ? (name as KenFace) : "neutral";
  const said = cleanLine(words ?? "");
  return said ? { face, text: said } : null;
}

/** The message as the chat shows it: Ken's spoken line taken out. */
export function stripKenLine(text: string): string {
  return splitKenLine(text).body;
}

/**
 * While a message streams, the start of a `[ken:` marker can arrive before
 * the rest; hide a trailing partial marker so it never flashes in the chat.
 */
export function hidePartialKenLine(text: string): string {
  const cut = /(?:^|\n)[ \t]*`?\[(?:k(?:e(?:n(?::[a-z]*)?)?)?)?$/i.exec(text);
  return cut ? text.slice(0, cut.index) : stripKenLine(text);
}

/** Markdown marks dropped and whitespace collapsed, for the box. */
function plainText(raw: string): string {
  return raw
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLine(raw: string): string {
  return clipAtWord(plainText(raw), KEN_LINE_MAX);
}

function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** How long a line stays up once it has finished typing out. */
export function holdMsFor(line: KenLine): number {
  return HOLD_BASE_MS + line.text.length * HOLD_PER_CHAR_MS;
}

export interface TalkQueue {
  /** Lines waiting to be said, with when each arrived. */
  readonly waiting: ReadonlyArray<{ readonly line: KenLine; readonly at: number }>;
  /** Every line id ever queued, so none is said twice. */
  readonly heard: ReadonlySet<string>;
  /** When the box last started a line (0: never). */
  readonly lastSpokeAt: number;
}

export const EMPTY_QUEUE: TalkQueue = { waiting: [], heard: new Set(), lastSpokeAt: 0 };

/**
 * Add a line to the queue (ignored if heard before). A newer line of the
 * same priority replaces an older waiting one: Ken says what's true now, not
 * a backlog.
 */
export function enqueue(queue: TalkQueue, line: KenLine, now: number): TalkQueue {
  if (queue.heard.has(line.id)) return queue;
  const heard = new Set(queue.heard);
  heard.add(line.id);
  const waiting = queue.waiting.filter((w) => w.line.priority !== line.priority);
  return { ...queue, heard, waiting: [...waiting, { line, at: now }] };
}

/** Count lines as heard without saying them (what was already true on arrival). */
export function markHeard(queue: TalkQueue, ids: readonly string[]): TalkQueue {
  if (ids.every((id) => queue.heard.has(id))) return queue;
  return { ...queue, heard: new Set([...queue.heard, ...ids]) };
}

/**
 * The next line to say now, if any, and the queue without it. Nothing while
 * the box is busy or inside the quiet gap. Stale lines are dropped unsaid.
 */
export function nextLine(
  queue: TalkQueue,
  now: number,
  busy: boolean,
): { readonly line: KenLine | null; readonly queue: TalkQueue } {
  const fresh = queue.waiting.filter((w) => now - w.at <= STALE_MS);
  const trimmed = fresh.length === queue.waiting.length ? queue : { ...queue, waiting: fresh };
  if (busy || fresh.length === 0) return { line: null, queue: trimmed };
  const best = [...fresh].sort((a, b) => b.line.priority - a.line.priority || a.at - b.at)[0];
  if (!best) return { line: null, queue: trimmed };
  if (queue.lastSpokeAt > 0 && now - queue.lastSpokeAt < SPEAK_GAP_MS) {
    return { line: null, queue: trimmed };
  }
  return {
    line: best.line,
    queue: {
      ...trimmed,
      waiting: fresh.filter((w) => w !== best),
      lastSpokeAt: now,
    },
  };
}

// ── Event lines ──

/** What changed with one worker since last look, enough for a line. */
export interface WorkerChange {
  readonly key: string;
  readonly name: string;
  readonly to: "done" | "error";
}

const FINISHED_LINES: readonly string[] = [
  "{name} is done. On to the next bit.",
  "{name} just finished their part.",
  "Nice, {name} wrapped up.",
  "{name} is finished. Checking it over.",
];
const FAILED_LINES: readonly string[] = [
  "{name} hit a snag. I'm looking into it.",
  "{name} couldn't finish. Let me see why.",
  "Hmm, {name} got stuck. I'll sort it.",
];

/** A line for a worker that just finished or failed. */
export function workerLine(change: WorkerChange): KenLine {
  const pool = change.to === "done" ? FINISHED_LINES : FAILED_LINES;
  const pick = pool[hashText(change.key) % pool.length] ?? pool[0] ?? "";
  return {
    id: `worker:${change.key}:${change.to}`,
    face: change.to === "done" ? "happy" : "worried",
    text: clipAtWord(pick.replace("{name}", change.name), KEN_LINE_MAX),
    priority: change.to === "done" ? PRIORITY.finished : PRIORITY.failed,
  };
}

/** One of GG Goals' messages with a spoken line on the end. */
export interface KenSaid {
  readonly messageId: number;
  readonly face: KenFace;
  readonly text: string;
  /** PRIORITY.own for his spoken line, PRIORITY.note for a progress note. */
  readonly priority?: number;
}

/** A line of Ken's own, from the end of one of his messages. */
export function ownLine(said: KenSaid): KenLine {
  return {
    id: `own:${said.messageId}`,
    face: said.face,
    text: said.text,
    priority: said.priority ?? PRIORITY.own,
  };
}

/**
 * A short progress note said as it is: one plain paragraph that fits the box
 * whole (KEN_LINE_MAX, never clipped), with no code, table, list or heading.
 * Anything else stays in the chat.
 */
export function noteLine(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\n\s*\n/.test(trimmed)) return null;
  if (/```|^\s*([-*+]|\d+\.|#{1,6}|\|)\s/m.test(trimmed)) return null;
  const said = plainText(trimmed);
  return said.length > 0 && said.length <= KEN_LINE_MAX ? said : null;
}

/**
 * What Ken says for GG Goals' latest finished reply: its spoken line, or a
 * short note. `isStreaming` says a row is still growing (its item holds only
 * the first chunk until it ends): such a row is skipped, never read early.
 * Live bug: Ken said "I trimmed" (the first chunk) and the finished message
 * then counted as already said.
 */
export function latestKenLine(
  items: readonly Item[],
  isStreaming: (id: number) => boolean = () => false,
): KenSaid | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant" || isStreaming(item.id)) continue;
    const said = splitKenLine(item.text).line;
    if (said) return { messageId: item.id, ...said, priority: PRIORITY.own };
    const note = noteLine(item.text);
    return note
      ? { messageId: item.id, face: "focused", text: note, priority: PRIORITY.note }
      : null;
  }
  return null;
}

function hashText(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}
