/**
 * Pure helpers behind Markdown tables: what kind of data a column holds, how
 * its cells sort, how a table copies out as Markdown or CSV, and how a date
 * reads relative to now. No DOM and no clock: callers pass `now` in.
 */

/** The hast shape these helpers read (structural, so react-markdown's nodes fit). */
export interface TableHastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: TableHastNode[];
  properties?: Record<string, unknown>;
}

/**
 * What a column holds, decided from every non-empty body cell:
 * - `rank`: a leading #/rank column of small integers;
 * - `num`: numbers, optionally with a unit or a k/M/B suffix;
 * - `date`: ISO dates (`2026-10-18`, optionally with a time);
 * - `id`: versions, commit hashes, issue refs and ticket keys;
 * - `text`: anything else.
 */
export type ColumnKind = "rank" | "num" | "date" | "id" | "text";

export type SortDirection = "asc" | "desc";

/** Text content of a hast node, in document order. */
export function hastText(node: TableHastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  return node.children.map(hastText).join("");
}

/** Direct element children with the given tag name. */
export function childElements(node: TableHastNode, tagName: string): TableHastNode[] {
  return (node.children ?? []).filter(
    (child) => child.type === "element" && child.tagName === tagName,
  );
}

/** Rows of a hast `<table>`: the header row's cells and each body row's cells. */
export function tableRows(table: TableHastNode): {
  head: TableHastNode[];
  body: TableHastNode[][];
} {
  const headRow = childElements(table, "thead").flatMap((thead) => childElements(thead, "tr"))[0];
  const head = headRow ? childElements(headRow, "th") : [];
  const body = childElements(table, "tbody")
    .flatMap((tbody) => childElements(tbody, "tr"))
    .map((row) => childElements(row, "td"));
  return { head, body };
}

const NUMBER =
  /^[~≈]?([-+−]?)[$€£]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k|K|M|B|%|x|×|ms|s|KB|MB|GB|TB)?$/;
const SCALE: Readonly<Record<string, number>> = {
  k: 1e3,
  K: 1e3,
  M: 1e6,
  B: 1e9,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
};

/** A cell's number (`71.2k` → 71200, `1,234` → 1234), or null if it isn't one. */
export function parseNumber(text: string): number | null {
  const match = NUMBER.exec(text.trim());
  if (!match) return null;
  const [, sign = "", whole = "", fraction = "", unit = ""] = match;
  const value = Number(`${whole.replace(/,/g, "")}${fraction}`) * (SCALE[unit] ?? 1);
  if (!Number.isFinite(value)) return null;
  return sign === "-" || sign === "−" ? -value : value;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Epoch milliseconds of an ISO date cell, or null. Date-only values are UTC midnight. */
function parseIsoDate(text: string): number | null {
  const value = text.trim();
  if (!DATE.test(value)) return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(time) ? null : time;
}

const ID = /^(?:v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?|[0-9a-f]{7,40}|#\d+|[A-Z][A-Z0-9]+-\d+)$/;
const RANK_VALUE = /^#?\d{1,3}\.?$/;
const RANK_HEADERS = new Set(["", "#", "no", "no.", "nr", "rank", "pos"]);

/** Classify one column from its header and body cell texts (empty cells are skipped). */
export function classifyColumn(
  header: string,
  values: readonly string[],
  column: number,
): ColumnKind {
  const cells = values.map((value) => value.trim()).filter((value) => value !== "");
  if (cells.length === 0) return "text";
  if (column === 0 && cells.every((value) => RANK_VALUE.test(value))) {
    const ranks = cells.map((value) => Number(value.replace(/[#.]/g, "")));
    const ascending = ranks.every((rank, i) => i === 0 || rank > (ranks[i - 1] ?? 0));
    if (RANK_HEADERS.has(header.trim().toLowerCase()) || ascending) return "rank";
  }
  if (cells.every((value) => parseIsoDate(value) !== null)) return "date";
  if (cells.every((value) => parseNumber(value) !== null)) return "num";
  if (cells.every((value) => ID.test(value))) return "id";
  return "text";
}

/** The glyph a column header shows; each has its own small hover motion in App.css. */
export type HeaderIcon =
  | "rank"
  | "repo"
  | "package"
  | "star"
  | "time"
  | "fit"
  | "reason"
  | "note"
  | "file"
  | "risk"
  | "version";

const HEADER_ICONS: readonly (readonly [RegExp, HeaderIcon])[] = [
  [/\bstars?\b|\bgithub stars\b/, "star"],
  [/\brepo(?:sitor(?:y|ies))?s?\b|\bproject\b/, "repo"],
  [/\bpackages?\b|\blibrar(?:y|ies)\b|\bdependenc(?:y|ies)\b|\bdeps?\b/, "package"],
  [
    /\b(?:last )?push(?:ed)?\b|\bupdated\b|\bmodified\b|\bcreated\b|\bdate\b|\btime\b|\bwhen\b/,
    "time",
  ],
  // "Why it fits" is about fit (a puzzle piece), so fit is checked before the
  // generic why/reason columns (a lightbulb).
  [/\bfits?\b|\bfit score\b|\bmatch(?:es)?\b|\brelevance\b/, "fit"],
  [/\bwhy\b|\breasons?\b|\brationale\b/, "reason"],
  [/\bnotes?\b|\bdescription\b|\bsummary\b|\bdetails?\b|\bcomments?\b/, "note"],
  [/\bfiles?\b|\bpaths?\b/, "file"],
  [/\brisk\b|\bseverity\b|\bimpact\b/, "risk"],
  [/\bversions?\b|\brelease\b|\btag\b/, "version"],
];

/**
 * A column header's icon, from its label first and then its data: a rank
 * column gets `#`, an untitled date column a clock. Columns that match
 * nothing get no icon, so an unfamiliar table stays plain rather than
 * guessing.
 */
export function headerIcon(label: string, kind: ColumnKind): HeaderIcon | null {
  const text = label.trim().toLowerCase();
  // A header that already reads "#" would show the hash twice.
  if (text === "#") return null;
  if (kind === "rank") return "rank";
  for (const [pattern, icon] of HEADER_ICONS) if (pattern.test(text)) return icon;
  if (kind === "date") return "time";
  if (kind === "id") return "version";
  return null;
}

/** How a cell sorts: numbers and dates by value, everything else as text; empty is null. */
export function sortKey(text: string, kind: ColumnKind): number | string | null {
  const value = text.trim();
  if (value === "") return null;
  if (kind === "num") return parseNumber(value) ?? value;
  if (kind === "rank") return Number(value.replace(/[#.]/g, ""));
  if (kind === "date") return parseIsoDate(value) ?? value;
  return value;
}

const TEXT_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return TEXT_ORDER.compare(a, b);
}

/**
 * Row indexes in sorted order. Stable (ties keep their original order) and
 * empty cells always sink to the bottom, whichever way the column sorts.
 */
export function sortRowOrder(
  keys: readonly (number | string | null)[],
  direction: SortDirection,
): number[] {
  const sign = direction === "asc" ? 1 : -1;
  return keys
    .map((key, index) => ({ key, index }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        if (a.key === b.key) return a.index - b.index;
        return a.key === null ? 1 : -1;
      }
      return sign * compareKeys(a.key, b.key) || a.index - b.index;
    })
    .map((entry) => entry.index);
}

/** The direction a column sorts on its first click: biggest/newest first for figures. */
export function firstSortDirection(kind: ColumnKind): SortDirection {
  return kind === "num" || kind === "date" ? "desc" : "asc";
}

function inlineMarkdown(node: TableHastNode): string {
  if (node.type === "text") return (node.value ?? "").replace(/\|/g, "\\|");
  if (node.type !== "element") return "";
  const inner = (): string => (node.children ?? []).map(inlineMarkdown).join("");
  switch (node.tagName) {
    case "wbr":
      return "";
    case "br":
      return "<br>";
    case "code": {
      const text = hastText(node).replace(/\|/g, "\\|");
      const fence = text.includes("`") ? "``" : "`";
      return `${fence}${text}${fence}`;
    }
    case "a": {
      const href = node.properties?.href;
      return typeof href === "string" && href !== "" ? `[${inner()}](${href})` : inner();
    }
    case "strong":
    case "b":
      return `**${inner()}**`;
    case "em":
    case "i":
      return `*${inner()}*`;
    case "del":
      return `~~${inner()}~~`;
    default:
      return inner();
  }
}

function markdownCell(cell: TableHastNode): string {
  return inlineMarkdown(cell).replace(/\s+/g, " ").trim();
}

function alignmentRule(cell: TableHastNode | undefined): string {
  const align = cell?.properties?.align;
  if (align === "left") return ":---";
  if (align === "right") return "---:";
  if (align === "center") return ":---:";
  return "---";
}

/** The table as GFM Markdown, with links, code and emphasis kept. */
export function tableToMarkdown(table: TableHastNode): string {
  const { head, body } = tableRows(table);
  const columns = Math.max(head.length, ...body.map((row) => row.length));
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  const pad = (row: TableHastNode[]): string[] =>
    Array.from({ length: columns }, (_, i) => {
      const cell = row[i];
      return cell ? markdownCell(cell) : "";
    });
  return [
    line(pad(head)),
    line(Array.from({ length: columns }, (_, i) => alignmentRule(head[i]))),
    ...body.map((row) => line(pad(row))),
  ].join("\n");
}

/**
 * One CSV field (RFC 4180). A leading `=`, `+`, `@` or a dash before a
 * non-digit is prefixed with `'`, so a spreadsheet shows the reply's text
 * instead of running it as a formula.
 */
function csvField(text: string): string {
  let value = text.replace(/\s+/g, " ").trim();
  if (/^[=+@\t\r]/.test(value) || /^-[^\d.\s]/.test(value)) value = `'${value}`;
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The table as CSV: plain cell text, header first. */
export function tableToCsv(table: TableHastNode): string {
  const { head, body } = tableRows(table);
  return [head, ...body]
    .map((row) => row.map((cell) => csvField(hastText(cell))).join(","))
    .join("\n");
}

const DAY_MS = 86_400_000;
/** A repo pushed within this many days counts as fresh. */
const FRESH_DAYS = 90;
const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * "today", "yesterday", "3 days ago", "last week", "4 months ago"… for an ISO
 * date cell, counted in whole UTC days before `now`. Future dates read as
 * today. Null if the text isn't an ISO date.
 */
export function relativeDate(
  text: string,
  now: number,
): { label: string; freshness: "fresh" | "stale" } | null {
  const time = parseIsoDate(text);
  if (time === null) return null;
  const days = Math.max(0, Math.floor(now / DAY_MS) - Math.floor(time / DAY_MS));
  let label: string;
  if (days < 7) label = RELATIVE.format(-days, "day");
  else if (days < 30) label = RELATIVE.format(-Math.floor(days / 7), "week");
  else if (days < 365) label = RELATIVE.format(-Math.max(1, Math.floor(days / 30)), "month");
  else label = RELATIVE.format(-Math.floor(days / 365), "year");
  return { label, freshness: days <= FRESH_DAYS ? "fresh" : "stale" };
}
