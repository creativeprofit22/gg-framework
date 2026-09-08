import releaseNotesJson from "./local-release-notes.json";

export interface LocalReleaseNotes {
  schemaVersion: 1;
  date: string;
  label: string;
  sections: Array<{ title: string; items: string[] }>;
}

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

function requireCurrentReleaseNotes(value: unknown): LocalReleaseNotes {
  const note = value as Partial<LocalReleaseNotes> | null;
  if (
    !note ||
    note.schemaVersion !== 1 ||
    typeof note.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(note.date) ||
    typeof note.label !== "string" ||
    !Array.isArray(note.sections) ||
    note.sections.length === 0 ||
    !note.sections.every(
      (section) =>
        section &&
        typeof section.title === "string" &&
        section.title.length > 0 &&
        Array.isArray(section.items) &&
        section.items.length > 0 &&
        section.items.every((item) => typeof item === "string" && item.length > 0),
    )
  ) {
    throw new Error("Invalid Local Fork release notes");
  }
  return note as LocalReleaseNotes;
}

export const CURRENT_LOCAL_RELEASE_NOTES = requireCurrentReleaseNotes(releaseNotesJson);

/** Newest first. Maintained only by the Local Fork release flow. */
export const LOCAL_CHANGELOG: LocalChangelogEntry[] = [
  {
    id: "local-2026-09-07-upstream-0621-and-roadmap-recovery",
    label: CURRENT_LOCAL_RELEASE_NOTES.label,
    date: CURRENT_LOCAL_RELEASE_NOTES.date,
    items: CURRENT_LOCAL_RELEASE_NOTES.sections.flatMap(({ items }) => items),
  },
  {
    id: "local-2026-08-29-roadmap-completion-fails-closed",
    label: "Upstream 0.62.0, still your Local Fork",
    date: "2026-09-06",
    items: [
      "The companion apps `Boss`, `Editor`, `Premiere panel`, `Voice`, and `Eyes` are retired from this workspace. GG Coder’s terminal and desktop app remain, along with your Local Fork customizations. Boss’s source is saved as a local research reference—not an actively maintained app.",
      "A plain question should get an answer, not an old check reminder. Follow-up questions now leave earlier verification work quiet without calling it passed. Start changing code again and the reminders return; failed or unfinished checks still need attention.",
      "Shorter output shouldn’t hide a failed check. Supported checks piped through `tail` now keep the failure visible, while fresh passing checks on newer code can clear an older failure. A different green command on unchanged code doesn’t erase a red result, and a persistent shell isn’t accepted as a finished check.",
      "Stuck repeating the same approach? GG Coder can ask your current model for a second look and suggest a different next step. These advisory loop checks run at most twice per run and use additional model usage. A timeout or cancellation aborts the request, and late advice can’t spill into your next prompt.",
      "Substantial `Ideal?` reviews can get a fresh pair of eyes from the same model, with read-only tools and no permission to change files. The reviewer may read documentation online and uses additional model usage. If it can’t finish within two minutes, the main review continues without treating a still-running helper as finished. Its findings never replace the file reads and checks the main agent still owes you.",
      "Your `OpenAI` agents now get clearer instructions for every tool call, including which details are required. That helps avoid malformed requests and wasted retries, while other providers keep the settings that work for them.",
      "See how your build is doing without leaving your workspace. The live `CI` chip now shows running, passing, or failing checks in your title bar. Click it to open `GitHub Actions` when you need the details.",
      "`Ken` can finish reviewing a plan without starting the build for you. The plan stays ready while you decide whether to revise it or move ahead, so a reviewer’s approval never replaces your own.",
      "An expired question no longer looks ready to answer. When `/programmatic-run` times out waiting for approval, its question card closes without closing other live questions. Answers only show as sent once accepted, so a refused answer never looks like permission to proceed.",
      "Run one opportunity without bringing your whole chat along. `/programmatic-run` asks you to approve the chosen specialist and scope, then runs it separately. Research stays read-only, and file changes need further approval. `Tauri` setup can inspect your app in that separate run, with fresh approval for each setup, calibration, or packaging action—not access to unrelated tools.",
      "Approved changes to project settings no longer leave a finished or interrupted run stuck after cleanup. Approve a refreshed scan profile before running against changed settings; interrupted work never restarts on its own. If background-process cleanup cannot be confirmed, the run stays unfinished and another opportunity cannot start in that project.",
      "Your `Codex` context choice now stays with the session. Pick `Stable` or `Experimental` before the conversation starts; follow-ups and resumed chats keep that choice, while Ken’s reviews run separately from your working chat.",
      "Stopping work should stop its helpers too. Persistent shells now use the same confirmed cleanup as other managed commands, including Windows Git Bash helpers that outlive their original parent. Cleanup failures keep work unfinished instead of pretending everything stopped, without targeting unrelated older processes. A failed launch check still leaves your other apps alone, and earlier update decisions stay available if you need another try.",
      "Can’t load, run, or delete a task? `Tasks` now keeps the window open and explains the failure instead of silently closing or clearing your list. You can see what happened before deciding what to try next.",
    ],
  },
  {
    id: "local-2026-08-28-roadmap-and-streaming",
    label: "August 28 update",
    date: "2026-08-28",
    items: [
      "One clear next step? `Roadmap` can get moving on its own. If there’s a choice to make, it waits for you—and manual `Ken` still waits for `Start`.",
      "Follow the answer as it arrives. Replies now unfold smoothly and stay pinned, without taking over the rest of your multi-pane workspace.",
    ],
  },
  {
    id: "local-2026-08-26-packaging-and-review-recovery",
    label: "August 26 update",
    date: "2026-08-26",
    items: [
      "Less installer busywork. Set up packaging once for a supported desktop app, then let GG Coder prepare and check repeat builds for you.",
      "A missing review shouldn’t leave you stuck. `Roadmap` now retries a missing or outdated final review once. Still blocked? The recovery message keeps the details and points you to the next step.",
    ],
  },
  {
    id: "local-2026-08-25-ui-and-update-reliability",
    label: "Local Fork",
    date: "2026-08-25",
    items: [
      "See what changed—and why. The new `Decisions` tab explains which local choices survived an update and which upstream improvements came along.",
      "Sent a prompt and got nothing back? Submission errors now show up right in the conversation, instead of leaving you wondering whether anything happened.",
      "Less clicking around your `Roadmap`. Expand a card where it sits, take the next action, and keep the check results right there with the work.",
      "`Done` should mean done. Roadmap work now needs its final review and fresh passing checks before it can cross the finish line. An earlier green result isn’t enough if the work changed afterward.",
      "Update, then get back to it. Local Fork checks the installer, closes cleanly, and reopens with your existing profile after installation.",
      "A failed runtime update no longer takes the working version with it. The new build is checked before it replaces the old one; if those checks fail, the previous version stays available instead.",
      "One less nag in the footer. Local Fork builds no longer show the automatic-update banner meant for the official app.",
    ],
  },
  {
    id: "local-2026-08-23-protected-updates",
    label: "August 23 update",
    date: "2026-08-23",
    items: [
      "Your unfinished work comes with you. Local updates save it before bringing in upstream changes and restore it afterward. Recovery details stay available, and a failed check stops the update from claiming it’s ready.",
      "No more wondering whether a Windows update finished. You now get a clear result and a way to retry when something needs attention.",
    ],
  },
  {
    id: "local-2026-08-22-roadmap-reviews",
    label: "August 22 update",
    date: "2026-08-22",
    items: [
      "The plan shouldn’t get lost once work starts. `Roadmap` now keeps your approved plan and its completion checks attached throughout the run. The final review checks the result against that plan before calling the work done.",
      "Connect your project tools and keep going. They can now start, report status, and shut down from the desktop app—no restart needed.",
    ],
  },
];
