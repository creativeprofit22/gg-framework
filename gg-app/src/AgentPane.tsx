import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import { autosizeComposer } from "./composer-autosize";
import {
  createPaneAgentClient,
  isSwitchModelError,
  newWindow,
  focusWindowByOffset,
  arrangeAllWindows,
  onWindowOrder,
  restoreTarget,
  onModelsChanged,
  onTrayIntent,
  takeTrayIntent,
  setUpdateAvailable,
  setRemoteActive as setRemoteActiveIPC,
  windowLabel,
  setWindowTitle,
  openProjectPath,
  getDroppedPathInfo,
  readDroppedFileAttachment,
  type AgentState,
  type WorkspaceMode,
  type ChatAgentId,
  type ModelOption,
  type PendingPlanReview,
  type SlashCommand,
  type BackgroundTask,
  type ProjectTask,
  type FileHit,
  type QueuedMessage,
  type TrayIntent,
  type Attachment,
  type PromptSegment,
  type AskUserPrompt,
  type PaneAgentClient,
  type PaneSessionTarget,
  NewSessionError,
  PlanMutationError,
} from "./agent";
import { createSafeTauriUnlisten, type SafeTauriUnlisten } from "./tauri-listener";
import { ActivityBar } from "./ActivityBar";
import { KenActivityBar } from "./KenActivityBar";
import { AutopilotReviewBar } from "./AutopilotReviewBar";
import { useKenMentor } from "./useKenMentor";
import { useAutopilot } from "./useAutopilot";
import { useAgentEvents, HOOK_PRESENTATION, type HookKind } from "./useAgentEvents";
import { useSmoothText } from "./useSmoothText";
import { LiveToolPanel, type LiveToolEntry } from "./LiveToolPanel";
import { SubAgentFeed, type SubAgentLine } from "./SubAgentFeed";
import { CompactionNotice } from "./CompactionNotice";
import { ModelSelect } from "./ModelSelect";
import { SlashMenu } from "./SlashMenu";
import { QueuedBar } from "./QueuedBar";
import { ScheduleHint } from "./ScheduleHint";
import { RunningSchedulesButton } from "./RunningSchedulesButton";
import {
  describeSchedule,
  isScheduleDraft,
  parseScheduleCommand,
  withInterval,
} from "./scheduleCommand";
import { useSchedules } from "./useSchedules";
import { FileMentionMenu } from "./FileMentionMenu";
import { ReferencedFiles, appendReferencedFiles, parseReferencedFiles } from "./ReferencedFiles";
import { ContextMeter } from "./ContextMeter";
import { BackgroundTasksButton } from "./BackgroundTasksButton";
import { TasksModal } from "./TasksModal";
import { ProjectNotes, type ProjectNotesPromptActions } from "./ProjectNotes";
import type {
  NotesPromptSaveResult,
  NotesSessionLink,
  NotesValidationError,
  PhaseStartResult,
} from "./notes-types";
import { MemoryModal } from "./MemoryModal";
import { ShimmerText } from "./ShimmerText";
import { WakeScreen } from "./WakeScreen";
import { ConfirmModal } from "./ConfirmModal";
import { LocalUpdateSummaryOption } from "./LocalUpdateSummaryOption";
import { InitGitModal } from "./InitGitModal";
import { PlanModeLogo } from "./PlanModeLogo";
import { KenPowerBanner } from "./KenPowerBanner";
import { ExportChatButton } from "./ExportChatButton";
import { PlanReviewModal } from "./PlanReviewModal";
import { McpElicitModal } from "./McpElicitModal";
import { WindowLayoutButton } from "./WindowLayoutButton";
// Experimental gaze focus — disabled for now (see main.tsx).
// import { GazeButton } from "./GazeButton";
import { RadioButton } from "./RadioButton";
import { ProjectPicker } from "./ProjectPicker";
import { ChatPicker } from "./ChatPicker";
import { BackButton } from "./BackButton";
import { Badge } from "./Badge";
import { AutopilotToggle } from "./AutopilotToggle";
import { HomeScreen } from "./HomeScreen";
import { SettingsModal } from "./SettingsModal";
import { initialEntryView, type EntryView } from "./app-entry-view";
import {
  showsQueuedBubble,
  submitDisposition,
  withoutSupersedingMessage,
} from "./submit-disposition";
import { Toaster } from "./Toaster";
import { Confetti } from "./Confetti";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { TitleUsageMeter } from "./TitleUsageMeter";
import { formatWorkspaceTitle, WorkspaceHeader } from "./WorkspaceHeader";
import { useProgress } from "./useProgress";
import { LoginScreen } from "./LoginScreen";
import { KenPromptActionProvider, Markdown } from "./Markdown";
import { FooterSkeleton, TranscriptSkeleton, Skeleton } from "./Skeleton";
import { useAppUpdate } from "./update";
import { formatBuildIdentity } from "./build-info";
import { MENTOR_DISPLAY_NAME, MENTOR_HANDLE, PRODUCT_DISPLAY_NAME } from "./brand";
import {
  LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL,
  LOCAL_UPDATE_CONFIRMATION_MESSAGE,
  LOCAL_UPDATE_CONFIRMATION_TITLE,
  shouldConfirmLocalUpdate,
} from "./local-update-confirmation";
import { recoverPromptLabel } from "./prompt-labels";
import { playSound } from "./sounds";
import { segmentDoneMarkers, hasDoneMarker, countPlanSteps } from "./plan-steps";
import { ArrowUp, Paperclip, AtSign, GitBranch, Square } from "lucide-react";
import { AttachmentBar } from "./AttachmentBar";
import { AskBand } from "./AskBand";
import { dropSupersededAsks, mergeAskAnswers } from "./ask-user";
import { glowPlacement, glowStateFor, glowVars } from "./window-glow";
import { EnhancedSegments } from "./PromptEnhancement";
import { EnhanceDissolve } from "./EnhanceDissolve";
import { toast } from "./toast";
import { fileToPending, toWire, attachmentToPending, type PendingAttachment } from "./attachments";
import { RoadmapPhaseDraftReviewModal } from "./RoadmapPhaseDraftReviewModal";
import type { RoadmapPhaseDraft } from "@kenkaiiii/gg-core/roadmap-workflow";
import {
  initialRoadmapPhaseDraftState,
  reduceRoadmapPhaseDraftState,
} from "./roadmap-phase-draft-state";
import { basename } from "./tool-format";
import {
  deriveKenPromptTitle,
  type KenPromptAction,
  type KenPromptActionDispatcher,
  type KenPromptActionResult,
  type KenPromptSavePreview,
} from "./ken-prompt-actions";
import "./App.css";

const BUILD_IDENTITY = formatBuildIdentity();
const SESSION_RESET_TIMEOUT_MS = 8_000;
const AUTOPILOT_NEW_SESSION_RETRY_MESSAGE =
  "Ken is reviewing this session. Wait for the review to finish or cancel it, then try again.";
const AMBIGUOUS_NEW_SESSION_MESSAGE =
  "Couldn’t confirm which session is active. Reopen this project before sending the prompt.";

class SessionResetConfirmationTimeoutError extends Error {
  constructor(readonly operationId: string) {
    super("Timed out waiting for the matching new-session confirmation.");
    this.name = "SessionResetConfirmationTimeoutError";
  }
}

class LocalSessionMutationBusyError extends Error {
  constructor() {
    super("A session change is already in progress.");
    this.name = "LocalSessionMutationBusyError";
  }
}

function isNotesRequestBodyTooLarge(error: NotesValidationError | undefined): boolean {
  return error?.path === "$" && /^notes request body exceeds \d+ bytes$/.test(error.message.trim());
}

function notesPromptActionResult(
  result: NotesPromptSaveResult,
  latestPreview?: KenPromptSavePreview,
): KenPromptActionResult {
  if (result.status === "committed") {
    return { status: "saved", phaseId: result.phaseId, title: result.title };
  }
  if (result.status === "replacement-conflict") {
    return {
      status: "failed",
      action: "commit-save",
      message: `${result.title} changed in another window. Review the latest destination before replacing it.`,
      preview: latestPreview,
    };
  }
  if (result.status === "missing-phase") {
    return {
      status: "failed",
      action: "commit-save",
      message: "That phase was removed in another window. Choose another destination.",
      preview: latestPreview,
    };
  }
  if (result.status === "archived-phase") {
    return {
      status: "failed",
      action: "commit-save",
      message: `${result.title} was archived in another window. Restore it or choose another destination.`,
      preview: latestPreview,
    };
  }
  if (result.reason === "invalid") {
    const message = isNotesRequestBodyTooLarge(result.error)
      ? "Project Notes is too large to save. Shorten the saved prompt or Notes document, then try again."
      : result.error
        ? `Project Notes rejected this save (${result.error.path}: ${result.error.message}). Review the Notes content and try again.`
        : "Project Notes rejected this prompt. Review the title and try again.";
    return { status: "failed", action: "commit-save", message, preview: latestPreview };
  }
  const messages = {
    missing: "Project Notes storage is missing. Reopen the project and try again.",
    corrupt: "Project Notes are unreadable. Repair or restore project storage first.",
    unavailable: "Project Notes are unavailable. Check the sidecar and try again.",
    storage: "Local Notes storage failed. Free space and try again.",
  } as const;
  return {
    status: "failed",
    action: "commit-save",
    message: messages[result.reason],
    preview: latestPreview,
  };
}

const DEFAULT_INPUT_PLACEHOLDER = `Type a message, / commands, @ files, ${MENTOR_HANDLE} for help`;
const INPUT_PLACEHOLDERS = [
  DEFAULT_INPUT_PLACEHOLDER,
  `Need a second opinion? Ask ${MENTOR_HANDLE}`,
  `Stuck on what to do next? Ask ${MENTOR_HANDLE}`,
  DEFAULT_INPUT_PLACEHOLDER,
  `Want a second set of eyes? Ask ${MENTOR_HANDLE}`,
  `Unsure how to proceed? Ask ${MENTOR_HANDLE}`,
  `Need a quick review? Ask ${MENTOR_HANDLE}`,
] as const;
const RUNNING_INPUT_PLACEHOLDERS = [
  "Agent is working. Add a follow-up if you want",
  "Got another thought? Queue it here",
  "Agent is on it. You can stack the next note",
  "Thinking ahead? Drop the next instruction",
  "Keep going. Your next message will queue up",
] as const;
const INPUT_PLACEHOLDER_INTERVAL_MS = 12_000;
const PLACEHOLDER_SHUFFLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PLACEHOLDER_SHUFFLE_FRAMES = 18;
const PLACEHOLDER_SHUFFLE_FRAME_MS = 24;

// Autopilot Ken's "all clear" line, rotated so the auto-review loop doesn't
// repeat the exact same sentence every time GG Coder's work checks out.
// Info row shown when a video attachment is sent to a model without native
// video analysis. Shared by the live send path and history restore so the
// resumed transcript matches the live one exactly.
const VIDEO_CAPABILITY_WARNING =
  "This model can't watch video directly. The agent can still extract frames or audio with ffmpeg if needed — switch to a video-capable model (Gemini, Kimi, MiniMax) for native video analysis.";

const ALL_CLEAR_VARIATIONS = [
  "All clear. Looks good to me.",
  "Checks out. Nothing left to flag.",
  "Nice, this holds up. Nothing more from me.",
  "Solid work. I've got no notes.",
  "Yep, that covers it. All good.",
  "Looks right to me — ship it.",
  "Clean pass. Nothing to add here.",
  "That does the job. No complaints.",
  "Good to go, no issues found.",
  "This holds together. All clear.",
] as const;

function stableIndex(seed: string, modulo: number): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % modulo;
}

function allClearCopy(seed: string | undefined, fallbackId: number): string {
  const index = seed
    ? stableIndex(seed, ALL_CLEAR_VARIATIONS.length)
    : fallbackId % ALL_CLEAR_VARIATIONS.length;
  return ALL_CLEAR_VARIATIONS[index];
}

function shufflePlaceholderFrame(target: string, frame: number): string {
  const revealCount = Math.ceil((target.length * frame) / PLACEHOLDER_SHUFFLE_FRAMES);
  return Array.from(target, (char, index) => {
    if (index < revealCount || /\s|[.,?/@]/.test(char)) return char;
    const pick = Math.floor(Math.random() * PLACEHOLDER_SHUFFLE_CHARS.length);
    return PLACEHOLDER_SHUFFLE_CHARS[pick];
  }).join("");
}

// ── Transcript model ───────────────────────────────────────
// Tool activity lives in the pinned LiveToolPanel except durable MCP failures.
// Exported (type-only) so the Ken mentor hook can produce/typecheck ken + error
// transcript items without a runtime import cycle.
export type Item =
  // `command` marks a workflow slash command — rendered as just the short
  // `/name` with a highlight + shimmer, never the expanded prompt body.
  // `label` overrides what's shown with a friendly shimmer phrase (e.g.
  // "Initializing Git…") while the full prompt still goes to the agent.
  | {
      kind: "user";
      id: number;
      text: string;
      command?: boolean;
      label?: string;
      images?: string[];
      files?: string[];
      // Corrected-term segments from the prompt enhancer, when this message was
      // sent unedited straight after an enhance. Drives the highlighted bubble.
      enhancements?: PromptSegment[];
      // True while this message is still waiting in the mid-run steering queue.
      // Rendered dimmed; cleared at run_end once the agent has consumed it.
      queued?: boolean;
      promoted?: boolean;
      // True when this prompt was addressed to Ken (`@Ken …`). Renders the bubble
      // in Ken's color so the transcript shows it went to the mentor, not GG Coder.
      ken?: boolean;
      // True when this bubble came from clicking a "Send to GG Coder" button on
      // one of Ken's recommended prompts. Renders as a shimmering "Sent to GG
      // Coder" label in Ken's color (like a slash command shows `/name`), instead
      // of the full prompt body that was actually sent to GG Coder.
      kenSent?: boolean;
    }
  | { kind: "assistant"; id: number; text: string }
  // Ken Kai (mentor agent) reply — magenta-tinted bubble + "Ken Kai" badge,
  // streamed from the ken_* SSE events. Never mistaken for GG Coder.
  | { kind: "ken"; id: number; text: string }
  | { kind: "info"; id: number; text: string }
  | {
      kind: "mcp_tool_failure";
      id: number;
      name: string;
      result: string;
      displayName?: string;
    }
  // Structured error (see gg-ai's formatError): headline always answers "is this
  // me or them", message is the raw detail (omitted when redundant with the
  // headline), guidance is the action line (retry / switch model / log in /
  // wait until a reset time). `text` is a legacy fallback for older items.
  | {
      kind: "error";
      id: number;
      text?: string;
      headline?: string;
      message?: string;
      guidance?: string;
    }
  // Agent self-correction hook notice (ideal review / loop-break / re-grounding),
  // rendered like the TUI: a shimmering tone-colored one-liner.
  | { kind: "hook"; id: number; hook: HookKind }
  // Images produced by a tool (screenshot / read of an image file).
  | { kind: "images"; id: number; images: TranscriptImage[]; caption?: string }
  // Image generation in progress — a shimmering square placeholder that gets
  // replaced by the final image when the tool result arrives.
  | { kind: "generating_image"; id: number; prompt: string }
  // Plan-mode entry banner (ASCII logo + optional reason).
  | { kind: "plan"; id: number; reason: string }
  | {
      kind: "ask";
      id: number;
      prompt: AskUserPrompt;
      answers?: Record<string, string | string[]>;
      sent?: boolean;
      cancelled?: boolean;
    }
  // A task kicked off from the Tasks modal (shown at the top of its session).
  | { kind: "task"; id: number; title: string }
  // Sub-agents delegated in a turn — a live, in-chat feed of each one's tools.
  | { kind: "subagent_group"; id: number; agents: SubAgentLine[]; aborted?: boolean }
  // Context compaction — shimmering "compacting…" while running, then a quiet
  // "compacted · N → M messages" summary when done.
  | {
      kind: "compaction";
      id: number;
      status: "running" | "done";
      originalCount?: number;
      newCount?: number;
    }
  // Autopilot Ken verdict — emitted by the auto-review loop and rendered like a
  // normal @Ken reply bubble (Ken dot + text), not a separate marker style.
  // `phase` selects the message: he prompted GG Coder (with the `body` he sent),
  // gave the all-clear, needs a human (with `reason`), or hit the round cap.
  | {
      kind: "autopilot";
      id: number;
      phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
      reason?: string;
      body?: string;
      /** Stable seed from persisted marker data so resumed all-clear copy doesn't flicker. */
      copySeed?: string;
    };

export interface TranscriptImage {
  /** data: URL (base64) ready to drop into <img src>. */
  src: string;
  /** Source file path, shown as a caption + used as a stable key. */
  path?: string;
}

let idSeq = 0;
const nextId = (): number => ++idSeq;

// Vertical divider between footer segments (mirrors the TUI's ` \u2502 ` in
// border color). Rendered between adjacent groups, never leading/trailing.
function FooterSep(): React.ReactElement {
  return (
    <span className="footer-sep" style={{ color: theme.border }}>
      {"\u2502"}
    </span>
  );
}

// BLACK_CIRCLE — ⏺ on mac (matches the TUI figure).
const DOT = "\u23FA";

// `/schedule` lives in the webview, not the sidecar's command registry: it
// registers a recurring timer instead of prompting the agent. Declared here so
// the palette can still discover it alongside the real slash commands.
const SCHEDULE_COMMAND: SlashCommand = {
  name: "schedule",
  aliases: ["sched"],
  description: "Run a prompt on a repeating schedule — <prompt> | 15m | [times]",
  input: { text: "optional", references: "optional", attachments: "optional" },
  source: "built-in",
};

function slashCommandForInput(
  input: string,
  commands: SlashCommand[],
): { command: SlashCommand; args: string } | null {
  const match = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return null;
  const command = commands.find(
    (candidate) => candidate.name === match[1] || candidate.aliases.includes(match[1]!),
  );
  return command ? { command, args: match[2]?.trim() ?? "" } : null;
}

export function noInputSlashSubmissionError(
  input: string,
  commands: SlashCommand[],
  attachmentCount: number,
  referencedFileCount: number,
): string | null {
  const match = slashCommandForInput(input, commands);
  if (!match) return null;
  const blocked = [
    match.args && match.command.input.text === "none" ? "additional text" : null,
    referencedFileCount > 0 && match.command.input.references === "none" ? "file references" : null,
    attachmentCount > 0 && match.command.input.attachments === "none" ? "attachments" : null,
  ].filter((kind): kind is string => kind !== null);
  if (blocked.length === 0) return null;
  return `/${match.command.name} does not accept ${blocked.join(", ")}. Remove them and send the command again.`;
}

// Thinking-tier color, mirroring the ggcoder TUI footer's getThinkingColor:
// warmer/more saturated as the tier rises; xhigh/max are "max power" hot pink.
const MAX_POWER_COLOR = "#db2777";
const MAX_POWER_SHIMMER = "#f472b6";
function thinkingColor(level: string | null | undefined): string {
  if (!level) return theme.textDim;
  if (level === "low") return theme.textMuted;
  if (level === "medium") return theme.accent;
  if (level === "high") return theme.warning;
  return MAX_POWER_COLOR; // xhigh / max
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

type WebkitEntry = { isDirectory?: boolean };
type DirectoryAwareDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => WebkitEntry | null;
};

function isDirectoryDragItem(item: DataTransferItem): boolean {
  const entry = (item as DirectoryAwareDataTransferItem).webkitGetAsEntry?.();
  return entry?.isDirectory === true;
}

function filesForAttachment(dataTransfer: DataTransfer): File[] {
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length === 0) return Array.from(dataTransfer.files);
  return items
    .filter((item) => item.kind === "file" && !isDirectoryDragItem(item))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function canHandleWindowFileDrop(): boolean {
  return !document.querySelector(".modal-backdrop");
}

export interface PaneSnapshot {
  paneId: string;
  generation?: number | null;
  mode: WorkspaceMode;
  chatAgent?: ChatAgentId;
  cwd: string | null;
  sessionPath: string | null;
  sessionTitle: string | null;
  projectBound: boolean;
  restoreChecked: boolean;
  activeWork: boolean;
}

export interface PaneInputActions {
  focus: () => void;
  setNativeFileDragOver: (dragging: boolean) => void;
  handleNativeDrop: (paths: string[]) => void;
}

export interface AgentPaneProps {
  client?: PaneAgentClient;
  paneId?: string;
  kind?: "primary" | "auxiliary";
  focused?: boolean;
  windowFocused?: boolean;
  initialTarget?: PaneSessionTarget | null;
  onFocus?: (paneId: string) => void;
  onSnapshot?: (snapshot: PaneSnapshot) => void;
  onUserTargetChange?: () => void;
  workspaceOwnsSessionLifecycle?: boolean;
  reclaimNativeSession?: boolean;
  registerInput?: (paneId: string, actions: PaneInputActions | null) => void;
  target?: PaneSessionTarget | null;
  generation?: number | null;
  onGenerationChange?: (generation: number) => void;
  onLifecycleError?: (error: unknown) => void;
}

export function preferredRoadmapPhaseSession(
  phase:
    | {
        session: NotesSessionLink | null;
        execution?: { lastSession: NotesSessionLink | null } | null;
      }
    | undefined,
  compatibilitySession: NotesSessionLink,
): NotesSessionLink {
  return phase?.execution?.lastSession ?? phase?.session ?? compatibilitySession;
}

export function resolveRoadmapPhaseResume(
  phase:
    | {
        session: NotesSessionLink | null;
        execution?: { state?: string; lastSession: NotesSessionLink | null } | null;
      }
    | undefined,
  compatibilitySession: NotesSessionLink,
): { status: "blocked"; message: string } | { status: "ready"; session: NotesSessionLink } {
  if (phase?.execution?.state === "needs-reconciliation") {
    return {
      status: "blocked",
      message:
        "Resume is blocked until this phase is reconciled. Open Project Notes, select Roadmap, then choose Reconcile.",
    };
  }
  return { status: "ready", session: preferredRoadmapPhaseSession(phase, compatibilitySession) };
}

export async function resolveRoadmapPhaseResumeFromNotes(
  client: Pick<PaneAgentClient, "getNotes">,
  phaseId: string,
  compatibilitySession: NotesSessionLink,
): Promise<ReturnType<typeof resolveRoadmapPhaseResume>> {
  try {
    const opened = await client.getNotes();
    return opened.status === "ok"
      ? resolveRoadmapPhaseResume(
          opened.snapshot.document.phases.find((phase) => phase.id === phaseId),
          compatibilitySession,
        )
      : resolveRoadmapPhaseResume(undefined, compatibilitySession);
  } catch {
    return {
      status: "blocked",
      message:
        "Couldn’t verify whether this phase needs reconciliation. Open Project Notes and retry Resume.",
    };
  }
}

export function AgentPane(props: AgentPaneProps): React.ReactElement {
  const paneId = props.paneId ?? props.client?.paneId ?? "primary";
  const kind = props.kind ?? (paneId === "primary" ? "primary" : "auxiliary");
  const { onUserTargetChange, onSnapshot, registerInput } = props;
  const generatedClient = useMemo(() => createPaneAgentClient(paneId), [paneId]);
  const client = props.client ?? generatedClient;
  const ownsWindowGlobals = kind === "primary" && props.client === undefined;
  const {
    getState,
    sendPrompt,
    prepareContinuationHandoff,
    sendKenPrompt,
    cancelKen,
    setAutopilot,
    cancel,
    newSession,
    cycleThinking,
    listModels,
    switchModel,
    switchKenModel,
    listCommands,
    listHistory,
    cancelQueued,
    exportTranscriptName,
    saveTranscript,
    listTasks,
    runTask,
    runAllTasks,
    deleteTask,
    searchFiles,
    enhancePrompt,
    getServeStatus,
    startServe,
    stopServe,
    acceptPlan: acceptPlanIPC,
    revisePlan: revisePlanIPC,
  } = client;
  const subscribe = client.subscribe;
  const catalogClient = useMemo(() => createPaneAgentClient("primary"), []);
  const [items, setItems] = useState<Item[]>([]);
  const lifecycleEpochRef = useRef(0);
  const hydrateEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const generationRef = useRef(props.generation);
  // Managed panes acquire their generation internally. Do not erase it on rerenders
  // merely because their owner does not mirror the optional prop back to us.
  if (props.generation !== undefined) generationRef.current = props.generation;
  const onGenerationChangeRef = useRef(props.onGenerationChange);
  onGenerationChangeRef.current = props.onGenerationChange;
  const onLifecycleErrorRef = useRef(props.onLifecycleError);
  onLifecycleErrorRef.current = props.onLifecycleError;
  const adoptGeneration = useCallback((generation: number): void => {
    generationRef.current = generation;
    onGenerationChangeRef.current?.(generation);
  }, []);
  const waitForReady = useCallback(async (): Promise<void> => {
    const ready = await client.waitForReady();
    adoptGeneration(ready.generation);
  }, [adoptGeneration, client]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleEpochRef.current += 1;
      hydrateEpochRef.current += 1;
    };
  }, []);

  const target = props.target ?? props.initialTarget ?? null;
  useEffect(() => {
    const epoch = ++lifecycleEpochRef.current;
    if (!target) return;
    setWorkspaceMode(target.mode ?? "code");
    let ownedGeneration: number | null = null;
    const existingGeneration = generationRef.current;
    const shouldRestore =
      props.workspaceOwnsSessionLifecycle ||
      props.reclaimNativeSession ||
      existingGeneration != null;
    const operation = shouldRestore ? client.restore(target) : client.create(target);
    void operation
      .then((next) => {
        if (!props.workspaceOwnsSessionLifecycle) ownedGeneration = next;
        if (mountedRef.current && lifecycleEpochRef.current === epoch) {
          adoptGeneration(next);
          setNeedsProject(false);
          setHydrateNonce((nonce) => nonce + 1);
        } else if (ownedGeneration !== null) {
          void client.dispose(ownedGeneration).catch(() => {});
        }
      })
      .catch((error) => {
        if (mountedRef.current && lifecycleEpochRef.current === epoch) {
          onLifecycleErrorRef.current?.(error);
        }
      });
    return () => {
      if (lifecycleEpochRef.current === epoch) lifecycleEpochRef.current += 1;
      if (!props.workspaceOwnsSessionLifecycle && ownedGeneration !== null) {
        void client.dispose(ownedGeneration).catch(() => {});
      }
    };
  }, [
    adoptGeneration,
    client,
    props.reclaimNativeSession,
    props.workspaceOwnsSessionLifecycle,
    target,
  ]);

  // Ken Kai (mentor agent): own running flag, token/thinking metrics, streaming
  // bubble, and `ken_*` SSE handling. Lives in its own hook; App just consumes
  // the state for rendering and delegates ken events to `handleKenEvent`.
  const {
    kenRunning,
    kenTokens,
    kenRunStartTs,
    kenIsThinking,
    kenThinkingStartTs,
    kenThinkingAccumMs,
    handleKenEvent,
  } = useKenMentor({ setItems, nextId });
  // Autopilot Ken (auto-reviewer): consumes the `autopilot_*` event family into
  // compact transcript markers + a "Ken reviewing…" flag. Separate hook, same
  // shared setItems/nextId pattern as useKenMentor.
  const { autopilotReviewing, handleAutopilotEvent } = useAutopilot({ setItems, nextId });
  const { snapshot: progress, levelUp, levelUpNonce, levelUpOrigin } = useProgress();
  const [showScorecard, setShowScorecard] = useState(false);
  const [rankCelebrateNonce, setRankCelebrateNonce] = useState<string | null>(null);
  const [xpChips, setXpChips] = useState<Array<{ id: string; label: string }>>([]);
  const lastProgressXpRef = useRef<number | null>(null);
  const [confettiNonce, setConfettiNonce] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [displayPlaceholder, setDisplayPlaceholder] = useState(DEFAULT_INPUT_PLACEHOLDER);
  const displayPlaceholderRef = useRef(DEFAULT_INPUT_PLACEHOLDER);
  // Shell-style prompt history for ↑/↓ recall in the chat input. Newest entries
  // last. `historyIndex` is null while editing a fresh draft; stepping ↑ walks
  // backwards into history, ↓ forwards. `historyDraftRef` stashes the in-progress
  // text so stepping ↓ past the newest entry restores what was being typed.
  const promptHistoryRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraftRef = useRef("");
  // Staged attachments (paste / attach button / whole-window drag-drop) shown above the input.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The most recent prompt-enhancement result. `plain` is the text now in the
  // textarea; `segments` drive the inline highlight overlay + the sent bubble.
  // It's dropped the moment the textarea diverges from `plain` so highlights
  // never misalign. `enhancing` shows the pulse on the Enhance pill mid-call.
  const [enhancement, setEnhancement] = useState<{
    plain: string;
    segments: PromptSegment[];
  } | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  // The floating "Enhance" pill is shown only after the user pauses typing for
  // ~1s (and hidden again on the next keystroke / send / empty input).
  const [enhanceHintVisible, setEnhanceHintVisible] = useState(false);
  // Drives the Matrix dissolve→decode animation over the input while enhancing.
  // `newText` is null until the enhancer returns (dissolve/scramble), then the
  // enhanced text (decode). Null when no animation is playing.
  const [enhanceAnim, setEnhanceAnim] = useState<{
    oldText: string;
    newText: string | null;
  } | null>(null);
  // Holds the resolved enhancement so the animation's onDone can apply it once
  // the decode settles (rather than popping the text in mid-animation).
  const pendingEnhanceRef = useRef<{ enhanced: string; segments: PromptSegment[] } | null>(null);
  // Number of messages queued mid-run (injected as steering by the sidecar).
  const [queuedCount, setQueuedCount] = useState(0);
  // Pending queued messages, so each can be cancelled individually. Kept
  // alongside the count because the sidecar is the source of truth for both.
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [state, setState] = useState<AgentState | null>(null);
  const [roadmapDraftState, dispatchRoadmapDraft] = useReducer(
    reduceRoadmapPhaseDraftState,
    initialRoadmapPhaseDraftState,
  );
  const roadmapDraftEventVersionRef = useRef(roadmapDraftState.eventVersion);
  roadmapDraftEventVersionRef.current = roadmapDraftState.eventVersion;
  // Transient "KEN IS ON"/"KEN IS OFF" takeover banner shown when Autopilot
  // is toggled. Null = not showing; the banner clears itself via `onDone`
  // once its slide-out animation finishes.
  const [kenPowerBanner, setKenPowerBanner] = useState<"on" | "off" | null>(null);
  const [running, setRunning] = useState(false);
  const [hasFinishedRun, setHasFinishedRun] = useState(false);
  const glowSeed = `${windowLabel}:${props.paneId}`;
  const glowStyle = useMemo(() => glowVars(glowPlacement(glowSeed)), [glowSeed]);
  const glowState = glowStateFor(running, hasFinishedRun);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      setHasFinishedRun(false);
    } else if (wasRunning.current) {
      wasRunning.current = false;
      setHasFinishedRun(true);
    }
  }, [running]);
  const cancelling = state?.runState === "cancelling";
  const requestCancel = useCallback(() => {
    if (cancelling) return;
    void cancel().catch(() => {
      // Native/sidecar transport failures may prevent the SSE cancel_failed
      // frame; restore the owned-running affordance so retry remains possible.
      setState((previous) =>
        previous ? { ...previous, running: true, runState: "running" } : previous,
      );
      setRunning(true);
      setStatus("cancellation failed; agent still running");
    });
  }, [cancel, cancelling]);
  const [status, setStatus] = useState("connecting to agent\u2026");
  const [liveToolFeed, setLiveToolFeed] = useState<LiveToolEntry[]>([]);
  const [tokens, setTokens] = useState(0);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  // Pending plan awaiting an explicit workflow-gate decision. The gate remains
  // inline with the transcript until approval, feedback, or dismissal resolves it.
  const [planReview, setPlanReview] = useState<PendingPlanReview | null>(null);
  const [planGateBusy, setPlanGateBusy] = useState(false);
  // Exact operation that entered Plan Mode. Kept in webview memory only: approval
  // replays this prompt after the sidecar has accepted the plan.
  const planResumePromptRef = useRef<string | null>(null);
  // Path of the plan awaiting review, captured from `plan_exit`. Needed on accept
  // to bake the plan's `## Steps` into the agent's system prompt so it emits
  // `[DONE:n]` progress markers (drives the activity bar's Plan Steps widget).
  const planReviewPathRef = useRef<string | null>(null);
  // Approved-plan progress for the activity bar: total steps + completed set.
  const [planTotal, setPlanTotal] = useState(0);
  const [planDone, setPlanDone] = useState<Set<number>>(new Set());
  // Refs mirror the plan progress state for the memoized SSE event handler,
  // which intentionally does not re-capture React state on every render.
  const planTotalRef = useRef(0);
  const planDoneRef = useRef<Set<number>>(new Set());
  // Approval-time count kept only as a compatibility fallback for an older
  // sidecar whose session_reset has no canonical live-file total.
  const pendingPlanTotalRef = useRef<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStartTs, setThinkingStartTs] = useState<number | null>(null);
  const [thinkingAccumMs, setThinkingAccumMs] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelCatalogRefreshNonce, setModelCatalogRefreshNonce] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  // Caret offset in the composer, tracked so the `/schedule` hint can highlight
  // the slot the user is currently typing in.
  const [caret, setCaret] = useState(0);
  // `/schedule` runtime. Fires each due prompt through the normal send path,
  // skipping any occurrence that comes due mid-run rather than stacking agents.
  // In-memory for the life of the window — see useSchedules.
  const { schedules, addSchedule, stopSchedule } = useSchedules({
    queuedPrompts: useMemo(() => queuedMessages.map((m) => m.text), [queuedMessages]),
    onFire: useCallback((prompt: string) => {
      // keepInput: the user did not press Enter for this — leave whatever they
      // are typing untouched.
      submitTextRef.current(prompt, undefined, { keepInput: true });
    }, []),
  });
  // `@`-mention file picker state. `mention` is the active token being typed
  // (its query + where it starts in the input); `fileMatches` is the live
  // search result; `fileIndex` is the keyboard-highlighted row.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [fileMatches, setFileMatches] = useState<FileHit[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  // Files referenced via `@`, tracked as chips (NOT left in the input text).
  // Their paths are appended to the prompt on submit.
  const [mentionedPaths, setMentionedPaths] = useState<string[]>([]);
  const matchedSlashCommand = slashCommandForInput(input, commands)?.command ?? null;
  const noInputSlashCommand =
    matchedSlashCommand?.input.text === "none" ? matchedSlashCommand : null;
  const noReferenceSlashCommand =
    matchedSlashCommand?.input.references === "none" ? matchedSlashCommand : null;
  const noAttachmentSlashCommand =
    matchedSlashCommand?.input.attachments === "none" ? matchedSlashCommand : null;
  const noInputSlashCommandRef = useRef<SlashCommand | null>(null);
  const noReferenceSlashCommandRef = useRef<SlashCommand | null>(null);
  const noAttachmentSlashCommandRef = useRef<SlashCommand | null>(null);
  noInputSlashCommandRef.current = noInputSlashCommand;
  noReferenceSlashCommandRef.current = noReferenceSlashCommand;
  noAttachmentSlashCommandRef.current = noAttachmentSlashCommand;
  // Footer extras mirrored from the sidecar: live background tasks and the
  // running context-window usage (input-side tokens of the latest turn).
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [contextTokens, setContextTokens] = useState(0);
  // Project task list (the agent's `tasks` tool store) + the Tasks modal.
  // Updated live via the `tasks_list` SSE event while a run-all sweep advances.
  const [projectTasks, setProjectTasks] = useState<ProjectTask[]>([]);
  const [showTasks, setShowTasks] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  // Every window chooses a code or chat workspace before connecting. Mode stays
  // separate from picker visibility so restore and reopened pickers are explicit.
  const [needsProject, setNeedsProject] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("code");
  // False until the boot-time workspace-restore check resolves.
  const [restoreChecked, setRestoreChecked] = useState(false);
  // Every window starts from the mode-neutral home screen before choosing Code or Chat.
  const [entryView, setEntryView] = useState<EntryView>(initialEntryView(kind === "auxiliary"));
  // Re-open the matching session picker over an already-open workspace.
  const [showPicker, setShowPicker] = useState(false);
  // Bumped on each workspace/session choice to force re-hydration.
  const [hydrateNonce, setHydrateNonce] = useState(0);
  // New-session confirmation modal + in-flight guard.
  const [confirmNewSession, setConfirmNewSession] = useState(false);
  const [showLocalUpdateConfirm, setShowLocalUpdateConfirm] = useState(false);
  const [summarizeDecisions, setSummarizeDecisions] = useState(false);
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
  const setToolsHiddenPersisted = useCallback((hidden: boolean) => {
    try {
      localStorage.setItem("gg-tools-hidden", hidden ? "1" : "0");
    } catch {
      /* ignore */
    }
    setToolsHidden(hidden);
  }, []);
  const toggleTools = useCallback(
    () => setToolsHiddenPersisted(!toolsHidden),
    [toolsHidden, setToolsHiddenPersisted],
  );
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const sessionMutationLockRef = useRef(false);
  const kenPromptActionLockRef = useRef(false);
  // Transcript export (the download button in the activity bar). The chosen
  // folder is remembered so the second export lands where the first one did —
  // stored per-machine, not per-project, because that's how people organise
  // exports (one "agent transcripts" folder, many projects).
  const [exporting, setExporting] = useState(false);
  // The export pill only exists while the pointer is over the chat area. Kept
  // true while a save is in flight so the button doesn't vanish mid-click when
  // the native dialog steals the pointer and fires mouseleave.
  const [chatHovered, setChatHovered] = useState(false);
  const exportTranscript = useCallback(async () => {
    setExporting(true);
    try {
      const filename = (await exportTranscriptName()) ?? "your-chat.md";
      let lastDir: string | null = null;
      try {
        lastDir = localStorage.getItem("gg-export-dir");
      } catch {
        /* ignore */
      }
      const target = await save({
        title: "Save transcript",
        defaultPath: lastDir ? `${lastDir}/${filename}` : filename,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target) return; // user cancelled — not an error, say nothing
      await saveTranscript(target);
      const dir = target.replace(/[/\\][^/\\]*$/, "");
      try {
        if (dir) localStorage.setItem("gg-export-dir", dir);
      } catch {
        /* ignore */
      }
      toast(`Saved ${target.split(/[/\\]/).pop() ?? "transcript"}`, "success");
    } catch (e) {
      toast(`Could not save transcript: ${String(e)}`, "error");
    } finally {
      setExporting(false);
    }
  }, [exportTranscriptName, saveTranscript]);
  // App self-update (GitHub releases). Drives the footer update banner.
  const appUpdate = useAppUpdate();

  // ── macOS menu-bar tray ───────────────────────────────────────────────────
  // Settings opened from the tray. Owned HERE, not by HomeScreen, because the
  // tray targets a WINDOW and that window may be showing Home, a picker, or a
  // live workspace — only App renders in all three.
  const [showTraySettings, setShowTraySettings] = useState(false);
  // Bumped to ask HomeScreen to re-read serve/auth state after the tray changed
  // it. A counter, not a boolean, so repeat tray clicks always re-fire.
  const [homeRefreshSignal, setHomeRefreshSignal] = useState(0);

  const closeTraySettings = useCallback((): void => {
    setShowTraySettings(false);
    // Home gates Code/Chat on the projects folder + a provider; re-read them in
    // case this modal is where they were just set.
    setHomeRefreshSignal((n) => n + 1);
  }, []);

  // Rust owns the tray menu but not the updater — the webview polls GitHub. Push
  // availability down so "Update now" shows only while an update is pending.
  const updateVersion = appUpdate.phase === "available" ? appUpdate.version : null;
  useEffect(() => {
    if (ownsWindowGlobals) void setUpdateAvailable(updateVersion);
  }, [ownsWindowGlobals, updateVersion]);

  // Remote (the Telegram serve loop) lives in the sidecar, so the tray can't
  // know its state — poll it and push it down, which keeps the menu item's label
  // honest even when Remote is toggled from Home or another window. Nothing in
  // React renders it, so this returns the value instead of holding state; Rust
  // is the one that needs it, and it already de-dupes unchanged pushes.
  const syncRemote = useCallback(async (): Promise<boolean> => {
    if (!ownsWindowGlobals) return false;
    try {
      await waitForReady();
      const { running } = await getServeStatus();
      void setRemoteActiveIPC(running);
      return running;
    } catch {
      return false;
    }
  }, [getServeStatus, ownsWindowGlobals, waitForReady]);

  useEffect(() => {
    if (!ownsWindowGlobals) return;
    void syncRemote();
    const id = setInterval(() => void syncRemote(), 30_000);
    return () => clearInterval(id);
  }, [ownsWindowGlobals, syncRemote]);

  const applyTrayIntent = useCallback(
    (intent: TrayIntent): void => {
      switch (intent) {
        case "update":
          void appUpdate.install();
          break;
        // Route to the session picker for the requested mode. On Home that's the
        // entry view; over an open workspace it's the picker overlay, which keeps
        // the running session intact until a different one is chosen.
        case "new-chat":
        case "new-code": {
          const mode = intent === "new-chat" ? "chat" : "code";
          setWorkspaceMode(mode);
          if (needsProject) setEntryView(mode === "chat" ? "chats" : "projects");
          else setShowPicker(true);
          break;
        }
        // A toggle, matching the menu item's label. Re-read the live status
        // first rather than trusting the poll, so a stale cache can't start a
        // second serve loop or stop one the user just started elsewhere.
        case "remote":
          void syncRemote()
            .then(async (running) => {
              if (running) {
                await stopServe();
                toast("Remote is off.", "success");
              } else {
                await startServe();
                toast("Remote is on.", "success");
              }
            })
            .catch((e: unknown) => toast(`Remote failed: ${String(e)}`, "error"))
            .finally(() => {
              void syncRemote();
              setHomeRefreshSignal((n) => n + 1);
            });
          break;
        case "settings":
          setShowTraySettings(true);
          break;
      }
    },
    [appUpdate, needsProject, startServe, stopServe, syncRemote],
  );

  // The handler is re-created on most renders (it closes over `appUpdate`, a
  // fresh object each render). Holding it in a ref keeps the Tauri listener
  // registered exactly ONCE for the window's lifetime — re-subscribing per
  // render raced listen/unlisten and threw inside the event plugin.
  const trayIntentRef = useRef(applyTrayIntent);
  useEffect(() => {
    trayIntentRef.current = applyTrayIntent;
  }, [applyTrayIntent]);

  // Two delivery paths, because a window built BY the tray isn't listening yet
  // when the menu is clicked: an existing window gets the event, a new one
  // claims the parked intent on mount.
  useEffect(() => {
    if (!ownsWindowGlobals) return;
    let unlisten: SafeTauriUnlisten | null = null;
    let disposed = false;
    void onTrayIntent((intent) => trayIntentRef.current(intent)).then((un) => {
      if (disposed) void un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      void unlisten?.();
    };
  }, [ownsWindowGlobals]);

  useEffect(() => {
    if (!ownsWindowGlobals) return;
    void takeTrayIntent().then((intent) => {
      if (intent) applyTrayIntent(intent);
    });
    // Mount-only: the parked intent is consumed once, by the window it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownsWindowGlobals]);
  // Initialize-git modal (shown via the top-right button when not yet a repo).
  const [showInitGit, setShowInitGit] = useState(false);
  // True once the initial hydrate (state + models + commands + history) has
  // settled for the current project/session. Gates the footer + chrome so they
  // reveal fully-formed in one pass instead of popping in piecemeal (cwd, git,
  // thinking, model each arriving separately would reflow the bar mid-load).
  const [hydrated, setHydrated] = useState(false);

  const readyRef = useRef(false);
  // Mirror of `state` for use inside the memoized event handler (which doesn't
  // re-capture state). Lets turn_end pick the right context-token formula by
  // provider without re-subscribing the SSE listener on every state change.
  const stateRef = useRef<AgentState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const projectNotesActionsRef = useRef<ProjectNotesPromptActions>(null);
  const observedSessionResetOperationsRef = useRef<Set<string>>(new Set());
  const sessionResetOperationWaitersRef = useRef(
    new Map<
      string,
      {
        resolve(): void;
        reject(error: Error): void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  // NOTE: the build-session event machine's private refs (streaming bubble id,
  // rAF buffer, per-run accumulators, sub-agent / compaction group ids) now live
  // inside the useAgentEvents hook. Only the cross-cutting refs that App's render
  // + other handlers also touch (stateRef above, the plan refs + stickToBottom
  // below) stay here and are passed into the hook.

  // Whether the transcript is "pinned" to the bottom. Auto-scroll only runs
  // while pinned. The user scrolling up un-pins it — so they can read freely
  // even while the agent keeps streaming — and scrolling back to the bottom
  // re-pins. Default true so a fresh transcript follows the newest output.
  const stickToBottomRef = useRef(true);

  // Pin to the bottom. Images (screenshots / attachments) load asynchronously
  // and grow the content after this fires, so it's also called from each image's
  // onLoad to keep the newest content visible.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);

  // Same as scrollToBottom, but a no-op while the user has scrolled up to read.
  const maybeScrollToBottom = useCallback(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  // Track the user's scroll intent. Any real scroll that lands more than a
  // small threshold above the bottom un-pins; returning to (near) the bottom
  // re-pins. Our own programmatic scrollToBottom lands at the bottom, so it
  // simply keeps the pin set — no need to distinguish it from a user scroll.
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 48;
  }, []);

  // Native drag leave/drop can be lost when the pointer exits the webview.
  useEffect(() => {
    if (!isFileDragOver) return;
    const reset = (): void => setIsFileDragOver(false);
    const timer = window.setTimeout(reset, 4000);
    window.addEventListener("blur", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("blur", reset);
      window.removeEventListener("drop", reset);
    };
  }, [isFileDragOver]);

  const insertDroppedFolderPaths = useCallback((paths: string[]): void => {
    if (paths.length === 0 || noInputSlashCommandRef.current) return;
    const text = paths.join(" ");
    setInput((prev) => {
      if (!prev.trim()) return text;
      return `${prev}${/\s$/.test(prev) ? "" : " "}${text}`;
    });
    setEnhancement(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const showXpChip = useCallback((label: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    playSound("xp");
    setXpChips((chips) => [...chips.slice(-2), { id, label }]);
    window.setTimeout(() => {
      setXpChips((chips) => chips.filter((chip) => chip.id !== id));
    }, 1700);
  }, []);

  useEffect(() => {
    if (!progress) return;
    const previous = lastProgressXpRef.current;
    lastProgressXpRef.current = progress.xp;
    if (previous == null) return;
    const gained = progress.xp - previous;
    // Chip + sound only in the window whose run earned the XP — other windows
    // still receive the frame (badge/percent update) but stay quiet.
    if (gained > 0 && progress.origin) showXpChip(`+${gained} XP`);
  }, [progress, showXpChip]);

  useEffect(() => {
    if (!levelUp || !levelUpNonce) return;
    toast(`Rank up! → ${levelUp.rankName}`, "success", 5200);
    // Rank-up visuals show everywhere; the sound only plays in the earning window.
    if (levelUpOrigin) playSound("levelUp");
    setRankCelebrateNonce(levelUpNonce);
    const clearRank = window.setTimeout(() => setRankCelebrateNonce(null), 2400);

    const crossedTier = Math.floor((levelUp.from - 1) / 5) !== Math.floor((levelUp.to - 1) / 5);
    let clearConfetti = 0;
    if (crossedTier) {
      setConfettiNonce(levelUpNonce);
      clearConfetti = window.setTimeout(() => setConfettiNonce(null), 1900);
    }

    return () => {
      window.clearTimeout(clearRank);
      if (clearConfetti) window.clearTimeout(clearConfetti);
    };
  }, [levelUp, levelUpNonce, levelUpOrigin]);

  // Re-pin to the bottom before every paint — but only while pinned. The live
  // tool panel + activity bar (.liveregion) grow/shrink below the transcript as
  // tools run and finish; since the transcript is a flexible sibling, that
  // growth steals height from it and would leave the newest content (often the
  // just-sent user prompt) scrolled under the fold. Keying this layout effect on
  // the live-region's height inputs (tool feed, run state, done status) AND
  // `items` re-pins synchronously after layout but before paint, so the prompt
  // is never hidden. useLayoutEffect (not a ResizeObserver) avoids the post-paint
  // flash and the RO's unreliable timing relative to the flex re-layout. The
  // stick-to-bottom gate keeps it from yanking the view away while the user is
  // scrolled up reading mid-stream.
  useLayoutEffect(() => {
    maybeScrollToBottom();
  }, [items, liveToolFeed, running, doneStatus, queuedCount, maybeScrollToBottom]);

  // Settle the scroll position after a session hydrates. The single layout-effect
  // scroll above runs the instant `items` is set, but the transcript keeps
  // growing afterward — web fonts swap in (FOUT reflows text taller), code blocks
  // and markdown finish laying out — which leaves the view pinned a little above
  // the true bottom. Re-pin across the next two frames and once fonts are ready,
  // gated on stick-to-bottom so it never yanks the view if the user scrolled up.
  useEffect(() => {
    if (!hydrated) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      maybeScrollToBottom();
      raf2 = requestAnimationFrame(maybeScrollToBottom);
    });
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) maybeScrollToBottom();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [hydrated, hydrateNonce, maybeScrollToBottom]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const inputPlaceholder = running
    ? RUNNING_INPUT_PLACEHOLDERS[placeholderIndex % RUNNING_INPUT_PLACEHOLDERS.length]
    : INPUT_PLACEHOLDERS[placeholderIndex % INPUT_PLACEHOLDERS.length];
  const setAnimatedPlaceholder = useCallback((text: string) => {
    displayPlaceholderRef.current = text;
    setDisplayPlaceholder(text);
  }, []);
  useEffect(() => {
    if (input.length > 0) return;
    const id = window.setInterval(() => {
      setPlaceholderIndex((i) => i + 1);
    }, INPUT_PLACEHOLDER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [input.length]);
  useEffect(() => {
    if (input.length > 0) {
      setAnimatedPlaceholder(inputPlaceholder);
      return;
    }
    if (displayPlaceholderRef.current === inputPlaceholder) return;

    let frame = 0;
    const id = window.setInterval(() => {
      frame += 1;
      const text =
        frame >= PLACEHOLDER_SHUFFLE_FRAMES
          ? inputPlaceholder
          : shufflePlaceholderFrame(inputPlaceholder, frame);
      setAnimatedPlaceholder(text);
      if (frame >= PLACEHOLDER_SHUFFLE_FRAMES) window.clearInterval(id);
    }, PLACEHOLDER_SHUFFLE_FRAME_MS);
    return () => window.clearInterval(id);
  }, [input.length, inputPlaceholder, setAnimatedPlaceholder]);

  // Stop the browser from navigating to / opening a file dropped anywhere
  // (which would replace the whole UI with the raw file). The active chat view
  // handles files as attachments; native Tauri drop events add folder paths to
  // the draft because browser File objects cannot represent directories well.
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      // Only files — don't interfere with text selection drags.
      if (hasDraggedFiles(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    if (!ownsWindowGlobals) return;
    let disposed = false;
    let unlisten: SafeTauriUnlisten | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          if (canHandleWindowFileDrop()) setIsFileDragOver(true);
          return;
        }
        if (payload.type === "leave") {
          setIsFileDragOver(false);
          return;
        }
        setIsFileDragOver(false);
        if (!canHandleWindowFileDrop() || payload.paths.length === 0) return;
        void getDroppedPathInfo(payload.paths).then((infos) => {
          if (disposed) return;
          insertDroppedFolderPaths(infos.filter((info) => info.isDir).map((info) => info.path));
          const filePaths = infos.filter((info) => !info.isDir).map((info) => info.path);
          if (filePaths.length > 0) void addNativeDroppedFiles(filePaths);
        });
      })
      .then((off) => {
        const stop = createSafeTauriUnlisten(off, "webview-drag-drop");
        if (disposed) void stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      void unlisten?.();
    };
  }, [insertDroppedFolderPaths, ownsWindowGlobals]);

  // Keep the native window title aligned with the visible title-bar context.
  useEffect(() => {
    if (!ownsWindowGlobals) return;
    const fallbackTitle = workspaceMode === "chat" ? "GG Chat" : PRODUCT_DISPLAY_NAME;
    const title =
      !needsProject && !showPicker
        ? formatWorkspaceTitle(
            state?.cwd,
            state?.gitBranch,
            fallbackTitle,
            state?.gitDirtyFileCount,
            state?.gitHubIssues ?? null,
            state?.gitHubPRs ?? null,
          )
        : fallbackTitle;
    setWindowTitle(title);
  }, [
    needsProject,
    ownsWindowGlobals,
    showPicker,
    state?.cwd,
    state?.gitBranch,
    state?.gitDirtyFileCount,
    state?.gitHubIssues,
    state?.gitHubPRs,
    workspaceMode,
  ]);

  // Auto-grow the composer without letting its temporary collapse un-pin the transcript.
  const autosizeInput = useCallback(() => {
    autosizeComposer(inputRef.current, scrollRef.current, stickToBottomRef.current);
  }, []);

  useLayoutEffect(() => {
    autosizeInput();
  }, [input, enhanceAnim, autosizeInput]);

  // Re-measure when wrapping changes independently of the draft value.
  const inputResizeObserverRef = useRef<ResizeObserver | null>(null);
  const inputResizeFrameRef = useRef<number | null>(null);
  const attachInput = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inputRef.current = el;
      inputResizeObserverRef.current?.disconnect();
      inputResizeObserverRef.current = null;
      if (inputResizeFrameRef.current !== null) {
        cancelAnimationFrame(inputResizeFrameRef.current);
        inputResizeFrameRef.current = null;
      }
      if (!el || typeof ResizeObserver === "undefined") return;
      let lastWidth = el.clientWidth;
      const observer = new ResizeObserver(() => {
        const width = el.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        if (inputResizeFrameRef.current !== null) {
          cancelAnimationFrame(inputResizeFrameRef.current);
        }
        inputResizeFrameRef.current = requestAnimationFrame(() => {
          inputResizeFrameRef.current = null;
          autosizeInput();
        });
      });
      observer.observe(el);
      inputResizeObserverRef.current = observer;
    },
    [autosizeInput],
  );

  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) autosizeInput();
    });
    return () => {
      cancelled = true;
    };
  }, [autosizeInput]);

  // Keyboard shortcuts for multi-window navigation.
  //   Cmd/Ctrl+N         → new project window
  //   Cmd/Ctrl+`          → cycle forward through windows (reading order)
  //   Cmd/Ctrl+Shift+`    → cycle backward
  //   Cmd/Ctrl+Shift+A    → auto-arrange all windows into a clean grid
  useEffect(() => {
    if (!ownsWindowGlobals) return;
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // New window: Cmd/Ctrl + N (no Shift/Alt).
      if (e.key.toLowerCase() === "n" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void newWindow();
        return;
      }
      // Cycle windows: Cmd/Ctrl + Backquote (Shift = backward).
      // Use e.code (physical key) — Shift turns ` into ~, but code stays stable.
      if (e.code === "Backquote" && !e.altKey) {
        e.preventDefault();
        void focusWindowByOffset(e.shiftKey ? -1 : 1);
        return;
      }
      // Auto-arrange all windows: Cmd/Ctrl + Shift + A.
      if (e.shiftKey && (e.key === "a" || e.key === "A") && !e.altKey) {
        e.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ownsWindowGlobals]);

  // Track whether THIS window holds OS focus (for the prominent input border).
  // The webview's own focus/blur events are instant — no IPC round-trip.
  const [windowFocused, setWindowFocused] = useState(true);

  // Position in the multi-window reading order (e.g. window 2 of 4), plus
  // whether this window is the focused one. Driven by the Rust `window-order`
  // broadcast so the label updates automatically when windows move/close.
  const [windowIndex, setWindowIndex] = useState<number | null>(null);
  const [windowTotal, setWindowTotal] = useState(1);
  const [isThisFocused, setIsThisFocused] = useState(true);

  // Focus the chat input whenever this window gains focus (or clicked anywhere),
  // so switching between project windows lands the cursor in the input without
  // a second click. Skips when the user is selecting text or focused elsewhere
  // intentionally (e.g. a menu button).
  useEffect(() => {
    const focusInput = (): void => {
      const active = document.activeElement;
      if (active && active !== document.body && active.tagName === "BUTTON") return;
      if (window.getSelection()?.toString()) return;
      // A modal/overlay owns keyboard focus while open — stealing it back to the
      // chat input means the user can't type in the modal's fields. Bail when one
      // is present (every modal renders inside `.modal-backdrop`).
      if (document.querySelector(".modal-backdrop")) return;
      // Don't yank focus out of another editable field (a different input,
      // textarea, or contenteditable) the user is intentionally typing in.
      if (
        active instanceof HTMLElement &&
        active !== inputRef.current &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
      ) {
        return;
      }
      inputRef.current?.focus();
    };
    const onFocus = (): void => {
      setWindowFocused(true);
      focusInput();
    };
    const onBlur = (): void => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mouseup", focusInput);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mouseup", focusInput);
    };
  }, []);

  // Subscribe to the reading-order broadcast from Rust so each window knows its
  // position (e.g. "1/4") and whether it's focused. Updates automatically when
  // windows are arranged, moved (debounced), created, closed, or focused.
  useEffect(() => {
    if (!ownsWindowGlobals) return;
    let disposed = false;
    let unlisten: SafeTauriUnlisten | undefined;
    void onWindowOrder((e) => {
      const idx = e.order.indexOf(windowLabel);
      setWindowIndex(idx >= 0 ? idx + 1 : null);
      setWindowTotal(e.order.length);
      setIsThisFocused(e.focused === windowLabel);
    }).then((stop) => {
      if (disposed) void stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      void unlisten?.();
    };
  }, [ownsWindowGlobals]);

  // Global UI click sound — plays only when an actual interactive element is
  // clicked (buttons, links, role=button, options, labels), never bare
  // background/text. Capture phase so it fires even when a handler stops
  // propagation; left button only.
  useEffect(() => {
    if (!ownsWindowGlobals) return;
    const INTERACTIVE = "button, a, [role='button'], [role='option'], label, summary, select";
    const onClick = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      const el = target?.closest?.(INTERACTIVE);
      if (!el) return;
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
      // The autopilot toggle plays its own dedicated sound (only when turning
      // on) instead of the generic click, so skip it here to avoid a double cue.
      if (el.closest("[data-suppress-click-sound]")) return;
      playSound("click");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [ownsWindowGlobals]);

  useEffect(() => {
    if (props.focused) inputRef.current?.focus();
  }, [props.focused]);

  const registerSessionResetOperationWaiter = useCallback((operationId: string) => {
    if (observedSessionResetOperationsRef.current.delete(operationId)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!sessionResetOperationWaitersRef.current.delete(operationId)) return;
        reject(new SessionResetConfirmationTimeoutError(operationId));
      }, SESSION_RESET_TIMEOUT_MS);
      sessionResetOperationWaitersRef.current.set(operationId, { resolve, reject, timeout });
    });
  }, []);

  const onAuthoritativeSessionReset = useCallback((operationId?: string) => {
    if (!operationId) return;
    const waiter = sessionResetOperationWaitersRef.current.get(operationId);
    if (waiter) {
      sessionResetOperationWaitersRef.current.delete(operationId);
      clearTimeout(waiter.timeout);
      waiter.resolve();
      return;
    }
    observedSessionResetOperationsRef.current.add(operationId);
    if (observedSessionResetOperationsRef.current.size > 32) {
      const oldest = observedSessionResetOperationsRef.current.values().next().value;
      if (oldest) observedSessionResetOperationsRef.current.delete(oldest);
    }
  }, []);

  useEffect(
    () => () => {
      for (const waiter of sessionResetOperationWaitersRef.current.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("The pane closed before the new session was confirmed."));
      }
      sessionResetOperationWaitersRef.current.clear();
      observedSessionResetOperationsRef.current.clear();
    },
    [],
  );

  const onRoadmapPhaseDraftChange = useCallback((draft: RoadmapPhaseDraft | null) => {
    dispatchRoadmapDraft({ type: "event", draft });
  }, []);

  // Build-session SSE handling + assistant-streaming helpers live in the
  // useAgentEvents hook (mirrors useKenMentor). It owns the event machine's
  // private refs + the streaming helpers; App keeps owning the build-session
  // state (its render + other handlers use it) and passes the setters +
  // cross-cutting refs in. App consumes `handleEvent` (for the SSE subscription)
  // and the two helpers it still calls directly (`pushItem`, `endStreamingText`).
  const { handleEvent, pushItem, endStreamingText, replacePlanReview } = useAgentEvents({
    client,
    setItems,
    nextId,
    handleKenEvent,
    handleAutopilotEvent,
    setState,
    setTasks,
    setProjectTasks,
    setStatus,
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens,
    setDoneStatus,
    setIsThinking,
    setThinkingStartTs,
    setThinkingAccumMs,
    setPlanTotal,
    setPlanDone,
    setPlanReview,
    setQueuedCount,
    setQueuedMessages,
    setAttachments,
    setCommands,
    setModels,
    onRoadmapPhaseDraftChange,
    stateRef,
    planDoneRef,
    planTotalRef,
    planReviewPathRef,
    pendingPlanTotalRef,
    stickToBottomRef,
    onSessionReset: onAuthoritativeSessionReset,
  });

  // Run the connect/ready flow against the current sidecar and hydrate state,
  // models, and commands. Re-invoked after a project switch respawns the
  // sidecar (its port changes, so we re-wait for readiness).
  const hydrate = useCallback(async (): Promise<void> => {
    readyRef.current = false;
    setHydrated(false);
    setStatus("connecting to agent\u2026");
    try {
      await waitForReady();
      readyRef.current = true;
      const st = await getState().catch(() => null);
      if (st) {
        setState(st);
        setRunning(st.running);
        replacePlanReview(st.pendingPlanReview ?? null);
        setStatus(st.runState === "cancelling" ? "cancelling..." : "ready");
      }
      const available = await listModels();
      // null = the fetch failed; keep whatever the picker already had.
      if (available) setModels(available);
      const cmds = await listCommands();
      if (cmds.length > 0) setCommands(cmds);
      // Project task list for the Tasks modal + nav button.
      setProjectTasks(await listTasks());
      // Hydrate the transcript when resuming an existing session — the webview
      // only sees live SSE events, so past messages must be fetched explicitly.
      const history = await listHistory();
      if (history.length > 0) {
        // A freshly hydrated session lands at the bottom (newest message).
        stickToBottomRef.current = true;
        // Seed ↑/↓ recall from the resumed prompts (chronological), so history
        // works after reopening a session — not just within the live one. App-
        // button prompts (shimmer labels) weren't typed by the user, so skip
        // them; everything else the user actually entered is included.
        promptHistoryRef.current = history
          .filter((h) => h.role === "user" && !(!h.command && recoverPromptLabel(h.text)))
          .map((h) => {
            const parsed = !h.command ? parseReferencedFiles(h.text) : null;
            return (parsed ? parsed.text : h.text).trim();
          })
          .filter((t, i, a) => t.length > 0 && a[i - 1] !== t);
        setItems(
          history.map((h): Item => {
            if (h.mcpToolFailure)
              return {
                kind: "mcp_tool_failure",
                id: nextId(),
                name: h.mcpToolFailure.name,
                result: h.mcpToolFailure.result,
              };
            // Tool-produced images (screenshots, generate_image) — reconstructed
            // from persisted ImageContent blocks, downsampled by the sidecar.
            if (h.toolImages && h.toolImages.length > 0)
              return {
                kind: "images",
                id: nextId(),
                images: h.toolImages.map((img) => ({ src: img.src, path: img.path })),
              };
            // Sub-agent delegation group — reconstructed from persisted tool_call
            // + tool_result pairing. toolUseCount/activities aren't persisted, so
            // the resumed feed shows agent name + status only.
            if (h.subagentGroup && h.subagentGroup.length > 0)
              return {
                kind: "subagent_group",
                id: nextId(),
                agents: h.subagentGroup.map((a, i) => ({
                  toolCallId: `history-${i}`,
                  agentName: a.agentName,
                  status: a.status,
                  activities: [],
                  toolUseCount: a.toolUseCount,
                  tokenUsage: { input: 0, output: 0 },
                })),
              };
            if (h.hook) return { kind: "hook", id: nextId(), hook: h.hook };
            // A resumed compacted session shows the quiet compaction notice in
            // place of the raw summary body (counts aren't persisted).
            if (h.compacted)
              return {
                kind: "compaction",
                id: nextId(),
                status: "done",
                originalCount: h.compactionCounts?.originalCount,
                newCount: h.compactionCounts?.newCount,
              };
            // Persisted display-only markers: plan-mode banner, task header,
            // error rows, and the video-capability info row — all rendered
            // identically to their live counterparts.
            if (h.plan) return { kind: "plan", id: nextId(), reason: h.plan.reason };
            if (h.task) return { kind: "task", id: nextId(), title: h.task.title };
            if (h.error) {
              const prefix =
                h.error.scope === "ken_error"
                  ? `${MENTOR_DISPLAY_NAME}: `
                  : h.error.scope === "autopilot_error"
                    ? "Autopilot: "
                    : "";
              return {
                kind: "error",
                id: nextId(),
                headline: `${prefix}${h.error.headline}`,
                message: h.error.message,
                guidance: h.error.guidance,
              };
            }
            if (h.infoKind === "video_warning")
              return { kind: "info", id: nextId(), text: VIDEO_CAPABILITY_WARNING };
            // Ken "Send to GG Coder" prompts: restore the shimmer label, not the
            // full prompt body (matches live).
            if (h.kenSent && h.role === "user")
              return { kind: "user", id: nextId(), text: h.text, kenSent: true };
            // Persisted Ken (mentor) turns: his reply restores as a Ken bubble,
            // the `@Ken` question as a Ken-tinted user bubble (matches live).
            if (h.ken && h.role === "assistant") return { kind: "ken", id: nextId(), text: h.text };
            if (h.ken && h.role === "user")
              return { kind: "user", id: nextId(), text: h.text, ken: true };
            // Persisted autopilot verdict marker: render identically to the
            // live item so a resumed session never shows the raw verdict text
            // (e.g. "ALL_CLEAR") the model actually replied with.
            if (h.autopilot)
              return {
                kind: "autopilot",
                id: nextId(),
                phase: h.autopilot.phase,
                reason: h.autopilot.reason,
                body: h.autopilot.body,
                copySeed: h.autopilot.copySeed,
              };
            if (h.role !== "user") return { kind: h.role, id: nextId(), text: h.text };
            // App-button prompts (e.g. "Initialize Git") were shown live as a
            // friendly shimmer label, not the expanded body. The label is
            // webview-only, so recover it from the restored prompt text. Slash
            // commands are already collapsed to `/name` by the sidecar (h.command).
            const label = !h.command ? recoverPromptLabel(h.text) : null;
            // Recover @-referenced files appended to the prompt so resumed
            // sessions show the same file chips (and clean text) as when sent.
            const parsed = !h.command && label === null ? parseReferencedFiles(h.text) : null;
            return {
              kind: "user",
              id: nextId(),
              text: parsed ? parsed.text : h.text,
              command: h.command || label !== null,
              ...(label !== null ? { label } : {}),
              images: h.images && h.images.length > 0 ? h.images : undefined,
              ...(parsed && parsed.files.length > 0 ? { files: parsed.files } : {}),
              ...(h.enhancements && h.enhancements.length > 0
                ? { enhancements: h.enhancements }
                : {}),
            };
          }),
        );
      }
    } catch (err) {
      setStatus(`agent failed to start: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Reveal the footer + chrome now that everything we know about the
      // session is in hand — one fade-in, no staggered reflow.
      setHydrated(true);
    }
  }, [getState, listCommands, listHistory, listModels, listTasks, replacePlanReview, waitForReady]);

  useEffect(() => {
    const unsub = subscribe(handleEvent);
    return () => unsub();
  }, [handleEvent, subscribe]);

  // Boot-time/reload workspace recovery: Rust keeps THIS window's active target
  // for its lifetime. A restored app launch and a WebKit content-process reload
  // therefore both hydrate straight back into the existing daemon session.
  useEffect(() => {
    if (kind !== "primary" || props.workspaceOwnsSessionLifecycle) {
      setRestoreChecked(true);
      return;
    }
    const epoch = lifecycleEpochRef.current;
    void restoreTarget()
      .then((restoredTarget) => {
        if (!mountedRef.current || lifecycleEpochRef.current !== epoch) return;
        if (restoredTarget) {
          setWorkspaceMode(restoredTarget.mode);
          onProjectChosen();
        }
      })
      .finally(() => {
        if (mountedRef.current && lifecycleEpochRef.current === epoch) setRestoreChecked(true);
      });
  }, [kind, props.workspaceOwnsSessionLifecycle]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: SafeTauriUnlisten | undefined;
    void onModelsChanged(() => {
      setModelCatalogRefreshNonce((nonce) => nonce + 1);
      void (async () => {
        try {
          await waitForReady();
          const [available, refreshedState] = await Promise.all([
            client.listModels(),
            client.getState(),
          ]);
          if (cancelled) return;
          setModels(available);
          setState(refreshedState);
        } catch {
          // The normal readiness/hydration path reports daemon failures.
        }
      })();
    }).then((stop) => {
      if (cancelled) void stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      void unlisten?.();
    };
  }, [client, waitForReady]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const startedAtEventVersion = roadmapDraftEventVersionRef.current;
    void client
      .getRoadmapPhaseDraft()
      .then((draft) => {
        if (!cancelled) {
          dispatchRoadmapDraft({ type: "hydrated", draft, startedAtEventVersion });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          dispatchRoadmapDraft({
            type: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, hydrated, hydrateNonce]);

  const approveRoadmapDraft = useCallback(() => {
    const draftId = roadmapDraftState.draft?.id;
    if (!draftId || roadmapDraftState.decision !== "idle") return;
    dispatchRoadmapDraft({ type: "decision-started", decision: "approving" });
    void client
      .approveRoadmapPhaseDraft(draftId)
      .then((result) => dispatchRoadmapDraft({ type: "approval-result", result }))
      .catch((error) =>
        dispatchRoadmapDraft({
          type: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, [client, roadmapDraftState.decision, roadmapDraftState.draft?.id]);

  const rejectRoadmapDraft = useCallback(() => {
    const draftId = roadmapDraftState.draft?.id;
    if (!draftId || roadmapDraftState.decision !== "idle") return;
    dispatchRoadmapDraft({ type: "decision-started", decision: "rejecting" });
    void client
      .rejectRoadmapPhaseDraft(draftId)
      .then((result) => dispatchRoadmapDraft({ type: "rejection-result", result }))
      .catch((error) =>
        dispatchRoadmapDraft({
          type: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, [client, roadmapDraftState.decision, roadmapDraftState.draft?.id]);

  useEffect(() => {
    // Only the main window auto-connects to its default project. Secondary
    // (project-*) windows show the picker first and connect on selection.
    // hydrateNonce forces a re-run when re-selecting a session in an already-
    // connected window (needsProject stays false there).
    if (!needsProject) void hydrate();
  }, [needsProject, hydrate, hydrateNonce]);

  // Open the Tasks modal, refreshing the list from the sidecar first so it
  // reflects any tasks the agent just added.
  const openTasks = useCallback(() => {
    setShowTasks(true);
    void listTasks().then(setProjectTasks);
  }, [listTasks]);

  // Run a single task: the sidecar opens a fresh session and streams progress
  // back (session_reset → task_start → run_start/…/run_end). Close the modal so
  // the transcript is visible while it runs.
  const handleRunTask = useCallback(
    (id: string) => {
      setShowTasks(false);
      void runTask(id);
    },
    [runTask],
  );

  // Run every pending task sequentially (a fresh session each), in order.
  const handleRunAllTasks = useCallback(() => {
    setShowTasks(false);
    void runAllTasks();
  }, [runAllTasks]);

  const handleDeleteTask = useCallback(
    (id: string) => {
      void deleteTask(id).then(setProjectTasks);
    },
    [deleteTask],
  );

  // Pin Ken to a model (or null → clear the pin, follow GG Coder). The
  // sidecar's ken_model_change broadcast updates state; the .then is just a
  // faster local echo of the same payload.
  function onSelectKenModel(modelId: string | null): void {
    if (state && modelId !== null && state.kenModelOverride && modelId === state.kenModel) return;
    if (state && modelId === null && !state.kenModelOverride) return;
    void switchKenModel(modelId).then((res) => {
      if (res) {
        setState((s) =>
          s
            ? {
                ...s,
                kenProvider: res.kenProvider,
                kenModel: res.kenModel,
                kenModelOverride: res.kenModelOverride,
              }
            : s,
        );
      }
    });
  }

  function onSelectModel(modelId: string): void {
    if (state && modelId === state.model) return;
    void switchModel(modelId).then((res) => {
      if (isSwitchModelError(res)) {
        // The sidecar refuses with a reason worth reading ("Ollama isn't
        // running at …", "has no tool calling"). Show it — otherwise the
        // picker just snaps back with no explanation.
        toast(res.error, "error");
        return;
      }
      // Sakana Fugu easter egg: blow the fugu horn when a Fugu model is picked.
      if (res.model.startsWith("fugu")) playSound("fugu");
      setState((s) =>
        s
          ? {
              ...s,
              provider: res.provider,
              model: res.model,
              thinkingLevel: res.thinkingLevel,
              supportedThinkingLevels: res.supportedThinkingLevels,
            }
          : s,
      );
    });
  }

  // Context-window usage percentage for the footer meter. 0 (hidden) until we
  // have both a window size and a real token reading from a completed turn.
  const contextPct =
    state?.contextWindow && contextTokens > 0
      ? Math.min(100, Math.round((contextTokens / state.contextWindow) * 100))
      : 0;

  // Workflow commands matching the current `/prefix` (only while the input is a
  // single `/token` with no space yet). Empty when not in slash mode.
  const slashQuery =
    input.startsWith("/") && !input.includes(" ") ? input.slice(1).toLowerCase() : null;
  // `/schedule ` (past the command token) swaps the palette for the argument
  // hint. An invalid draft is blocked from being sent to the agent.
  const scheduleDraft = isScheduleDraft(input);
  const scheduleParse = scheduleDraft ? parseScheduleCommand(input) : null;
  // Drives the composer's invalid affordance; submit() enforces the block.
  const scheduleInvalid = scheduleParse !== null && !scheduleParse.ok;
  // Commit lives in the top-right button, not the slash menu.
  const COMMIT_NAMES = ["commit", "setup-commit"];
  // `/schedule` is handled entirely in the webview (it registers a timer rather
  // than prompting the agent), so the sidecar's registry never lists it. Inject
  // it here or it would be undiscoverable — typing `/sch` would show nothing.
  const menuCommands = [SCHEDULE_COMMAND, ...commands].filter(
    (c) => !COMMIT_NAMES.includes(c.name),
  );
  const slashMatches =
    slashQuery !== null
      ? menuCommands.filter(
          (c) =>
            c.name.toLowerCase().startsWith(slashQuery) ||
            c.aliases.some((a) => a.toLowerCase().startsWith(slashQuery)),
        )
      : [];
  const slashOpen = slashMatches.length > 0;
  // Clamp so a shrinking match list never points past the end.
  const clampedSlashIndex = slashMatches.length > 0 ? slashIndex % slashMatches.length : 0;

  // `@Ken` is the mentor-agent address, not a file mention. When the input leads
  // with it (case-insensitive, word-boundary so `@kennedy.ts` still picks files),
  // Ken is "active": the file picker is suppressed and the input is tinted in
  // Ken's color with a shimmering marker, so it's obvious the message goes to Ken.
  const kenActive = workspaceMode === "code" && /^@(ken|supah)\b/i.test(input.trimStart());
  // Split the input for the `@Ken` highlight overlay: any leading whitespace,
  // the literal `@Ken` token (preserving the user's casing), then the rest. Only
  // the token shimmers; lead+rest render in the normal input color.
  const kenInputParts = (() => {
    const m = /^(\s*)(@(ken|supah))/i.exec(input);
    if (!m) return null;
    return { lead: m[1], token: m[2], rest: input.slice(m[1].length + m[2].length) };
  })();
  // `@`-mention picker: open whenever a mention token is active and the search
  // returned at least one file. Clamp the highlighted row to the result count.
  // Never open while `@Ken` is active — that token addresses Ken, not a file.
  const mentionOpen = mention !== null && fileMatches.length > 0 && !kenActive;
  const clampedFileIndex = fileMatches.length > 0 ? fileIndex % fileMatches.length : 0;
  // Footer background-tasks indicator only shows while something is actually
  // running (exited tasks shouldn't keep the bar item around).
  const runningTaskCount = tasks.filter((t) => t.exitCode === null).length;

  // True when `text` is a known workflow command invocation (first token).
  function isWorkflowCommand(text: string): boolean {
    if (!text.startsWith("/")) return false;
    const name = text.slice(1).split(" ")[0]?.toLowerCase() ?? "";
    return commands.some(
      (c) => c.name.toLowerCase() === name || c.aliases.some((a) => a.toLowerCase() === name),
    );
  }

  // Top-right commit affordance: once a project-local `/commit` exists it shows
  // `/commit`; until then it offers `/setup-commit` to generate one. Only shown
  // when at least one of the two is available from the sidecar.
  const hasCommit = commands.some((c) => c.name === "commit");
  const hasSetupCommit = commands.some((c) => c.name === "setup-commit");
  const commitCommand = hasCommit ? "commit" : hasSetupCommit ? "setup-commit" : null;
  // Until the project is a git repo, setting up commits is pointless — offer
  // "Initialize Git" first (modal collects visibility + repo name, then drives
  // the agent). isGitRepo can be undefined on older sidecars / before hydrate;
  // only treat an explicit `false` as "not a repo".
  const needsGitInit = state?.isGitRepo === false;
  // Default repo name = the project folder name.
  const defaultRepoName = (state?.cwd ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

  /**
   * Fill the interval slot from a preset chip. Replaces an existing interval
   * rather than appending, so clicking `1h` after `15m` swaps it instead of
   * producing a second bar. Keeps focus in the composer so typing continues.
   */
  function fillScheduleInterval(preset: string): void {
    const { text, caret: caretAt } = withInterval(input, preset);
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caretAt, caretAt);
      setCaret(caretAt);
    });
  }

  /**
   * Cancel one pending queued message. The sidecar returns the remaining queue,
   * which we adopt wholesale rather than filtering locally: the agent may have
   * consumed messages between render and click, so its list is authoritative.
   */
  function handleCancelQueued(id: string): void {
    const cancelledText = queuedMessages.find((m) => m.id === id)?.text;
    void cancelQueued(id).then((remaining) => {
      if (remaining === null) return;
      setQueuedMessages(remaining);
      setQueuedCount(remaining.length);
      // Drop the transcript bubble for a message that will now never run.
      // Leaving it would clear its `queued` flag on the next queue broadcast and
      // render it identically to a message the agent actually received.
      // Only remove it if the sidecar really dropped it: a cancel that lost the
      // race (already consumed) comes back with the text still in the queue.
      if (cancelledText === undefined) return;
      if (remaining.some((m) => m.id === id)) return;
      setItems((prev) => {
        const index = prev.findIndex(
          (it) => it.kind === "user" && it.queued && it.text === cancelledText,
        );
        return index === -1 ? prev : [...prev.slice(0, index), ...prev.slice(index + 1)];
      });
    });
  }

  function pickSlashCommand(cmd: SlashCommand): void {
    if (cmd.name === "add-dir" || cmd.name === "remove-dir") {
      setInput("");
      setSlashIndex(0);
      void pickWorkspaceDirectory(cmd.name);
      return;
    }

    const next = cmd.input.text === "none" ? `/${cmd.name}` : `/${cmd.name} `;
    setInput(next);
    setSlashIndex(0);
    setCaret(next.length);
    if (cmd.input.references === "none") {
      setMention(null);
      setMentionedPaths([]);
    }
    if (cmd.input.attachments === "none") {
      setAttachments([]);
      setIsFileDragOver(false);
    }
    if (cmd.input.text === "none") setEnhancement(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function pickWorkspaceDirectory(command: "add-dir" | "remove-dir"): Promise<void> {
    inputRef.current?.blur();
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title:
          command === "add-dir"
            ? "Add project folder to workspace"
            : "Remove project folder from workspace",
      });
      if (typeof selected !== "string") return;
      submitText(`/${command} ${selected}`, command === "add-dir" ? "/add-dir" : "/remove-dir");
    } finally {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  // Detect an active `@`-mention token at the caret: a `@` that starts at a word
  // boundary with no whitespace between it and the caret. Returns the query text
  // after `@` and the `@`'s index, or null when not in a mention.
  function detectMention(text: string, caret: number): { query: string; start: number } | null {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    // Must start at the line start or after whitespace.
    const prev = at > 0 ? before[at - 1] : " ";
    if (prev !== undefined && !/\s/.test(prev)) return null;
    const query = before.slice(at + 1);
    // A space ends the token — no mention once the path is followed by a space.
    if (/\s/.test(query)) return null;
    return { query, start: at };
  }

  // Sync the mention picker to the current input + caret on every change.
  function updateMention(text: string, caret: number): void {
    setMention(noReferenceSlashCommandRef.current ? null : detectMention(text, caret));
  }

  // Debounced file search whenever the active mention query changes. Skipped when
  // `@Ken` is active so typing `@ken` never spawns a file lookup or picker.
  useEffect(() => {
    if (mention === null || kenActive || noReferenceSlashCommand) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchFiles(mention.query).then((files) => {
        if (!cancelled) {
          setFileMatches(files);
          setFileIndex(0);
        }
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mention, kenActive, noReferenceSlashCommand, searchFiles]);

  // Pick a file: drop the typed `@query` from the input, add the file as a chip
  // (deduped), and restore the caret where the token was. The path lives in chip
  // state, never in the textarea text.
  function pickMentionFile(file: FileHit): void {
    if (mention === null || noReferenceSlashCommandRef.current) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const head = input.slice(0, mention.start);
    const tail = input.slice(caret);
    const next = head + tail;
    setInput(next);
    setMentionedPaths((prev) => (prev.includes(file.path) ? prev : [...prev, file.path]));
    setMention(null);
    setFileMatches([]);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(head.length, head.length);
    });
  }

  // Drop a referenced-file chip.
  function removeMentionChip(p: string): void {
    setMentionedPaths((prev) => prev.filter((x) => x !== p));
  }

  // Submit arbitrary text as if typed + entered. Shared by the input, the
  // top-right commit button, and the workspace directory picker. `label` shows
  // a friendly shimmer phrase in the transcript while the full `text` is still
  // sent to the agent.
  //
  // `keepInput` is for sends the user did not initiate right now — a scheduled
  // prompt firing on its interval. Those must NOT clear the composer, or a
  // schedule that comes due mid-sentence deletes what the user was typing.
  function submitText(text: string, label?: string, opts?: { keepInput?: boolean }): void {
    // A pending plan is the only operation that can move this session forward.
    // Do not let toolbar commands or scheduled prompts silently clear its gate.
    if (planReview !== null) return;
    const trimmed = text.trim();
    // Mid-run this QUEUES as steering, exactly like a typed message (see
    // submit()): the sidecar injects it into the running loop. Dropping it
    // instead would be silent — the folder picker especially, which gives no
    // hint that the directory you just chose went nowhere.
    const disposition = submitDisposition(trimmed, readyRef.current, running);
    if (disposition === "ignore") return;
    const queued = disposition === "queue";
    const supersedesQuestion = hasOpenAsk();
    if (supersedesQuestion) {
      dismissOpenAsks();
      if (queued) noteSupersedingSend(trimmed);
    }
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    pushItem({
      kind: "user",
      id: nextId(),
      text: trimmed,
      command: label !== undefined || isWorkflowCommand(trimmed),
      ...(label !== undefined ? { label } : {}),
      ...(showsQueuedBubble(disposition, supersedesQuestion) ? { queued: true } : {}),
    });
    if (!opts?.keepInput) {
      setInput("");
      setSlashIndex(0);
    }
    if (!queued) endStreamingText();
    void sendPrompt(trimmed).then((submission) => {
      if (!submission.queued) planResumePromptRef.current = trimmed;
    });
  }

  // Scheduled prompts fire from a ticker that is set up once, so it can't close
  // over this render's `submitText`. The ref keeps the ticker pointed at the
  // current one without re-creating the interval on every render.
  const submitTextRef = useRef(submitText);
  submitTextRef.current = submitText;

  const typingAskRef = useRef<{ itemId: number; promptId: string; questionId: string } | null>(
    null,
  );

  function hasOpenAsk(): boolean {
    return items.some((item) => item.kind === "ask" && !item.sent && !item.cancelled);
  }

  const dismissOpenAsks = useCallback((): void => {
    setItems(dropSupersededAsks);
    typingAskRef.current = null;
  }, [setItems]);

  const supersedingTextRef = useRef<string | null>(null);
  const [supersedingText, setSupersedingText] = useState<string | null>(null);
  const supersedeClearRef = useRef<number | null>(null);
  const noteSupersedingSend = useCallback((text: string): void => {
    supersedingTextRef.current = text;
    setSupersedingText(text);
    if (supersedeClearRef.current !== null) window.clearTimeout(supersedeClearRef.current);
    supersedeClearRef.current = window.setTimeout(() => {
      supersedingTextRef.current = null;
      setSupersedingText(null);
    }, 5000);
  }, []);
  useEffect(() => {
    const text = supersedingTextRef.current;
    if (text !== null && !queuedMessages.some((message) => message.text === text)) {
      supersedingTextRef.current = null;
      setSupersedingText(null);
    }
  }, [queuedMessages]);
  useEffect(
    () => () => {
      if (supersedeClearRef.current !== null) window.clearTimeout(supersedeClearRef.current);
    },
    [],
  );
  const visibleQueuedMessages = useMemo(
    () => withoutSupersedingMessage(queuedMessages, supersedingText),
    [queuedMessages, supersedingText],
  );

  const handleAskAnswer = useCallback(
    (itemId: number, promptId: string, delta: Record<string, string | string[]>): void => {
      setItems((current) =>
        current.map((item) => {
          if (item.kind !== "ask" || item.id !== itemId || item.sent || item.cancelled) return item;
          const merged = mergeAskAnswers(item.answers, delta, item.prompt.questions);
          if (merged.complete) {
            void client
              .answerAskUser(promptId, "answer", merged.answers)
              .catch((error) => setStatus(`could not answer question: ${String(error)}`));
          }
          return { ...item, answers: merged.answers, sent: merged.complete || undefined };
        }),
      );
    },
    [client],
  );

  const handleAskType = useCallback(
    (itemId: number, promptId: string, questionId: string, seed = ""): void => {
      typingAskRef.current = { itemId, promptId, questionId };
      if (seed) setInput(seed);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [],
  );

  const createAuthoritativeNewSession = useCallback(async (): Promise<string> => {
    if (running) throw new LocalSessionMutationBusyError();
    if (autopilotReviewing) throw new Error(AUTOPILOT_NEW_SESSION_RETRY_MESSAGE);
    if (newSessionBusy || sessionMutationLockRef.current) {
      throw new LocalSessionMutationBusyError();
    }
    sessionMutationLockRef.current = true;
    setNewSessionBusy(true);
    try {
      const { operationId } = await newSession();
      await waitForReady();
      await registerSessionResetOperationWaiter(operationId);
      return operationId;
    } finally {
      sessionMutationLockRef.current = false;
      setNewSessionBusy(false);
    }
  }, [
    autopilotReviewing,
    newSession,
    newSessionBusy,
    registerSessionResetOperationWaiter,
    running,
    waitForReady,
  ]);

  const restorePromptToComposer = useCallback((prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  }, []);

  const dispatchKenPromptAction = useCallback(
    async (action: KenPromptAction): Promise<KenPromptActionResult> => {
      const prompt = action.prompt;
      if (!prompt) {
        return { status: "failed", action: action.type, message: "This prompt is empty." };
      }
      if (planReview !== null && (action.type === "send-current" || action.type === "send-fresh")) {
        return {
          status: "failed",
          action: action.type,
          message: "Approve or dismiss the pending plan before sending another prompt.",
        };
      }

      if (action.type === "send-current") {
        if (sessionMutationLockRef.current) {
          return {
            status: "failed",
            action: action.type,
            message: "A session change is already in progress.",
          };
        }
        if (kenPromptActionLockRef.current) {
          return {
            status: "failed",
            action: action.type,
            message: "This prompt is already being sent.",
          };
        }
        const disposition = submitDisposition(prompt, readyRef.current, running);
        if (disposition === "ignore") {
          return {
            status: "failed",
            action: action.type,
            message: `${PRODUCT_DISPLAY_NAME} is still connecting. Try again in a moment.`,
          };
        }
        kenPromptActionLockRef.current = true;
        try {
          const supersedesQuestion = hasOpenAsk();
          if (supersedesQuestion) dismissOpenAsks();
          const submission = await sendPrompt(prompt, [], { kenSent: true });
          if (supersedesQuestion && submission.queued) noteSupersedingSend(prompt);
          if (!submission.queued) planResumePromptRef.current = prompt;
          stickToBottomRef.current = true;
          setQueuedCount(submission.count);
          pushItem({
            kind: "user",
            id: nextId(),
            text: prompt,
            kenSent: true,
            queued: showsQueuedBubble(disposition, supersedesQuestion),
          });
          if (!submission.queued) endStreamingText();
          return { status: "sent", session: "current" };
        } catch {
          return {
            status: "failed",
            action: action.type,
            message: "Couldn’t send the prompt. Try again.",
          };
        } finally {
          kenPromptActionLockRef.current = false;
        }
      }

      if (action.type === "send-fresh") {
        if (autopilotReviewing) {
          return {
            status: "failed",
            action: action.type,
            message: AUTOPILOT_NEW_SESSION_RETRY_MESSAGE,
          };
        }
        if (running) {
          return {
            status: "failed",
            action: action.type,
            message: "Wait for the current build to finish before starting a new session.",
          };
        }
        if (kenPromptActionLockRef.current) {
          return {
            status: "failed",
            action: action.type,
            message: "This prompt action is already in progress.",
          };
        }
        kenPromptActionLockRef.current = true;
        try {
          let preparedPrompt: string;
          try {
            preparedPrompt = (await prepareContinuationHandoff(prompt)).prompt;
          } catch {
            return {
              status: "failed",
              action: action.type,
              message:
                "Couldn’t prepare the continuation handoff. The current session is unchanged; try again.",
            };
          }
          try {
            await createAuthoritativeNewSession();
          } catch (error) {
            if (error instanceof LocalSessionMutationBusyError) {
              return { status: "failed", action: action.type, message: error.message };
            }
            if (error instanceof NewSessionError && error.kind === "creation-rejected") {
              return {
                status: "failed",
                action: action.type,
                message:
                  "Couldn’t create a new session. The current session is unchanged; try again.",
              };
            }
            restorePromptToComposer(preparedPrompt);
            return {
              status: "failed",
              action: action.type,
              message: `${AMBIGUOUS_NEW_SESSION_MESSAGE} The complete continuation handoff is in the composer.`,
              recoverPrompt: preparedPrompt,
            };
          }
          try {
            planResumePromptRef.current = preparedPrompt;
            const submission = await sendPrompt(preparedPrompt, [], { kenSent: true });
            stickToBottomRef.current = true;
            setQueuedCount(submission.count);
            pushItem({
              kind: "user",
              id: nextId(),
              text: preparedPrompt,
              kenSent: true,
              queued: submission.queued,
            });
            endStreamingText();
            return { status: "sent", session: "fresh" };
          } catch {
            restorePromptToComposer(preparedPrompt);
            return {
              status: "failed",
              action: action.type,
              message:
                "The new session opened, but sending failed. The complete continuation handoff is back in the composer.",
              recoverPrompt: preparedPrompt,
            };
          }
        } finally {
          kenPromptActionLockRef.current = false;
        }
      }

      const notesActions = projectNotesActionsRef.current;
      if (!notesActions) {
        return {
          status: "failed",
          action: action.type,
          message: "Project Notes are unavailable for this workspace.",
        };
      }

      if (action.type === "prepare-save") {
        return {
          status: "preview",
          preview: {
            prompt,
            suggestedTitle: deriveKenPromptTitle(prompt),
            destinations: notesActions.listDestinations(),
            recommendedDestination: { kind: "new-draft" },
          },
        };
      }

      const saveResult = await notesActions.savePrompt(
        action.target.kind === "new-draft"
          ? { kind: "new-draft", title: action.target.title, prompt }
          : {
              kind: "existing-phase",
              phaseId: action.target.phaseId,
              prompt,
              expectedSourcePrompt: action.target.expectedSourcePrompt,
            },
      );
      const latestPreview: KenPromptSavePreview = {
        prompt,
        suggestedTitle: deriveKenPromptTitle(prompt),
        destinations: notesActions.listDestinations(),
        recommendedDestination: { kind: "new-draft" },
      };
      return notesPromptActionResult(saveResult, latestPreview);
    },
    [
      autopilotReviewing,
      createAuthoritativeNewSession,
      dismissOpenAsks,
      endStreamingText,
      noteSupersedingSend,
      planReview,
      pushItem,
      restorePromptToComposer,
      running,
      sendPrompt,
      prepareContinuationHandoff,
    ],
  );

  const kenPromptDispatcher = useMemo<KenPromptActionDispatcher>(
    () => ({
      dispatch: dispatchKenPromptAction,
      blockedReason: (action) => {
        if (planReview !== null && (action === "send-current" || action === "send-fresh")) {
          return "Approve or dismiss the pending plan before sending another prompt.";
        }
        if (action !== "send-fresh") return null;
        if (autopilotReviewing) return AUTOPILOT_NEW_SESSION_RETRY_MESSAGE;
        if (running) return "Wait for the current build to finish before starting a new session.";
        if (newSessionBusy || sessionMutationLockRef.current) {
          return "A session change is already in progress.";
        }
        return null;
      },
    }),
    [autopilotReviewing, dispatchKenPromptAction, newSessionBusy, planReview, running],
  );

  // Record a sent prompt for ↑/↓ recall (skips consecutive duplicates, capped).
  function recordHistory(text: string): void {
    const h = promptHistoryRef.current;
    if (text && h[h.length - 1] !== text) h.push(text);
    if (h.length > 200) h.shift();
    setHistoryIndex(null);
    historyDraftRef.current = "";
  }

  // Replace the input with a recalled history entry and park the caret at the end.
  function applyHistory(text: string): void {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }

  // Walk prompt history with ↑ (dir -1, older) / ↓ (dir +1, newer). Returns true
  // when it consumed the key. Only triggers when the caret is on the first line
  // (↑) or last line (↓) so multi-line editing still moves the cursor normally.
  function navigateHistory(dir: -1 | 1, el: HTMLTextAreaElement): boolean {
    const hist = promptHistoryRef.current;
    if (hist.length === 0) return false;
    const collapsed = el.selectionStart === el.selectionEnd;
    const caret = el.selectionStart ?? 0;
    if (dir === -1) {
      const onFirstLine = collapsed && !el.value.slice(0, caret).includes("\n");
      if (!onFirstLine) return false;
      if (historyIndex === null) {
        historyDraftRef.current = el.value;
        const idx = hist.length - 1;
        setHistoryIndex(idx);
        applyHistory(hist[idx]);
      } else if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        applyHistory(hist[idx]);
      }
      return true; // consume even at the oldest entry
    }
    if (historyIndex === null) return false; // not navigating — let ↓ move the caret
    const onLastLine = collapsed && !el.value.slice(caret).includes("\n");
    if (!onLastLine) return false;
    if (historyIndex < hist.length - 1) {
      const idx = historyIndex + 1;
      setHistoryIndex(idx);
      applyHistory(hist[idx]);
    } else {
      setHistoryIndex(null);
      applyHistory(historyDraftRef.current);
    }
    return true;
  }

  // Apply a finished enhancement to the input: fill the textarea with the plain
  // text, stash the highlighted segments (drives the inline highlight overlay +
  // sent bubble), and park the caret at the end.
  function applyEnhanceResult(r: { enhanced: string; segments: PromptSegment[] }): void {
    setInput(r.enhanced);
    setEnhancement({ plain: r.enhanced, segments: r.segments });
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }

  // Run the prompt enhancer: rewrite the current draft via the active model into
  // a tighter, terminology-correct prompt. The result plays in over the input as
  // a Matrix dissolve→decode animation (unless reduced-motion), then fills it.
  async function runEnhance(): Promise<void> {
    const draft = input.trim();
    if (!draft || enhancing) return;
    setEnhanceHintVisible(false);
    setEnhancing(true);

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      try {
        applyEnhanceResult(await enhancePrompt(draft));
      } catch {
        toast("Couldn't enhance the prompt", "error");
      } finally {
        setEnhancing(false);
      }
      return;
    }

    // Start the dissolve immediately (newText null), then flip to decode when the
    // enhancer returns. applyEnhanceResult + cleanup run in the animation's
    // onDone so the text never pops in before the decode settles.
    setEnhanceAnim({ oldText: draft, newText: null });
    try {
      const r = await enhancePrompt(draft);
      pendingEnhanceRef.current = r;
      setEnhanceAnim((a) => (a ? { ...a, newText: r.enhanced } : null));
    } catch {
      toast("Couldn't enhance the prompt", "error");
      setEnhanceAnim(null);
      setEnhancing(false);
    }
  }

  // The dissolve→decode animation finished: hand off to the real input WITHOUT a
  // flash. The decoded text lives in the .enh-diss overlay (on top); the textarea
  // sits hidden beneath it (.input-anim). If we removed the overlay and filled
  // the textarea in the same commit, you'd see the overlay text vanish and the
  // textarea text reflow/resize a frame later. So: fill the textarea FIRST (still
  // hidden under the overlay) and let useLayoutEffect size it, THEN drop the
  // overlay on the next frame — the sized text is already in place underneath.
  function onEnhanceAnimDone(): void {
    const r = pendingEnhanceRef.current;
    pendingEnhanceRef.current = null;
    if (r) {
      setInput(r.enhanced);
      setEnhancement({ plain: r.enhanced, segments: r.segments });
    }
    requestAnimationFrame(() => {
      setEnhanceAnim(null);
      setEnhancing(false);
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }

  // Show the corner "Enhance" pill whenever the input holds text — it stays put
  // (no debounce) and only hides when the box is empty. Shows even while the agent
  // is running, so a queued follow-up draft can be enhanced too: enhancePrompt is
  // a standalone one-shot call, independent of the agent loop. Still skipped mid-
  // enhance, with a menu open, or when the draft is already the current
  // enhancement (nothing left to improve).
  useEffect(() => {
    if (enhancing || !hydrated) return setEnhanceHintVisible(false);
    if (input.trim().length === 0) return setEnhanceHintVisible(false);
    if (slashOpen || mentionOpen) return setEnhanceHintVisible(false);
    // Never offer to rewrite a `/schedule` draft: the enhancer rewrites prose
    // and would happily mangle the `| 15m` argument tail into something the
    // parser rejects.
    if (scheduleDraft) return setEnhanceHintVisible(false);
    if (enhancement && enhancement.plain === input) return setEnhanceHintVisible(false);
    setEnhanceHintVisible(true);
  }, [input, enhancing, hydrated, slashOpen, mentionOpen, scheduleDraft, enhancement]);

  // Both typed `@Ken` prompts and composer quick actions use this path so Ken's
  // transcript identity and transport stay identical. Quick actions opt out of
  // clearing composer state, preserving the user's in-progress work.
  function sendToKen(question: string, addressedText: string, preserveComposer = false): void {
    const trimmedQuestion = question.trim();
    const trimmedAddressedText = addressedText.trim();
    if (!readyRef.current || planReview !== null || !trimmedQuestion || !trimmedAddressedText) {
      return;
    }

    recordHistory(trimmedAddressedText);
    stickToBottomRef.current = true;
    pushItem({ kind: "user", id: nextId(), text: trimmedAddressedText, ken: true });
    if (!preserveComposer) {
      setInput("");
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
    }
    void sendKenPrompt(trimmedQuestion);
  }

  // Submit the current input together with any staged attachments. Images are
  // echoed inline in the user's bubble; all media is sent to the agent.
  function submit(): void {
    const trimmed = input.trim();
    const typedAsk = typingAskRef.current;
    if (typedAsk && trimmed) {
      typingAskRef.current = null;
      setInput("");
      setSlashIndex(0);
      handleAskAnswer(typedAsk.itemId, typedAsk.promptId, { [typedAsk.questionId]: trimmed });
      return;
    }
    if (!readyRef.current || planReview !== null) return;
    if (!trimmed && attachments.length === 0 && mentionedPaths.length === 0) return;
    const noInputError = noInputSlashSubmissionError(
      input,
      commands,
      attachments.length,
      mentionedPaths.length,
    );
    if (noInputError) {
      const match = slashCommandForInput(input, commands);
      if (match?.args && match.command.input.text === "none") {
        setInput(`/${match.command.name}`);
      }
      if (match?.command.input.references === "none") {
        setMention(null);
        setMentionedPaths([]);
      }
      if (match?.command.input.attachments === "none") setAttachments([]);
      pushItem({
        kind: "error",
        id: nextId(),
        headline: "Command input blocked",
        guidance: noInputError,
      });
      return;
    }

    // `/schedule` registers a recurring prompt instead of sending anything now.
    // An invalid draft is refused outright — sending it would run the raw command
    // text as a prompt — and the hint above the composer already says why.
    if (isScheduleDraft(input)) {
      const result = parseScheduleCommand(input);
      if (!result.ok) return;
      addSchedule(result.value);
      // Confirm in the transcript, otherwise pressing Enter looks like it did
      // nothing: the first run is a whole interval away, so there is no other
      // feedback until then.
      pushItem({
        kind: "user",
        id: nextId(),
        text: trimmed,
        command: true,
        label: `Scheduled · ${describeSchedule(result.value)}`,
      });
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      setInput("");
      setSlashIndex(0);
      return;
    }

    // `@Ken <prompt>` (case-insensitive, optional colon) routes to Ken Kai, the
    // read-only mentor agent — NOT GG Coder. Ken runs concurrently with any
    // build run; his reply streams into a magenta bubble via ken_* events.
    const kenMatch = workspaceMode === "code" ? /^@(ken|supah)\b:?\s*/i.exec(trimmed) : null;
    if (kenMatch) {
      const question = trimmed.slice(kenMatch[0].length).trim();
      sendToKen(question, trimmed);
      return;
    }

    recordHistory(trimmed);
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    // Referenced files are appended to the prompt as a small block so the agent
    // knows which paths to read; they aren't shown in the user's bubble text.
    const prompt =
      mentionedPaths.length > 0 ? appendReferencedFiles(trimmed, mentionedPaths) : trimmed;
    // Carry the enhancer's highlighted segments into the sent bubble ONLY when
    // the message is the unedited enhanced text (the bubble shows `trimmed`).
    const sentEnhancements =
      enhancement && enhancement.plain === trimmed ? enhancement.segments : undefined;
    const reportPromptFailure = (error: unknown) => {
      pushItem({
        kind: "error",
        id: nextId(),
        headline: "Prompt wasn’t sent",
        message: error instanceof Error ? error.message : String(error),
        guidance: "Retry your prompt.",
      });
    };
    // While a run is in flight, the message is QUEUED as steering (the sidecar
    // injects it mid-loop). Attachments queue too — they're persisted and ride
    // the same native-block path when the queue drains. Queued rows render
    // dimmed until run_end clears the flag.
    if (running) {
      const supersedesQuestion = hasOpenAsk();
      if (supersedesQuestion) {
        dismissOpenAsks();
        noteSupersedingSend(prompt);
      }
      const queuedWire = attachments.map(toWire);
      const queuedImgs = attachments.filter((a) => a.previewUrl).map((a) => a.previewUrl!);
      pushItem({
        kind: "user",
        id: nextId(),
        text: trimmed,
        command: isWorkflowCommand(trimmed),
        images: queuedImgs.length > 0 ? queuedImgs : undefined,
        files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
        enhancements: sentEnhancements,
        queued: showsQueuedBubble("queue", supersedesQuestion),
      });
      setInput("");
      setAttachments([]);
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
      void sendPrompt(
        prompt,
        queuedWire,
        sentEnhancements ? { enhancements: sentEnhancements } : undefined,
      ).catch(reportPromptFailure);
      return;
    }
    const wire = attachments.map(toWire);
    const imgPreviews = attachments.filter((a) => a.previewUrl).map((a) => a.previewUrl!);
    pushItem({
      kind: "user",
      id: nextId(),
      text: trimmed,
      command: isWorkflowCommand(trimmed),
      images: imgPreviews.length > 0 ? imgPreviews : undefined,
      files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
      enhancements: sentEnhancements,
    });
    // Warn the user when a video attachment is sent to a model without native
    // video analysis — the agent can still use ffmpeg to extract frames/audio,
    // but can't watch the clip directly.
    if (wire.some((a) => a.kind === "video") && !(state?.supportsVideo ?? false)) {
      pushItem({
        kind: "info",
        id: nextId(),
        text: VIDEO_CAPABILITY_WARNING,
      });
    }
    setInput("");
    setAttachments([]);
    setSlashIndex(0);
    setMention(null);
    setMentionedPaths([]);
    setEnhancement(null);
    endStreamingText();
    void sendPrompt(prompt, wire, sentEnhancements ? { enhancements: sentEnhancements } : undefined)
      .then((submission) => {
        if (!submission.queued) planResumePromptRef.current = prompt;
      })
      .catch(reportPromptFailure);
  }

  // ── Attachment intake (paste / attach button / whole-window drag-drop) ──
  async function addFiles(files: FileList | File[]): Promise<void> {
    if (noAttachmentSlashCommandRef.current) return;
    const list = Array.from(files);
    const pendings = await Promise.all(list.map((file) => fileToPending(file).catch(() => null)));
    const ok = pendings.filter((pending): pending is PendingAttachment => pending !== null);
    if (ok.length > 0 && !noAttachmentSlashCommandRef.current) {
      setAttachments((previous) => [...previous, ...ok]);
    }
  }

  // Native Tauri drop events hand us absolute paths, not browser File objects
  // (macOS/Linux keep the native drag-drop handler enabled so folder drops can
  // report a path at all — see build_app_window). Non-directory paths are read
  // here and staged exactly like a picked/pasted file.
  async function addNativeDroppedFiles(paths: string[]): Promise<void> {
    if (paths.length === 0 || noAttachmentSlashCommandRef.current) return;
    const results = await Promise.all(paths.map((path) => readDroppedFileAttachment(path)));
    const ok = results
      .filter((attachment): attachment is Attachment => attachment !== null)
      .map((attachment) => attachmentToPending(attachment));
    if (ok.length > 0 && !noAttachmentSlashCommandRef.current) {
      setAttachments((previous) => [...previous, ...ok]);
    }
  }

  function handleWindowDragEnter(e: React.DragEvent<HTMLDivElement>): void {
    if (
      noAttachmentSlashCommandRef.current ||
      !hasDraggedFiles(e.dataTransfer) ||
      !canHandleWindowFileDrop()
    )
      return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleWindowDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (
      noAttachmentSlashCommandRef.current ||
      !hasDraggedFiles(e.dataTransfer) ||
      !canHandleWindowFileDrop()
    )
      return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleWindowDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    const nextTarget = e.relatedTarget;
    if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
    setIsFileDragOver(false);
  }

  function handleWindowDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    setIsFileDragOver(false);
    if (noAttachmentSlashCommandRef.current || !canHandleWindowFileDrop()) return;
    const files = filesForAttachment(e.dataTransfer);
    if (files.length > 0) void addFiles(files);
  }

  function removeAttachment(id: number): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  // ── Durable plan review actions ──

  function recoverPlanMutation(error: unknown, fallback: string): void {
    if (error instanceof PlanMutationError && error.pendingPlanReview !== undefined) {
      replacePlanReview(error.pendingPlanReview);
    }
    toast(error instanceof PlanMutationError ? error.message : fallback, "error", 7_000);
  }

  async function acceptPlan(): Promise<void> {
    // Capture the approved plan's step count BEFORE the IPC — accepting starts a
    // fresh session on the sidecar, whose session_reset broadcast nulls
    // planReview (and clears the transcript + counters) here.
    const nextPlanTotal = planReview ? countPlanSteps(planReview.content) : 0;
    // Stash a fallback for older sidecars. The current sidecar puts its canonical
    // live-file count directly on session_reset, which wins over this snapshot.
    pendingPlanTotalRef.current = nextPlanTotal;
    // Accept the plan: the sidecar wipes the planning conversation into a FRESH
    // session (so the build doesn't carry all the plan-mode research), bakes the
    // approved plan into the new system prompt, and broadcasts authoritative
    // progress before this request resolves. Do not re-seed from stale modal
    // content after the await: the plan file may already have changed.
    setPlanGateBusy(true);
    try {
      if (!planReview) return;
      await acceptPlanIPC(planReview.checkpointId, planReview.generation);
      planResumePromptRef.current = null;
      replacePlanReview(null);
      pushItem({ kind: "info", id: nextId(), text: "\u2713 Plan accepted. Resuming." });
    } catch (error) {
      pendingPlanTotalRef.current = null;
      recoverPlanMutation(error, "Couldn’t approve the plan. The approval gate is still open.");
    } finally {
      setPlanGateBusy(false);
    }
  }

  async function sendPlanFeedback(feedback: string): Promise<void> {
    if (!planReview) return;
    setPlanGateBusy(true);
    try {
      await revisePlanIPC(planReview.checkpointId, planReview.generation, feedback);
      setPlanReview((current) =>
        current ? { ...current, state: "revision-requested", feedback } : current,
      );
      pushItem({ kind: "info", id: nextId(), text: "✎ Feedback sent. Revising the plan." });
    } catch (error) {
      recoverPlanMutation(error, "Couldn’t request revision. The approval gate is still open.");
    } finally {
      setPlanGateBusy(false);
    }
  }

  async function retryPlanRevision(): Promise<void> {
    if (!planReview || planReview.state !== "revision-requested" || !planReview.feedback) return;
    setPlanGateBusy(true);
    try {
      await revisePlanIPC(planReview.checkpointId, planReview.generation, planReview.feedback);
      pushItem({ kind: "info", id: nextId(), text: "↻ Revision retry started." });
    } catch (error) {
      recoverPlanMutation(
        error,
        "Couldn’t retry revision. The persisted request is still available.",
      );
    } finally {
      setPlanGateBusy(false);
    }
  }

  // The toolbar and Ken prompt actions share the same correlated reset path.
  async function startNewSession(): Promise<void> {
    try {
      await createAuthoritativeNewSession();
      setConfirmNewSession(false);
    } catch (error) {
      if (error instanceof LocalSessionMutationBusyError) {
        toast(error.message, "error", 7_000);
        return;
      }
      if (error instanceof NewSessionError && error.kind === "creation-rejected") {
        toast(
          "Couldn’t create a new session. The current session is unchanged; try again.",
          "error",
        );
        return;
      }
      // An ambiguous outcome must not offer a blind retry against an unknown session.
      setConfirmNewSession(false);
      toast(AMBIGUOUS_NEW_SESSION_MESSAGE, "error", 7_000);
    }
  }

  // Re-point this window at a freshly chosen project: clear the old transcript
  // and force a re-hydrate against the new sidecar. Bumping the nonce re-runs
  // the hydrate effect even when needsProject is already false (switching
  // sessions from the reopened picker), which flipping the boolean alone won't.
  function onProjectChosen(): void {
    stickToBottomRef.current = true;
    setItems([]);
    setLiveToolFeed([]);
    setState(null);
    setTasks([]);
    setContextTokens(0);
    setTokens(0);
    setDoneStatus(null);
    setPlanReview(null);
    planTotalRef.current = 0;
    planDoneRef.current = new Set();
    setPlanTotal(0);
    setPlanDone(new Set());
    setAttachments([]);
    setQueuedCount(0);
    setQueuedMessages([]);
    setHydrated(false);
    setNeedsProject(false);
    setHydrateNonce((n) => n + 1);
  }

  const bindPickerProject = useCallback(
    async (cwd: string, sessionPath?: string): Promise<number> => {
      const nextGeneration = await client.selectWorkspace(
        { mode: "code", cwd, sessionPath: sessionPath ?? null },
        generationRef.current ?? 0,
      );
      adoptGeneration(nextGeneration);
      return nextGeneration;
    },
    [adoptGeneration, client],
  );
  const bindPickerChat = useCallback(
    async (
      cwd: string,
      sessionPath: string | undefined,
      chatAgent: ChatAgentId,
    ): Promise<number> => {
      const nextGeneration = await client.selectWorkspace(
        { mode: "chat", cwd, sessionPath: sessionPath ?? null, chatAgent },
        generationRef.current ?? 0,
      );
      adoptGeneration(nextGeneration);
      return nextGeneration;
    },
    [adoptGeneration, client],
  );
  const handlePickerChosen = useCallback((): void => {
    onUserTargetChange?.();
    onProjectChosen();
  }, [onUserTargetChange]);

  const startRoadmapPhase = useCallback(
    async (phaseId: string): Promise<PhaseStartResult> => {
      if (state?.mode !== "code") {
        return {
          status: "failed",
          code: "coding-mode-required",
          operationId: null,
          message: "Roadmap phases can only start in coding mode.",
        };
      }
      if (running || autopilotReviewing || newSessionBusy) {
        return {
          status: "failed",
          code: "session-busy",
          operationId: null,
          message: "Wait for the current run or Autopilot review to finish.",
        };
      }
      return client.startPhase(phaseId);
    },
    [autopilotReviewing, client, newSessionBusy, running, state?.mode],
  );

  const resumeRoadmapPhase = useCallback(
    async (phaseId: string, link: NotesSessionLink): Promise<void> => {
      if (running || autopilotReviewing || newSessionBusy) {
        throw new Error("Wait for the current run or Autopilot review to finish.");
      }
      const currentCwd = stateRef.current?.cwd;
      if (!currentCwd) throw new Error("The project session is not ready.");
      const resolution = await resolveRoadmapPhaseResumeFromNotes(client, phaseId, link);
      if (resolution.status === "blocked") throw new Error(resolution.message);
      link = resolution.session;
      if (link.sessionPath === null) {
        const recovered = await startRoadmapPhase(phaseId);
        if (recovered.status === "failed") throw new Error(recovered.message);
        if (recovered.status === "accepted") return;
        link = recovered.session;
      }
      if (link.sessionPath === null) {
        throw new Error("This phase has no resumable session file.");
      }
      const nextGeneration = await client.selectWorkspace(
        { mode: "code", cwd: currentCwd, sessionPath: link.sessionPath },
        generationRef.current ?? 0,
      );
      adoptGeneration(nextGeneration);
      // onProjectChosen owns the single readiness + hydration pass for this session.
      onProjectChosen();
    },
    [adoptGeneration, autopilotReviewing, client, newSessionBusy, running, startRoadmapPhase],
  );

  useEffect(() => {
    onSnapshot?.({
      paneId,
      generation: generationRef.current ?? null,
      mode: state?.mode ?? target?.mode ?? workspaceMode,
      chatAgent: state?.chatAgent ?? target?.chatAgent,
      cwd: state?.cwd ?? target?.cwd ?? null,
      sessionPath: state?.sessionPath ?? target?.sessionPath ?? null,
      sessionTitle: formatWorkspaceTitle(
        state?.cwd,
        state?.gitBranch,
        workspaceMode === "chat" ? "GG Chat" : PRODUCT_DISPLAY_NAME,
        state?.gitDirtyFileCount,
      ),
      projectBound: !needsProject && Boolean(state?.cwd ?? target?.cwd),
      restoreChecked,
      activeWork: running || autopilotReviewing,
    });
  }, [
    autopilotReviewing,
    needsProject,
    paneId,
    props.generation,
    onSnapshot,
    restoreChecked,
    running,
    state?.chatAgent,
    state?.cwd,
    state?.gitBranch,
    state?.gitDirtyFileCount,
    state?.mode,
    state?.sessionPath,
    target?.chatAgent,
    target?.cwd,
    target?.mode,
    target?.sessionPath,
    workspaceMode,
  ]);

  useEffect(() => {
    registerInput?.(paneId, {
      focus: () => inputRef.current?.focus(),
      setNativeFileDragOver: (dragging) => {
        setIsFileDragOver(dragging && canHandleWindowFileDrop());
      },
      handleNativeDrop: (paths) => {
        if (!canHandleWindowFileDrop() || paths.length === 0) return;
        setIsFileDragOver(false);
        void getDroppedPathInfo(paths).then((infos) => {
          insertDroppedFolderPaths(infos.filter((info) => info.isDir).map((info) => info.path));
          const filePaths = infos.filter((info) => !info.isDir).map((info) => info.path);
          if (filePaths.length > 0) void addNativeDroppedFiles(filePaths);
        });
      },
    });
    return () => registerInput?.(paneId, null);
  }, [insertDroppedFolderPaths, paneId, registerInput]);

  // Show explicit recovery feedback while Rust resolves this window's durable
  // target. This branch used to paint only the dark background, which looked
  // indistinguishable from a dead/black webview during a slow recovery.
  if (needsProject && !restoreChecked) {
    return (
      <div className="app app-restoring" style={{ background: theme.background }}>
        <div className="app-restoring-status" role="status" aria-live="polite">
          <span className="app-restoring-dot" aria-hidden="true" />
          Restoring workspace…
        </div>
      </div>
    );
  }

  if (needsProject) {
    return (
      <div className="app" style={{ background: theme.background }}>
        {entryView === "home" ? (
          <HomeScreen
            onProjects={() => {
              setWorkspaceMode("code");
              setEntryView("projects");
            }}
            onChat={() => {
              setWorkspaceMode("chat");
              setEntryView("chats");
            }}
            onLogin={() => setEntryView("login")}
            refreshSignal={homeRefreshSignal}
            waitForAgentReady={catalogClient.waitForReady}
            loadProgress={catalogClient.getProgress}
            mcpClient={client}
          />
        ) : entryView === "login" ? (
          <LoginScreen onClose={() => setEntryView("home")} />
        ) : entryView === "chats" ? (
          <ChatPicker
            onChosen={handlePickerChosen}
            onClose={() => setEntryView("home")}
            waitForCatalogReady={catalogClient.waitForReady}
            discoverSessions={catalogClient.listSessions}
            bindChat={bindPickerChat}
            showWindowControls={kind === "primary"}
          />
        ) : (
          <ProjectPicker
            onChosen={handlePickerChosen}
            waitForCatalogReady={catalogClient.waitForReady}
            discoverProjects={catalogClient.listProjects}
            discoverSessions={catalogClient.listSessions}
            bindProject={bindPickerProject}
            refreshSignal={homeRefreshSignal}
            showWindowControls={kind === "primary"}
            onClose={() => setEntryView("home")}
          />
        )}
        {showTraySettings && <SettingsModal onClose={closeTraySettings} />}
        <Toaster />
      </div>
    );
  }

  // Picker reopened over an already-open workspace. Back from the picker returns
  // to the home screen; choosing a session resets and re-hydrates this window.
  if (showPicker) {
    const pickerProps = {
      onChosen: () => {
        setShowPicker(false);
        handlePickerChosen();
      },
      onClose: () => {
        setShowPicker(false);
        setNeedsProject(true);
        setEntryView("home" as const);
      },
      waitForCatalogReady: catalogClient.waitForReady,
      discoverSessions: catalogClient.listSessions,
      refreshSignal: homeRefreshSignal,
      showWindowControls: kind === "primary",
    };
    return (
      <div className="app" style={{ background: theme.background }}>
        {workspaceMode === "chat" ? (
          <ChatPicker
            initialAgent={state?.chatAgent ?? "general"}
            bindChat={bindPickerChat}
            {...pickerProps}
          />
        ) : (
          <ProjectPicker
            initialProjectPath={state?.cwd ?? null}
            discoverProjects={catalogClient.listProjects}
            bindProject={bindPickerProject}
            {...pickerProps}
          />
        )}
        {showTraySettings && <SettingsModal onClose={closeTraySettings} />}
      </div>
    );
  }

  const roadmapDraftTrigger = roadmapDraftState.draft ? (
    <button
      type="button"
      className="btn btn-sm btn-ghost roadmap-draft-trigger"
      onClick={() => dispatchRoadmapDraft({ type: "open" })}
      title="Review pending Roadmap draft"
      aria-label={`Review Roadmap draft with ${roadmapDraftState.draft.phases.length} proposed ${roadmapDraftState.draft.phases.length === 1 ? "phase" : "phases"}`}
      aria-haspopup="dialog"
    >
      <GitBranch size={13} aria-hidden="true" />
      <span>Review draft</span>
      <span className="roadmap-draft-trigger-count" aria-hidden="true">
        {roadmapDraftState.draft.phases.length}
      </span>
    </button>
  ) : null;

  return (
    <div
      className={`app agent-pane${props.focused !== false ? " pane-focused" : ""}${isFileDragOver ? " app-file-dragover" : ""}${windowFocused && props.windowFocused !== false ? " window-focused" : ""}`}
      data-glow={glowState}
      style={{ background: theme.background, ...glowStyle }}
      onPointerDown={() => props.onFocus?.(paneId)}
      onDragEnter={handleWindowDragEnter}
      onDragOver={handleWindowDragOver}
      onDragLeave={handleWindowDragLeave}
      onDrop={handleWindowDrop}
    >
      {confettiNonce && <Confetti key={confettiNonce} />}

      <WorkspaceHeader
        workspaceMode={workspaceMode}
        cwd={state?.cwd}
        gitBranch={state?.gitBranch}
        gitDirtyFileCount={state?.gitDirtyFileCount}
        gitHubIssues={state?.gitHubIssues}
        gitHubPRs={state?.gitHubPRs}
        gitHubRepoUrl={state?.gitHubRepoUrl}
        additionalRoots={state?.additionalRoots}
        navHidden={navHidden}
        onToggleNav={toggleNav}
        stripExtras={
          <>
            <TitleUsageMeter currentProvider={state?.provider ?? ""} />
            {windowTotal > 1 && windowIndex !== null && (
              <span
                className={`window-index${isThisFocused ? "" : " dim"}`}
                data-tauri-drag-region
                title={`Window ${windowIndex} of ${windowTotal} · ⌘\` to cycle`}
              >
                {windowIndex}/{windowTotal}
              </span>
            )}
          </>
        }
      >
        <BackButton
          label={workspaceMode === "chat" ? "Back to chats" : "Back to this project's sessions"}
          onClick={() => setShowPicker(true)}
        />
        <div className="rank-badge-wrap">
          <RankBadge
            snapshot={progress}
            celebrateNonce={rankCelebrateNonce}
            onClick={() => setShowScorecard(true)}
          />
          <div className="rank-xp-chip-layer" aria-hidden="true">
            {xpChips.map((chip) => (
              <span className="rank-xp-chip" key={chip.id}>
                {chip.label}
              </span>
            ))}
          </div>
        </div>
        {workspaceMode === "chat" ? (
          <span className="picker-head-actions">
            {roadmapDraftTrigger}
            <button
              className="btn btn-primary btn-sm"
              disabled={running || autopilotReviewing || newSessionBusy}
              title="Start a new chat"
              onClick={() => setConfirmNewSession(true)}
            >
              {"+ New"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="View and curate chat memories and Jiwa"
              onClick={() => setShowMemories(true)}
            >
              Brain
            </button>
            <RadioButton />
            <WindowLayoutButton />
          </span>
        ) : (
          <>
            <span className="picker-head-actions">
              <AutopilotToggle
                checked={state?.autopilot ?? false}
                disabled={running || autopilotReviewing}
                onChange={(next) => {
                  setState((s) => (s ? { ...s, autopilot: next } : s));
                  void setAutopilot(next);
                  setKenPowerBanner(next ? "on" : "off");
                  // The upstream sound set no longer ships dedicated autopilot assets.
                  playSound(next ? "done" : "click");
                }}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={running || autopilotReviewing || newSessionBusy}
                title="Start a new session for this project"
                onClick={() => setConfirmNewSession(true)}
              >
                {"+ New"}
              </button>
              <ProjectNotes
                ref={projectNotesActionsRef}
                cwd={state?.cwd ?? null}
                client={client}
                onStartPhase={startRoadmapPhase}
                onStartNextPhase={(checkpointId, nextPhaseId) =>
                  client.startNextPhase(checkpointId, nextPhaseId)
                }
                commands={commands}
                onRunCommand={(invocation) => submitText(invocation)}
                onCancelPhase={(phaseId) => client.cancelPhaseRun(phaseId)}
                onResumePhase={resumeRoadmapPhase}
                phaseStartUnavailableReason={
                  state?.mode === "code" ? null : "Roadmap phases can only start in coding mode."
                }
                phaseActionDisabled={
                  running || autopilotReviewing || newSessionBusy || planReview !== null
                }
                paneFocused={props.focused !== false}
                windowFocused={windowFocused && props.windowFocused !== false}
              />
              {roadmapDraftTrigger}
              <button
                className="btn btn-sm btn-ghost"
                title="View and run this project's tasks"
                onClick={openTasks}
              >
                {projectTasks.some((t) => t.status !== "done")
                  ? `Tasks (${projectTasks.filter((t) => t.status !== "done").length})`
                  : "Tasks"}
              </button>
              <RadioButton />
              {/* <GazeButton /> */}
              <WindowLayoutButton
                onArrange={() => {
                  setNavHiddenPersisted(true);
                  setToolsHiddenPersisted(true);
                }}
              />
              {needsGitInit ? (
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={running}
                  title="Initialize git + create a GitHub repository"
                  onClick={() => setShowInitGit(true)}
                >
                  {"Initialize Git"}
                </button>
              ) : (
                commitCommand && (
                  <button
                    className={`btn btn-sm ${hasCommit ? "btn-success" : "btn-ghost"}`}
                    disabled={running || planReview !== null}
                    title={
                      planReview !== null
                        ? "Approve or dismiss the pending plan first"
                        : hasCommit
                          ? "Run /commit"
                          : "Generate a /commit command"
                    }
                    onClick={() =>
                      submitText(
                        `/${commitCommand}`,
                        hasCommit ? "Committing\u2026" : "Setting up commits\u2026",
                      )
                    }
                  >
                    {`/${commitCommand}`}
                  </button>
                )
              )}
            </span>
          </>
        )}
      </WorkspaceHeader>

      {/* Non-scrolling frame the same size as the chat viewport. The banner
          lives HERE, not inside `.transcript` — `.transcript` scrolls, and an
          absolutely positioned child of a scrolling container is pinned to the
          top of the scrolled CONTENT, not the visible viewport, so in an
          existing session scrolled down it rendered far above what's on
          screen. Anchoring to this non-scrolling sibling keeps it pinned to
          what the user is actually looking at, at any scroll position. */}
      <div
        className="transcript-frame"
        onMouseEnter={() => setChatHovered(true)}
        onMouseLeave={() => setChatHovered(false)}
      >
        {workspaceMode === "code" && kenPowerBanner && (
          <KenPowerBanner mode={kenPowerBanner} onDone={() => setKenPowerBanner(null)} />
        )}
        <div className="transcript" ref={scrollRef} onScroll={onTranscriptScroll}>
          {!hydrated && items.length === 0 ? (
            <TranscriptSkeleton />
          ) : (
            <>
              {items.length === 0 &&
                (status === "ready" ? (
                  <WakeScreen chat={workspaceMode === "chat"} />
                ) : (
                  <div className="line transcript-reveal" style={{ color: theme.textDim }}>
                    {`\u273b ${status}`}
                  </div>
                ))}
              <KenPromptActionProvider value={kenPromptDispatcher}>
                {items.map((it) =>
                  createElement(TranscriptRow, {
                    key: it.id,
                    item: it,
                    onImageLoad: maybeScrollToBottom,
                    onAskAnswer: handleAskAnswer,
                    onAskType: handleAskType,
                  }),
                )}
              </KenPromptActionProvider>
              {workspaceMode === "code" && planReview !== null && (
                <PlanReviewModal
                  content={planReview.content}
                  kenReviewing={autopilotReviewing}
                  kenReady={planReview.reviewStatus === "ready"}
                  revisionPending={planReview.state === "revision-requested"}
                  revisionRunning={running}
                  busy={planGateBusy}
                  onAccept={() => void acceptPlan()}
                  onFeedback={(feedback) => void sendPlanFeedback(feedback)}
                  onRetryRevision={() => void retryPlanRevision()}
                />
              )}
            </>
          )}
        </div>
        {items.length > 0 && (
          <ExportChatButton
            visible={chatHovered || exporting}
            busy={exporting}
            onExport={() => void exportTranscript()}
          />
        )}
      </div>

      <div className="liveregion">
        {workspaceMode === "code" && autopilotReviewing && (
          <AutopilotReviewBar onCancel={requestCancel} />
        )}
        {workspaceMode === "code" && kenRunning && (
          <KenActivityBar
            runStartTs={kenRunStartTs}
            tokens={kenTokens}
            isThinking={kenIsThinking}
            thinkingStartTs={kenThinkingStartTs}
            thinkingAccumMs={kenThinkingAccumMs}
            onCancel={() => void cancelKen()}
          />
        )}
        {!toolsHidden && <LiveToolPanel entries={liveToolFeed} />}
        {/* Ken's bar (chat OR autopilot review) REPLACES the main bar while the
            build is idle — otherwise the idle "Ready for work" line stacks under
            Ken's spinner. When the build is also running, both bars show. */}
        {(workspaceMode === "chat" || running || (!kenRunning && !autopilotReviewing)) && (
          <ActivityBar
            running={running}
            cancelling={cancelling}
            tokens={tokens}
            doneStatus={doneStatus}
            isThinking={isThinking}
            thinkingStartTs={thinkingStartTs}
            thinkingAccumMs={thinkingAccumMs}
            planTotal={workspaceMode === "chat" ? 0 : planTotal}
            planDone={workspaceMode === "chat" ? 0 : Math.min(planDone.size, planTotal)}
            onCancel={requestCancel}
            toolsHidden={toolsHidden}
            hasToolFeed={liveToolFeed.length > 0}
            onToggleTools={toggleTools}
          />
        )}
      </div>

      <div
        className={`inputwrap${isFileDragOver ? " dragover" : ""}${
          scheduleInvalid ? " schedule-invalid" : ""
        }`}
      >
        {scheduleDraft ? (
          <ScheduleHint input={input} caret={caret} onPickInterval={fillScheduleInterval} />
        ) : (
          slashOpen && (
            <SlashMenu
              commands={slashMatches}
              activeIndex={clampedSlashIndex}
              onSelect={pickSlashCommand}
              onHover={setSlashIndex}
            />
          )
        )}
        {mentionOpen && !noReferenceSlashCommand && (
          <FileMentionMenu
            files={fileMatches}
            activeIndex={clampedFileIndex}
            isRecent={mention?.query === ""}
            onSelect={pickMentionFile}
            onHover={setFileIndex}
          />
        )}
        <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
        <ReferencedFiles paths={mentionedPaths} onRemove={removeMentionChip} />
        <QueuedBar messages={visibleQueuedMessages} onCancel={handleCancelQueued} />
        <div className="inputrow">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            disabled={planReview !== null || noAttachmentSlashCommand !== null}
            style={{ display: "none" }}
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            className="icon-circle"
            aria-label="Attach files"
            title={
              noAttachmentSlashCommand
                ? `/${noAttachmentSlashCommand.name} does not accept attachments`
                : planReview !== null
                  ? "Resolve the pending plan first"
                  : "Attach files"
            }
            disabled={planReview !== null || noAttachmentSlashCommand !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={15} strokeWidth={1.8} />
          </button>
          <div className="input-stack">
            {enhanceAnim && (
              <EnhanceDissolve
                oldText={enhanceAnim.oldText}
                newText={enhanceAnim.newText}
                onDone={onEnhanceAnimDone}
              />
            )}
            {/* `@Ken` active: a textarea can't color just one token, so we mirror
                the input in an aligned overlay where the leading `@Ken` shimmers
                in Ken's color. The textarea text below is made transparent (caret
                stays visible) so only this styled copy shows. Metrics match
                `.input` 1:1 so wrapping/caret line up. */}
            {kenActive && kenInputParts && (
              <div className="ken-input-highlight" aria-hidden="true">
                {kenInputParts.lead}
                <ShimmerText base={theme.ken} bright="#ffffff">
                  {kenInputParts.token}
                </ShimmerText>
                {kenInputParts.rest}
              </div>
            )}
            <textarea
              ref={attachInput}
              className={`input${enhanceAnim ? " input-anim" : ""}${kenActive ? " input-ken" : ""}`}
              rows={1}
              // No-input commands stay keyboard-submittable while preventing edits.
              readOnly={enhanceAnim !== null || noInputSlashCommand !== null}
              disabled={planReview !== null}
              title={
                noInputSlashCommand
                  ? `Send /${noInputSlashCommand.name} as-is; it accepts no added input`
                  : undefined
              }
              value={input}
              placeholder={
                planReview !== null
                  ? "Approve or dismiss the pending plan to continue…"
                  : workspaceMode === "chat"
                    ? "Ask anything…"
                    : displayPlaceholder
              }
              onPaste={(event) => {
                if (noInputSlashCommandRef.current) {
                  event.preventDefault();
                  return;
                }
                const files = Array.from(event.clipboardData.files);
                if (files.length === 0) return;
                event.preventDefault();
                if (!noAttachmentSlashCommandRef.current) void addFiles(files);
              }}
              onChange={(event) => {
                if (noInputSlashCommandRef.current) return;
                setInput(event.target.value);
                setSlashIndex(0);
                setCaret(event.target.selectionStart ?? event.target.value.length);
                // Typing exits history-recall mode so ↑/↓ start fresh next time.
                if (historyIndex !== null) setHistoryIndex(null);
                // Drop the enhancement the instant the text diverges from it, so
                // the highlighted preview/bubble never misalign with edited text.
                if (enhancement && event.target.value !== enhancement.plain) setEnhancement(null);
                updateMention(
                  event.target.value,
                  event.target.selectionStart ?? event.target.value.length,
                );
              }}
              onClick={(e) => {
                const el = e.currentTarget;
                setCaret(el.selectionStart ?? el.value.length);
                updateMention(el.value, el.selectionStart ?? el.value.length);
              }}
              onKeyUp={(e) => {
                const el = e.currentTarget;
                setCaret(el.selectionStart ?? el.value.length);
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  updateMention(el.value, el.selectionStart ?? el.value.length);
                }
              }}
              onKeyDown={(e) => {
                // While the dissolve→decode animation plays the input is locked;
                // swallow keys so Enter can't submit the un-enhanced draft.
                if (enhanceAnim) {
                  e.preventDefault();
                  return;
                }
                if (mentionOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setFileIndex((i) => (i + delta + fileMatches.length) % fileMatches.length);
                } else if (mentionOpen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                  e.preventDefault();
                  const file = fileMatches[clampedFileIndex];
                  if (file) pickMentionFile(file);
                } else if (mentionOpen && e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                } else if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex((i) => (i + delta + slashMatches.length) % slashMatches.length);
                } else if (slashOpen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                  e.preventDefault();
                  const cmd = slashMatches[clampedSlashIndex];
                  if (cmd) pickSlashCommand(cmd);
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  // Menus are closed here (handled above), so arrows recall sent
                  // prompts shell-style — unless the caret is mid-text in a
                  // multi-line draft, where navigateHistory declines and the
                  // cursor moves normally.
                  if (navigateHistory(e.key === "ArrowUp" ? -1 : 1, e.currentTarget)) {
                    e.preventDefault();
                  }
                } else if (e.key === "Enter" && !e.shiftKey) {
                  // Enter sends; Shift+Enter inserts a newline (textarea default).
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  // Cancel the build if it's running; otherwise cancel Ken so the
                  // "esc to cancel" on his bar actually works.
                  if (slashOpen) setInput("");
                  else if (running && !cancelling) requestCancel();
                  else if (kenRunning) void cancelKen();
                }
              }}
              autoFocus
            />
          </div>
          {workspaceMode === "code" && (
            <button
              type="button"
              className="ken-next-pill"
              title={
                planReview !== null
                  ? "Resolve the pending plan first"
                  : kenRunning
                    ? "Ken is already running"
                    : "Ask Ken what to do next"
              }
              disabled={kenRunning || planReview !== null}
              onClick={() => sendToKen("next?", "@Ken next?", true)}
            >
              Ken, next?
            </button>
          )}
          <div className="inputactions-trailing">
            <button
              type="button"
              className={`composer-send-icon${running ? " is-stop" : ""}`}
              aria-label={running ? "Stop response" : "Send message"}
              title={running ? (cancelling ? "Stopping…" : "Stop response") : "Send message"}
              disabled={
                running
                  ? cancelling
                  : !readyRef.current ||
                    planReview !== null ||
                    (!input.trim() && attachments.length === 0 && mentionedPaths.length === 0)
              }
              onClick={running ? requestCancel : submit}
            >
              {running ? <Square size={12} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
        {!enhanceAnim && (
          // Pill pinned to the center of the input box (.inputwrap) top border,
          // overlapping it. Decoupled from text flow, so it never overlaps text,
          // drifts, or shifts the caret/height; centered (not in a corner) to
          // stay clear of the status row's "esc to cancel". Always mounted (so it
          // can transition both ways); the `visible` class fades/slides it in
          // when there's text and out when there isn't.
          <button
            className={`enhance-pill${enhanceHintVisible ? " visible" : ""}${enhancing ? " enhancing" : ""}`}
            title="Enhance prompt — clearer wording + correct terms"
            disabled={planReview !== null || enhancing || !enhanceHintVisible}
            aria-hidden={!enhanceHintVisible}
            onClick={() => void runEnhance()}
          >
            {enhancing ? "Enhancing…" : "Enhance?"}
          </button>
        )}
      </div>

      <div
        className={`footer${workspaceMode === "chat" ? " footer-chat" : ""}`}
        style={{ color: theme.footerText }}
      >
        {!hydrated ? (
          <FooterSkeleton />
        ) : (
          <>
            {workspaceMode === "chat" ? (
              <span className="footer-left footer-reveal" style={{ color: theme.textDim }}>
                {state?.chatAgent === "therapist"
                  ? "Therapist Agent"
                  : state?.chatAgent === "research"
                    ? "Research Agent"
                    : "Brainstorm"}
              </span>
            ) : (
              <span className="footer-left footer-reveal">
                {BUILD_IDENTITY && (
                  <span className="footer-custom-build">{`◆ ${BUILD_IDENTITY}`}</span>
                )}
                {runningTaskCount > 0 && (
                  <>
                    {BUILD_IDENTITY && <FooterSep />}
                    <BackgroundTasksButton tasks={tasks} />
                  </>
                )}
                {schedules.length > 0 && (
                  <>
                    {(BUILD_IDENTITY || runningTaskCount > 0) && <FooterSep />}
                    <RunningSchedulesButton schedules={schedules} onStop={stopSchedule} />
                  </>
                )}
                {state?.planMode && (
                  <>
                    {(BUILD_IDENTITY || runningTaskCount > 0 || schedules.length > 0) && (
                      <FooterSep />
                    )}
                    <span className="footer-plan">
                      <ShimmerText base={theme.secondary} bright="#ddd6fe">
                        {"\u25C6 plan mode"}
                      </ShimmerText>
                    </span>
                  </>
                )}
              </span>
            )}
            <span className="footer-right footer-reveal">
              {contextPct > 0 && (
                <>
                  <ContextMeter pct={contextPct} />
                  <FooterSep />
                </>
              )}
              {(state?.supportedThinkingLevels?.length ?? 0) > 0 &&
                (() => {
                  const level = state?.thinkingLevel ?? null;
                  const label = level ? `Thinking ${level}` : "Thinking off";
                  const maxPower = level === "xhigh" || level === "max";
                  return (
                    <>
                      <button
                        className="thinking-toggle"
                        style={{
                          color: thinkingColor(level),
                          fontWeight: level === "high" ? 600 : 400,
                        }}
                        title="Cycle reasoning level"
                        onClick={() => void cycleThinking()}
                      >
                        {maxPower ? (
                          <ShimmerText base={MAX_POWER_COLOR} bright={MAX_POWER_SHIMMER}>
                            {label}
                          </ShimmerText>
                        ) : (
                          label
                        )}
                      </button>
                      <FooterSep />
                    </>
                  );
                })()}
              <span className="model-anchor">
                <span className="model-label" style={{ color: theme.text }}>
                  GG
                </span>
                <ModelSelect
                  key={`gg-models-${modelCatalogRefreshNonce}`}
                  models={models}
                  currentModel={state?.model ?? ""}
                  onSelect={onSelectModel}
                  disabled={running}
                  refreshNonce={modelCatalogRefreshNonce}
                  title={
                    workspaceMode === "chat"
                      ? "Switch GG's model"
                      : `Switch ${PRODUCT_DISPLAY_NAME}'s model`
                  }
                />
              </span>
              {workspaceMode === "code" && (
                <>
                  <FooterSep />
                  <span className="model-anchor">
                    <span className="model-label" style={{ color: theme.ken }}>
                      {MENTOR_DISPLAY_NAME}
                    </span>
                    <ModelSelect
                      key={`ken-models-${modelCatalogRefreshNonce}`}
                      models={models}
                      currentModel={state?.kenModel ?? state?.model ?? ""}
                      onSelect={(id) => onSelectKenModel(id)}
                      color={theme.ken}
                      refreshNonce={modelCatalogRefreshNonce}
                      title={
                        state?.kenModelOverride
                          ? `${MENTOR_DISPLAY_NAME} is pinned to a separate model — click to change`
                          : `${MENTOR_DISPLAY_NAME} follows ${PRODUCT_DISPLAY_NAME}'s model — click to pin one`
                      }
                      onSelectFollow={() => onSelectKenModel(null)}
                      followActive={!state?.kenModelOverride}
                    />
                  </span>
                </>
              )}
            </span>
          </>
        )}
      </div>

      {appUpdate.phase === "available" && !appUpdate.localPatched && (
        <button
          className="update-banner"
          title={appUpdate.installTitle}
          onClick={() => {
            if (shouldConfirmLocalUpdate(appUpdate.localPatched, appUpdate.phase)) {
              setSummarizeDecisions(false);
              setShowLocalUpdateConfirm(true);
            } else {
              void appUpdate.install();
            }
          }}
        >
          <span className="update-banner-dot" />
          {appUpdate.localPatched
            ? `${appUpdate.installLabel} — click to review the protected source update`
            : `${MENTOR_DISPLAY_NAME} just updated ${PRODUCT_DISPLAY_NAME}!`}
          {!appUpdate.localPatched && <Badge>Install</Badge>}
        </button>
      )}
      {appUpdate.phase === "installing" && !appUpdate.localPatched && (
        <div
          className="update-banner update-banner-busy update-banner-progress"
          role="progressbar"
          aria-valuenow={appUpdate.progress ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Downloading update"
        >
          <span className="update-banner-fill" style={{ width: `${appUpdate.progress ?? 0}%` }} />
          <span className="update-banner-pct">{`${appUpdate.progress ?? 0}%`}</span>
        </div>
      )}
      {appUpdate.localPatched && ["installing", "completed", "error"].includes(appUpdate.phase) && (
        <div className="update-banner update-banner-busy" title={appUpdate.installTitle}>
          <span className="update-banner-dot" />
          {appUpdate.statusMessage ?? appUpdate.installLabel}
        </div>
      )}

      {workspaceMode === "code" && showInitGit && (
        <InitGitModal
          defaultName={defaultRepoName}
          onClose={() => setShowInitGit(false)}
          onInitialize={(prompt) => {
            setShowInitGit(false);
            submitText(prompt, "Initializing Git\u2026");
          }}
        />
      )}

      {props.focused !== false && showLocalUpdateConfirm && (
        <ConfirmModal
          title={LOCAL_UPDATE_CONFIRMATION_TITLE}
          message={LOCAL_UPDATE_CONFIRMATION_MESSAGE}
          confirmLabel={LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL}
          content={
            <LocalUpdateSummaryOption
              checked={summarizeDecisions}
              onChange={setSummarizeDecisions}
            />
          }
          onConfirm={() => {
            setShowLocalUpdateConfirm(false);
            void appUpdate.install({ summarizeDecisions });
            setSummarizeDecisions(false);
          }}
          onClose={() => {
            setShowLocalUpdateConfirm(false);
            setSummarizeDecisions(false);
          }}
        />
      )}

      {confirmNewSession && (
        <ConfirmModal
          title={workspaceMode === "chat" ? "New Chat" : "New Session"}
          message={
            workspaceMode === "chat"
              ? "Start a fresh chat? Your current conversation is saved in Sessions."
              : "Start a fresh session? Your current conversation is saved in Sessions."
          }
          confirmLabel={workspaceMode === "chat" ? "New Chat" : "New Session"}
          busy={newSessionBusy}
          onConfirm={() => void startNewSession()}
          onClose={() => setConfirmNewSession(false)}
        />
      )}

      <RoadmapPhaseDraftReviewModal
        draft={roadmapDraftState.draft}
        open={roadmapDraftState.open}
        decision={roadmapDraftState.decision}
        error={roadmapDraftState.error}
        announcement={roadmapDraftState.announcement}
        onClose={() => dispatchRoadmapDraft({ type: "dismiss" })}
        onApprove={approveRoadmapDraft}
        onReject={rejectRoadmapDraft}
      />
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {!roadmapDraftState.open ? roadmapDraftState.announcement : ""}
      </div>

      {/* Always mounted: an MCP server can ask for input at any moment, in any
          workspace mode, and its tool call stays blocked until we answer. */}
      <McpElicitModal />

      {workspaceMode === "chat" && showMemories && (
        <MemoryModal onClose={() => setShowMemories(false)} />
      )}

      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}

      {/* Settings reached from the menu-bar tray. Rendered in every view branch
          (Home, picker, workspace) because the tray targets a WINDOW and can't
          know which of the three it is showing. */}
      {showTraySettings && <SettingsModal onClose={closeTraySettings} />}

      {workspaceMode === "code" && showTasks && (
        <TasksModal
          tasks={projectTasks}
          running={running}
          onRun={handleRunTask}
          onRunAll={handleRunAllTasks}
          onDelete={handleDeleteTask}
          onClose={() => setShowTasks(false)}
        />
      )}
    </div>
  );
}

/** Smoothly reveals streamed prose and keeps its growing tail visible. */
function StreamingMarkdown({
  text,
  onGrow,
}: {
  text: string;
  onGrow?: () => void;
}): React.ReactElement {
  const { text: revealed, animating } = useSmoothText(text);
  useLayoutEffect(() => {
    onGrow?.();
  }, [revealed, onGrow]);
  return <Markdown animate={animating}>{revealed}</Markdown>;
}

// ── Row renderers ──────────────────────────────────────────
// Memoized per row: the streaming run rebuilds the `items` array on every
// `text_delta`, but `appendAssistant` returns the SAME object reference for
// every non-streaming row, and `onImageLoad` is a stable useCallback. So a
// default shallow `memo` re-renders ONLY the row whose `item` reference changed
// (the one actively streaming) — the rest bail out, keeping per-token cost O(1)
// instead of O(transcript length).
const TranscriptRow = memo(function TranscriptRow({
  item,
  onImageLoad,
  onAskAnswer,
  onAskType,
}: {
  item: Item;
  onImageLoad?: () => void;
  onAskAnswer?: (
    itemId: number,
    promptId: string,
    delta: Record<string, string | string[]>,
  ) => void;
  onAskType?: (itemId: number, promptId: string, questionId: string, seed?: string) => void;
}): React.ReactElement | null {
  switch (item.kind) {
    case "user":
      if (item.kenSent) {
        // Sent from a Ken "Send to GG Coder" button: show a shimmering "Sent to GG
        // Coder" in Ken's color (like a slash command shows `/name`), not the
        // full prompt body. The full body still went to GG Coder.
        return (
          <div className={`user-msg command labelled user-ken-sent${item.queued ? " queued" : ""}`}>
            {item.queued && <span className="queued-pill">queued</span>}
            <span className="command-shimmer" style={{ color: theme.ken }}>
              Sent to {PRODUCT_DISPLAY_NAME}
            </span>
          </div>
        );
      }
      if (item.command) {
        // Workflow command: show just the short `/name` (or a friendly `label`
        // phrase) with a highlight + shimmer sweep. The full expanded prompt
        // was sent to the agent. Labels read as prose, so drop the mono font.
        return (
          <div className={`user-msg command${item.label ? " labelled" : ""}`}>
            <span className="command-shimmer" style={{ color: theme.commandColor }}>
              {item.label ?? item.text}
            </span>
          </div>
        );
      }
      return (
        <div
          className={`user-msg${item.queued ? " queued" : ""}${item.promoted ? " promoted" : ""}${item.ken ? " user-ken" : ""}`}
        >
          {(item.queued || item.promoted) && (
            <span className="queued-pill" aria-hidden={item.promoted}>
              queued
            </span>
          )}
          {item.images && item.images.length > 0 && (
            <div className="user-img-row">
              {item.images.map((src, i) => (
                <img key={i} className="user-img" src={src} alt="attachment" onLoad={onImageLoad} />
              ))}
            </div>
          )}
          {item.enhancements && item.enhancements.some((s) => s.kind === "term") ? (
            <EnhancedSegments segments={item.enhancements} />
          ) : (
            item.text
          )}
          {item.files && item.files.length > 0 && (
            <div className="user-files-row">
              {item.files.map((p) => (
                <span key={p} className="user-file-chip" title={p}>
                  <AtSign size={11} style={{ color: theme.accent }} />
                  <span style={{ color: theme.code }}>{p}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "assistant": {
      // Split out [DONE:n] plan-step markers so each renders as a "✓ Step n"
      // completion row instead of leaking the raw marker into the prose.
      const segments = hasDoneMarker(item.text)
        ? segmentDoneMarkers(item.text)
        : [{ kind: "text" as const, text: item.text }];
      return (
        <>
          {segments.map((seg, i) =>
            seg.kind === "done" ? (
              <div key={i} className="plan-step-done">
                <span className="plan-step-check" aria-hidden="true">
                  {"\u2713"}
                </span>
                <span className="plan-step-label">{`Step ${seg.stepNum} completed`}</span>
              </div>
            ) : (
              <div key={i} className="assistant-msg">
                <span className="assistant-dot" style={{ color: theme.primary }}>
                  {DOT}
                </span>
                <div className="assistant-text">
                  <StreamingMarkdown text={seg.text} onGrow={onImageLoad} />
                </div>
              </div>
            ),
          )}
        </>
      );
    }
    case "ken":
      // Ken Kai's reply: the whole bubble is tinted in Ken's color (dot + all
      // text), which is the ONLY differentiator from a normal GG Coder reply.
      // No badge, no byline. The Markdown component special-cases ```prompt
      // fences into a "Send to GG Coder" button.
      return (
        <div className="assistant-msg ken-msg">
          <span className="assistant-dot" style={{ color: theme.ken }}>
            {DOT}
          </span>
          <div className="assistant-text">
            <StreamingMarkdown text={item.text} onGrow={onImageLoad} />
          </div>
        </div>
      );
    case "autopilot": {
      // Autopilot Ken's verdict, rendered like a normal @Ken reply (Ken-tinted
      // dot + text) rather than its own marker style. The text is his verdict as
      // prose: for a PROMPT he shows what he sent GG Coder back to do; the
      // terminal verdicts read as short Ken one-liners. `done` rotates through
      // several casual Ken lines (picked deterministically off the item's
      // stable id, so it never flickers on re-render) instead of always
      // repeating the exact same sentence turn after turn.
      const copy: Record<Extract<Item, { kind: "autopilot" }>["phase"], string> = {
        prompted: item.body?.trim()
          ? `Sending ${PRODUCT_DISPLAY_NAME} back in:\n\n${item.body.trim()}`
          : `Sending ${PRODUCT_DISPLAY_NAME} back in for another pass.`,
        done: allClearCopy(item.copySeed, item.id),
        human: item.reason?.trim() ? item.reason.trim() : "Need you to weigh in on this one.",
        capped: "Paused autopilot after 3 rounds. Take a look before I keep going.",
        plan_approved: "Plan looks solid. Approved it — implementation is underway.",
      };
      return (
        <div className="assistant-msg ken-msg">
          <span className="assistant-dot" style={{ color: theme.ken }}>
            {DOT}
          </span>
          <div className="assistant-text">
            <Markdown>{copy[item.phase]}</Markdown>
          </div>
        </div>
      );
    }
    case "info":
      return (
        <div className="line info" style={{ color: theme.textDim }}>
          {item.text}
        </div>
      );
    case "mcp_tool_failure": {
      const label = item.displayName ?? item.name.replace(/^mcp__/, "").replace("__", " / ");
      return (
        <div className="line error" role="status" aria-label={`Failed MCP tool: ${label}`}>
          <div style={{ color: theme.error, fontWeight: 600 }}>Failed</div>
          <div style={{ color: theme.text }}>{label}</div>
          <div style={{ color: theme.textDim, whiteSpace: "pre-wrap" }}>{item.result}</div>
        </div>
      );
    }
    case "error": {
      // Structured errors (see gg-ai's formatError) always answer "is this me or
      // them" and, for usage-limit stops, when it resets — mirrors the CLI's
      // ErrorRow instead of dumping the raw provider string. `text` is the
      // legacy fallback for items that only ever carried a flat string.
      const headline = item.headline ?? item.text ?? "";
      const showMessage = item.message && item.message !== headline;
      return (
        <div className="line error">
          <div style={{ color: theme.error, fontWeight: 600 }}>{headline}</div>
          {showMessage && <div style={{ color: theme.textDim }}>{item.message}</div>}
          {item.guidance && <div style={{ color: theme.textDim }}>{item.guidance}</div>}
        </div>
      );
    }
    case "hook": {
      // Mirrors the TUI IdealHookMessage: assistant-style dot + a shimmering
      // tone-colored one-liner so the self-correction is obvious.
      const { text, color } = HOOK_PRESENTATION[item.hook];
      return (
        <div className="assistant-msg">
          <span className="assistant-dot" style={{ color }}>
            {DOT}
          </span>
          <div className="assistant-text">
            <ShimmerText base={color} bright="#ffffff">
              {text}
            </ShimmerText>
          </div>
        </div>
      );
    }
    case "images":
      return (
        <div className="img-grid">
          {item.images.map((img, i) => {
            const openImage = (): void => {
              if (img.path) void openProjectPath(img.path);
            };
            return (
              <figure
                key={img.path ?? i}
                className={`img-card${img.path ? " img-card-clickable" : ""}`}
                role={img.path ? "button" : undefined}
                tabIndex={img.path ? 0 : undefined}
                title={img.path ? `Open ${img.path}` : undefined}
                onClick={openImage}
                onKeyDown={(e) => {
                  if (!img.path || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  openImage();
                }}
              >
                <img
                  className="img-thumb"
                  src={img.src}
                  alt={img.path ?? "image"}
                  onLoad={onImageLoad}
                />
                {img.path && (
                  <figcaption className="img-cap" title={img.path}>
                    {basename(img.path)}
                  </figcaption>
                )}
              </figure>
            );
          })}
        </div>
      );
    case "generating_image":
      return (
        <div className="img-grid">
          <div className="img-gen-placeholder">
            <Skeleton width={200} height={200} radius={12} />
            <span className="img-gen-label">
              {item.prompt.length > 60 ? item.prompt.slice(0, 57) + "\u2026" : item.prompt}
            </span>
          </div>
        </div>
      );
    case "plan":
      return <PlanModeLogo reason={item.reason} />;
    case "ask":
      return (
        <AskBand
          prompt={item.prompt}
          answers={item.answers}
          sent={item.sent}
          cancelled={item.cancelled}
          onAnswer={(delta) => onAskAnswer?.(item.id, item.prompt.id, delta)}
          onTypeInstead={(questionId, seed) =>
            onAskType?.(item.id, item.prompt.id, questionId, seed)
          }
        />
      );
    case "task":
      return (
        <div className="line task-row">
          <span className="task-row-glyph" style={{ color: theme.primary }}>
            {"\u25B8 "}
          </span>
          <span style={{ color: theme.textMuted }}>{"Task: "}</span>
          <span style={{ color: theme.text, fontWeight: 600 }}>{item.title}</span>
        </div>
      );
    case "subagent_group":
      return <SubAgentFeed agents={item.agents} aborted={item.aborted} />;
    case "compaction":
      return (
        <CompactionNotice
          status={item.status}
          originalCount={item.originalCount}
          newCount={item.newCount}
        />
      );
    default:
      return null;
  }
});

export default AgentPane;
