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
    id: "local-2026-09-18-upstream-0651-queues-and-discovery",
    label: CURRENT_LOCAL_RELEASE_NOTES.label,
    date: CURRENT_LOCAL_RELEASE_NOTES.date,
    items: CURRENT_LOCAL_RELEASE_NOTES.sections.flatMap(({ items }) => items),
  },
  {
    id: "local-2026-09-15-upstream-0650-reviewed-commands",
    label: "Upstream 0.65.0, with commands you can review and reuse",
    date: "2026-09-15",
    items: [
      "Find a useful starting point with `Opportunities`. Review the project setup before scanning, then choose `Approve and save setup` when it looks right. Add an optional focus with `/programmatic` to steer the advice without changing the scan or losing completed and dismissed history. Advice can compare available commands, suggest a manual alternative, or explain what is missing rather than forcing every task into a command.",
      "Turn a missing command into something you can reuse, with two separate decisions. Review the proposed command and helper contents before creation; existing files are not overwritten. Running an existing or newly created command needs its own approval for the selected contents and actions. Creating or successfully loading it does not prove its behavior or give it permission to run.",
      "Read the result without a second conversation spilling into yours. `Opportunities` shows a readable execution summary and `Evidence` with backend attribution and completed-tool details, while the child conversation stays out of your transcript. Direct command runs use the same separate session without receiving your chat history; this is not a filesystem sandbox.",
      "Keep the next decision within reach. Reconnecting to a still-running session restores live review questions and matching answer drafts without submitting them. Resizing a review keeps its focused option visible as you scroll, and prompts queued during an overlapping `Opportunities` report can continue when that report finishes instead of being left waiting.",
      "Get to the point sooner. Default replies now aim to be shorter while keeping essential context, risks, and verification. Ask for a full explanation whenever you need one; there is no hard length limit or reduction in the work requested.",
      "Give a stalled `OpenAI` chat one more chance. Through your ChatGPT connection, a rejected `encrypted content` replay gets one automatic recovery attempt using visible messages and tool results, without changing saved history. This targets that specific error, not every provider failure.",
      "Choose your button style with `GG UI` under `Settings > Effects`. Switch the metallic finish on or off, with your choice remembered across windows and restarts. Animated working indicators and the input glow return, while rounded button finishes follow their edges more cleanly when you zoom.",
    ],
  },
  {
    id: "local-2026-09-12-upstream-0634-reviews-and-replies",
    label: "Upstream 0.63.4, with reviews that stay in reach",
    date: "2026-09-12",
    items: [
      "Review without losing your conversation. `Pending reviews` keeps plan approvals and proposed `Roadmap` phases inside the pane, with room to read and scroll while your chat and draft stay in place. A missed notification can recover the same pending proposal while its session is still running; it does not create a second proposal or approve it for you.",
      "Finished an existing `Roadmap` phase? You can now ask the coding agent to record `Done` from your completion report, checking the phase's own goal and completion criteria rather than unrelated release gates. Supporting evidence is still required, and newly proposed phases still wait for your approval.",
      "Get an answer shaped around your question, not a fixed checklist. Replies now favor readable paragraphs and an actionable opening, with room for the detail your task needs instead of a rigid line limit or mandatory status label.",
      "Keep your intent when you use `Enhance?`. The rewrite instructions now make your questions, exclusions, and restart boundaries explicit, so polishing a request is not permission to add work or turn a question into an implementation task.",
      "Let your build finish. Foreground commands now run without a time limit unless one is explicitly requested, including commands that reuse a shell. A hidden five-minute cutoff no longer overrides that choice. You can still stop the work yourself.",
      "Long conversations keep a clearer trail of unfinished fixes. Failing test names now stay in the agent's compacted memory until matching passing results clear them, so shortening the conversation does not silently drop the failures it still needs to address.",
      "Replace repeated text without duplicating the replacement. Global `replace_all` edits now handle each match once, including replacements that contain the original text, rather than accidentally editing their own output.",
      "Read the conversation, not raw diagnostic dumps. Post-edit checks still send problems to the agent, but their internal output stays out of your chat. Your Local Fork also keeps automatic check reminders removed without calling failed or unfinished commands passed.",
      "Know an image limit before chasing another retry. `Flare` and `Sunburst` explain that `transparent backgrounds` are unavailable through your ChatGPT connection, rather than switching models or silently substituting an opaque image.",
    ],
  },
  {
    id: "local-2026-09-09-upstream-0630-images-and-prompts",
    label: "Upstream 0.63.0, with clearer prompts and image results",
    date: "2026-09-09",
    items: [
      "Sharpen your request without changing the mission. `Enhance?` respects your selected model and keeps questions, details, and exclusions in view. Empty or cut-short rewrites are rejected rather than replacing your draft.",
      "Image requests use `GPT Image 2.5 Flare` for creation and `Sunburst` for edits through your connected OpenAI account, even when your chat uses another provider. Saved originals are not resized to match your request. Size mismatches get a warning; exact sizing is not guaranteed, and transparent backgrounds are not supported.",
      "Pick up your images where you left off. Reopened chats keep multiple previews paired with their saved originals and retain image warnings. If generation or preview creation stops partway through, the result lists what was saved without retrying it. Deleted originals lose their open action, not their retained preview.",
      "A sent prompt should stay sent. Accepted prompts are saved before work begins, and pane-local drafts stay with their workspace instead of spilling into another pane. Regular sent prompts also get a distinct blue treatment without changing queued messages or question answers.",
      "Question cards wait for an accepted answer before looking settled. Busy controls and `Autopilot` keep their session boundaries, so a stale response cannot silently approve a newer request or start unrelated work.",
      "Repository references are easier to follow. Linked repository names take you to the source without losing the context of the result.",
      "Preview ready? Keep going without shutting it down. `Dev-server readiness` lets the agent check your page while the server stays running, without calling that ongoing command complete.",
      "Keep moving while `edit checks` run in the background. Delayed diagnostics still reach the agent without bringing back the Local Fork's removed automatic check reminders.",
    ],
  },
  {
    id: "local-2026-09-07-upstream-0621-and-roadmap-recovery",
    label: "Upstream 0.62.1, with steadier Roadmap updates",
    date: "2026-09-07",
    items: [
      "Stay signed in across windows and the `CLI`. When another session refreshes your login, this one now notices the replacement even when its timestamp looks unchanged, instead of hanging on to an old login.",
      "Less work before you get to yours. `What's new` and release histories now load when needed rather than with your workspace. Empty-input hints stop animating while you type, focus the composer, or leave a pane inactive.",
      "A refused `Roadmap` update no longer looks saved. If another session owns the phase or the plan changed while work was running, the agent gets the reason instead of a success message. Newer progress stays in place.",
      "Recovering `Project Notes` shouldn’t undo newer work. A delayed recovery response now leaves newer edits alone and checks the latest saved notes before trying again. Notes from an unsupported app version stay untouched rather than falling back to an older local copy.",
      "Your approval still starts the work. An approved plan carries its instructions into the working session without letting a reviewer start it for you. Completed `Roadmap` activity also keeps its `Done` label when reopening older sessions.",
    ],
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
