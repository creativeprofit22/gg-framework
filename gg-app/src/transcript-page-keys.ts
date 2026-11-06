/**
 * Page Up / Page Down for the focused chat pane: they page its transcript even
 * while the caret sits in the composer, where the browser would otherwise move
 * the caret instead. Other editors, menus and dialogs keep their native keys.
 */

export type PageDirection = -1 | 1;

/** The key fields the rules read — a KeyboardEvent satisfies it. */
export interface PageKeyIntent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
}

/** Up (-1) or down (1) for a bare Page Up / Page Down; null for anything else. */
export function pageKeyDirection(e: PageKeyIntent): PageDirection | null {
  if (e.defaultPrevented || e.isComposing) return null;
  // Shift selects a page of text in an editor; the other modifiers are shortcuts.
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === "PageUp") return -1;
  if (e.key === "PageDown") return 1;
  return null;
}

// Chromium pages by 87.5% of the viewport, keeping a few lines for context.
const PAGE_FRACTION = 0.875;
const MIN_PAGE_PX = 40;

/**
 * One page of transcript. The title bar floats over the transcript's top edge
 * and the dock over its bottom edge, so only the band between them counts as
 * what the reader can see.
 */
export function transcriptPageStep(
  clientHeight: number,
  insetTop: number,
  insetBottom: number,
): number {
  const visible = Math.max(0, clientHeight - Math.max(0, insetTop) - Math.max(0, insetBottom));
  return Math.max(MIN_PAGE_PX, Math.round(visible * PAGE_FRACTION));
}

const NATIVE_KEY_OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="listbox"], [role="menu"], [role="dialog"]';

/**
 * Whether a page key aimed at `target` should page this pane's transcript:
 * nothing focused, the pane's own composer, or anything else in the pane that
 * has no native use for the key.
 */
export function shouldPageTranscript(
  target: EventTarget | null,
  pane: Element,
  composer: Element | null,
): boolean {
  if (!(target instanceof Element)) return true;
  const doc = target.ownerDocument;
  if (target === doc.body || target === doc.documentElement) return true;
  if (!pane.contains(target)) return false;
  if (composer !== null && target === composer) return true;
  return target.closest(NATIVE_KEY_OWNERS) === null;
}
