import { useEffect } from "react";
import { error as logError } from "@tauri-apps/plugin-log";
import { windowLabel, openWhatsNewWindow } from "./agent";
import { appBuildInfo } from "./build-info";
import { getWhatsNewStatus } from "./whats-new";

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

    const status = getWhatsNewStatus(localStorage, appBuildInfo.localPatched);
    if (status.unreadFeedIds.length === 0) return;
    void openWhatsNewWindow().catch((error) =>
      logError(`What's-new window failed to open: ${String(error)}`),
    );
  }, []);

  return null;
}
