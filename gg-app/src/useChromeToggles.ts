import { useCallback, useState } from "react";
import type { createChatLayoutMotion } from "./chat-layout-motion";

/** Persisted live-tool-panel visibility toggle. Extracted from App.tsx. */
export function useChromeToggles(chatLayout: ReturnType<typeof createChatLayoutMotion>) {
  // Hide/show the live tool panel (the rolling feed above the activity bar).
  // Persisted across reloads, and auto-enabled when windows are tiled (tight
  // space) so freshly opened windows boot with it collapsed.
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
    toolsHidden,
    setToolsHiddenPersisted,
    toggleTools,
  };
}
