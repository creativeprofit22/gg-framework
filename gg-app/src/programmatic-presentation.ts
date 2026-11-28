import type {
  ProgrammaticAreaProgress,
  ProgrammaticAreaProgressStatus,
  ProgrammaticAssessment,
  ProgrammaticAssessmentArea,
} from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type {
  ProgrammaticChatConfiguration,
  ProgrammaticChatSummary,
  ProgrammaticExecutionEvidence,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { PROGRAMMATIC_AREA_RETRY_REFUSED } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type {
  DiscoveryCandidate,
  DiscoveryChoice,
  DiscoveryReview,
  RecommendationHistoryReport,
  RecommendationSummary,
} from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import type { LampTone } from "./InstrumentParts";
import type { ProgrammaticChatState } from "./programmatic-chat-state";
import { programmaticConfiguration } from "./programmatic-chat-selectors";
import type { OpportunityStep, OpportunityStepState } from "./programmatic-opportunity-tabs";

/*
 * The only owner of user-facing Opportunities wording. Components import from
 * here; no Opportunities view keeps a label map of its own.
 */

export interface IdeaVerdict {
  /** Short card plate: says at a glance whether the user needs to act. */
  readonly plate: string;
  /** Sentence form, used where the kind reads inside a sentence (Other options). */
  readonly sentence: string;
  /** What the user needs to do, shown first in an open idea. */
  readonly yourPart: string;
  readonly tone: LampTone;
}

export const IDEA_VERDICTS = {
  "reuse-command": {
    plate: "Already handled",
    sentence: "You already have a command for this",
    yourPart: "Nothing. A command you already have covers this.",
    tone: "success",
  },
  manual: {
    plate: "Nothing to do",
    sentence: "Better left as a manual step",
    yourPart: "Nothing to set up. Keep doing this yourself; it isn't worth automating.",
    tone: "neutral",
  },
  "needs-more-evidence": {
    plate: "Worth a closer look",
    sentence: "Needs a closer look before deciding",
    yourPart: "Optional. Look into it if it matters to you.",
    tone: "warning",
  },
  "missing-capability": {
    plate: "Needs a new command",
    sentence: "Needs a new command",
    yourPart: "Your call. Review the idea if you want this command made.",
    tone: "primary",
  },
  "extend-command": {
    plate: "Change a command",
    sentence: "A command you have could do this with changes",
    yourPart: "Your call. Review the suggested changes to your command.",
    tone: "primary",
  },
  "generate-from-reference": {
    plate: "Build one then copy it",
    sentence: "Build one, then copy it for the rest",
    yourPart: "Your call. Review the plan for building it.",
    tone: "primary",
  },
} as const satisfies Record<DiscoveryChoice, IdeaVerdict>;

/** "Already handled" is only true while the command is confirmed to exist. */
const UNCONFIRMED_COMMAND_VERDICT = {
  plate: "Check your command",
  sentence: IDEA_VERDICTS["reuse-command"].sentence,
  yourPart: "Check the command again. AI couldn't confirm it still works here.",
  tone: "warning",
} as const satisfies IdeaVerdict;

export const isCommandIdea = (item: Pick<DiscoveryCandidate, "choice">) =>
  item.choice === "reuse-command" || item.choice === "extend-command";

const commandUnconfirmed = (item: Pick<DiscoveryCandidate, "choice" | "availability">) =>
  isCommandIdea(item) && item.availability?.status !== "available";

export function ideaVerdict(
  item: Pick<DiscoveryCandidate, "choice" | "availability">,
): IdeaVerdict {
  return item.choice === "reuse-command" && commandUnconfirmed(item)
    ? UNCONFIRMED_COMMAND_VERDICT
    : IDEA_VERDICTS[item.choice];
}

export const ideaKindSentence = (choice: DiscoveryChoice): string => IDEA_VERDICTS[choice].sentence;

export function availabilityLabel(
  status: NonNullable<DiscoveryCandidate["availability"]>["status"] | undefined,
): string {
  return status === "available"
    ? "Command found"
    : status === "unavailable"
      ? "Command not found"
      : "Command needs another check";
}

export const reviewLabel = (item: Pick<DiscoveryCandidate, "choice" | "availability">) =>
  commandUnconfirmed(item) ? "Check the command again" : "Review this idea";

/** Says what the review button does before it is pressed. */
export const reviewHint = (item: Pick<DiscoveryCandidate, "choice" | "availability">) =>
  commandUnconfirmed(item)
    ? "AI checks the command again. Nothing is changed or run."
    : "AI explains the exact change first. Nothing is changed or run.";

export const IDEA_DETAIL_TERMS = {
  yourPart: "Your part",
  change: "What would change?",
  where: "Where?",
  unsure: "What we're not sure about",
  risk: "What could go wrong?",
  notes: "Good to know",
} as const;

/** Collapsed inside More details; keeps exact sources out of the default view. */
export const TECHNICAL_DETAILS = {
  summary: "Technical details",
  intro: "Sources for each finding above, in the same order.",
} as const;

export const NO_RISKS_LISTED =
  "AI didn't spot any risks. Check the change yourself before approving it.";

export const REVIEW_STATUS_LABELS = {
  prepared: "Review ready. Nothing was changed.",
  "reinspection-required": "This command needs another check first.",
  unsupported: "This idea can't be reviewed here.",
} as const satisfies Record<DiscoveryReview["status"], string>;

/** One plain word per evidence basis, shared by every Opportunities view. */
const EVIDENCE_BASIS_LABELS = {
  observed: "Checked",
  inferred: "Best guess",
  assumed: "Assumed",
} as const satisfies Record<ProgrammaticExecutionEvidence["basis"], string>;

export const evidenceBasisLabel = (basis: ProgrammaticExecutionEvidence["basis"]) =>
  EVIDENCE_BASIS_LABELS[basis];

// Past ideas

export const PAST_IDEAS_RECORD_NOTE =
  "This is a list of earlier ideas. Opening one doesn't change or approve anything.";

export const PAST_IDEA_DECISION_LABELS = {
  open: "Still open: not acted on yet",
  completed: "Done: you handled this",
  dismissed: "Dismissed: you said no",
} as const satisfies Record<RecommendationSummary["decision"], string>;

export const PAST_IDEA_COPY_NOTE = "Same as an earlier idea. See the earlier one for its status.";
export const PAST_IDEA_POSSIBLE_REPEAT = "May repeat another idea.";

export const PAST_IDEAS_STATUS_LABELS = {
  disabled: "Saving past ideas is off",
  missing: "No past ideas yet",
  ready: "Past ideas loaded",
  recovered: "Past ideas loaded, but some may be missing",
  unavailable: "Couldn't load past ideas",
} as const satisfies Record<RecommendationHistoryReport["status"], string>;

export const seenCount = (count: number) =>
  `Found in ${count} ${count === 1 ? "search" : "searches"}`;

// Idea search (assessment) outcome

type Assessment = ProgrammaticAssessment;

export const SEARCH_STATUS_LABELS = {
  completed: "Done",
  incomplete: "Not finished",
  cancelled: "Stopped",
  unavailable: "Not available",
} as const satisfies Record<Assessment["status"], string>;

export const SEARCH_HISTORY_LABELS = {
  saved: "saved",
  disabled: "off",
  "setup-not-saved": "not saved during setup",
  unsaved: "not saved",
  "acknowledgement-unknown": "not sure it saved",
} as const satisfies Record<NonNullable<Assessment["history"]>["status"], string>;

export const CHECK_RUN_LABELS = {
  succeeded: "Done",
  "not-run": "Not run",
  unavailable: "Not available",
  denied: "Not allowed",
  cancelled: "Stopped",
  failed: "Failed",
} as const satisfies Record<Assessment["deterministic"]["status"], string>;

export const CHECK_RUN_EXPLANATIONS = {
  unavailable: "Your checks couldn't run.",
  denied: "Your checks weren't allowed to run.",
  cancelled: "Your checks were stopped, so results are incomplete.",
  failed: "Your checks failed. See Details for why.",
} as const satisfies Record<
  Exclude<Assessment["deterministic"]["status"], "succeeded" | "not-run">,
  string
>;

export const COVERAGE_LABELS = {
  inspected: "Checked",
  uninspected: "Not checked",
  "budget-limited": "Partly checked",
  unreadable: "Couldn't read",
  unsafe: "Skipped for safety",
  nonmatching: "Didn't match",
  "not-applicable": "Didn't apply",
} as const satisfies Record<Assessment["coverage"][number]["status"], string>;

const TOOL_LIMIT = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*): (tool error|cancelled)\./g;

// Must stay in sync with TOOL_LABELS and plainToolLimitation() in
// packages/ggcoder/src/core/programmatic/advisory.ts, so old and new sessions
// word the same failure identically. Display text only, not a gg-core contract.
const TOOL_LABELS: Readonly<Record<string, string>> = {
  programmatic_scan: "Running your project checks",
  programmatic_advisory_result: "Saving the answer",
  programmatic_profile: "Reading your check setup",
  command_information: "Reading your commands",
  research_corpus: "Searching code examples",
  git_history: "Reading project history",
  web_fetch: "Opening a web page",
  web_search: "Searching the web",
  read: "Reading project files",
  find: "Reading project files",
  grep: "Reading project files",
  ls: "Reading project files",
  code_search: "Reading project files",
  code_nav: "Reading project files",
};

/**
 * Plain wording for host limitation lines saved by older sessions, such as
 * "programmatic_advisory_result: tool error.". Newer sessions already store
 * plain sentences; other text passes through unchanged.
 */
export function plainLimitation(text: string): string {
  return text.replace(TOOL_LIMIT, (_match, tool: string, outcome: string) => {
    const label = TOOL_LABELS[tool] ?? "One of AI's checks";
    const cancelled = outcome === "cancelled";
    return `${label} ${cancelled ? "was stopped" : "failed"}, so this search may have missed something.`;
  });
}

// Steps: 1 Quick checks, 2 Find ideas, 3 Review. Order and state live in
// programmatic-opportunity-tabs.ts; this file owns only the words.

export const STEP_COPY = {
  checks: {
    label: "Quick checks",
    intro: "Free checks that look for known setup problems. They don't use AI.",
  },
  ideas: {
    label: "Find ideas",
    intro:
      "AI reads your project and suggests work you could automate. Nothing changes until you approve it.",
  },
  review: {
    label: "Review",
    intro: "Look over what was found. Saved check results and AI ideas are kept apart.",
  },
} as const satisfies Record<OpportunityStep, { label: string; intro: string }>;

/** The word carries the meaning; the icon is decoration. */
export const STEP_STATE_WORDS = {
  done: { word: "Done", icon: "✓" },
  next: { word: "Next", icon: "→" },
  "not-yet": { word: "Not yet", icon: "○" },
} as const satisfies Record<OpportunityStepState, { word: string; icon: string }>;

export const STEP_ACTIONS = {
  findIdeas: "Find ideas",
  searchAgain: "Search again",
  openReview: "Open review",
  skip: "Skip for now",
  pastIdeas: "Past ideas",
  close: "Close",
} as const;

export const REVIEW_GROUPS = {
  ready: "Ready to run",
  ideas: "Ideas",
} as const;

/** Shown inside an empty Review group; the step bar says which step fills it. */
export const REVIEW_EMPTY = {
  ready: "No saved check results yet.",
  ideas: "No ideas to review yet.",
} as const;

// Step 1. Only Find ideas uses AI; every Quick checks action is instant and free.

export const CHECKS_ACTIONS = {
  show: "Show suggested checks",
  update: "Update checks",
  save: "Save checks",
  notNow: "Not now",
  checkAgain: "Check again",
  dismiss: "Dismiss",
  tryAgain: "Try again",
} as const;

/** "Update checks" only when relevant project files changed since the checks were saved. */
export const checksReviewLabel = (
  configuration: Pick<ProgrammaticChatConfiguration, "refreshAvailable"> | null,
): string => (configuration?.refreshAvailable ? CHECKS_ACTIONS.update : CHECKS_ACTIONS.show);

/** The proposal can no longer be saved; name the button that shows it again. */
export const staleProposalText = (
  configuration: Pick<ProgrammaticChatConfiguration, "refreshAvailable"> | null,
): string =>
  `These suggested checks are out of date. Choose ${checksReviewLabel(configuration)} again.`;

export const CHECKS_NOTICES = {
  proposalCurrent: "Your checks are up to date. Nothing to save.",
  proposalRefresh: "Updated checks are ready. Nothing is saved until you choose Save checks.",
  proposalSetup: "Suggested checks are ready. Nothing is saved until you choose Save checks.",
  saved: "Checks saved. Choose Check again to run them.",
  checked: "Checks done. Loading results.",
  dismissed: "Dismissed. Loading results.",
} as const;

export const CHECKS_COPY = {
  intro: "Pick which checks to save. You don't need this to find ideas.",
  ready: "Your checks are set up.",
  superseded: "These results are older than your latest checks. Choose Check again to update them.",
  staleAfterSave: "Older results are still below. After saving, choose Check again to update them.",
  noResults: "No results yet. Choose Check again to run your checks. This won't start any work.",
  setupFirst: "Set up checks first.",
  blockedInventory: "This project can't be checked right now.",
  blockedUnreadable: "Your saved checks can't be read, so they can't run.",
  blockedSetup: "Save checks before choosing Check again.",
  proposalIntro:
    "Save checks writes these settings to your project. It doesn't start any work; each task asks first.",
  proposalCurrent: "Nothing to save. After code changes, choose Check again.",
  proposalReplaced: "A newer review replaced this one. It's shown for reference only.",
  historyUpgrade: " Choose Not now to keep your checks as they are.",
  planMode:
    "Turn off plan mode to find ideas or change your checks. You can still look at results.",
  failed: "That didn't finish. Choose Try again when nothing else is running.",
  reconcileFailed: "We couldn't tell if that was saved. Choose Try again to reload results.",
  reconciling: "Checking what was saved. Nothing will retry on its own.",
  requestFailed: "That didn't work. Choose Try again to see what happened.",
  runUnknown: "We couldn't tell if it started. Choose Try again to reload results.",
} as const;

export const CHECK_RESULT_STATE_LABELS = {
  discovered: "New",
  queued: "Waiting to start",
  running: "Running",
  completed: "Done",
  dismissed: "Dismissed",
} as const satisfies Record<ProgrammaticChatSummary["state"], string>;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Header wording for saved checks that are not current. */
export const CHECKS_STATUS_WORDS = {
  missing: "Checks not set up",
  "refresh-required": "Checks need updating",
  unreadable: "Checks can't be read",
} as const satisfies Record<Exclude<ProgrammaticChatConfiguration["status"], "current">, string>;

/** The header's one-line status: idea search, then saved checks. */
export function opportunityStatusLine(state: ProgrammaticChatState): string {
  const total = state.report?.total;
  const status = programmaticConfiguration(state)?.status ?? "missing";
  return [
    state.assessmentPending
      ? "Searching"
      : state.discovery
        ? plural(state.discovery.candidates.length, "idea", "ideas")
        : state.assessment
          ? "Search done"
          : "No search yet",
    status === "current"
      ? total
        ? plural(total, "check result", "check results")
        : "Checks set up"
      : CHECKS_STATUS_WORDS[status],
  ].join(" · ");
}

// Area-by-area search progress (step 2) and the early finds shown in Review.

const ideaCount = (count: number) =>
  count === 0 ? "No ideas" : `${count} ${count === 1 ? "idea" : "ideas"}`;

/** The word carries the meaning; the icon is decoration. */
export const AREA_STATUS_ICONS = {
  waiting: "○",
  reading: "→",
  found: "✓",
  partly: "✓",
  failed: "!",
  stopped: "■",
} as const satisfies Record<ProgrammaticAreaProgressStatus, string>;

export function areaStatusWord(area: Pick<ProgrammaticAreaProgress, "status" | "finds">): string {
  const count = area.finds?.length ?? 0;
  switch (area.status) {
    case "waiting":
      return "Waiting";
    case "reading":
      return "Reading";
    case "found":
      return ideaCount(count);
    case "partly":
      return `${ideaCount(count)} · read partly`;
    case "failed":
      return "Couldn't finish";
    case "stopped":
      return "Stopped";
  }
}

export const AREA_PROGRESS = {
  listLabel: "Areas",
  merging: "Checking ideas from every area…",
  stop: "Stop search",
  stopped: "Search stopped.",
  retry: "Try this area again",
  retryName: (area: string) => `Try ${area} again`,
  retryRefused: PROGRAMMATIC_AREA_RETRY_REFUSED,
  earlyHeading: "Early finds",
  earlyRunning: "Still checking. These become ideas you can review when the search finishes.",
  earlyStopped: "Stopped before checking. Search again to get ideas you can review.",
  earlyPlate: "Still checking",
} as const;

/** Final per-area words when only the finished assessment is known (no live rows). */
export const AREA_RESULT_WORDS = {
  searched: "Read",
  partly: "Read partly",
  "not-searched": "Not read",
} as const satisfies Record<ProgrammaticAssessmentArea["status"], string>;

/** Polite announcement for one area that just finished; null while it is still running. */
export function areaAnnouncement(area: ProgrammaticAreaProgress): string | null {
  if (area.status === "found" || area.status === "partly")
    return `${area.label}: ${ideaCount(area.finds?.length ?? 0).toLowerCase()}`;
  if (area.status === "failed") return `${area.label}: couldn't finish`;
  return null;
}

export function areaCoverageLine(
  areas: readonly Pick<ProgrammaticAssessmentArea, "status">[],
): string {
  const full = areas.filter(({ status }) => status === "searched").length;
  const partly = areas.filter(({ status }) => status === "partly").length;
  const missed = areas.length - full - partly;
  return [
    `Read ${full} of ${areas.length} areas fully.`,
    partly ? `${partly} read partly.` : "",
    missed ? `${missed} not read.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
