/**
 * The `--dock-h` value to write for the dock, or null to leave the current one.
 *
 * Measured in layout CSS pixels (`offsetHeight`), never a viewport DOMRect:
 * the app zooms with CSS `zoom` on <html>, and WebKit reports
 * `getBoundingClientRect` already scaled by it. Written back as a CSS length,
 * that value gets zoomed a second time, so at 80% the transcript reserved only
 * 64% of the dock and the newest lines slid under the composer. Layout pixels
 * also don't change with the zoom level, so the value stays right even when a
 * zoom step resizes nothing the dock's observer would notice.
 *
 * A dock hidden behind a Goal's Workers view measures 0; that isn't its height,
 * and writing it would collapse the conversation's bottom padding while hidden,
 * then spring it back on return, shifting every message.
 */
export function nextDockHeight(
  dock: Pick<HTMLElement, "offsetHeight">,
  current: string,
): string | null {
  const px = Math.round(dock.offsetHeight);
  if (px <= 0) return null;
  const next = `${px}px`;
  return next === current ? null : next;
}
