import { useCallback, useState } from "react";
import type { createChatLayoutMotion } from "./chat-layout-motion";

/** Persisted nav-row / live-tool-panel visibility toggles. Extracted from App.tsx. */
export function useChromeToggles(chatLayout: ReturnType<typeof createChatLayoutMotion>) {
  // Hide/show the nav button row (the bar + centered title always stay).
  // Persisted across reloads.
  const [navHidden, setNavHidden] = useState(() => {
    try {
      return localStorage.getItem("gg-nav-hidden") === "1";
    } catch {
      return false;
    }
  });
  const setNavHiddenPersisted = useCallback((hidden: boolean) => {
    try {
      localStorage.setItem("gg-nav-hidden", hidden ? "1" : "0");
    } catch {
      /* ignore */
    }
    setNavHidden(hidden);
  }, []);
  const toggleNav = useCallback(
    () => setNavHiddenPersisted(!navHidden),
    [navHidden, setNavHiddenPersisted],
  );
  // Hide/show the live tool panel (the rolling feed above the activity bar).
  // Mirrors navHidden: persisted across reloads, and auto-enabled when windows
  // are tiled (tight space) so freshly opened windows boot with it collapsed.
  const [toolsHidden, setToolsHidden] = useState(() => {
    try {
      return localStorage.getItem("gg-tools-hidden") === "1";
    } catch {
      return false;
    }
  });
  const setToolsHiddenPersisted = useCallback(
    (hidden: boolean) => {
      try {
        localStorage.setItem("gg-tools-hidden", hidden ? "1" : "0");
      } catch {
        /* ignore */
      }
      chatLayout.capture();
      setToolsHidden(hidden);
    },
    [chatLayout],
  );
  const toggleTools = useCallback(
    () => setToolsHiddenPersisted(!toolsHidden),
    [toolsHidden, setToolsHiddenPersisted],
  );
  return {
    navHidden,
    setNavHiddenPersisted,
    toggleNav,
    toolsHidden,
    setToolsHiddenPersisted,
    toggleTools,
  };
}
