/**
 * The `--dock-h` value to write for a measured dock height, or null to leave
 * the current one. A dock hidden behind a Goal's Workers view measures 0; that
 * isn't its height, and writing it would collapse the conversation's bottom
 * padding while hidden, then spring it back on return, shifting every message.
 */
export function nextDockHeight(measured: number, current: string): string | null {
  const px = Math.round(measured);
  if (px <= 0) return null;
  const next = `${px}px`;
  return next === current ? null : next;
}
