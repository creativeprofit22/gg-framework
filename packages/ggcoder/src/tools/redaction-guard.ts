import { REDACTION_MARKER, environmentSecrets, redactText } from "@kenkaiiii/gg-ai";

/**
 * Tool output passes through secret redaction before the model sees it, so a
 * file holding `API_KEY=sk-…` reads back as `API_KEY=[REDACTED]`. If the model
 * then writes what it saw, the real secret is silently replaced by the marker
 * and lost. This guard catches that before anything is written.
 *
 * It is precise rather than blanket: files whose redacted view equals their
 * real content (nothing was hidden from the model) are never restricted, so
 * code and tests that legitimately contain the marker text keep working. Only
 * when the model's view of THIS file had values hidden does a write that adds
 * markers beyond what the file really contains get rejected.
 */

function countMarkers(text: string): number {
  let count = 0;
  for (let i = text.indexOf(REDACTION_MARKER); i !== -1;) {
    count++;
    i = text.indexOf(REDACTION_MARKER, i + REDACTION_MARKER.length);
  }
  return count;
}

/** Same options the agent loop uses for tool output, so both see the same view. */
function redactedView(text: string): string {
  return redactText(text, { secrets: environmentSecrets(process.env) });
}

/** True when some of `content` is hidden from the model by redaction. */
export function hasHiddenValues(content: string): boolean {
  return countMarkers(redactedView(content)) > countMarkers(content);
}

/**
 * Returns an error message when writing `next` over `original` would put
 * redaction markers where real values were, or null when the write is safe.
 * `original` is undefined for a new file, which has nothing to lose.
 */
export function redactionLossError(
  original: string | undefined,
  next: string,
  fileName: string,
): string | null {
  if (original === undefined) return null;
  const added = countMarkers(next) - countMarkers(original);
  if (added <= 0 || !hasHiddenValues(original)) return null;
  return (
    `Refused: this would write ${added} "${REDACTION_MARKER}" placeholder${added === 1 ? "" : "s"} into ${fileName}, ` +
    `replacing real values. Parts of this file (credentials) were hidden from you as "${REDACTION_MARKER}" when you read it; ` +
    `the file itself holds the real values. Nothing was written. ` +
    `Edit only the lines you need with old_text/new_text or span edits that do not include the hidden values. ` +
    `If a hidden value itself must change, ask the user to provide or change it.`
  );
}

/** Hint appended when an edit's old_text contains the marker and fails to match. */
export function redactedOldTextHint(oldText: string): string {
  return oldText.includes(REDACTION_MARKER)
    ? ` Your old_text contains "${REDACTION_MARKER}", which is how hidden credentials appear in tool output — ` +
        `the file holds the real value there, so this text can never match. ` +
        `Choose old_text that avoids the hidden part, or use a span edit that leaves those lines out.`
    : "";
}
