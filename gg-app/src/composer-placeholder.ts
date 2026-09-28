/**
 * Short hints used when the full composer hint would wrap. The composer is one
 * line tall while empty, so a wrapped hint is cut mid-phrase (for example
 * "Type a message, /") instead of reading as a hint.
 */
export const COMPACT_IDLE_PLACEHOLDER = "Type a message…";
export const COMPACT_RUNNING_PLACEHOLDER = "Add a follow-up…";

/**
 * The full hint when it fits the field's text width, otherwise the compact one.
 * Unknown width or unmeasurable text keeps the full hint (jsdom, first paint).
 */
export function fitPlaceholder(
  full: string,
  compact: string,
  availablePx: number | null,
  measurePx: (text: string) => number | null,
): string {
  if (availablePx === null) return full;
  const width = measurePx(full);
  if (width === null) return full;
  return width <= availablePx ? full : compact;
}

/** Text width available inside a field, plus the font its hint renders with. */
export type FieldTextBox = Readonly<{ availablePx: number; font: string }>;

export function fieldTextBox(el: HTMLElement): FieldTextBox {
  const style = getComputedStyle(el);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return {
    availablePx: Math.max(0, el.clientWidth - padding),
    font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
  };
}
