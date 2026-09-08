import { useEffect } from "react";
import { error as logError } from "@tauri-apps/plugin-log";
import { windowLabel, openWhatsNewWindow } from "./agent";
import { appBuildInfo } from "./build-info";

/**
 * Invisible post-update trigger. Only the main window checks bundled feed heads;
 * fresh installs are seeded silently and failed native opens remain retryable.
 */
const DEV_FORCE_WHATSNEW = false;

export function WhatsNewModal(): null {
  useEffect(() => {
    if (windowLabel !== "main") return;

    if (import.meta.env.DEV && DEV_FORCE_WHATSNEW) {
      void openWhatsNewWindow().catch(() => {});
      return;
    }

    let cancelled = false;
    void import("./whats-new")
      .then(({ getWhatsNewStatus }) => {
        if (cancelled) return;
        const status = getWhatsNewStatus(localStorage, appBuildInfo.localPatched);
        if (status.unreadFeedIds.length === 0) return;
        return openWhatsNewWindow();
      })
      .catch((error) => {
        if (!cancelled) void logError(`What's-new check or window open failed: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
