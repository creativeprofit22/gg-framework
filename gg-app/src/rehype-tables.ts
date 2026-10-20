/**
 * Rehype plugin: makes every Markdown table data-aware before it renders.
 *
 * - Each column gets a kind (rank, number, date, id or text) from its cells;
 *   typed columns get an `md-col-<kind>` class on their header and cells, so
 *   CSS can right-align figures and keep dates and ids on one line.
 * - Every cell carries its column index, kind and header label (`data-label`),
 *   which sorting and the narrow-pane card layout read; number cells carry
 *   their share of the column's largest value (`data-ratio`).
 * - Empty cells get `md-cell-empty` (CSS draws a dim dash).
 * - A GitHub repo link reading `owner/name` becomes a two-line identity
 *   (owner line, bold name); other `owner/name` or path text splits into
 *   muted folder segments and a bold name, breaking only after a slash.
 * - A rank column's numbers become badges, the top three lit.
 * - Tables of four or more columns get `md-table-cards` (cards in narrow panes).
 *
 * Runs before word animation, so it reads whole text nodes. Text is never
 * changed: only classes, data attributes, spans and `<wbr>` are added.
 */
import {
  type ColumnKind,
  classifyColumn,
  hastText,
  parseNumber,
  type TableHastNode,
  tableRows,
} from "./markdown-table-data";

/** Columns at which a table switches to cards in narrow panes. */
const CARD_COLUMNS = 4;
/** Longer names may still wrap mid-name rather than overflow a narrow pane. */
const MAX_NOWRAP_NAME = 32;
const PATH = /^(?:[\w@.+-]+\/)+[\w@.+-]+\/?$/;
const FILE_NAME = /\.\w{1,8}$/;

function addClass(node: TableHastNode, name: string): void {
  const properties = node.properties ?? {};
  const current = properties.className;
  const list = Array.isArray(current)
    ? current.map(String)
    : typeof current === "string"
      ? [current]
      : [];
  if (!list.includes(name)) list.push(name);
  properties.className = list;
  node.properties = properties;
}

function setData(node: TableHastNode, values: Record<string, string>): void {
  node.properties = { ...node.properties, ...values };
}

function element(tagName: string, className: string | null, text?: string): TableHastNode {
  return {
    type: "element",
    tagName,
    properties: className ? { className: [className] } : {},
    children: text === undefined ? [] : [{ type: "text", value: text }],
  };
}

/**
 * `owner/name`, `dir/file.ts`: dim the folders, bold the name, and allow a
 * break only after a slash. Links take any path; bare text needs three
 * segments or a file name, so prose like "and/or" is left alone.
 */
function splitPath(text: string, inLink: boolean): TableHastNode[] | null {
  const value = text.trim();
  if (value !== text || !PATH.test(value) || value.includes("://")) return null;
  const segments = value.replace(/\/$/, "").split("/");
  const name = segments.at(-1) ?? "";
  if (segments.every((segment) => /^\d+$/.test(segment))) return null;
  if (!inLink && segments.length < 3 && !FILE_NAME.test(name)) return null;
  if (name.length > MAX_NOWRAP_NAME) return null;
  const parts: TableHastNode[] = [];
  for (const folder of segments.slice(0, -1)) {
    parts.push(element("span", "md-path-seg", `${folder}/`), element("wbr", null));
  }
  parts.push(element("span", "md-path-name", value.endsWith("/") ? `${name}/` : name));
  return [{ ...element("span", "md-path"), children: parts }];
}

/** Text inside these is literal; paths there are handled by the cell's code styling. */
const LITERAL = new Set(["code", "pre", "kbd", "samp", "svg", "math"]);
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/**
 * A link to a GitHub repo whose text is that repo's `owner/name` becomes a
 * two-line identity: the owner as a small muted line above the name in bold.
 * The slash stays in the text for copying and screen readers.
 */
function repoIdentity(link: TableHastNode): boolean {
  const href = link.properties?.href;
  if (typeof href !== "string") return false;
  const match = GITHUB_REPO.exec(href);
  const owner = match?.[1];
  const name = match?.[2];
  if (!owner || !name) return false;
  if (hastText(link).trim().toLowerCase() !== `${owner}/${name}`.toLowerCase()) return false;
  const ownerLine = element("span", "md-repo-owner", owner);
  ownerLine.children?.push(element("span", "md-repo-slash", "/"));
  const repo = element("span", "md-repo");
  repo.children = [ownerLine, element("span", "md-repo-name", name)];
  link.children = [repo];
  return true;
}

function splitPathsIn(node: TableHastNode, inLink: boolean): void {
  if (!node.children) return;
  const next: TableHastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const parts = splitPath(child.value, inLink);
      if (parts) next.push(...parts);
      else next.push(child);
      continue;
    }
    if (child.type === "element" && child.tagName === "a" && repoIdentity(child)) {
      next.push(child);
      continue;
    }
    if (child.type === "element" && !LITERAL.has(child.tagName ?? "")) {
      splitPathsIn(child, inLink || child.tagName === "a");
    }
    next.push(child);
  }
  node.children = next;
}

/** A rank cell's number becomes a badge; the top three are lit (`data-rank`). */
function rankBadge(cell: TableHastNode): void {
  const value = hastText(cell).trim();
  if (value === "") return;
  const badge = element("span", "md-rank", value);
  const rank = Number(value.replace(/[#.]/g, ""));
  if (Number.isInteger(rank) && rank >= 1 && rank <= 3) {
    badge.properties = { ...badge.properties, dataRank: String(rank) };
  }
  cell.children = [badge];
}

function annotateTable(table: TableHastNode): void {
  const { head, body } = tableRows(table);
  const columns = Math.max(head.length, ...body.map((row) => row.length));
  if (columns === 0) return;
  if (columns >= CARD_COLUMNS) addClass(table, "md-table-cards");
  for (let column = 0; column < columns; column++) {
    const headerCell = head[column];
    const label = headerCell ? hastText(headerCell).replace(/\s+/g, " ").trim() : "";
    const texts = body.map((row) => {
      const cell = row[column];
      return cell ? hastText(cell) : "";
    });
    const kind: ColumnKind = classifyColumn(label, texts, column);
    const numbers = kind === "num" ? texts.map(parseNumber) : [];
    const max = Math.max(0, ...numbers.map((value) => value ?? 0));
    if (headerCell) {
      if (kind !== "text") addClass(headerCell, `md-col-${kind}`);
      setData(headerCell, { dataCol: String(column), dataKind: kind });
    }
    body.forEach((row, rowIndex) => {
      const cell = row[column];
      if (!cell) return;
      if (kind !== "text") addClass(cell, `md-col-${kind}`);
      setData(cell, { dataCol: String(column), dataKind: kind, dataLabel: label });
      if ((texts[rowIndex] ?? "").trim() === "") addClass(cell, "md-cell-empty");
      const value = numbers[rowIndex];
      if (typeof value === "number" && max > 0 && value >= 0) {
        setData(cell, { dataRatio: (value / max).toFixed(3) });
      }
      if (kind === "text") splitPathsIn(cell, false);
      if (kind === "rank") rankBadge(cell);
    });
  }
}

function walk(node: TableHastNode): void {
  for (const child of node.children ?? []) {
    if (child.type !== "element") continue;
    if (child.tagName === "table") annotateTable(child);
    else walk(child);
  }
}

export function rehypeTables() {
  return (tree: TableHastNode): void => walk(tree);
}
