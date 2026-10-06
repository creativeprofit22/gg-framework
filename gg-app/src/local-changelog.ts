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
    id: "local-2026-10-06-upstream-0822-clearer-failures-and-leaner-agent",
    label: CURRENT_LOCAL_RELEASE_NOTES.label,
    date: CURRENT_LOCAL_RELEASE_NOTES.date,
    items: CURRENT_LOCAL_RELEASE_NOTES.sections.flatMap(({ items }) => items),
  },
  {
    id: "local-2026-10-05-upstream-0821-checklist-and-clearer-errors",
    label: "Upstream 0.82.1, with a project Checklist and clearer error notices",
    date: "2026-10-05",
    items: [
      "Every project gets a health hub. Open `Checklist` from the top of a chat pane to work through setup, tests, security and shipping one check at a time. Results are saved, each pane checks its own project, and you get a nudge when a check is due again.",
      "When a chat hits a snag, the notice tells you what to do next. Usage limits, sign-in trouble and unavailable models each get their own notice with expandable details and a `Choose model` or `Switch provider` button when switching helps. Rate limits show the time the provider says you can retry, and a rotating crew of critters keeps you company.",
      "Attachments land every time. `Send` waits until your files finish loading, so nothing gets left behind, and a file that fails to load tells you instead of quietly vanishing.",
      "Fresh starts feel fresh. A new session opens straight to the welcome screen instead of showing the last run's `cancelled` status.",
      "Your plans wait for you. When the agent hands over a plan for review, it stops cleanly instead of burning extra turns while you decide.",
      "`Ultra` on OpenAI thinks the way Codex does, and helper agents now inherit the effort level you picked instead of quietly dropping to the lowest one.",
      "`Checks passed` means what it says. Mixed shell commands no longer count as fresh verification, and the agent has a clear way to run its checks and look over its changes without hiding a failure.",
      "Every turn is a little lighter. The agent loads its task list tool only when it needs it and follows shorter house rules, so each request sends about `1,400` fewer characters.",
      "`Find references` reaches further in JavaScript projects without a config file. It includes callers in files you haven't opened and tells the agent when coverage is incomplete.",
    ],
  },
  {
    id: "local-2026-10-04-upstream-0810-faster-openai-and-multi-file-edits",
    label: "Upstream 0.81.0, with faster OpenAI runs and multi-file edits",
    date: "2026-10-04",
    items: [
      "Your `ChatGPT` and OpenAI API key chats move faster. The agent can now send several tool calls in one go instead of one per reply, and it stops spelling out every blank option on each call, so work lands sooner and costs fewer tokens. Prefer the old one-at-a-time style? Set `codexResponsesLite` and `codexStrictTools` to `on` in your settings file.",
      "Changes that span files land in one step. The agent can edit several files in a single call instead of crawling through them one turn at a time, so renames and refactors across your project finish sooner. If one file fails, the rest still save and the agent retries only the one that failed.",
      "Bug fixes stick. When the cause is clear, the agent sends the fix together with a small test that catches the bug and runs your tests once, so the same problem can't quietly come back.",
      "Less busywork before the real work. The agent no longer hunts for instruction files it has already read, and it skips loading specialist skills for everyday fixes and renames.",
      "`Gemini` works with your whole toolbox again. A hidden snag made it refuse requests whenever certain tools were loaded, like `web_fetch`; that's fixed.",
      "Helper agents start reliably in the desktop app again. A crash that stopped the `subagent` tool before it even began is fixed, so handing off work just works.",
    ],
  },
  {
    id: "local-2026-10-04-upstream-0790-campfire-and-faster-agent",
    label: "Upstream 0.79.0, with a campfire Home and a faster agent",
    date: "2026-10-04",
    items: [
      "Your Home screen is now a cozy campfire clearing in the pines, and it follows your clock. Stars and an owl at night, mist and waking birds at dawn, sunbeams by day, then fireflies and bats at dusk.",
      "Replies look finished from the very first letter. Bold, code and links render as they stream instead of flashing raw symbols, and a floating pill takes you back down to `You have new chats` or `You have a new question` when you scroll away.",
      "Plan review opens full window, laid out just like your chat, with a little critter crew keeping you company while you accept, reject or send feedback.",
      "Your laptop won't nap halfway through a big job. The new `Keep computer awake` switch in Settings, under `Power`, keeps it working while the agent runs; your screen can still turn off.",
      "No more paying full price by surprise. If you step away long enough for the AI's memory of your chat to go cold, a heads-up appears before you send, with a one-click `Compact first` to keep the next message cheap.",
      "Motion mode learned sound and style: sound effects that stay locked to the action when you retime it, real motion blur, music that cuts on the beat, and `10` fresh animation pieces. `GG Motion` checks also run up to `4` parts at once.",
      "Your agent answers sooner and spends fewer tokens. The extra self-review pass that padded every turn is gone; `Autopilot` reviews and your project's checks still run as before.",
      "Helper agents have to meet the bar. The main agent can set checks up front, like a file must exist or a command must pass, and each one is judged from what the helper really did: `PASS`, `FAIL` or `UNVERIFIED`. Every helper report also lists the files it really read and changed.",
      "The agent can now debug like a pro. The new `debug` tool pauses a Node program on a breakpoint, steps through it line by line and reads live variables, so bugs get found by watching the code run.",
      "A question you missed no longer freezes the agent. After `10 minutes`, or `2 minutes` on `Autopilot`, it carries on with its best guess, and if you answer later your answer still gets sent.",
      "Send a new message while a command is running and the agent stops right there to read it, while file edits always finish cleanly so nothing is left half-written.",
      "A sturdier safety net. The agent refuses git commands that would wipe uncommitted work, scripts piped straight from the internet into your shell, and packages with lookalike names. Web pages that try to sneak orders to the agent get flagged.",
      "Give the agent house rules. A short markdown note in your project's rules folder sets its habits, and it gets a reminder whenever its output breaks one, like leaving a stray `console.log`.",
    ],
  },
  {
    id: "local-2026-10-01-upstream-0750-ken-face-and-home-critters",
    label: "Upstream 0.75.0, with Ken's face and a lively Home",
    date: "2026-10-01",
    items: [
      "Ken has a face. His replies now open with a little animated pixel portrait that blinks and talks while he types. Flip `Autopilot` on and he wakes up with a happy hop beside the big `KEN ON` banner; flip it off and he nods off with a sleepy `z`.",
      "Your Home screen is alive. The whole critter crew beams in along the bottom on a fresh world each visit, from a sunny meadow to a beach, a desert, snow or deep space. Watch them wander, meet up and play, and click one to make it jump.",
      "File chips under the message box now slide in when you attach or `@`-mention a file, and fold away smoothly when you remove them or send, instead of popping in and out.",
    ],
  },
  {
    id: "local-2026-10-01-upstream-0740-critters-and-palette",
    label: "Upstream 0.74.0, with helper critters",
    date: "2026-10-01",
    items: [
      "Helper agents now show up as little pixel critters above the chat. They beam in, wander around, hop with each new task and now and then say what they are doing, then wave goodbye when they finish. Click one to see how it reacts.",
      "Chat stays where you scroll. While the agent is still typing, scrolling up to reread something no longer pulls you back to the bottom, and scrolling back down turns following back on.",
      "Signed in with `ChatGPT`? Long replies no longer stop mid-sentence, because the agent picks up where the reply was cut off. `GPT-6.1 Sol` replaces GPT-6 Sol in the model list, and `GPT-6 Astra` stays your default.",
      "A command like `npm run dev &` no longer leaves the agent waiting for two minutes. Helpers that hit their time limit now bring back what they found, and the agent has to read the rest of a big file before it can rewrite the whole thing.",
      "Passwords inside database links, like the ones `Redis` uses, are now hidden from the agent. Invisible text tucked into files like `AGENTS.md` is removed before the agent reads them, and tooltips fade out gently instead of blinking away.",
      "`GG Motion` checks every video for harmful flashing. Your project list leaves out hidden tool folders and projects you never worked in, and on `Windows` the window layout menu no longer opens behind the chat.",
      "Press `Ctrl+K` (`Cmd+K` on Mac) to open a `Commands` palette with your collection commands, grouped into Everyday, Specialist, Setup and Other. Type to search. If a command file could not be read, the palette tells you why instead of quietly leaving it out.",
      "The session pickers now show each session's last reply and model, so you can tell sessions apart at a glance. If a session will not open, the picker explains why in plain words, with `Details` for the full message. In narrow windows, the picker's header actions fold into a `More actions` menu.",
      "A `/command` you send while the agent is busy now reaches it as the command's full instructions, not just its name, and the queue still shows what you typed. If the app cannot take a message right then, it asks you to wait for the current work to finish instead of failing quietly.",
      "Your mentor is called Ken again. Both `@Ken` and `@Supah` still reach him, and his replies show the same name live as they do when you reopen a session.",
      "Pane controls come first when you move around with Tab and keep a visible focus ring. A single pane no longer has a frame drawn around it.",
      "Controls under the message box show a hover label, plus a small arrow where they open a picker. Picker buttons are bigger and easier to hit, the search box shows a clear focus ring, and rows no longer stretch across very wide windows.",
      "The tagline on Home stays readable over the dotted background, and the Home buttons wrap in narrow windows. The radio and window layout buttons have new headphones and grid icons.",
    ],
  },
  {
    id: "local-2026-09-28-readable-tables-and-slash-menu",
    label: "Tables that fit your pane, and a clearer slash menu",
    date: "2026-09-28",
    items: [
      "Wide tables in chat now wrap their text to fit the pane instead of pushing out a sideways scrollbar. A table only scrolls sideways when its columns truly cannot get any narrower.",
      "The `/` menu has a solid background, so command names and their hints stay easy to read over the chat behind it.",
      "`/steroids` folds its list of suggested repos under a `Show table` button, so the question about how many to index stays in view. Open it to compare the ranked picks, and `Hide table` tucks it away again.",
    ],
  },
  {
    id: "local-2026-09-28-upstream-0721-motion-and-sonnet-55",
    label: "Upstream 0.72.1, with Motion videos and Sonnet 5.5",
    date: "2026-09-28",
    items: [
      "Home has a new `Motion` button beside Code and Chat. It opens a workspace for short videos like product launches, feature demos, social ads and explainers, with its own session list and a `+ New video` button. An empty Motion screen offers starters such as `Launch my product` and `Make a social ad`, which fill in the message box so you can add your link or files before sending.",
      "Motion panes now come back when you reopen a saved layout instead of quietly disappearing. Reviewed command runs only start inside Code workspaces, so they cannot fire from Chat or Motion by accident.",
      "`Claude Sonnet 5.5` replaces Sonnet 5 as Anthropic's starting model, and you can push its thinking up to the extra-deep `xhigh` level. If you had Sonnet 5 picked, you move to 5.5 automatically.",
      "Custom commands can now show what to type after them. Highlight a command in the `/` menu and its hint appears on that row, wrapping underneath in narrow panes.",
      "`/sweep --map` splits a whole codebase into areas to check, and `/sweep --merge` gathers the results into fix tasks you run one at a time. `/trace`, `/parity`, `/contract`, `/flow` and `/ship` now share one set of rules, so they stay read-only, avoid filing the same task twice, and ask their questions as clickable cards.",
      "When the code checker for a language is missing, the agent tells you once how to install it instead of going quiet or repeating itself.",
      "The `Radio` is ready as soon as the app opens, so your stations load on the first click.",
      "The message box resizes more smoothly while you type and send.",
    ],
  },
  {
    id: "local-2026-09-28-upstream-0720-settings-and-clearer-questions",
    label: "Upstream 0.72.0, with a Settings screen and clearer questions",
    date: "2026-09-28",
    items: [
      "`Settings` now opens as a full screen instead of a popup, with tabs for `General`, `AI Providers`, `Remote`, `MCP` and `Steroids`. The gear on Home takes you there, and going back refreshes Home so your changes show right away.",
      "Home has a gently moving `dithered wave` behind the Supah Coder banner. It pauses when the window is out of focus, and `Background on` under Settings, Effects turns it off. The app also has a crisper icon set throughout, and the memes button is gone.",
      "New models arrived with the update: `Kimi K2.8 Preview`, `DeepSeek V4.1 Flash` with screenshot support, Sakana's `Fugu Max`, and `Qwen3.8 Max` as OpenRouter's starting model. Your Kimi sign-in also renews in the background, so it no longer expires mid-session.",
      "Every question card now says what the agent found and why it needs your call, so a card makes sense even if you skipped the chat above it. When the agent gets a card wrong and has to redo it, the status reads `Question closed` instead of claiming it is continuing with a decision you never made.",
      "The agent answers your question first. If what you asked is unclear, it answers the likeliest reading and tells you what it assumed, and only asks when it truly cannot go on without you.",
      "When a pane loses its connection, it shows `Reconnecting…` again instead of looking frozen.",
      "Simple housekeeping like `git status` no longer makes the agent ask to re-check work that has not changed.",
      "Folded code previews keep their green and red diff colours, the message box switches to a shorter hint when the full one would be cut off, and letters like g and y are no longer clipped in the plan review header.",
    ],
  },
  {
    id: "local-2026-09-27-upstream-0705-steadier-replies",
    label: "Upstream 0.70.5, with steadier question cards and big edits",
    date: "2026-09-27",
    items: [
      "No more blank window when the agent asks a few quick questions at once. A card with two or more `Yes / No` questions could empty the whole window. The cause is fixed, and your sessions stay right where you left them.",
      "Large file edits are no longer cut off partway through. While the agent is writing a big change, it can pause for up to five minutes between chunks before the run is treated as stuck. Before this fix, the limit was 90 seconds.",
      "Models that think quietly for a long time get more room. The agent now waits up to ten minutes of silence after thinking starts, and up to fifteen minutes in total, so a hard problem is not stopped just before the answer arrives.",
    ],
  },
  {
    id: "local-2026-09-26-steadier-commands-and-questions",
    label: "Long commands that keep going, and questions you can always finish",
    date: "2026-09-26",
    items: [
      "A slow build or install is no longer cut off because the agent guessed it would be quick. After two minutes it moves to the `Background tasks` list and keeps running while the agent carries on. A command that prints nothing for ten minutes, or runs past an hour, is stopped as stuck, so a hung step cannot hold your session forever.",
      "Closing the app on Windows now also closes the commands the agent started, so no stray builds or servers are left running in the background after you quit.",
      "A card with several questions always has a `Send answers` button that shows how many you have answered. Questions you leave open reach the agent as skipped, and choices you ticked are included, so an optional question never leaves `Stop` as the only way out.",
      "If a question was no longer waiting when you answered, the card closes and says `That question expired before your answer arrived.` instead of staying clickable. When you stop a run while a question is open, the agent is told you did not answer rather than being left to guess.",
      "`Enhance?` now focuses on vocabulary. It swaps everyday descriptions for the term a seasoned practitioner would use, in any field from code and design to video, audio, or writing, and highlights each new term next to your own words so you can learn it. Your request, details, and limits stay exactly as you wrote them.",
      "`Light` windows open light, with no dark flash on reload, and new windows appear already in place with the right title bar. Provider logos that were nearly invisible on light sign-in tiles are now easy to see.",
      "Fewer stray scrollbars. Home scrolls when the window is short instead of hiding its top and bottom, and wide tables in chat scroll on their own while fitting the pane, without splitting words in narrow columns.",
      "A project that is slow to start on a busy machine now gets more time to come up instead of failing to open.",
    ],
  },
  {
    id: "local-2026-09-23-upstream-0702-gpt6-and-calmer-app",
    label: "Upstream 0.70.2, with GPT-6 Sol and Luna and a calmer app",
    date: "2026-09-23",
    items: [
      "`GPT-6 Sol` and `GPT-6 Luna` join `GPT-6 Astra` in the model menu, replacing the `GPT-5.6` family. Sol is a strong coder that reaches up to `ultra` effort, and Luna is the quick, inexpensive choice for lighter work. New OpenAI chats in your Local Fork still start on `GPT-6 Astra` unless you pick otherwise.",
      "API keys and passwords were already hidden from the agent. Now it also cannot overwrite a real key in your files with the hidden placeholder it was shown, so a routine edit to your `.env` or config leaves your actual secrets intact.",
      "Every button can now explain itself. Hover or tab onto a control and its `tooltip` appears in the app's own style, quickly as you move between buttons, and never when you did not ask for one.",
      "Always know where you are with the keyboard. Controls show a clear `focus ring`, and popups fade away instead of vanishing. Turn off `Animation effects` in Windows settings, or turn on `Reduce motion` on macOS, and those animations calm down for you.",
      "Errors wait for you. They stay on screen until you close them, and any notice holds still while you hover or focus it, so nothing important slips past while you are looking away.",
      "Swap arrows now appear on every pane in a grid, including the middle column of a `3x2` layout whose dividers were dragged a few pixels apart. Rows that line up by eye are treated as the same row.",
      "See why a task stopped. When a `Tasks` run ends early, the task now says why, such as `Last run stopped: it was cancelled.` Running or deleting a task also reports a clear failure instead of waiting forever when the run cannot start or the save fails.",
      "Settings and `Internet Radio` tell you what happened. Saving or loading shows its progress and any error, the `New project` folder preview follows a changed projects folder straight away, and pausing the radio on Windows really stops playback.",
      "A command that cannot start is now reported as a failure rather than looking like it quietly succeeded, and turning off network access also stops a web fetch that is already following redirects.",
    ],
  },
  {
    // Named 0.66.4 because that build was packaged but never installed; the
    // content covers upstream through 0.69.0. Keep the identifier: changing it
    // would present already-read notes as unread.
    id: "local-2026-09-22-upstream-0664-status-and-reading",
    label: "Upstream 0.69.0, with Claude Opus 5.5 and long sessions that keep their pace",
    date: "2026-09-22",
    items: [
      "Choose `Claude Opus 5.5` when a coding session runs long. Anthropic built it for exactly that, and it reasons adaptively at every level from `low` through `max` rather than being locked to one setting. It holds a `1M` token conversation, reads images, and costs less to run than the model it replaces. New `Anthropic` chats still start on `Claude Sonnet 5` unless you pick otherwise.",
      "`Grok 4.7` now starts your `xAI` chats in place of `4.6`. It keeps the same `500K` context and adds an extra-deep `xhigh` reasoning level for the problems that need more thought.",
      "Xiaomi's `MiMo V2.6` family replaces `V2.5`. `MiMo V2.6 Pro` starts your `Xiaomi` chats and can read screenshots and video clips alongside your code, `MiMo V2.6 Flash` keeps quick lookups inexpensive, and an `UltraSpeed` option is there when pace matters more than depth.",
      "A long session no longer slows to a crawl. Conversations are now shortened against a budget suited to the model before they ever get heavy, so the pace an hour into a large task holds up instead of degrading.",
      "Fewer phantom stalls on a large prompt. A big request is no longer abandoned after a fixed wait and restarted from the beginning; it gets the time the work actually needs, so you see fewer unexplained pauses and retries.",
      "Ask for UI and get genuine source rather than an invented lookalike. Your agent can inspect public `Bklit` and `Kokonut` components, `shadcn` source, and animation APIs, then plan and adopt that real source into your project. Adoption does not overwrite your existing files or install packages on its own.",
      "Animation that respects how you like to work. New `Motion` guidance means real animation APIs, your `reduced motion` preference honored, and animations cleaned up when a view closes.",
      "Ask for interfaces with fewer repeated descriptions and more consistent controls. The updated `UI skill` puts more emphasis on checking keyboard focus and dropdown behavior through actual interactions, not treating a screenshot as proof that everything works.",
      "Follow the work without reading every tool message. The `activity bar` now distinguishes checking code, retrying, reconnecting, waiting for you, and `Ken` reviewing. It keeps the result visible when work stops, and each pane follows its own conversation instead of borrowing another pane's progress.",
      "Read a fresh answer without inheriting yesterday's green check. Status separates checks from the current request from warnings about earlier work, and gives research and background jobs their own finish messages. Passing checks are not a claim that an update was released or installed.",
      "Watch a task list update as it happens. When your agent adds, finishes, or drops a task, the count in the header and an open `Tasks` view now change immediately, rather than waiting for the next background refresh or a manual reopen.",
      "Keep `Ken` and `Autopilot` focused on the work you asked for. Reviews retain your latest decisions and look for unfinished requirements rather than an endless list of optional improvements. Your Local Fork still waits for your approval before implementing a proposed plan.",
      "Make a `slash command` fit this invocation. An explicit choice of scope, format, or whether to edit takes priority over the template's default, while the rest of its procedure stays intact. Neither command text nor its arguments grant permission to use tools or skip an approval.",
      "Keep working through longer conversations. Automatic compaction can prepare a shorter history in the background, then use it at a safe boundary rather than interrupting a tool result. Your recent conversation and saved command invocations remain part of the continuation.",
      "Keep pictures with your chat in connected editors. `ACP` connections now forward screenshots and generated images both as they arrive and when saved history is reopened, instead of leaving the image behind.",
      "Start supported deep-thinking models at a more practical reasoning level. New chats use the model's default rather than automatically choosing its maximum, and `plan mode` limits deeper reasoning. A reasoning choice you saved still takes precedence where that model supports it.",
      "Choose a workspace that suits your eyes in `Settings > Appearance`. Switch between `Dark` and `Light`, adjust `Prose size`, `Letter spacing`, and `Paragraph spacing`, or limit the reading width in wide panes. Code and compact controls keep their sizing, and `Reset appearance defaults` gives you a clear way back.",
      "Keep your place while arranging conversations. Reading anchors, drafts, and focus stay with their pane through supported swaps and resizes, while saved appearance choices carry across windows. `Identity markers` and `Crisp reveal` offer another way to distinguish speakers and read streamed replies.",
      "Reach a brand-new model on the day it arrives. When `Anthropic` turns a request away because it expects a newer client than this app reports, the app now reads the version it asked for, adopts it straight away, and retries your message instead of repeating the refusal for up to a day. This was keeping `Claude Opus 5.5` unreachable behind an error saying the model was not supported.",
      "A provider refusal no longer disappears behind a blank finish. The agent can make one bounded recovery attempt when the provider's response allows it; a repeated refusal remains a clear error in the conversation. This does not override the provider's restrictions or promise that every request will succeed.",
      "Let scratch files stay out of your way. Temporary-file handling now accounts for the shell's scratch folder on Windows as well as platform temporary folders, while preserving checks that keep file access within the permitted locations.",
    ],
  },
  {
    id: "local-2026-09-18-upstream-0651-queues-and-discovery",
    label: "Upstream 0.65.1, with steadier queues and clearer next steps",
    date: "2026-09-18",
    items: [
      "Cancel the message you meant to cancel. When two queued prompts have the same text, removing one no longer removes the other's conversation bubble. The remaining prompt keeps its attachments and enhancements, and another pane's queue stays separate.",
      "Keep an accurate conversation when timing is close. If a queued message has already reached the agent, a late cancellation does not erase it. Delayed replies cannot bring a cancelled bubble back or replace a newer queue, and the queued label clears when a message starts running.",
      "Start with what your project needs in `Opportunities`, even before a scanner is configured. Discovery can suggest reusing a command, extending one, preparing something new, or leaving already-automated work alone. Scanner results stay separate from those suggestions, so finding a candidate is not proof that a command exists or is ready to run.",
      "Review a candidate before committing to it. Selecting an opportunity starts a read-only review; it does not create files or run the proposed work. A missing command needs a complete proposal before it can be ready for your next decision, and a finished review now returns its summary to the selected opportunity instead of leaving it looking unfinished.",
      "Keep earlier decisions in view. Recommendation history retains completed and dismissed choices and lets you browse older candidates without treating an old review as fresh permission. Changed project context calls for a new review; creating a command and executing it still require separate approvals.",
      "Manage your `Qwen Cloud` connection without exposing a saved key in the interface. Saving, replacing, or removing it refreshes connection and model availability across open windows. Changes wait while work is running, and a locally saved key is not presented as a remotely verified account or allowance.",
      "Read progress without guessing what finished. Replies keep the Local Fork's short-by-default style, with room for detail when you need it, while distinguishing work that is implemented, tested, committed, or released. There is no hard reply-length limit, and a successful check is not described as an installed update.",
    ],
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
