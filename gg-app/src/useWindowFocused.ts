import { useEffect, useState } from "react";

/**
 * Whether THIS window holds OS focus. Drives the prominent input border and
 * pauses decorative animations in background windows (see
 * `.app:not(.window-focused)` in App.css).
 *
 * Seeded from `document.hasFocus()`, not `true`: a window restored at launch
 * that never receives focus gets no blur event, and would otherwise count as
 * focused forever — running its animations for every idle hour.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
}
