import { useEffect } from "react";
import { error as logError } from "@tauri-apps/plugin-log";
import { windowLabel, openWhatsNewWindow } from "./agent";
import { appBuildInfo } from "./build-info";

/**
 * Invisible post-update trigger (renders nothing). Mounted in every window, but
 * only the main window checks bundled feed heads (Local Fork + Upstream), so the
 * dedicated, screen-centered window (Rust `open_whatsnew_window` +
 * `WhatsNewWindow.tsx`) opens exactly once. Fresh installs are seeded silently;
 * an unread head opens it in the `hype` mood (the home screen's button opens
 * the calm one); failed native opens remain retryable.
 *
 * DEV ONLY — set DEV_FORCE_WHATSNEW to force the window open on launch.
 */
const DEV_FORCE_WHATSNEW = false;

export function WhatsNewModal(): null {
  useEffect(() => {
    if (windowLabel !== "main") return;

    if (import.meta.env.DEV && DEV_FORCE_WHATSNEW) {
      void openWhatsNewWindow("hype").catch(() => {});
      return;
    }

    let cancelled = false;
    void import("./whats-new-status")
      .then(({ getWhatsNewStatus }) => {
        if (cancelled) return;
        const status = getWhatsNewStatus(localStorage, appBuildInfo.localPatched);
        if (status.unreadFeedIds.length === 0) return;
        return openWhatsNewWindow("hype");
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
