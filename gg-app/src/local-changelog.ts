/**
 * User-facing release notes for the Local Fork. Prepend an entry whenever a
 * genuinely user-facing local change ships. IDs are immutable after shipping:
 * changing or reusing one can hide unread notes for existing users.
 */
export interface LocalChangelogEntry {
  /** Stable release identifier. Never change after shipping. */
  id: string;
  /** Short display label for this local release. */
  label: string;
  /** Release date, ISO `YYYY-MM-DD`. */
  date: string;
  /** One cohesive bullet per user-facing change. */
  items: string[];
}

/** Newest first. Maintained only by the Local Fork release flow. */
export const LOCAL_CHANGELOG: LocalChangelogEntry[] = [
  {
    id: "local-2026-08-26-packaging-and-review-recovery",
    label: "August 26 update",
    date: "2026-08-26",
    items: [
      "GG Coder can now prepare and test installers for supported desktop apps built with Tauri. Run `/setup-tauri-package` once, then `/package-tauri` for repeatable builds with fewer manual steps.",
      "Roadmap final reviews now retry once when a result is missing or out of date. If completion still needs attention, follow the recovery message to retry without losing the failure details.",
    ],
  },
  {
    id: "local-2026-08-25-ui-and-update-reliability",
    label: "Local Fork",
    date: "2026-08-25",
    items: [
      "Added optional verified update summaries and a Decisions tab in What’s New.",
      "Prompt submission failures now appear in the conversation instead of failing silently.",
      "Roadmap cards now expand in place, run primary actions directly, and preserve verification evidence.",
      "Roadmap completion now requires the expected final review and successful fresh verification.",
      "Local Fork updates now verify the installer, close gracefully, install automatically, and relaunch your existing profile.",
      "Sidecar builds now promote atomically and preserve the previous working bundle after validation failures.",
      "Local Fork builds no longer show the automatic-update footer banner.",
    ],
  },
  {
    id: "local-2026-08-23-protected-updates",
    label: "August 23 update",
    date: "2026-08-23",
    items: [
      "Local updates now guard the entire handoff from upstream merge to patched installer. Dirty work is restored byte-for-byte, recovery state stays available, and a failed check stops before anything can be shipped.",
      "The Windows updater no longer leaves the app waiting forever. Every protected update reports a clear completed or failed outcome, with a safe retry path when something needs attention.",
    ],
  },
  {
    id: "local-2026-08-22-roadmap-reviews",
    label: "August 22 update",
    date: "2026-08-22",
    items: [
      "Approved plans now stay attached to the work they govern. Roadmap phases carry their completion checks through execution, then stop for a real final review before they can be marked done.",
      "Project MCP servers now work through their full desktop lifecycle, so local tools can start, report status, and shut down cleanly without leaving stale processes behind.",
    ],
  },
];
