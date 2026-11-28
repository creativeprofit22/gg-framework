/** Convert viewport snapshots to layout CSS pixels (including inherited zoom).
 * Use fractional computed border-box width rather than rounded offsetWidth.
 * Call on an unscaled container; translation does not affect this measurement. */
export function viewportScale(el: HTMLElement, rect: DOMRect): number {
  const style = getComputedStyle(el);
  let width = parseFloat(style.width);
  if (style.boxSizing !== "border-box") {
    for (const value of [
      style.paddingLeft,
      style.paddingRight,
      style.borderLeftWidth,
      style.borderRightWidth,
    ]) {
      width += parseFloat(value) || 0;
    }
  }
  if (!Number.isFinite(width) || width <= 0) width = el.offsetWidth;
  const scale = rect.width / width;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
