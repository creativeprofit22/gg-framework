/**
 * Minimal YAML frontmatter reader for skill and agent markdown files.
 *
 * Only flat `key: scalar` maps are needed, but the scalar forms real SKILL.md
 * files use must all work, or a skill silently reaches the catalog with a
 * description like `>` and never gets chosen:
 *
 * - plain values, which may continue on more-indented lines (folded to spaces)
 * - single- and double-quoted values (quotes removed, `''` / `\"` unescaped)
 * - block scalars: `>` folds lines into one, `|` keeps newlines; `-`/`+` chomping
 *   indicators are accepted
 *
 * Keys are lowercased. Nested maps and lists are not interpreted; their text is
 * kept as the value's continuation, which callers ignore for unknown keys.
 */

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
  /** False when the file has no well-formed `---` … `---` block. */
  hasFrontmatter: boolean;
}

const KEY_LINE = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?\s*$/;
const BLOCK_INDICATOR = /^([|>])[+-]?\d*$/;

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { fields: {}, body: raw, hasFrontmatter: false };
  // The block ends at the first line that is exactly `---`; a `---` inside a
  // description must not close it.
  const close = /^---[ \t]*$/m;
  const rest = text.slice(4);
  const match = close.exec(rest);
  if (!match) return { fields: {}, body: raw, hasFrontmatter: false };

  const lines = rest.slice(0, match.index).split("\n");
  const body = rest.slice(match.index + match[0].length).trim();
  const fields: Record<string, string> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = KEY_LINE.exec(line);
    i++;
    if (!keyMatch || /^\s/.test(line)) continue;

    const key = keyMatch[1].toLowerCase();
    const inline = (keyMatch[2] ?? "").trim();

    // Collect indented continuation lines (blank lines included, so block
    // scalars keep paragraph breaks).
    const continuation: string[] = [];
    while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
      continuation.push(lines[i]);
      i++;
    }
    while (continuation.length > 0 && continuation[continuation.length - 1].trim() === "") {
      continuation.pop();
    }

    const block = BLOCK_INDICATOR.exec(inline);
    if (block) {
      const indent = Math.min(
        ...continuation.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
      );
      const dedented = continuation.map((l) => (l.trim() ? l.slice(indent) : ""));
      fields[key] = block[1] === "|" ? dedented.join("\n") : foldLines(dedented);
      continue;
    }

    const joined = [inline, ...continuation.map((l) => l.trim())].filter(Boolean).join(" ");
    fields[key] = unquote(joined);
  }

  return { fields, body, hasFrontmatter: true };
}

/** YAML folding: single newlines become spaces; blank lines become newlines. */
function foldLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line.trim());
    }
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}
