/**
 * Strip a single leading UTF-8 byte-order mark (U+FEFF).
 *
 * Windows editors (Notepad, some VS Code configs) prepend a BOM; a BOM before
 * `---` silently breaks frontmatter parsing in skills/agents/commands, and it
 * pollutes instruction-file rendering. Applied at every instruction-file read.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Characters that carry meaning to a model but render as nothing to a human.
 *
 * An MCP server or a fetched page can use these to smuggle instructions that
 * are invisible in the transcript and to the user, yet arrive in the model's
 * context as ordinary text — the prompt-injection payload nobody can see.
 *
 *  - `U+E0000–U+E007F`  the tag block: a full ASCII alphabet, the actual
 *                       smuggling channel. Its only sanctioned use was language
 *                       tags, deprecated since Unicode 5.1.
 *  - `U+200B`           zero-width space
 *  - `U+200E/U+200F`,
 *    `U+202A–U+202E`,
 *    `U+2066–U+2069`    bidi controls, which reorder visible text (Trojan Source)
 *  - `U+2060–U+2064`    word joiner and invisible math operators
 *  - `U+206A–U+206F`    deprecated format controls
 *
 * Deliberately NOT stripped, unlike the widely-copied public regex that spans
 * `\u200B-\u200F` wholesale:
 *  - `U+200C/U+200D` (ZWNJ/ZWJ) are load-bearing. ZWJ builds emoji families
 *    (👨‍👩‍👧‍👦) and both are orthographically required in Persian, Hindi and
 *    other scripts — stripping them corrupts legitimate text.
 *  - Variation selectors (`U+FE00–U+FE0F`, `U+E0100–U+E01EF`) select emoji vs
 *    text presentation and CJK glyph variants.
 *
 * This is the single source of truth for both the model-bound sanitizer here
 * and the terminal display path (ui/utils/text-utils.ts). If they disagree, the
 * transcript cannot show a user what the model was actually told — which is the
 * whole point.
 */
export const INVISIBLE_UNICODE_PATTERN =
  "\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u206A-\\u206F\\uFEFF\\u{E0000}-\\u{E007F}";

const INVISIBLE_UNICODE = new RegExp(`[${INVISIBLE_UNICODE_PATTERN}]`, "gu");

/**
 * Remove invisible Unicode characters from untrusted text.
 *
 * Returns the count so callers can say what happened: silently mutating model
 * input would hide the attack it just defused.
 */
export function stripInvisibleUnicode(text: string): { text: string; stripped: number } {
  let stripped = 0;
  const cleaned = text.replace(INVISIBLE_UNICODE, () => {
    stripped += 1;
    return "";
  });
  return { text: cleaned, stripped };
}
