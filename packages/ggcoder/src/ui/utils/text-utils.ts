import { stripVTControlCharacters } from "node:util";
import stripAnsi from "strip-ansi";
import { INVISIBLE_UNICODE_PATTERN } from "../../utils/text.js";

/**
 * Strip characters that can break terminal rendering.
 *
 * Mirrors Gemini CLI's display sanitization: strip ANSI, unsafe C0/C1,
 * BiDi/zero-width controls, then any remaining VT control sequences.
 *
 * The invisible set is shared with {@link stripInvisibleUnicode}, which cleans
 * model-bound text. Both paths must remove exactly the same characters: if the
 * display path kept any of them, the transcript could not show a user what the
 * model was actually told.
 */
const UNSAFE_DISPLAY = new RegExp(
  `[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x80-\\x9F${INVISIBLE_UNICODE_PATTERN}]`,
  "gu",
);

export function stripUnsafeCharacters(str: string): string {
  const strippedAnsi = stripAnsi(str);
  const strippedWithRegex = strippedAnsi.replace(UNSAFE_DISPLAY, "");
  return stripVTControlCharacters(strippedWithRegex);
}
