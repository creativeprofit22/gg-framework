import { useEffect, useState } from "react";

/**
 * Whether THIS window holds OS focus. Drives the prominent input border and the
 * home scenery/dither render loops. CSS loops, critters, spinners and clocks
 * follow the fuller `window-motion.ts` level (focused / visible / hidden).
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
