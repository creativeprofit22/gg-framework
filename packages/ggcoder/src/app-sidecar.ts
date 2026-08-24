/**
 * gg-app sidecar — bridges the full ggcoder AgentSession to the Tauri webview
 * over plain HTTP + Server-Sent Events (zero browser-side dependencies).
 *
 * Transport:
 *   GET  /state    → { provider, model, cwd, ready }
 *   GET  /events   → text/event-stream of forwarded agent + session events
 *   POST /prompt   → { text } ; runs AgentSession.prompt(text)
 *   POST /cancel   → aborts the in-flight run
 *
 * The agent spine (gg-ai → gg-agent → gg-core) and every tool are reused
 * unchanged via AgentSession — this file is only a network seam.
 */
import http from "node:http";
import fs from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { environmentSecrets, redactValue, type ToolResultContent } from "@kenkaiiii/gg-ai";
import type { AddressInfo } from "node:net";
import { runJsonMode } from "./modes/json-mode.js";
import { appSettingsFile } from "./app-sidecar-paths.js";
import { formatSidecarError, sidecarSensitiveValues } from "./app-sidecar-error.js";
import { runSubagentWorkerMode } from "./modes/subagent-worker-mode.js";
import type { MessageProvenance, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { setStreamDiagnostic } from "@kenkaiiii/gg-agent";
import { AgentSession } from "./core/agent-session.js";
import { applyDesktopMcpMutation } from "./app-sidecar-mcp-lifecycle.js";
import { mcpManagementRouteFailure } from "./app-sidecar-mcp-management.js";
import { collectPersistedMcpToolFailures } from "./app-sidecar-tool-failures.js";
import {
  AppSidecarContinuationHandoffService,
  type ContinuationSynthesisSessionOptions,
} from "./app-sidecar-continuation-handoff.js";
import {
  AppSidecarDecisionSummaryService,
  DECISION_SUMMARY_CONTEXT_MAX_BYTES,
  type DecisionSummarySessionOptions,
} from "./app-sidecar-decision-summary.js";
import { handleDecisionSummaryRequest } from "./app-sidecar-decision-summary-route.js";
import { CONTINUATION_HANDOFF_LIMITS } from "./core/continuation-handoff.js";
import { SharedMcpClientPool } from "./core/mcp/shared-client-pool.js";
import { RunLifecycle, type RunState } from "./core/run-lifecycle.js";
import { RunClaim } from "./core/run-claim.js";
import {
  CHAT_AGENT_IDS,
  chatAgentSessionsDir,
  createChatAgent,
  parseChatAgentId,
  switchChatAgent,
  type ChatAgentId,
} from "./chat-agents/index.js";
import { buildJiwaTools, JiwaStore } from "./chat-agents/jiwa.js";
import { buildMemoryTools, MemoryStore } from "./chat-agents/memory.js";
import { buildKenSystemPrompt, buildKenAutopilotSystemPrompt } from "./core/ken-prompt.js";
import {
  buildKenDigest,
  buildKenAutopilotContext,
  buildKenAutopilotPlanContext,
} from "./core/ken-context.js";
import { parseAutopilotVerdict, type AutopilotVerdict } from "./core/autopilot-verdict.js";
import {
  isWorkflowCommandText,
  countAssistantMessages,
  shouldStartAutopilotCycle,
  extractTurnToolCalls,
  isMechanicalOnlyTurn,
  type WorkflowCommandSpec,
} from "./core/autopilot-gate.js";
import { driveAutopilotCycle, frameAutopilotInjection } from "./core/autopilot-cycle.js";
import { validateKenModelPref, effectiveKenModel, type KenModelPref } from "./core/ken-model.js";
import type { KenTurnPayload, AppMarkerPayload, RunOutcome } from "./core/session-manager.js";
import {
  normalizeAutopilotMarkersForHistory,
  normalizeAppMarkersForHistory,
  normalizeKenTurnsForHistory,
  getHistoryMessageVisibility,
  replayMessagesInOrder,
  restoreUserRow,
  restoreAssistantTexts,
  resolveRestoredCommand,
  autopilotMarkerCopySeed,
} from "./core/session-history.js";
import {
  sessionToMarkdown,
  defaultExportFilename,
  type ToolDetail,
} from "./core/session-export.js";
import { AuthStorage } from "./core/auth-storage.js";
import {
  advancesPhase,
  explainPullFailure,
  isGgufShard,
  isValidHfRepoId,
  parseOllamaPullLine,
  pickGgufQuant,
  SHARDED_MESSAGE,
  toHfSearchRow,
  type GgufFile,
  type HfSearchRow,
  type PullPhase,
} from "./hf-pull.js";
import { cleanupToolOutputs } from "./tools/overflow.js";
import { readCappedBody } from "./utils/http-body.js";
import {
  fetchSubscriptionUsage,
  SubscriptionUsageError,
  XIAOMI_CREDITS_KEY,
  dualAuthProvider,
  oauthStorageKey,
  discoverLocalModels,
  findProbedModel,
  formatLocalModelId,
  parseLocalModelId,
  probeEndpoint,
  toModelInfo as localModelInfo,
  type LocalEndpoint,
  type LocalEndpointProbe,
  type PlanAcceptResult,
  type PlanMutationFailure,
  type PlanRevisionResult,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
} from "@kenkaiiii/gg-core";
import {
  LocalEndpointError,
  addCustomEndpoint,
  listAllEndpoints,
  removeCustomEndpoint,
  syncEndpointCredentials,
} from "./core/local-endpoint-store.js";
import { loginAnthropic } from "./core/oauth/anthropic.js";
import { loginOpenAI } from "./core/oauth/openai.js";
import { loginGemini } from "./core/oauth/gemini.js";
import { loginKimi } from "./core/oauth/kimi.js";
import { loginXai } from "./core/oauth/xai.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./core/oauth/types.js";
import {
  AUTH_PROVIDERS,
  authPriorityNote,
  describeAuthMethods,
  type AuthMethod,
  type AuthMethodMeta,
  type AuthProviderMeta,
} from "./core/auth-providers.js";
import { ensureAppDirs, loadSavedSettings, projectScopeAllowed } from "./config.js";
import { SettingsManager, type Settings } from "./core/settings-manager.js";
import {
  installPlugin,
  listInstalledPlugins,
  removePlugin,
} from "./core/extensions/plugin-bundles.js";
import {
  getModel,
  getDefaultThinkingLevel,
  getContextWindow,
  getAllModels,
  clearRuntimeModels,
  registerRuntimeModels,
} from "./core/model-registry.js";
import { resolveStartOrFallback } from "./core/resolve-start.js";
import { getGitBranch, getGitDirtyFileCount, isGitRepo } from "./utils/git.js";
import { getGitHubOpenCounts, getGitHubRepoSlug } from "./utils/github.js";
import { extractPlanSteps } from "./utils/plan-steps.js";
import {
  clampThinkingLevel,
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
  resolveInitialThinkingLevel,
} from "./core/thinking-level.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";
import { loadCustomCommands } from "./core/custom-commands.js";
import { discoverProjects } from "./core/project-discovery.js";
import { listSidecarSessions } from "./app-sidecar-sessions.js";
import {
  loadTasksSync,
  saveTasksSync,
  pruneDoneTasksSync,
  getNextPendingTask,
  markTaskInProgress,
} from "./core/tasks-store.js";
import { initLogger, log } from "./core/logger.js";
import { installTerminationHandlers } from "./core/shutdown.js";
import {
  RADIO_STATIONS,
  getCurrentStation,
  getRadioVolume,
  playRadio,
  setRadioVolume,
  stopRadio,
} from "./core/radio.js";
import { enrichProcessPath } from "./core/shell-path.js";
import { downscaleForPreview, shrinkToFit, validateVisionImage } from "./utils/image.js";
import { startServeMode, type ServeController } from "./modes/serve-mode.js";
import { loadTelegramConfig, saveTelegramConfig, verifyBotToken } from "./core/telegram-config.js";
import {
  loadServers,
  addServer,
  removeServer,
  getServer,
  parseMcpAddCommand,
  MCPClientManager,
  McpOAuthStore,
  createElicitationBridge,
  type MCPScope,
  type MCPServerConfig,
} from "./core/mcp/index.js";
import type { ElicitResult } from "@modelcontextprotocol/client";
import { buildSnapshot, levelForXp, rankForLevel } from "./core/progress/ranks.js";
import { loadProgress, peekProgress, updateProgress } from "./core/progress/store.js";
import { awardPrompt, awardCommits } from "./core/progress/engine.js";
import { detectNewCommits, repoKey } from "./core/progress/git-xp.js";
import { rebuildFromSessions } from "./core/progress/rebuild.js";
import type { ProgressFile, ProgressSnapshot } from "./core/progress/types.js";
import { AppSidecarReloadCoordinator } from "./app-sidecar-reload.js";
import { AppSidecarSessionRouter, sessionEventFrame } from "./app-sidecar-session-router.js";
import { createAppSidecarNotesHandler, type AppSidecarNotesHandler } from "./app-sidecar-notes.js";
import {
  AppSidecarReminderCoordinator,
  createAppSidecarReminderHandler,
  type AppSidecarReminderHandler,
} from "./app-sidecar-reminders.js";
import {
  ProjectNotesRepository,
  canonicalProjectKey,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import {
  launchBoundPhase,
  type BoundPhaseCandidate,
  type PhaseStartResponseBody,
} from "./app-sidecar-phase-launch.js";
import { handlePhaseStartRoute } from "./app-sidecar-phase-route.js";
import {
  AppSidecarPlanGate,
  hasPlanOnlyBoundary,
  planGateConflictCode,
  type PersistedPlanReviewCheckpoint,
} from "./app-sidecar-plan-gate.js";
import { persistApprovedPlanSnapshot } from "./app-sidecar-approved-plan.js";
import {
  executePlanRevisionRequest,
  isPlanRevisionSessionBusy,
  parsePlanRevisionBody,
} from "./app-sidecar-plan-revision.js";
import {
  AppSidecarPlanHandoff,
  type ApprovedPlanConsumptionIdentity,
} from "./app-sidecar-plan-handoff.js";
import {
  parsePhaseAdvancementStartBody,
  parsePhaseAdvancementStartRoute,
} from "./app-sidecar-phase-advancement-route.js";
import { AppSidecarJsonBodyError, readJsonBody } from "./app-sidecar-http-json.js";
import { AppSidecarPhaseCandidateStore } from "./app-sidecar-phase-candidates.js";
import {
  AppSidecarPhaseCompletionCoordinator,
  AppSidecarPhaseImplementationPlanTracker,
  checkpointSettledPhaseImplementation,
  restorePhaseImplementationPlanEvidence,
} from "./app-sidecar-phase-completion.js";
import {
  AppSidecarPhaseCancellationCoordinator,
  type ActiveOperationCancellationResult,
} from "./app-sidecar-phase-cancellation.js";
import {
  commitImplementationRunStart,
  commitPlanApprovalCheckpoint,
  PhaseCheckpointError,
  phaseCheckpointFailurePayload,
} from "./app-sidecar-phase-checkpoint.js";
import { AppSidecarPhaseLifecycleCoordinator } from "./app-sidecar-phase-lifecycle.js";
import { reconcileActivePhaseVerificationStage } from "./app-sidecar-phase-verification.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  AppSidecarRoadmapReviewRunCoordinator,
  AppSidecarRoadmapReviewScheduler,
  appSidecarRoadmapReviewSchedulingFailure,
  appSidecarRoadmapReviewTrigger,
  type AppSidecarRoadmapReviewTrigger,
} from "./app-sidecar-roadmap-review-scheduler.js";
import { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
  type AppSidecarFinalReviewAttempt,
} from "./app-sidecar-roadmap-tool-host.js";
import {
  boundPhaseForAutopilotReview,
  classifyAppSidecarFinalReviewAttempt,
  phaseCompletionVerdict,
} from "./app-sidecar-autopilot-phase-review.js";
import { latestVerificationExceptionForReview } from "./app-sidecar-phase-completion.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";
import { AppSidecarRoadmapDraftToolHost } from "./app-sidecar-roadmap-draft-tool-host.js";
import {
  commitChatResearchTransition,
  resolveChatResearchCommandRoute,
} from "./app-sidecar-chat-research-handoff.js";
import {
  appSidecarChatCommandsResponse,
  handleAppSidecarChatResearchPrompt,
} from "./app-sidecar-chat-research-route.js";
import {
  createAppSidecarChatRoadmapSessionOptions,
  createAppSidecarCodingRoadmapSessionOptions,
} from "./app-sidecar-roadmap-session-options.js";
import {
  AppSidecarRoadmapDraftDecisionService,
  parseRoadmapPhaseDraftRejectBody,
  parseRoadmapPhaseDraftRoute,
  roadmapPhaseDraftApprovalHttpStatus,
  roadmapPhaseDraftRejectionHttpStatus,
} from "./app-sidecar-roadmap-draft-route.js";
import {
  AppSidecarSessionMutationCoordinator,
  runAppSidecarNewSessionMutation,
} from "./app-sidecar-session-mutation.js";
import {
  captureSidecarError,
  flushSidecarErrors,
  shouldCaptureToolFailure,
  shouldCaptureUsagePollingError,
  wrapSidecarHandler,
} from "./core/sidecar-error-reporter.js";

const AUTOMATION_PROVENANCE: MessageProvenance = {
  source: "runtime",
  kind: "automation",
  visibility: "hidden",
};

const ALL_PROVIDERS: Provider[] = [
  // US
  "anthropic",
  "openai",
  "azure",
  "gemini",
  "xai",
  // China
  "moonshot",
  "glm",
  "minimax",
  "xiaomi",
  "deepseek",
  // Open-community gateway, before the provider-agnostic one
  "huggingface",
  // Japan, then provider-agnostic gateway last
  "sakana",
  "openrouter",
];

// ── gg-app settings (~/.gg/gg-app.json) ────────────────────
// App-specific, separate from the shared ggcoder settings file so the desktop
// app's preferences never collide with the CLI's.

/** Per-project model + thinking preferences. Persisted so each window (one
 *  project cwd) restores its OWN model across app restarts — instead of every
 *  window reading the same single global slot that the last writer clobbered. */
interface ProjectModelPrefs {
  provider: Provider;
  model: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}

interface AppSettings {
  /** Folder new projects are created inside. Defaults to ~/gg-projects. */
  projectsRoot: string;
  /** Model + thinking prefs keyed by normalized project cwd. A window restores
   *  its own entry on boot; absent → global settings.json → provider default. */
  projectModels?: Record<string, ProjectModelPrefs>;
  /** Autopilot (auto-review) on/off keyed by normalized project cwd. Per-window
   *  (one window = one cwd); absent/false → off. Restored on boot. */
  autopilot?: Record<string, boolean>;
  /** Ken's model override keyed by normalized project cwd. Absent → Ken follows
   *  GG Coder's model (the historical behavior). Set → Ken (chat + autopilot)
   *  uses this model regardless of GG Coder's. */
  kenModels?: Record<string, KenModelPref>;
  /** Extra folders scanned for projects alongside `projectsRoot`. */
  projectRoots?: string[];
  /** Project paths dismissed from the picker, as normalized cwds. */
  hiddenProjects?: string[];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

function defaultProjectsRoot(): string {
  return path.join(os.homedir(), "gg-projects");
}

/** Normalize a project cwd to a stable settings key so trailing slashes /
 *  relative segments collapse — the same project always maps to one entry. */
function projectModelKey(cwd: string): string {
  return path.resolve(cwd);
}

async function loadAppSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as Partial<AppSettings>;
    return {
      projectsRoot:
        typeof raw.projectsRoot === "string" && raw.projectsRoot.trim()
          ? raw.projectsRoot
          : defaultProjectsRoot(),
      // Preserve the per-project map verbatim (validated + written by the
      // model/thinking handlers below).
      projectModels:
        raw.projectModels && typeof raw.projectModels === "object" ? raw.projectModels : undefined,
      autopilot: raw.autopilot && typeof raw.autopilot === "object" ? raw.autopilot : undefined,
      kenModels: raw.kenModels && typeof raw.kenModels === "object" ? raw.kenModels : undefined,
      projectRoots: stringArray(raw.projectRoots),
      hiddenProjects: stringArray(raw.hiddenProjects),
    };
  } catch {
    return { projectsRoot: defaultProjectsRoot() };
  }
}

async function saveAppSettings(settings: AppSettings): Promise<void> {
  await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
  await fs.writeFile(appSettingsFile(), JSON.stringify(settings, null, 2), "utf-8");
}

/** Read this project's persisted model/thinking prefs, if any. */
async function loadProjectModelPrefs(cwd: string): Promise<ProjectModelPrefs | undefined> {
  const s = await loadAppSettings();
  return s.projectModels?.[projectModelKey(cwd)];
}

/** Persist this project's model/thinking prefs via read-modify-write so the rest
 *  of the settings file (projectsRoot, other projects' entries) is preserved. */
async function saveProjectModelPrefs(cwd: string, prefs: ProjectModelPrefs): Promise<void> {
  const s = await loadAppSettings();
  const key = projectModelKey(cwd);
  s.projectModels = { ...(s.projectModels ?? {}), [key]: prefs };
  await saveAppSettings(s);
}

/** Read this project's persisted Ken model override, if any. */
async function loadKenModelPref(cwd: string): Promise<KenModelPref | undefined> {
  const s = await loadAppSettings();
  return s.kenModels?.[projectModelKey(cwd)];
}

/** Persist (or with null, clear) this project's Ken model override via
 *  read-modify-write so the rest of the settings file is preserved. */
async function saveKenModelPref(cwd: string, pref: KenModelPref | null): Promise<void> {
  const s = await loadAppSettings();
  const key = projectModelKey(cwd);
  const next = { ...(s.kenModels ?? {}) };
  if (pref) next[key] = pref;
  else delete next[key];
  s.kenModels = next;
  await saveAppSettings(s);
}

/** Read this project's persisted autopilot flag (default off). */
async function loadAutopilot(cwd: string): Promise<boolean> {
  const s = await loadAppSettings();
  return s.autopilot?.[projectModelKey(cwd)] ?? false;
}

/** Persist this project's autopilot flag via read-modify-write so the rest of
 *  the settings file (projectsRoot, model map, other projects) is preserved. */
async function saveAutopilot(cwd: string, enabled: boolean): Promise<void> {
  const s = await loadAppSettings();
  const key = projectModelKey(cwd);
  s.autopilot = { ...(s.autopilot ?? {}), [key]: enabled };
  await saveAppSettings(s);
}

/**
 * Persist the active model selection to ~/.gg/settings.json so it survives app
 * restarts. Mirrors the CLI's handleModelSelect persistence (App.tsx).
 */
async function persistModelSelection(
  settingsFile: string,
  provider: Provider,
  model: string,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("defaultProvider", provider as Settings["defaultProvider"]);
    await sm.set("defaultModel", model);
  } catch (err) {
    captureSidecarError(err, "app-sidecar.settings.persist-model");
    log("WARN", "app-sidecar", "failed to persist model selection", { err: String(err) });
  }
}

/**
 * Persist the thinking level to ~/.gg/settings.json so it survives app restarts.
 * Mirrors the CLI's handleToggleThinking persistence (App.tsx).
 */
async function persistThinkingLevel(
  settingsFile: string,
  level: ThinkingLevel | undefined,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("thinkingEnabled", !!level);
    if (level) await sm.set("thinkingLevel", level);
  } catch (err) {
    captureSidecarError(err, "app-sidecar.settings.persist-thinking");
    log("WARN", "app-sidecar", "failed to persist thinking level", { err: String(err) });
  }
}

/** Validate a project folder name: lowercase letters, digits, dashes only. */
function isValidProjectName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

// ── History reconstruction types ──────────────────────────
// Mirrors HistoryEntry in gg-app/src/agent.ts — the wire shape the webview
// receives from GET /history. Fields beyond role/text carry the transcript
// item kinds that are reconstructed from persisted session data.
interface HistoryEntryForWire {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  hook?: "ideal" | "loop_break" | "regrounding" | null;
  command?: boolean;
  compacted?: boolean;
  /** Persisted counts for a compacted row's "N → M messages" summary. */
  compactionCounts?: { originalCount: number; newCount: number };
  /** True when this entry is a Ken Kai (mentor) turn: a `user` row is the `@Ken`
   *  question, an `assistant` row is Ken's reply. The webview renders these in
   *  Ken's color (user bubble tinted; assistant as a Ken bubble). */
  ken?: boolean;
  /** Present when this entry is a persisted autopilot verdict marker (an
   *  `assistant` row with empty `text`). The webview renders it exactly like
   *  the live `autopilot` item — never the raw verdict keyword the model
   *  actually replied with (e.g. `ALL_CLEAR`). */
  autopilot?: {
    phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
    reason?: string;
    body?: string;
    /** Stable seed derived from persisted marker data for deterministic all-clear copy. */
    copySeed?: string;
  };
  /** True when this user prompt came from a Ken "Send to GG Coder" button —
   *  the webview renders the shimmering label instead of the prompt body. */
  kenSent?: boolean;
  /** Enhancer highlight segments for this user prompt (unedited enhanced sends). */
  enhancements?: unknown[];
  /** Plan-mode entry banner (ASCII logo + reason), persisted at plan_enter. */
  plan?: { reason: string };
  /** Task header row (task title), persisted at task_start. */
  task?: { title: string };
  /** Error row (headline/message/guidance), persisted by broadcastError.
   *  `scope` selects the live prefix (ken_error → "Ken: ", autopilot_error →
   *  "Autopilot: "). */
  error?: { scope: string; headline: string; message?: string; guidance?: string };
  /** Webview-copy info row marker (e.g. the video-capability warning). */
  infoKind?: "video_warning";
  toolImages?: Array<{ src: string; path?: string }>;
  /** Failed MCP result restored as a durable transcript row. */
  mcpToolFailure?: { name: string; result: string };
  subagentGroup?: Array<{
    agentName?: string;
    status: "done" | "error";
    toolUseCount: number;
  }>;
}

// ── Chat attachments (images / videos / files dropped into the input) ──────
// The webview sends base64 payloads; we persist each under .gg/uploads/ so the
// agent's tools can open files, then hand media to the model as native blocks.
interface AppAttachment {
  kind: "image" | "video" | "file";
  name: string;
  mediaType: string;
  /** base64 (no data: prefix). */
  data: string;
}

interface PreparedAttachment extends AppAttachment {
  path?: string;
}

async function prepareAttachments(
  cwd: string,
  attachments: AppAttachment[],
): Promise<PreparedAttachment[]> {
  const dir = path.join(cwd, ".gg", "uploads");
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const out: PreparedAttachment[] = [];
  for (const a of attachments) {
    // Sanitize the filename and prefix with a short timestamp to avoid clobber.
    const safe = a.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
    const fileName = `${Date.now().toString(36)}-${safe}`;
    const filePath = path.join(dir, fileName);
    const buf = Buffer.from(a.data, "base64");
    // Validate and cap image attachments before they become native image content
    // blocks. Anthropic applies a 2000 px per-dimension cap once conversation
    // history contains more than 20 images, so every attachment must be safe for
    // later turns too. Keep the original on disk, but send the resized bytes.
    // Corrupt or unsupported images become plain files so they cannot reject the
    // entire provider request.
    let prepared: PreparedAttachment = { ...a };
    if (a.kind === "image") {
      try {
        const resized = await shrinkToFit(buf, a.mediaType);
        const validatedType = await validateVisionImage(resized.buffer);
        prepared = validatedType
          ? {
              ...a,
              mediaType: validatedType,
              data: resized.buffer.toString("base64"),
            }
          : { ...a, kind: "file" };
      } catch {
        prepared = { ...a, kind: "file" };
      }
    }
    try {
      await fs.writeFile(filePath, buf);
      out.push({ ...prepared, path: filePath });
    } catch {
      out.push({ ...prepared });
    }
  }
  return out;
}

// ── @-mention file search (chat-input file picker) ─────────────────────────
// Lists project files for the webview's `@` picker. Empty query → newest files
// by mtime; a query → fuzzy-ranked basename/path matches. Honors .gitignore and
// skips node_modules/.git so the picker mirrors the agent's `find` tool.
interface FileHit {
  /** Project-relative POSIX path, e.g. "src/App.tsx". */
  path: string;
  /** File name only, e.g. "App.tsx". */
  name: string;
}

const FILE_SEARCH_LIMIT = 20;
// Upper bound on files walked per search (baseline #8 memory cap). Far above the
// 20-result output limit, so relevance/recency ranking is unaffected in practice.
const FILE_SEARCH_SCAN_CAP = 50_000;

/** Score a candidate path against a lowercased query. Higher is better; a
 *  negative score means "no match". Basename hits beat path hits; prefix beats
 *  substring; shorter paths break ties. */
function scoreFile(relPath: string, name: string, query: string): number {
  const lcPath = relPath.toLowerCase();
  const lcName = name.toLowerCase();
  let score = -1;
  if (lcName === query) score = 1000;
  else if (lcName.startsWith(query)) score = 800;
  else if (lcName.includes(query)) score = 600;
  else if (lcPath.startsWith(query)) score = 400;
  else if (lcPath.includes(query)) score = 200;
  else if (subsequenceMatch(lcPath, query)) score = 100;
  if (score < 0) return -1;
  // Prefer shorter paths (closer to root, less nesting) on equal match class.
  return score - relPath.length * 0.1;
}

/** True when every char of `needle` appears in `haystack` in order (fuzzy). */
function subsequenceMatch(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

async function searchProjectFiles(cwd: string, rawQuery: string): Promise<FileHit[]> {
  const fg = await import("fast-glob");
  const ignore = await import("ignore");
  const query = rawQuery.trim().toLowerCase();

  let gitignore: string[] = [];
  try {
    const content = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8");
    gitignore = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    // No .gitignore — nothing extra to ignore.
  }
  const ig = ignore.default().add(gitignore);

  // `stats: true` gives mtime without a second stat pass, so the empty-query
  // "recent files" path is a single walk. Stream + hard scan cap (baseline #8):
  // collecting the full result array retained ~0.9 MB per 1k files (18.5 MB at
  // 20k), unbounded. Bail after FILE_SEARCH_SCAN_CAP entries so a giant repo
  // can't balloon RSS; the newest/most-relevant matches still surface because
  // the cap is far above the 20-result output limit.
  const entries: { path: string; stats?: { mtimeMs: number } }[] = [];
  const scanStream = fg.default.stream("**/*", {
    cwd,
    dot: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.gg/**"],
    suppressErrors: true,
    followSymbolicLinks: false,
    stats: true,
  });
  for await (const entry of scanStream) {
    entries.push(entry as unknown as { path: string; stats?: { mtimeMs: number } });
    if (entries.length >= FILE_SEARCH_SCAN_CAP) {
      (scanStream as unknown as { destroy: () => void }).destroy();
      log("DEBUG", "app-sidecar", "file search scan cap hit", {
        cap: String(FILE_SEARCH_SCAN_CAP),
        cwd,
      });
      break;
    }
  }
  const files = entries.filter((e) => !ig.ignores(e.path));

  if (!query) {
    return files
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
      .slice(0, FILE_SEARCH_LIMIT)
      .map((e) => ({ path: e.path, name: path.posix.basename(e.path) }));
  }

  const scored: { hit: FileHit; score: number }[] = [];
  for (const e of files) {
    const name = path.posix.basename(e.path);
    const score = scoreFile(e.path, name, query);
    if (score >= 0) scored.push({ hit: { path: e.path, name }, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, FILE_SEARCH_LIMIT).map((s) => s.hit);
}

/**
 * Detect whether a restored user message is actually an injected self-correction
 * hook prompt, by its distinctive opening phrase. Returns the hook kind so the
 * webview can render the short notice line instead of the full prompt body.
 */
/** `?tools=` on /export. Anything unrecognised (including absent) falls back to
 *  the human-facing `summary` default rather than dumping every payload. */
function parseToolDetail(value: string | null): ToolDetail {
  return value === "none" || value === "full" ? value : "summary";
}

function detectHookKind(text: string): "ideal" | "loop_break" | "regrounding" | null {
  const t = text.trimStart();
  if (t.startsWith("Ideal? Review the actual work")) return "ideal";
  if (t.startsWith("Stuck? You've repeated essentially")) return "loop_break";
  if (t.startsWith("Re-ground. The conversation was just compacted")) return "regrounding";
  return null;
}

// ── MCP server management (mirrors `ggcoder mcp`) ───────────────────────────
// The webview's MCP modal lists configured servers with live connection status,
// adds them via the same paste-a-`claude mcp add …` grammar, and removes them.
// All persistence + connection logic lives in core/mcp (single source of truth);
// these helpers only shape it for the wire.

/** One wire row for the MCP list: a server config joined with its live status. */
interface McpWireRow {
  name: string;
  scope: MCPScope;
  ok: boolean;
  toolCount: number;
  error?: string;
  kind: "stdio" | "http";
  summary: string;
  /** True when the server needs an interactive OAuth login before it connects. */
  requiresAuth?: boolean;
}

/** A short transport summary for display (URL for http/sse, command+args for stdio). */
function mcpRowSummary(config: MCPServerConfig): string {
  if (config.url) return config.url;
  return [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
}

/** Load + connect every server, returning one wire row per server. Mirrors the
 *  CLI dashboard's buildRows (connectAllDetailed, then dispose). Empty list
 *  short-circuits before spawning any stdio process / opening any HTTP conn.
 *  Project-scope servers run repo-controlled commands, so unless the user
 *  trusts them (trustProjectMcpServers) they are reported blocked WITHOUT
 *  being connected — even a status probe would spawn the process. */
async function buildMcpRows(cwd: string, settingsFile: string): Promise<McpWireRow[]> {
  const scoped = await loadServers(cwd);
  if (scoped.length === 0) return [];

  const settings = loadSavedSettings(settingsFile);
  const allowProject = projectScopeAllowed(
    settings.trustProjectMcpServers,
    settings.trustedProjects,
    cwd,
  );
  const connectable = scoped.filter((s) => allowProject || s.scope !== "project");
  const blocked = scoped.filter((s) => !allowProject && s.scope === "project");

  const manager = new MCPClientManager();
  try {
    const results =
      connectable.length > 0
        ? await manager.connectAllDetailed(connectable.map((s) => s.config))
        : [];
    return [
      ...connectable.map((s): McpWireRow => {
        const result = results.find((r) => r.name === s.config.name);
        return {
          name: s.config.name,
          scope: s.scope,
          ok: result?.ok ?? false,
          toolCount: result?.toolCount ?? 0,
          error: result?.error,
          kind: s.config.url ? "http" : "stdio",
          summary: mcpRowSummary(s.config),
          requiresAuth: result?.requiresAuth,
        };
      }),
      ...blocked.map(
        (s): McpWireRow => ({
          name: s.config.name,
          scope: s.scope,
          ok: false,
          toolCount: 0,
          error:
            "Project-scope server not connected — this repo's .gg/mcp.json runs " +
            "repo-controlled commands. Add or re-add a server in this project via " +
            "the MCP modal to trust it.",
          kind: (s.config.url ? "http" : "stdio") as "http" | "stdio",
          summary: mcpRowSummary(s.config),
        }),
      ),
    ];
  } finally {
    await manager.dispose();
  }
}

/** Probe a single server's connection before persisting it. Never throws — a
 *  failed probe returns ok:false with a human-readable error so the config can
 *  still be saved. Mirrors the CLI's probeServer. */
async function probeMcp(
  config: MCPServerConfig,
): Promise<{ ok: boolean; toolCount: number; error?: string; requiresAuth?: boolean }> {
  const manager = new MCPClientManager();
  try {
    const result = await manager.probe(config);
    return {
      ok: result.ok,
      toolCount: result.toolCount,
      error: result.error,
      requiresAuth: result.requiresAuth,
    };
  } finally {
    await manager.dispose();
  }
}

interface SseClient {
  id: number;
  res: http.ServerResponse;
}

/**
 * Sub-agents spawn the ggcoder CLI in JSON mode to run a delegated task. In the
 * packaged desktop app the only runnable entry is THIS bundle (there's no
 * sibling `cli.js`), so the subagent tool ends up spawning the sidecar itself.
 * Without this guard that would boot a second HTTP server, emit no NDJSON, and
 * hang until the 10-minute hard timeout. So when invoked with `--json`, behave
 * exactly like `ggcoder --json …`: stream the sub-agent run as NDJSON and exit,
 * never starting the HTTP/SSE server. Mirrors the `values.json` branch in cli.ts.
 */
async function runJsonModeIfRequested(): Promise<boolean> {
  if (!process.argv.includes("--json")) return false;
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      "system-prompt": { type: "string" },
      "agent-prompt": { type: "string" },
      "agent-context": { type: "string" },
      tools: { type: "string" },
      "mcp-servers": { type: "string" },
      "prompt-cache-key": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const maxTurnsRaw = values["max-turns"];
  // Optional tool allow-list forwarded by the subagent spawner from an agent
  // definition's `tools:` frontmatter. Mirrors the identical parsing in
  // cli.ts's `values.json` branch — keep both in sync (see subagent.ts).
  const parsedTools = values.tools
    ? values.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const allowedTools = parsedTools.length > 0 ? parsedTools : undefined;
  // MCP servers the agent definition asked for. Without forwarding these, an
  // allow-listed child connects no MCP at all and loses live code search.
  const parsedMcpServers = values["mcp-servers"]
    ? values["mcp-servers"]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const allowedMcpServers = parsedMcpServers.length > 0 ? parsedMcpServers : undefined;
  await runJsonMode({
    message: positionals[0] ?? "",
    provider: (values.provider ?? "anthropic") as Provider,
    model: values.model ?? "claude-opus-5",
    cwd: process.cwd(),
    systemPrompt: values["system-prompt"],
    agentPrompt: values["agent-prompt"],
    agentContext: values["agent-context"] === "none" ? "none" : undefined,
    maxTurns: maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined,
    allowedTools,
    allowedMcpServers,
    promptCacheKey: values["prompt-cache-key"],
  }).catch(async (err: unknown) => {
    captureSidecarError(err, "app-sidecar.json-mode", {
      provider: String(values.provider ?? "anthropic"),
    });
    await flushSidecarErrors();
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  });
  return true;
}

// ── Daemon-level HTTP helpers (shared by the session-management routes) ─────
// The per-session route table has its own local copies; these serve the
// daemon's own POST /session / DELETE /session routes.
function daemonReadBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<string | null> {
  return readCappedBody(req, res);
}

function daemonJson(res: http.ServerResponse, status: number, body: unknown): void {
  // No CORS headers: only the Rust proxy (no Origin) should call this daemon.
  // Granting origins would let any web page read responses from loopback.
  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function hasDaemonAuth(req: http.IncomingMessage, expectedToken: string): boolean {
  const provided = req.headers["x-gg-daemon-token"];
  return typeof provided === "string" && provided === expectedToken;
}

async function main(): Promise<void> {
  // Hidden persistent-worker dispatch must win before strict JSON/server parsing.
  if (process.argv.includes("--subagent-worker")) {
    await runSubagentWorkerMode();
    return;
  }
  // Sub-agent JSON-mode dispatch must win before any sidecar/server setup.
  if (await runJsonModeIfRequested()) return;

  // Default to an ephemeral port (0) so concurrent/orphaned instances never
  // collide on a fixed port. The actual port is reported via the
  // GG_APP_LISTENING handshake and consumed by the shell.
  const port = Number(process.env.GG_APP_PORT ?? 0);
  const host = "127.0.0.1";
  const daemonAuthToken = process.env.GG_APP_AUTH_TOKEN?.trim();
  // Never leak the bootstrap credential to MCP servers, shells, or other child processes.
  delete process.env.GG_APP_AUTH_TOKEN;
  if (!daemonAuthToken) throw new Error("GG_APP_AUTH_TOKEN is required");

  // Per-launch bearer token. The Rust shell generates one and passes it via
  // GG_APP_TOKEN; spawned any other way (dev, tests, smoke) we mint our own
  // and report it on the GG_APP_LISTENING line. Every request must carry it
  // as x-gg-token: this daemon creates sessions for arbitrary cwds, runs
  // prompts, and installs plugins, so an unauthenticated loopback port lets
  // any local process drive the agent as the user.
  const configuredAuthToken = process.env.GG_APP_TOKEN?.trim();
  delete process.env.GG_APP_TOKEN;
  const authToken = configuredAuthToken || randomUUID();

  const paths = await ensureAppDirs();
  // The shell scopes this filename to its Tauri product identity so production
  // and local-fork daemons never interleave or race log rotation.
  const sidecarLogFile = path.basename(
    process.env.GG_APP_SIDECAR_LOG_FILE?.trim() || "gg-app-sidecar.log",
  );
  const sidecarLog = path.join(paths.agentDir, sidecarLogFile);
  initLogger(sidecarLog);
  const shellPid = process.ppid;
  log("INFO", "app-sidecar", "daemon lifecycle start", {
    daemonPid: process.pid,
    shellPid,
    agentDataRoot: paths.agentDir,
  });
  // The desktop sidecar previously omitted the stream diagnostic hook used by
  // the CLI, leaving device-specific provider stalls impossible to distinguish from
  // event-loop starvation or a broken streaming network path. Keep routine
  // phases lightweight; timeout phases include non-sensitive runtime context.
  setStreamDiagnostic((phase, data) => {
    const includeRuntime =
      phase === "idle_timeout_fired" ||
      phase === "hard_timeout_fired" ||
      phase === "stall_exhausted";
    // A session stuck on the non-streaming fallback costs real money and real
    // latency; it does not belong in the INFO noise floor.
    log(phase === "non_streaming_session" ? "WARN" : "INFO", "stream", phase, {
      ...(data ?? {}),
      ...(includeRuntime
        ? {
            platform: process.platform,
            arch: process.arch,
            osRelease: os.release(),
            node: process.version,
            logicalCpus: os.cpus().length,
            totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
            freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
            rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            processUptimeSec: Math.round(process.uptime()),
          }
        : {}),
    });
  });

  // Global last-resort guards, installed as early as the logger allows so they
  // cover the WHOLE lifecycle — including startup/initialize, the phase the
  // "sidecar did not start in time" bug lives in. The sidecar is a long-lived
  // HTTP server the Rust shell can respawn: a stray rejection or thrown error
  // from one request (e.g. an MCP probe spawning a misbehaving child) must not
  // tear down the whole process and strand the window on its next call. Log and
  // keep serving (mirrors astro/vscode/gstack long-lived-server handlers).
  process.on("unhandledRejection", (reason) => {
    log("ERROR", "app-sidecar", "unhandledRejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on("uncaughtException", (err) => {
    log("ERROR", "app-sidecar", "uncaughtException", {
      message: err.message,
      stack: err.stack,
    });
  });

  // The packaged desktop app launches from Finder/Dock with a minimal PATH that
  // omits Homebrew/Cargo/version-manager dirs, so the agent can't find node,
  // git, python, rg, etc. Enrich process.env.PATH from the login shell once,
  // before anything spawns (bash tool, background tasks, LSP, git helpers all
  // inherit it). Best-effort — never blocks startup beyond its internal cap.
  await enrichProcessPath();

  // Sweep recoverable full tool outputs (~/.gg/tool-output/) older than 48h.
  // Fire-and-forget: cleanup must never delay or break startup.
  void cleanupToolOutputs().catch(() => {});

  const auth = new AuthStorage(paths.authFile);
  await auth.load();

  // Every window's session lives here as an in-process object, keyed by the id
  // the daemon hands back from POST /session. The Rust shell routes each proxy
  // request to its window's session via the `x-gg-session` header (and the
  // `?session=` query for the SSE /events stream).
  const sessions = new AppSidecarSessionRouter<SessionContext>();
  const sharedMcpPool = new SharedMcpClientPool();
  const reloadCoordinator = new AppSidecarReloadCoordinator();

  const broadcastAll = (type: string, data: unknown): void => {
    for (const context of sessions.values()) context.broadcast(type, data);
  };

  const oauthInFlightProviders = new Set<string>();
  const notesRepository = new ProjectNotesRepository(paths.agentDir);
  const roadmapReconciliations = new AppSidecarRoadmapReconciliationCoordinator();
  const roadmapDrafts = new AppSidecarRoadmapDraftCoordinator({
    onChange: (projectKey, draft) => {
      for (const context of sessions.values()) {
        if (canonicalProjectKey(context.cwd) === projectKey) {
          context.broadcast("roadmap_phase_draft_change", draft);
        }
      }
    },
  });
  const projectAutopilot = new AppSidecarProjectAutopilotState();
  const broadcastNotesSnapshot = (snapshot: ProjectNotesSnapshot): void => {
    reminderCoordinator?.observeSnapshot(snapshot);
    for (const context of sessions.values()) {
      if (canonicalProjectKey(context.cwd) === snapshot.projectKey) {
        context.broadcastNotesChange(snapshot);
      }
    }
  };
  const roadmapDraftDecisions = new AppSidecarRoadmapDraftDecisionService({
    drafts: roadmapDrafts,
    repository: notesRepository,
    reconciliations: roadmapReconciliations,
    onCommittedSnapshot: broadcastNotesSnapshot,
  });
  const phaseCancellations = new AppSidecarPhaseCancellationCoordinator({
    repository: notesRepository,
    sessions: () => sessions.values(),
    broadcastSnapshot: broadcastNotesSnapshot,
  });
  const reminderCoordinator = new AppSidecarReminderCoordinator({
    repository: notesRepository,
    onReminderDue: (projectKey) => {
      for (const context of sessions.values()) {
        if (canonicalProjectKey(context.cwd) === projectKey) {
          context.broadcast("roadmap_reminder_due", {});
        }
      }
    },
    onCommitted: broadcastNotesSnapshot,
    onError: (error) => captureSidecarError(error, "app-sidecar.reminders.coordinator"),
  });
  const reminders = createAppSidecarReminderHandler(reminderCoordinator, (error) =>
    captureSidecarError(error, "app-sidecar.reminders.request"),
  );
  const notes = createAppSidecarNotesHandler({
    repository: notesRepository,
    onCommittedSnapshot: broadcastNotesSnapshot,
    onError: (error) => {
      captureSidecarError(error, "app-sidecar.notes.request");
      log("ERROR", "app-sidecar", "notes request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const memoryStore = new MemoryStore({
    onChange: ({ memories }) => {
      for (const ctx of sessions.values()) {
        ctx.broadcast("memory_change", { count: memories.length });
      }
    },
  });
  const jiwaStore = new JiwaStore({
    onChange: ({ jiwa }) => {
      for (const ctx of sessions.values()) {
        ctx.broadcast("jiwa_change", { count: jiwa.length });
      }
    },
  });

  // XP/rank progress — loaded once per daemon; awards fan out to every window.
  // Each frame is tagged `origin: true` only for the session that earned the
  // XP, so that window alone plays sounds/chips while the rest just re-render.
  const progress = await createProgressManager(paths.agentDir, (snapshot, originId) => {
    for (const ctx of sessions.values())
      ctx.broadcast("progress", { ...snapshot, origin: ctx.id === originId });
  });

  type UsageResult =
    | (SubscriptionUsageSnapshot & { connected: true; error?: never; stale?: boolean })
    | {
        provider: SubscriptionUsageProvider;
        displayName: string;
        connected: boolean;
        windows: [];
        fetchedAt: number;
        error?: string;
        stale?: boolean;
      };
  const usageCache = new Map<
    SubscriptionUsageProvider,
    { expiresAt: number; result: UsageResult }
  >();
  const usageRequests = new Map<SubscriptionUsageProvider, Promise<UsageResult>>();
  // Last snapshot that actually carried windows, per provider. Replayed while a
  // fetch is failing so the title meter never blinks out of existence. Bounded
  // by USAGE_LAST_GOOD_MAX_AGE_MS — a provider that never recovers must stop
  // reporting rather than freeze a percentage (and a long-past reset time) on
  // screen forever. The 429 backoff alone runs to 24h, far past any usefulness.
  const usageLastGood = new Map<SubscriptionUsageProvider, UsageResult>();
  const USAGE_LAST_GOOD_MAX_AGE_MS = 30 * 60_000;
  // 429 backoff: quota endpoints are auxiliary UI data. Honor Retry-After when
  // provided; otherwise retain the unavailable snapshot for 30 minutes. Clamp
  // the provider value so a malformed header can neither hammer the endpoint
  // nor suppress usage data forever.
  const usageRateLimitedUntil = new Map<SubscriptionUsageProvider, number>();
  const USAGE_RATE_LIMIT_FALLBACK_BACKOFF_MS = 30 * 60_000;
  const USAGE_RATE_LIMIT_MIN_BACKOFF_MS = 60_000;
  const USAGE_RATE_LIMIT_MAX_BACKOFF_MS = 24 * 60 * 60_000;

  async function fetchUsageProvider(provider: SubscriptionUsageProvider): Promise<UsageResult> {
    const displayName =
      provider === "anthropic" ? "Anthropic" : provider === "openai" ? "Codex" : "Kimi";
    // Kimi plan usage is tracked on the OAuth credential specifically — the
    // Moonshot platform API key is metered per-token, not per plan window.
    const authKey = oauthStorageKey(provider) ?? provider;
    if (!(await auth.hasProviderAuth(authKey))) {
      // Logged out: drop the replay cache so a later login on a DIFFERENT
      // account can never inherit the previous one's numbers.
      usageLastGood.delete(provider);
      return { provider, displayName, connected: false, windows: [], fetchedAt: Date.now() };
    }
    try {
      let credentials = await auth.resolveCredentials(authKey);
      try {
        const snapshot = {
          ...(await fetchSubscriptionUsage(provider, credentials)),
          connected: true as const,
        };
        usageRateLimitedUntil.delete(provider);
        return snapshot;
      } catch (error) {
        // A provider can revoke an access token before its stored expiry. Refresh
        // once on 401, matching inference auth recovery, then retry the usage call.
        if (error instanceof SubscriptionUsageError && error.status === 401) {
          // Name the rejected token. This poller runs on a timer alongside live
          // agent runs, so an unconditional refresh here would invalidate the
          // token those runs are holding and fail them mid-turn — a background
          // status check must never be able to log out the foreground.
          credentials = await auth.resolveCredentials(authKey, {
            forceRefresh: true,
            rejectedToken: credentials.accessToken,
          });
          const snapshot = {
            ...(await fetchSubscriptionUsage(provider, credentials)),
            connected: true as const,
          };
          usageRateLimitedUntil.delete(provider);
          return snapshot;
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldCaptureUsagePollingError(error)) {
        captureSidecarError(error, "app-sidecar.usage.fetch", { provider });
      }
      let backoffMs: number | undefined;
      if (error instanceof SubscriptionUsageError && error.status === 429) {
        backoffMs = Math.min(
          USAGE_RATE_LIMIT_MAX_BACKOFF_MS,
          Math.max(
            USAGE_RATE_LIMIT_MIN_BACKOFF_MS,
            error.retryAfterMs ?? USAGE_RATE_LIMIT_FALLBACK_BACKOFF_MS,
          ),
        );
        usageRateLimitedUntil.set(provider, Date.now() + backoffMs);
      }
      log("WARN", "app-sidecar", "subscription usage fetch failed", {
        provider,
        message,
        ...(backoffMs !== undefined && { backoffMs: String(backoffMs) }),
      });

      const connected = await auth.hasProviderAuth(authKey);
      // Transient failures (notably the 429s these auxiliary quota endpoints
      // hand out) must not blank the meter. Keep serving the last good
      // snapshot, flagged `stale`, so the bar stays put instead of flickering
      // out for the whole backoff window and back in on the next success.
      // Past the max age it's dropped — no data beats confidently wrong data.
      const lastGood = usageLastGood.get(provider);
      if (lastGood && Date.now() - lastGood.fetchedAt >= USAGE_LAST_GOOD_MAX_AGE_MS) {
        usageLastGood.delete(provider);
      } else if (connected && lastGood) {
        return { ...lastGood, stale: true };
      }
      return {
        provider,
        displayName,
        connected,
        windows: [],
        fetchedAt: Date.now(),
        error: connected ? "Usage is temporarily unavailable." : undefined,
      };
    }
  }

  async function subscriptionUsage(provider: SubscriptionUsageProvider): Promise<UsageResult> {
    const cached = usageCache.get(provider);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const inFlight = usageRequests.get(provider);
    if (inFlight) return inFlight;
    const request = fetchUsageProvider(provider);
    usageRequests.set(provider, request);
    try {
      const result = await request;
      // Never re-store a replay — it would keep its original `fetchedAt`, but
      // writing it back muddies the "last GOOD" contract for no gain.
      if (result.connected && !result.error && !result.stale && result.windows.length > 0) {
        usageLastGood.set(provider, result);
      }
      // Anthropic can return utilization before it assigns reset timestamps
      // (notably before the account's first active request). Retry that partial
      // snapshot quickly; complete snapshots keep the normal one-minute cache.
      const missingReset =
        result.connected &&
        result.windows.length > 0 &&
        result.windows.some((window) => window.resetsAt === undefined);
      const rateLimitedUntil = usageRateLimitedUntil.get(provider) ?? 0;
      usageCache.set(provider, {
        result,
        expiresAt:
          rateLimitedUntil > Date.now()
            ? rateLimitedUntil
            : Date.now() + (missingReset ? 10_000 : 60_000),
      });
      return result;
    } finally {
      if (usageRequests.get(provider) === request) usageRequests.delete(provider);
    }
  }

  const server = http.createServer(
    wrapSidecarHandler((req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      // Answer preflights with a bare 204 but grant NO origins — the webview
      // reaches the daemon through the Rust proxy, never cross-origin, so any
      // browser page's preflight must fail here.
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Host allowlist. The daemon binds 127.0.0.1 only; rejecting any other
      // Host blocks DNS rebinding, where a web page's request arrives with
      // the attacker's hostname (browsers cannot spoof Host).
      const reqHost = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(reqHost)) {
        daemonJson(res, 403, { error: "forbidden host" });
        return;
      }

      if (req.headers["x-gg-token"] !== authToken) {
        daemonJson(res, 401, { error: "unauthorized" });
        return;
      }

      // ── Daemon-level routes (session lifecycle) ──────────────────────────
      // Secret-free two-phase reload: reserve while Rust persists native config,
      // then dispose every session and exit only if no pane has active work.
      if (method === "POST" && url === "/admin/reload/prepare") {
        const decision = reloadCoordinator.prepare(sessions.values());
        daemonJson(
          res,
          decision.ok ? 200 : 409,
          decision.ok ? { ok: true } : { error: decision.reason },
        );
        return;
      }
      if (method === "POST" && url === "/admin/reload/cancel") {
        reloadCoordinator.cancel();
        daemonJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && url === "/admin/reload") {
        const decision = reloadCoordinator.begin(sessions.values());
        if (!decision.ok) {
          daemonJson(res, 409, { error: decision.reason });
          return;
        }
        daemonJson(res, 202, { ok: true });
        setImmediate(() => shutdown("configuration_refresh"));
        return;
      }
      const releaseMutation = reloadCoordinator.tryAcquireSessionMutation(method);
      if (!releaseMutation) {
        daemonJson(res, 409, { error: "configuration refresh in progress" });
        return;
      }
      // Keep the lease through asynchronous body reads and route completion. Both
      // events may fire; coordinator releases are intentionally idempotent.
      res.once("finish", releaseMutation);
      res.once("close", releaseMutation);

      // Create a session for a window: { mode?, cwd, sessionPath? } → { sessionId }.
      // Session UUIDs are capabilities, so minting them requires the native shell secret.
      if (method === "POST" && url === "/session") {
        if (!hasDaemonAuth(req, daemonAuthToken)) {
          daemonJson(res, 401, { error: "daemon authentication required" });
          return;
        }
        void daemonReadBody(req, res).then(async (raw) => {
          if (raw === null) return;
          let body: { mode?: unknown; chatAgent?: unknown; cwd?: unknown; sessionPath?: unknown } =
            {};
          try {
            body = raw ? (JSON.parse(raw) as typeof body) : {};
          } catch {
            /* empty/invalid body → defaults below */
          }
          const mode: WorkspaceMode = body.mode === "chat" ? "chat" : "code";
          const chatAgent = parseChatAgentId(body.chatAgent);
          const sessionCwd =
            typeof body.cwd === "string" && body.cwd
              ? body.cwd
              : (process.env.GG_APP_CWD ?? process.cwd());
          const sessionPath =
            typeof body.sessionPath === "string" && body.sessionPath ? body.sessionPath : undefined;
          const id = randomUUID();
          try {
            const ctx = await createSession(
              {
                auth,
                nativeAuthorityToken: daemonAuthToken,
                paths,
                progress,
                memoryStore,
                jiwaStore,
                broadcastAll,
                oauthInFlightProviders,
                reloadCoordinator,
                notes,
                reminders,
                reminderCoordinator,
                notesRepository,
                roadmapReconciliations,
                roadmapDrafts,
                roadmapDraftDecisions,
                projectAutopilot,
                broadcastNotesSnapshot,
                sharedMcpPool,
              },
              { id, mode, chatAgent, cwd: sessionCwd, sessionPath },
            );
            sessions.add(id, ctx);
            await reminderCoordinator.watchSession({ id, cwd: sessionCwd });
            log("INFO", "app-sidecar", "session created", {
              id,
              mode,
              chatAgent,
              cwd: sessionCwd,
            });
            daemonJson(res, 200, { sessionId: id });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            captureSidecarError(err, "app-sidecar.session.create");
            log("ERROR", "app-sidecar", "session create failed", { message });
            daemonJson(res, 500, { error: message });
          }
        });
        return;
      }

      // Dispose a session: DELETE /session/:id.
      if (method === "DELETE" && url.startsWith("/session/")) {
        const id = decodeURIComponent(url.slice("/session/".length));
        // deleteAndDispose takes ownership out of the registry synchronously before
        // awaiting disposal, so peer requests fail closed instead of reaching a
        // context that is shutting down.
        void sessions
          .deleteAndDispose(id)
          .then((disposed) => {
            if (disposed) log("INFO", "app-sidecar", "session disposed", { id });
            daemonJson(res, 200, { ok: true });
          })
          .catch((error) => {
            captureSidecarError(error, "app-sidecar.session.dispose");
            log("ERROR", "app-sidecar", "session disposal failed", {
              id,
              message: error instanceof Error ? error.message : String(error),
            });
            daemonJson(res, 500, { error: "session disposal failed" });
          });
        return;
      }

      // Progress is daemon-level so the Home screen can paint before a project
      // session exists; per-session callers still work through the same endpoint.
      if (method === "GET" && url === "/progress") {
        daemonJson(res, 200, progress.snapshot());
        return;
      }

      // Subscription quota is account-wide, not project/session-specific. OAuth
      // tokens stay in this daemon; only the active provider's normalized snapshot
      // reaches the webview.
      if (method === "GET" && (url === "/usage" || url.startsWith("/usage?"))) {
        void (async () => {
          const provider = new URL(url, `http://${host}`).searchParams.get("provider");
          if (provider !== "anthropic" && provider !== "openai" && provider !== "moonshot") {
            daemonJson(res, 400, { error: "unsupported usage provider" });
            return;
          }
          daemonJson(res, 200, await subscriptionUsage(provider));
        })().catch((error) => {
          captureSidecarError(error, "app-sidecar.usage.request");
          log("ERROR", "app-sidecar", "subscription usage request failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          daemonJson(res, 500, { error: "Usage is temporarily unavailable." });
        });
        return;
      }

      // ── Per-session delegation ───────────────────────────────────────────
      const isEventStream = method === "GET" && (url === "/events" || url.startsWith("/events?"));
      const ctx = sessions.resolveRequest(req, url, { allowQuery: isEventStream, host });
      if (!ctx) {
        daemonJson(res, 404, { error: "unknown session" });
        return;
      }

      const phaseCancellationMatch =
        method === "POST" ? /^\/phases\/([^/]+)\/cancel$/.exec(url) : null;
      if (phaseCancellationMatch) {
        let phaseId: string;
        try {
          phaseId = decodeURIComponent(phaseCancellationMatch[1] ?? "");
        } catch {
          daemonJson(res, 400, { error: "invalid phase id" });
          return;
        }
        void phaseCancellations
          .cancel(ctx.cwd, phaseId)
          .then((result) => daemonJson(res, 200, result))
          .catch((error) => {
            captureSidecarError(error, "app-sidecar.phase.cancel");
            daemonJson(res, 500, { error: "phase cancellation failed" });
          });
        return;
      }

      ctx.handle(req, res, url, method);
    }, "app-sidecar.http"),
  );
  server.listen(port, host, () => {
    const addr = server.address() as AddressInfo;
    // The Rust shell reads this line to learn the daemon port (it already
    // knows the token — it set GG_APP_TOKEN; the field serves other spawners).
    process.stdout.write(`GG_APP_LISTENING ${addr.port} ${authToken}\n`);
    log("INFO", "app-sidecar", "daemon listening", { port: String(addr.port), host });
  });

  type ShutdownReason =
    | "configuration_refresh"
    | "SIGINT"
    | "SIGTERM"
    | "SIGHUP"
    | "parent_unavailable";
  let terminationReason: ShutdownReason | "event_loop_exit" = "event_loop_exit";
  let shutdownRequested = false;
  let shutdownSessionCount = 0;

  // Session teardown awaits MCP servers, LSP servers and third-party extension
  // `deactivate()` hooks. Any of those can hang, and an unbounded await here
  // means the daemon never exits: the app looks quit while this process keeps
  // the port and the radio stream alive. The deadline exits regardless.
  const requestShutdown = installTerminationHandlers({
    scope: "app-sidecar",
    onShutdownStart: (signal) => {
      shutdownRequested = true;
      if (signal) terminationReason = signal;
      shutdownSessionCount = [...sessions.values()].length;
      log("INFO", "app-sidecar", "daemon termination requested", {
        daemonPid: process.pid,
        shellPid,
        reason: terminationReason,
      });
    },
    teardown: async () => {
      clearInterval(parentWatch);
      // Radio playback is app-wide (one stream across all windows), so it stops
      // at the daemon level, not per session.
      stopRadio();
      // Close the ~/.gg progress fs.watch handle (baseline #8 leak fix).
      progress.dispose();
      reminderCoordinator.dispose();
      await sessions.disposeAll();
      await sharedMcpPool.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log("INFO", "app-sidecar", "daemon shutdown complete", {
        daemonPid: process.pid,
        shellPid,
        reason: terminationReason,
      });
    },
    onTimeout: (timeoutMs) => {
      // Radio is audible, so it must stop even when the rest is wedged.
      stopRadio();
      log("WARN", "app-sidecar", "daemon teardown hung; exiting on deadline", {
        timeoutMs: String(timeoutMs),
        sessions: String(shutdownSessionCount),
      });
    },
  });

  function shutdown(reason: ShutdownReason): void {
    if (shutdownRequested) return;
    shutdownRequested = true;
    terminationReason = reason;
    requestShutdown(0);
  }

  process.once("exit", (code) => {
    stopRadio();
    log("INFO", "app-sidecar", "daemon lifecycle exit", {
      daemonPid: process.pid,
      shellPid,
      reason: terminationReason,
      exitCode: code,
    });
  });

  // Tauri can disappear without delivering a signal (force-quit, dev runner
  // teardown, crash). Detect reparenting or a dead shell so the daemon and its
  // radio player do not survive as audible orphans.
  const parentWatch = setInterval(() => {
    let parentAlive = process.ppid === shellPid;
    if (parentAlive && shellPid > 1) {
      try {
        process.kill(shellPid, 0);
      } catch (error) {
        parentAlive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (!parentAlive) shutdown("parent_unavailable");
  }, 1_000);
  parentWatch.unref?.();
}

/** MCP servers Ken is allowed to use. kencode-search lets him look into real
 *  public repos / verify against actual code instead of assuming — core to how
 *  he's meant to work. Read-only research; no other MCP server is connected. */
const KEN_ALLOWED_MCP_SERVERS = ["kencode-search"];

/** Extract the plain text of the most recent assistant message (Ken's reply).
 *  Strips tool-call / image blocks, returning just the prose Ken streamed. */
function lastAssistantText(messages: ReturnType<AgentSession["getMessages"]>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .map((c) => (c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

/**
 * Assemble Ken's context digest for one `@Ken` question: git/env + the build
 * session's compaction summary + recent activity. Prepended to the user's
 * question as Ken's prompt body each turn. Project docs (CLAUDE.md/AGENTS.md)
 * are NOT here — they're folded into Ken's cached system prompt once per
 * session instead (see ken-prompt.ts), so they hit the provider prompt cache
 * instead of being re-sent uncached on every question. Workflow commands +
 * autopilot-injected prompts are passed through so the digest labels them as
 * what they are instead of user-authored asks.
 */
function buildKenContext(
  buildSession: AgentSession,
  cwd: string,
  gitBranch: string | null,
  question: string,
  workflowCommands: readonly WorkflowCommandSpec[],
  injectedPrompts: readonly string[],
): string {
  return buildKenDigest({
    question,
    cwd,
    gitBranch,
    messages: buildSession.getMessages(),
    workflowCommands,
    injectedPrompts,
  });
}

// ── Progress ("Ranks") ──────────────────────────────────────────────────
// Daemon-level XP/rank manager: one durable file (~/.gg/progress.json), awards
// applied under a file lock, snapshots broadcast to EVERY session's SSE clients,
// and an fs.watch on ~/.gg so writes from OTHER daemon processes (dev + packaged
// app side by side) re-broadcast here too — deduped by the lastEvent nonce.
// XP failures are debug-log-only; progress must never break a run.

interface ProgressManager {
  /** Current snapshot for GET /progress + the SSE ready path. */
  snapshot: () => ProgressSnapshot;
  /** Award XP for one successfully completed run (prompt + any new commits). */
  awardRun: (cwd: string, runStartedAt: number, originId?: string) => Promise<void>;
  /** Close the ~/.gg fs.watch + clear any pending debounce (leak-free shutdown). */
  dispose: () => void;
}

async function createProgressManager(
  agentDir: string,
  broadcastAll: (snapshot: ProgressSnapshot, originId?: string) => void,
): Promise<ProgressManager> {
  // Boot: recovery chain main → backup → coding + chat session rebuild → empty.
  const coderSessionsDir = path.join(agentDir, "sessions");
  let file: ProgressFile = await loadProgress({
    rebuild: () =>
      rebuildFromSessions([
        coderSessionsDir,
        ...CHAT_AGENT_IDS.map((agentId) => chatAgentSessionsDir(coderSessionsDir, agentId)),
      ]),
  });
  // Don't re-celebrate an old levelUp event on boot.
  let lastSeenNonce: string | null = file.lastEvent?.nonce ?? null;
  log("INFO", "app-sidecar", "progress loaded", {
    xp: String(file.xp),
    level: String(levelForXp(file.xp)),
  });

  function snapshot(): ProgressSnapshot {
    return buildSnapshot(file);
  }

  async function awardRun(cwd: string, runStartedAt: number, originId?: string): Promise<void> {
    try {
      const now = Date.now();
      const updated = await updateProgress(async (f) => {
        const levelBefore = levelForXp(f.xp);
        awardPrompt(f, now, cwd);

        // Commit XP: probe repo root + HEAD, then score lastHead..HEAD bounded
        // by the run window. First sight of a repo records HEAD, scores nothing.
        const probe = await detectNewCommits(cwd, undefined, runStartedAt);
        if (probe) {
          const key = repoKey(probe.repoRoot);
          const lastHead = f.repos[key]?.lastHead;
          if (lastHead && lastHead !== probe.head) {
            const detected = await detectNewCommits(cwd, lastHead, runStartedAt);
            if (detected && detected.commits.length > 0) {
              awardCommits(f, detected.commits, now, cwd);
            }
          }
          f.repos[key] = { lastHead: probe.head };
        }

        // One combined lastEvent per run so other windows celebrate exactly once.
        const levelAfter = levelForXp(f.xp);
        const levelUp =
          levelAfter > levelBefore
            ? { from: levelBefore, to: levelAfter, rankName: rankForLevel(levelAfter).name }
            : null;
        f.lastEvent = { nonce: randomUUID(), levelUp };
        return { file: f, levelledUp: levelUp !== null };
      });
      file = updated;
      lastSeenNonce = updated.lastEvent?.nonce ?? null;
      broadcastAll(buildSnapshot(updated), originId);
    } catch (err) {
      captureSidecarError(err, "app-sidecar.progress.award");
      log("DEBUG", "app-sidecar", "progress award failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Watch ~/.gg (dir watch survives the atomic tmp+rename) for progress.json
  // writes from other daemon processes; debounce, reload read-only, dedupe by nonce.
  let watchDebounce: NodeJS.Timeout | null = null;
  let progressWatcher: ReturnType<typeof fsWatch> | null = null;
  try {
    const watcher = fsWatch(agentDir, (_event, filename) => {
      if (filename !== "progress.json") return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        void (async () => {
          const reloaded = await peekProgress();
          if (!reloaded) return;
          const nonce = reloaded.lastEvent?.nonce ?? null;
          if (nonce === lastSeenNonce) return;
          file = reloaded;
          lastSeenNonce = nonce;
          broadcastAll(buildSnapshot(reloaded));
        })();
      }, 150);
    });
    watcher.unref();
    progressWatcher = watcher;
  } catch (err) {
    captureSidecarError(err, "app-sidecar.progress.watch");
    log("DEBUG", "app-sidecar", "progress watch unavailable", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Dispose closes the fs.watch handle (baseline #8: it was previously never
  // closed — a per-daemon leak) and clears any pending debounce timer.
  function dispose(): void {
    if (watchDebounce) {
      clearTimeout(watchDebounce);
      watchDebounce = null;
    }
    try {
      progressWatcher?.close();
    } catch {
      // Already closed / never opened — nothing to do.
    }
    progressWatcher = null;
  }

  return { snapshot, awardRun, dispose };
}

type WorkspaceMode = "code" | "chat";

interface SessionContext {
  id: string;
  mode: WorkspaceMode;
  chatAgent: ChatAgentId;
  cwd: string;
  sessionPath?: string;
  session: AgentSession;
  clients: Set<SseClient>;
  broadcast: (type: string, data: unknown) => void;
  broadcastNotesChange: (snapshot: ProjectNotesSnapshot) => void;
  getActivePhaseContext: () => ReturnType<AgentSession["getActivePhaseContext"]>;
  cancelActiveOperation: () => Promise<ActiveOperationCancellationResult>;
  /** Handle one HTTP request for this session. Owns its own 404 fallthrough. */
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => void;
  dispose: () => Promise<void>;
  isRunning: () => boolean;
}

/**
 * Build one in-process agent session: its AgentSession, SSE client set, event
 * bridge, task runner, auth/login bridge, and the full HTTP route table exposed
 * as a `handle()` method. Many of these live inside one daemon process, fully
 * isolated (separate AgentSession, cwd, history, model) — only the HTTP server,
 * logger, PATH, shared auth file, and radio live at the daemon level.
 */
async function createSession(
  deps: {
    auth: AuthStorage;
    nativeAuthorityToken: string;
    paths: Awaited<ReturnType<typeof ensureAppDirs>>;
    progress: ProgressManager;
    memoryStore: MemoryStore;
    jiwaStore: JiwaStore;
    /** Fan one frame out to EVERY window, not just this session's. */
    broadcastAll: (type: string, data: unknown) => void;
    /** Providers with an OAuth flow in progress in some window. */
    oauthInFlightProviders: Set<string>;
    reloadCoordinator: AppSidecarReloadCoordinator;
    notes: AppSidecarNotesHandler;
    reminders: AppSidecarReminderHandler;
    reminderCoordinator: AppSidecarReminderCoordinator;
    notesRepository: ProjectNotesRepository;
    roadmapReconciliations: AppSidecarRoadmapReconciliationCoordinator;
    roadmapDrafts: AppSidecarRoadmapDraftCoordinator;
    roadmapDraftDecisions: AppSidecarRoadmapDraftDecisionService;
    projectAutopilot: AppSidecarProjectAutopilotState;
    broadcastNotesSnapshot: (snapshot: ProjectNotesSnapshot) => void;
    sharedMcpPool: SharedMcpClientPool;
  },
  opts: {
    id: string;
    mode: WorkspaceMode;
    chatAgent: ChatAgentId;
    cwd: string;
    sessionPath?: string;
  },
): Promise<SessionContext> {
  const {
    auth,
    nativeAuthorityToken,
    progress,
    memoryStore,
    jiwaStore,
    broadcastAll,
    oauthInFlightProviders,
    reloadCoordinator,
    notes,
    reminders,
    reminderCoordinator,
    notesRepository,
    roadmapReconciliations,
    roadmapDrafts,
    roadmapDraftDecisions,
    projectAutopilot,
    broadcastNotesSnapshot,
    sharedMcpPool,
  } = deps;
  const paths = deps.paths;
  const mode = opts.mode;
  let chatAgent = opts.chatAgent;
  const cwd = opts.cwd;
  // Base host for parsing request-URL query params (value is irrelevant to
  // parsing); the daemon owns the real listen host.
  const host = "127.0.0.1";
  const sessionMutations = new AppSidecarSessionMutationCoordinator();
  const phaseCompletion = new AppSidecarPhaseCompletionCoordinator({
    cwd,
    repository: notesRepository,
    broadcastSnapshot: broadcastNotesSnapshot,
    onError: (error) => captureSidecarError(error, "app-sidecar.phase-completion"),
  });
  const phaseImplementationPlans = new AppSidecarPhaseImplementationPlanTracker();

  const saved = loadSavedSettings(paths.settingsFile);
  // Native login/logout and other live sessions share auth.json. Refresh the
  // daemon-level snapshot before choosing this session's provider so a project
  // never boots against credentials that were just replaced or disconnected.
  await auth.load();
  // Per-project model/thinking prefs win over the shared global settings.json:
  // each window (one project cwd) restores its own selection instead of every
  // window reading the same single global slot that the last writer clobbered
  // (the old bug — switching models in one window reset every other window).
  const projectPrefs = await loadProjectModelPrefs(cwd);
  const preferred: Provider = projectPrefs?.provider ?? saved.provider ?? "anthropic";
  const savedModel = projectPrefs?.model ?? saved.model;
  // Boot-tolerant: when no provider is configured this returns a logged-out
  // fallback instead of throwing, so the sidecar still listens and the login
  // endpoints are reachable for a fresh user (throwing here used to kill the
  // sidecar before server.listen, making first-time login impossible).
  const { provider, model, loggedIn } = await resolveStartOrFallback(
    auth,
    ALL_PROVIDERS,
    preferred,
    savedModel,
  );
  if (!loggedIn) {
    log("WARN", "app-sidecar", "no provider configured — booting logged-out for login", {
      fallbackProvider: provider,
    });
  }

  // Per-project thinking prefs win over the global settings.json fallback.
  // Restore the endpoint-aware upstream default, then clamp it against the
  // resolved deployment identity so an Azure reload cannot retain an invalid level.
  const thinkEnabled = projectPrefs?.thinkingEnabled ?? saved.thinkingEnabled;
  const restoredThinkingLevel: ThinkingLevel | undefined = thinkEnabled
    ? (projectPrefs?.thinkingLevel ??
      saved.thinkingLevel ??
      getDefaultThinkingLevel(model, { baseUrl: auth.getStoredBaseUrl(provider) }))
    : undefined;
  const thinkingLevel = resolveInitialThinkingLevel(
    provider,
    model,
    thinkEnabled,
    restoredThinkingLevel,
  );
  if (
    projectPrefs &&
    projectPrefs.provider === provider &&
    thinkingLevel !== restoredThinkingLevel
  ) {
    await saveProjectModelPrefs(cwd, {
      provider,
      model,
      thinkingEnabled: !!thinkingLevel,
      thinkingLevel,
    });
  }

  // ── SSE fan-out (declared before the session so plan callbacks can use it) ─
  const clients = new Set<SseClient>();
  let clientSeq = 0;

  function sseFrame(type: string, data: unknown): string {
    const taggedPayload = sessionEventFrame(opts.id, type, data);
    const safePayload = redactValue(taggedPayload, { secrets: environmentSecrets(process.env) });
    return `data: ${JSON.stringify(safePayload)}\n\n`;
  }

  function broadcast(type: string, data: unknown): void {
    const frame = sseFrame(type, data);
    for (const client of clients) {
      try {
        if (client.res.destroyed) clients.delete(client);
        else client.res.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  }

  function broadcastNotesChange(snapshot: ProjectNotesSnapshot): void {
    broadcast("notes_change", snapshot);
  }

  // Replace CLI-specific guidance (slash commands, CLI tool names) with
  // desktop-app equivalents so the webview never shows "run ggcoder login".
  // Applied to BOTH the message and guidance fields — the auth "Not logged in…
  // Run "ggcoder login"" string lives in `message`, not `guidance`.
  function desktopGuidance(guidance: string): string {
    return (
      guidance
        // Auth: `Run "ggcoder login"` / `Run 'ggcoder login'` / `Run `ggcoder login``
        // (any quote style, or none) → button. Do this first so the whole phrase
        // is rewritten cleanly instead of leaving a dangling `Run "…"`.
        .replaceAll(/Run ["'`]?ggcoder login["'`]?/gi, "Use the Login to AI Providers button")
        // Any remaining bare mention.
        .replaceAll(/ggcoder login/gi, "the Login to AI Providers button")
        // /compact: the app has NO manual compact command or button — it only
        // auto-compacts (and now auto-recovers on overflow). If this guidance is
        // reached, auto-compaction already couldn't reduce enough, so the only
        // real affordance is a fresh session. Don't tell the user to run a
        // command that doesn't exist in the app.
        .replaceAll(
          /Run \/compact to shrink history, or start a new session\./gi,
          "Start a new session to reset the context.",
        )
        // /model: handle each phrasing pattern
        .replaceAll(
          /switch to claude-fable-5 with \/model/gi,
          "switch to claude-fable-5 using the model selector",
        )
        .replaceAll(/Switch with \/model\./gi, "Switch using the model selector.")
        .replaceAll(
          /try a different model with \/model\./gi,
          "try a different model using the model selector.",
        )
        .replaceAll(/Use \/model to switch/gi, "Use the model selector to switch")
        // /help
        .replaceAll(/see \/help/gi, "check the help menu")
    );
  }

  // Turn any thrown value into the same clear headline/message/guidance shape
  // the TUI shows (see gg-ai's formatError) instead of a bare `err.message`, log
  // the full detail, and broadcast it under `type` ("error" or "ken_error").
  // Without this the webview only ever saw a raw provider string like
  // `400 {"code":"400",...}` with no "is this me or them / when does it reset"
  // context that the CLI has always given.
  const sidecarErrorSecrets = sidecarSensitiveValues(process.env);

  function broadcastError(
    type: "error" | "ken_error" | "autopilot_error",
    logLabel: string,
    err: unknown,
  ): void {
    const formatted = formatSidecarError(err, desktopGuidance, sidecarErrorSecrets);
    captureSidecarError(err, `app-sidecar.${logLabel.replaceAll(" ", "-")}`, {
      scope: type,
    });
    log("ERROR", "app-sidecar", logLabel, formatted.logFields);
    broadcast(type, formatted.event);
    // Persist the error row (display-only marker) so a resumed session shows
    // the same headline/message/guidance the live run did. Best-effort.
    void session
      .persistAppMarker("error", {
        scope: type,
        headline: formatted.event.headline,
        ...(formatted.event.message ? { message: formatted.event.message } : {}),
        guidance: formatted.event.guidance,
      })
      .catch(() => {});
  }

  // ── MCP elicitation bridge ─────────────────────────────────
  // An MCP server can ask for user input in the middle of a tool call. The
  // bridge parks the promise; we broadcast the prompt over SSE and resolve it
  // when the webview POSTs /mcp/elicit/:id.
  const elicitations = createElicitationBridge({
    broadcast: (prompt) => broadcast("mcp_elicit", prompt),
    onTimeout: (prompt) =>
      log("WARN", "app-sidecar", "MCP elicitation timed out", {
        id: prompt.id,
        server: prompt.server,
      }),
  });

  // The session file path to resume (passed by the daemon's POST /session);
  // empty/unset starts a fresh session.
  const resumeSessionPath = opts.sessionPath;

  let abort = new AbortController();
  const baseSessionOptions = {
    provider,
    model,
    cwd,
    thinkingLevel,
    sessionId: resumeSessionPath,
    signal: abort.signal,
    // Keep MCP startup off the readiness path in both modes.
    backgroundMcpConnect: true,
    sharedMcpPool,
    onMcpElicit: elicitations.onElicit,
    // Keep restore-time auto-compaction off the readiness path too: its summary
    // LLM call (30s timeout) used to freeze waitForReady — and with it the whole
    // window (project picker, session list) — whenever a resumed session was
    // over the context threshold. First prompt compacts instead, with UI events.
    deferLoadCompaction: true,
  };
  let session!: AgentSession;
  let planGate!: AppSidecarPlanGate;
  const persistPlanGateMarker = (checkpoint: PersistedPlanReviewCheckpoint) =>
    session.persistRequiredAppMarker("plan_gate", checkpoint as unknown as Record<string, unknown>);
  const roadmapReviewScheduler = new AppSidecarRoadmapReviewScheduler();
  const roadmapReviewRuns =
    new AppSidecarRoadmapReviewRunCoordinator<AppSidecarFinalReviewAttempt>();
  let settledRoadmapReviewVerdict: { verdict: AutopilotVerdict | null } | null = null;
  const roadmapToolHost = new AppSidecarRoadmapToolHost({
    cwd,
    repository: notesRepository,
    reconciliations: roadmapReconciliations,
    projectAutopilot,
    canSubmitFinalReview: (actor) =>
      actor !== "ken-autopilot" || (!autopilotCancelled && projectAutopilot.isEnabled(cwd)),
    getAutopilotFinalReviewClaim: () => roadmapReviewRuns.activeClaim(),
    onFinalReview: (attempt) => {
      if (attempt.actor === "ken-autopilot") roadmapReviewRuns.record(attempt);
    },
    onReviewReady: (trigger, metadata) => {
      const outcome = roadmapReviewScheduler.enqueue(trigger);
      log("INFO", "app-sidecar", "roadmap final-review scheduled", {
        traceId: trigger.triggerId,
        phaseId: trigger.phaseId,
        observedRevision: metadata.revision,
        transition: metadata.transition,
        queueOutcome: outcome.status,
      });
      return outcome;
    },
    broadcastNotesSnapshot,
    onError: (error, metadata) =>
      captureSidecarError(error, "app-sidecar.roadmap-status", metadata),
  });
  const roadmapDraftToolHost = new AppSidecarRoadmapDraftToolHost({
    cwd,
    repository: notesRepository,
    drafts: roadmapDrafts,
    getOwningSession: () => session,
  });
  const createCodingSession = (
    sessionPath?: string,
    active?: { provider: Provider; model: string; thinkingLevel?: ThinkingLevel },
  ): AgentSession => {
    const created: AgentSession = new AgentSession({
      ...baseSessionOptions,
      ...(active ?? {}),
      sessionId: sessionPath,
      signal: abort.signal,
      onEnterPlan: async (reason) => {
        deactivateApprovedPlan();
        await created.setPlanMode(true);
        broadcast("plan_progress", { total: 0, completed: [] });
        broadcast("plan_enter", { reason: reason ?? "" });
        void created.persistAppMarker("plan", { reason: reason ?? "" }).catch(() => {});
      },
      onExitPlan: async (planPath: string, content: string) => {
        const checkpoint = await planGate.submit(planPath, content);
        await created.setPlanMode(false);
        broadcast("plan_exit", {
          checkpointId: checkpoint.checkpointId,
          generation: checkpoint.generation,
          planPath: checkpoint.planPath,
          content: checkpoint.content,
          contentHash: checkpoint.contentHash,
        });
        return "Plan submitted for user review. Wait for the user to approve, reject, or dismiss it before implementing.";
      },
      ...createAppSidecarCodingRoadmapSessionOptions(
        roadmapToolHost.createSessionTools("coding", () => created),
        roadmapDraftToolHost.createSessionTools(),
      ),
    });
    return created;
  };
  if (mode === "chat") {
    session = createChatAgent(chatAgent, {
      ...baseSessionOptions,
      sessionsDir: paths.sessionsDir,
      additionalTools: [...buildMemoryTools(memoryStore), ...buildJiwaTools(jiwaStore)],
      ...createAppSidecarChatRoadmapSessionOptions(roadmapDraftToolHost.createSessionTools()),
      getSystemPromptTail: () =>
        `${memoryStore.renderForPrompt()}\n\n${jiwaStore.renderForPrompt()}`,
      onAgentChange: async (nextAgent) => {
        chatAgent = nextAgent;
        broadcast("chat_agent_change", { chatAgent: nextAgent });
        await session.persistAppMarker("agent_handoff", { chatAgent: nextAgent }).catch((error) => {
          captureSidecarError(error, "app-sidecar.chat-agent.persist-handoff");
          log("WARN", "app-sidecar", "agent handoff marker persist failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });
  } else {
    session = createCodingSession(resumeSessionPath);
  }
  await session.initialize();
  planGate = new AppSidecarPlanGate(session.getAppMarkers(), persistPlanGateMarker);
  if (mode === "code") {
    await reconcileActivePhaseVerificationStage({ cwd, repository: notesRepository, session });
  }
  const phaseLifecycle = new AppSidecarPhaseLifecycleCoordinator({
    cwd,
    repository: notesRepository,
    getActivePhase: () => {
      const active = session.getActivePhaseContext();
      return active
        ? {
            phaseId: active.phase.id,
            session: active.session,
            executionStage: active.executionStage,
          }
        : undefined;
    },
    broadcastSnapshot: broadcastNotesSnapshot,
    onError: (error, signal) =>
      captureSidecarError(error, "app-sidecar.phase.lifecycle", { signal: signal.type }),
  });
  const phaseCandidates = new AppSidecarPhaseCandidateStore<BoundPhaseCandidate<AgentSession>>();
  if (mode === "chat") {
    const restoredAgent = [...session.getAppMarkers()]
      .reverse()
      .find((marker) => marker.kind === "agent_handoff")?.data.chatAgent;
    if (typeof restoredAgent === "string") {
      chatAgent = parseChatAgentId(restoredAgent);
      await switchChatAgent(session, chatAgent, false);
    }
  }
  log("INFO", "app-sidecar", "session ready", { provider, model, mode, chatAgent, cwd });

  // ── Local models (Ollama, plus user-added custom endpoints) ──
  // Probing endpoints must never delay readiness, so this runs in the
  // background (same shape as backgroundMcpConnect) and pushes a models_change
  // frame when it lands.
  let localProbes: LocalEndpointProbe[] = [];

  async function scanLocalModels(force: boolean): Promise<LocalEndpointProbe[]> {
    const endpoints = await listAllEndpoints();
    const { probes, models } = await discoverLocalModels(endpoints, { force });
    localProbes = probes;
    // Only endpoints that answered get a credential: writing one for a server
    // that isn't running would make `hasProviderAuth("local")` true forever.
    await syncEndpointCredentials(
      probes.filter((probe) => probe.reachable).map((probe) => probe.endpoint),
    );
    clearRuntimeModels((m) => m.provider === "local");
    registerRuntimeModels(models);
    log("INFO", "app-sidecar", "local model scan", {
      reachable: probes.filter((p) => p.reachable).length + "/" + probes.length,
      models: String(models.length),
    });
    return probes;
  }

  /** Endpoint rows + models, in the shape the Local models UI renders. */
  function localStatePayload(): {
    endpoints: {
      id: string;
      label: string;
      baseUrl: string;
      kind: LocalEndpoint["kind"];
      custom: boolean;
      reachable: boolean;
      reason?: string;
      models: {
        id: string;
        rawId: string;
        contextWindow: number;
        contextWindowKnown: boolean;
        supportsTools: boolean;
        supportsImages: boolean;
        supportsThinking: boolean;
        loaded?: boolean;
      }[];
    }[];
  } {
    return {
      endpoints: localProbes.map((probe) => ({
        id: probe.endpoint.id,
        label: probe.endpoint.label,
        baseUrl: probe.endpoint.baseUrl,
        kind: probe.endpoint.kind,
        custom: probe.endpoint.custom === true,
        reachable: probe.reachable,
        ...(probe.reason ? { reason: probe.reason } : {}),
        models: probe.models.map((m) => ({
          id: formatLocalModelId(probe.endpoint.id, m.rawId),
          rawId: m.rawId,
          contextWindow: m.contextWindow,
          contextWindowKnown: m.contextWindowKnown,
          supportsTools: m.supportsTools,
          supportsImages: m.supportsImages,
          supportsThinking: m.supportsThinking,
          ...(m.loaded === undefined ? {} : { loaded: m.loaded }),
        })),
      })),
    };
  }

  // ── Hugging Face → Ollama pulls (the "Add from Hugging Face" modal) ──
  // One pull at a time: multi-GB downloads, one progress surface. State lives
  // here (not in the webview) so a closed modal or app restart mid-pull keeps
  // streaming; the terminal state is kept until the next pull so reopening the
  // modal shows how the last one ended.
  interface HfPullState {
    repo: string;
    model: string;
    tag: string | null;
    file: string;
    sizeBytes: number;
    phase: PullPhase;
    percent: number;
    detail?: string;
    error?: string;
    child: ChildProcess | null;
  }
  let hfPull: HfPullState | null = null;

  const hfPullPayload = (s: HfPullState): Record<string, unknown> => ({
    repo: s.repo,
    model: s.model,
    tag: s.tag,
    file: s.file,
    sizeBytes: s.sizeBytes,
    phase: s.phase,
    percent: s.percent,
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.error ? { error: s.error } : {}),
  });

  /** Stored HF token, if the user connected the huggingface provider. */
  async function hfToken(): Promise<string | undefined> {
    try {
      const auth = new AuthStorage(paths.authFile);
      const creds = await auth.resolveCredentials("huggingface");
      return creds.accessToken || undefined;
    } catch {
      return undefined;
    }
  }

  async function hfHubJson(pathname: string): Promise<unknown> {
    const token = await hfToken();
    const res = await fetch(`https://huggingface.co${pathname}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Hugging Face responded ${res.status}`);
    return res.json();
  }

  /** Search the Hub for GGUF repos (what Ollama can pull). */
  async function hfSearch(query: string): Promise<HfSearchRow[]> {
    // `filter=gguf` (the tag the Hub applies to repos that actually contain
    // GGUF files) — `library=gguf` also matches safetensors-only base repos,
    // which then fail at pull time. `expand[]=gguf` confirms per row.
    const params = new URLSearchParams({
      search: query,
      filter: "gguf",
      sort: "downloads",
      direction: "-1",
      limit: "12",
    });
    for (const field of ["gguf", "downloads", "likes", "lastModified"]) {
      params.append("expand[]", field);
    }
    const data = (await hfHubJson(`/api/models?${params.toString()}`)) as {
      id?: unknown;
      downloads?: unknown;
      likes?: unknown;
      lastModified?: unknown;
      gguf?: unknown;
    }[];
    return (Array.isArray(data) ? data : [])
      .map(toHfSearchRow)
      .filter((r): r is HfSearchRow => r !== null);
  }

  /**
   * Start `ollama pull hf.co/<repo>[:quant]`. Resolves once the child is
   * spawned; progress streams as `hf_pull` events. The chosen quant comes from
   * the repo's real file list — the client only ever sends a repo id, so there
   * is no injection surface into argv.
   */
  async function startHfPull(repo: string): Promise<Record<string, unknown>> {
    if (hfPull?.child) {
      throw Object.assign(new Error("A download is already running."), { status: 409 });
    }
    // `recursive=true`: many repos (unsloth, mradermacher) keep quants in
    // per-quant subfolders, and a flat listing reports them as GGUF-less.
    const tree = (await hfHubJson(`/api/models/${repo}/tree/main?recursive=true`)) as unknown[];
    const files: GgufFile[] = (Array.isArray(tree) ? tree : []).flatMap((entry) => {
      const e = entry as {
        path?: unknown;
        type?: unknown;
        size?: unknown;
        lfs?: { size?: unknown };
      };
      // `type` guards a directory entry (size 0) from beating real files in the
      // size fallback; the Hub marks folders as "directory".
      if (e.type !== undefined && e.type !== "file") return [];
      if (typeof e.path !== "string" || !e.path.toLowerCase().endsWith(".gguf")) return [];
      const size = Number(e.lfs?.size ?? e.size ?? 0);
      return [{ path: e.path, sizeBytes: Number.isFinite(size) ? size : 0 }];
    });
    const choice = pickGgufQuant(files);
    if (!choice) {
      const sharded = files.some((f) => isGgufShard(f.path));
      throw Object.assign(
        new Error(sharded ? SHARDED_MESSAGE : "That repo has no GGUF file for Ollama to pull."),
        { status: 400 },
      );
    }
    const model = `hf.co/${repo}${choice.tag ? `:${choice.tag}` : ""}`;
    const token = await hfToken();
    const state: HfPullState = {
      repo,
      model,
      tag: choice.tag,
      file: choice.file.path,
      sizeBytes: choice.file.sizeBytes,
      phase: "preparing",
      percent: 0,
      child: null,
    };
    hfPull = state;
    broadcast("hf_pull", hfPullPayload(state));

    // ollama prints progress to stderr (stdout on some builds); parse both.
    let stderrTail = "";
    let lastBroadcast = "";
    const feed = (chunk: string): void => {
      // Once the pull is terminal (success, failure, or user cancel) stop
      // parsing: a killed ollama dumps a burst of stderr that would otherwise
      // spam the modal with garbage frames after the outcome is already shown.
      if (state.phase === "success" || state.phase === "error") return;
      for (const line of chunk.split(/\r\n|\r|\n/)) {
        const parsed = parseOllamaPullLine(line);
        if (!parsed) continue;
        // A redrawn frame repeats `pulling manifest` next to live progress; it
        // must not drag the modal back to "Contacting Ollama…".
        if (!advancesPhase(state.phase, parsed.phase)) continue;
        if (parsed.phase !== "error") {
          state.phase = parsed.phase;
          if (parsed.percent !== undefined) state.percent = parsed.percent;
          state.detail = parsed.detail;
        }
        // ollama redraws its TUI frame several times a second, mostly with
        // identical numbers. Broadcasting each one re-rendered the modal for no
        // visible change; only a frame that actually reads differently ships.
        const next = JSON.stringify(hfPullPayload(state));
        if (next === lastBroadcast) continue;
        lastBroadcast = next;
        broadcast("hf_pull", hfPullPayload(state));
      }
    };

    try {
      const child = spawn("ollama", ["pull", model], {
        env: { ...process.env, ...(token ? { HF_TOKEN: token } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.child = child;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", feed);
      child.stderr?.on("data", (d: string) => {
        stderrTail = (stderrTail + d).slice(-2000);
        feed(d);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        state.child = null;
        state.phase = "error";
        state.error =
          err.code === "ENOENT"
            ? "Ollama isn't installed (or isn't on PATH). Install it from ollama.com, then retry."
            : `Could not start Ollama: ${err.message}`;
        broadcast("hf_pull", hfPullPayload(state));
      });
      child.on("close", (code: number | null) => {
        state.child = null;
        if (state.phase === "success" || state.phase === "error") return; // cancelled
        if (code === 0) {
          state.phase = "success";
          state.percent = 100;
          state.detail = undefined;
          broadcast("hf_pull", hfPullPayload(state));
          // The new model only exists to the app once Ollama lists it. Ollama's
          // library is machine-wide, like the shared auth file, so every window
          // gets the refresh — not just the one that ran the download.
          void scanLocalModels(true)
            .then(() => broadcastAll("models_change", { local: localStatePayload() }))
            .catch(() => undefined);
        } else {
          state.phase = "error";
          state.error = state.error ?? explainPullFailure(stderrTail);
          broadcast("hf_pull", hfPullPayload(state));
        }
      });
    } catch (err) {
      state.child = null;
      state.phase = "error";
      state.error = `Could not start Ollama: ${err instanceof Error ? err.message : String(err)}`;
      broadcast("hf_pull", hfPullPayload(state));
    }
    return hfPullPayload(state);
  }

  function cancelHfPull(): boolean {
    const child = hfPull?.child;
    if (!child) return false;
    // Terminal state FIRST, then the kill: the child's death rattle must not
    // overwrite the clean "cancelled" outcome with raw stderr.
    if (hfPull) {
      hfPull.phase = "error";
      hfPull.error = "Download cancelled.";
      hfPull.detail = undefined;
      hfPull.child = null;
      broadcast("hf_pull", hfPullPayload(hfPull));
    }
    child.kill("SIGTERM");
    return true;
  }

  /**
   * Why `modelId` can't be selected right now, or `undefined` when it can.
   * Two real footguns get a clear answer instead of a mid-run provider error:
   * a model with no tool calling (can't drive the agent at all), and a server
   * that has since been shut down.
   */
  async function localModelBlocker(modelId: string): Promise<string | undefined> {
    const parsed = parseLocalModelId(modelId);
    if (!parsed) return undefined;
    const endpoints = await listAllEndpoints();
    const endpoint = endpoints.find((e) => e.id === parsed.endpointId);
    if (!endpoint)
      return `Unknown local endpoint "${parsed.endpointId}" — re-scan for local models.`;

    const probe = await probeEndpoint(endpoint);
    // Keep the cached view honest: this probe is fresher than the last scan.
    localProbes = localProbes.map((p) => (p.endpoint.id === endpoint.id ? probe : p));
    if (!probe.reachable) {
      return `${endpoint.label} isn't running at ${endpoint.baseUrl}. Start it and scan again.`;
    }
    const model = probe.models.find((m) => m.rawId === parsed.rawId);
    if (!model) {
      return `${endpoint.label} no longer serves "${parsed.rawId}".`;
    }
    if (!model.supportsTools) {
      return `${parsed.rawId} has no tool calling, so it can't run the agent. Pick a tool-capable model.`;
    }
    registerRuntimeModels(probe.models.map((m) => localModelInfo(m, endpoint)));
    return undefined;
  }

  /**
   * A restored per-project pref can ask for thinking on a local model that
   * turns out not to reason (capabilities are only known after a probe). Drop
   * the level once we know, so the first prompt doesn't carry a
   * `reasoning_effort` the server rejects.
   */
  function clampLocalThinking(): void {
    const st = session.getState();
    const level = session.getThinkingLevel();
    if (!level || st.provider !== "local") return;
    if (isThinkingLevelSupported(st.provider, st.model, level)) return;
    session.setThinkingLevel(undefined);
    broadcast("thinking_change", {
      thinkingLevel: null,
      supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
    });
  }

  // Workspace extras (context window, git status, background tasks). Git state
  // is resolved once at startup and refreshed after every run; the context
  // window follows the active model.
  const [initialGitBranch, initialGitIsRepo, initialDirtyFileCount, initialGitHubSlug] =
    await Promise.all([
      getGitBranch(cwd).catch(() => null),
      isGitRepo(cwd).catch(() => false),
      getGitDirtyFileCount(cwd).catch(() => 0),
      getGitHubRepoSlug(cwd).catch(() => null),
    ]);
  let gitBranch: string | null = initialGitBranch;
  let gitIsRepo: boolean = initialGitIsRepo;
  let gitDirtyFileCount = initialDirtyFileCount;
  // Open issue/PR counts for the origin repo's GitHub slug, via the `gh` CLI's
  // auth. null = unknown (gh missing/unauthed, non-GitHub origin) → chips hidden.
  const gitHubSlug: string | null = initialGitHubSlug;
  let gitHubIssues: number | null = null;
  let gitHubPRs: number | null = null;
  function currentContextWindow(): number {
    const st = session.getState();
    return getContextWindow(st.model, { provider: st.provider, accountId: st.accountId });
  }
  // Shared shape merged into /state + the SSE `ready` frame so the footer can
  // render context %, branch, and tasks immediately on connect.
  function footerExtras(): {
    contextWindow: number;
    gitBranch: string | null;
    isGitRepo: boolean;
    gitDirtyFileCount: number;
    gitHubIssues: number | null;
    gitHubPRs: number | null;
    gitHubRepoUrl: string | null;
    tasks: ReturnType<typeof session.listBackgroundProcesses>;
    additionalRoots: string[];
  } {
    return {
      contextWindow: currentContextWindow(),
      gitBranch,
      isGitRepo: gitIsRepo,
      gitDirtyFileCount,
      gitHubIssues,
      gitHubPRs,
      gitHubRepoUrl: gitHubSlug ? `https://github.com/${gitHubSlug}` : null,
      tasks: session.listBackgroundProcesses(),
      // Roots added with /add-dir — the header shows a badge when non-empty.
      additionalRoots: session.getAdditionalRoots(),
    };
  }

  void scanLocalModels(false)
    .then(() => {
      clampLocalThinking();
      broadcast("extras", footerExtras());
    })
    .then(() => broadcast("models_change", { local: localStatePayload() }))
    .catch((err: unknown) => {
      // A discovery failure is never fatal — the user simply has no local
      // models. Log it; don't push an error row into the transcript.
      log("WARN", "app-sidecar", "local model scan failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Refresh the GitHub counts and broadcast only on change. Transient failures
  // keep the last-known numbers so the chips don't flicker off on a timeout.
  async function refreshGitHubCounts(): Promise<void> {
    if (!gitHubSlug) return;
    const counts = await getGitHubOpenCounts(gitHubSlug);
    if (!counts) return;
    if (counts.issues !== gitHubIssues || counts.prs !== gitHubPRs) {
      gitHubIssues = counts.issues;
      gitHubPRs = counts.prs;
      broadcast("extras", footerExtras());
    }
  }

  // tool_call_end carries no tool name (only the id), so remember each call's
  // name from tool_call_start to log a useful line on completion. Mirrors the
  // CLI's logging so the app sidecar's ~/.gg/gg-app-sidecar.log records tool
  // failures (e.g. repeated invalid-argument errors) instead of leaving the
  // fatal-abort path with no forensic trail.
  const toolCallNames = new Map<string, string>();

  // Approved-plan progress belongs beside the plan file, not in the webview.
  // The implementation can rewrite/expand that file mid-run, so a step count
  // frozen at approval time becomes dishonest for legacy path-only plans. Durable
  // human approvals always use their server-owned exact snapshot, so edits to the
  // display file cannot alter either the prompt contract or progress totals.
  let approvedPlanPath: string | null = null;
  let approvedPlanTotal = 0;
  let approvedPlanMarkers = new Set<number>();
  let approvedPlanGeneration = 0;
  let planMarkerTail = "";
  let planProgressSync: Promise<boolean> = Promise.resolve(false);

  function planProgressPayload(): { total: number; completed: number[] } {
    const completed = [...approvedPlanMarkers]
      .filter((step) => step >= 1 && step <= approvedPlanTotal)
      .sort((a, b) => a - b);
    return { total: approvedPlanTotal, completed };
  }

  async function syncApprovedPlanProgress(generation: number): Promise<boolean> {
    const planPath = approvedPlanPath;
    if (planPath === null || generation !== approvedPlanGeneration) return false;
    const durableApproval = session.getApprovedPlanConsumption();
    const content =
      durableApproval?.approvedPlanPath === planPath
        ? durableApproval.content
        : await fs.readFile(planPath, "utf-8").catch(() => null);
    if (approvedPlanPath !== planPath || generation !== approvedPlanGeneration) return false;
    if (content !== null) {
      const freshTotal = extractPlanSteps(content).length;
      // During an in-place rewrite the step section can briefly disappear.
      // Keep the last real total instead of flashing 0 or declaring completion.
      if (freshTotal > 0 || approvedPlanTotal === 0) approvedPlanTotal = freshTotal;
    }
    broadcast("plan_progress", planProgressPayload());
    return (
      approvedPlanTotal > 0 &&
      Array.from({ length: approvedPlanTotal }, (_, index) => index + 1).every((step) =>
        approvedPlanMarkers.has(step),
      )
    );
  }

  function queueApprovedPlanProgressSync(): Promise<boolean> {
    const generation = approvedPlanGeneration;
    planProgressSync = planProgressSync
      .catch(() => false)
      .then(() => syncApprovedPlanProgress(generation))
      .catch((error) => {
        captureSidecarError(error, "app-sidecar.plan.refresh-progress");
        log("WARN", "app-sidecar", "plan progress refresh failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
    return planProgressSync;
  }

  async function activateApprovedPlan(
    planPath: string | undefined,
    exactContent?: string,
  ): Promise<number> {
    deactivateApprovedPlan();
    if (exactContent === undefined) await session.setApprovedPlan(planPath);
    if (!planPath) return exactContent ? extractPlanSteps(exactContent).length : 0;
    approvedPlanPath = planPath;
    approvedPlanTotal = exactContent ? extractPlanSteps(exactContent).length : 0;
    await queueApprovedPlanProgressSync();
    return approvedPlanTotal;
  }

  function deactivateApprovedPlan(options?: { retainImplementationEvidence?: boolean }): void {
    approvedPlanGeneration++;
    approvedPlanPath = null;
    approvedPlanTotal = 0;
    approvedPlanMarkers = new Set();
    planMarkerTail = "";
    planProgressSync = Promise.resolve(false);
    if (!options?.retainImplementationEvidence) phaseImplementationPlans.clear();
  }

  const restoredApprovedPlan = session.getApprovedPlanConsumption();
  const restoredApprovedPlanPath =
    restoredApprovedPlan?.approvedPlanPath ?? session.getActivePhaseContext()?.approvedPlanPath;
  if (restoredApprovedPlanPath || restoredApprovedPlan) {
    try {
      await activateApprovedPlan(restoredApprovedPlanPath, restoredApprovedPlan?.content);
      for (const message of session.getMessages()) {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((content) =>
                  content.type === "text" && "text" in content ? content.text : "",
                )
                .join("");
        recordApprovedPlanMarkers(text);
      }
      await queueApprovedPlanProgressSync();
    } catch (error) {
      captureSidecarError(error, "app-sidecar.plan.restore-progress");
      log("WARN", "app-sidecar", "approved plan progress restore failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    const activePhase = session.getActivePhaseContext();
    if (
      activePhase &&
      (activePhase.executionStage === "implementing" || activePhase.executionStage === "reviewing")
    ) {
      const loaded = await notesRepository.load(cwd);
      const persistedPhase =
        loaded.status === "ok"
          ? loaded.snapshot.document.phases.find((phase) => phase.id === activePhase.phase.id)
          : undefined;
      if (persistedPhase) {
        restorePhaseImplementationPlanEvidence({
          tracker: phaseImplementationPlans,
          phase: persistedPhase,
          expectedSession: activePhase.session,
        });
      }
    }
  }

  function recordApprovedPlanMarkers(text: string): void {
    if (approvedPlanPath === null || !text) return;
    const candidate = planMarkerTail + text;
    let changed = false;
    for (const match of candidate.matchAll(/\[DONE:(\d+)\]/gi)) {
      const step = Number.parseInt(match[1], 10);
      if (step >= 1 && !approvedPlanMarkers.has(step)) {
        approvedPlanMarkers.add(step);
        changed = true;
      }
    }
    planMarkerTail = candidate.slice(-32);
    if (changed) void queueApprovedPlanProgressSync();
  }

  // Bind the complete event surface to both initial and phase-replacement sessions.
  function bindSessionEvents(target: AgentSession): void {
    target.eventBus.on("text_delta", (data) => {
      broadcast("text_delta", data);
      recordApprovedPlanMarkers(data.text);
    });
    target.eventBus.on("thinking_delta", (data) => broadcast("thinking_delta", data));
    target.eventBus.on("queue_drained", (data) =>
      broadcast("queued", { count: data.count, messages: target.listQueuedMessages() }),
    );
    target.eventBus.on("tool_call_start", (data) => {
      toolCallNames.set(data.toolCallId, data.name);
      broadcast("tool_call_start", data);
    });
    target.eventBus.on("tool_call_update", (data) => broadcast("tool_call_update", data));
    target.eventBus.on("tool_call_end", (data) => {
      const name = toolCallNames.get(data.toolCallId) ?? "unknown";
      toolCallNames.delete(data.toolCallId);
      if (data.isError && shouldCaptureToolFailure(name, data.result)) {
        captureSidecarError(new Error(`Tool ${name} failed`), `tool.${name}`, { tool: name });
      }
      log(data.isError ? "ERROR" : "INFO", "tool", `Tool call ended: ${name}`, {
        id: data.toolCallId,
        durationMs: String(data.durationMs),
        isError: String(data.isError),
        ...(data.isError ? { result: data.result.slice(0, 500) } : {}),
        ...(data.invalidArgAttempt === undefined
          ? {}
          : { invalidArgAttempt: String(data.invalidArgAttempt) }),
      });
      broadcast("tool_call_end", data);
      if (approvedPlanPath !== null) void queueApprovedPlanProgressSync();
    });
    target.eventBus.on("server_tool_call", (data) => broadcast("server_tool_call", data));
    target.eventBus.on("turn_end", (data) => broadcast("turn_end", data));
    target.eventBus.on("agent_done", (data) => broadcast("agent_done", data));
    target.eventBus.on("truncated", (data) => {
      if (data.reason === "empty_response") {
        broadcastError(
          "error",
          "empty response",
          new Error("The model returned an empty response after retries — try sending again."),
        );
        return;
      }
      broadcast("truncated", data);
    });
    target.eventBus.on("error", (data) => broadcastError("error", "agent error", data.error));
    target.eventBus.on("model_change", (data) => broadcast("model_change", data));
    target.eventBus.on("hook", (data) => broadcast("hook", data));
    target.eventBus.on("hook_armed", (data) => broadcast("hook_armed", data));
    target.eventBus.on("subagent_state", (data) => broadcast("subagent_state", data));
    target.eventBus.on("mcp_server_state", (data) => broadcast("mcp_server_state", data));
    target.eventBus.on("compaction_start", (data) => broadcast("compaction_start", data));
    target.eventBus.on("compaction_end", (data) => broadcast("compaction_end", data));
  }
  bindSessionEvents(session);

  let running = false;
  // Closes the window between `/prompt` deciding to start a run and `runAgent`
  // flipping `running` — that stretch awaits, so Node yields inside it. See
  // RunClaim.
  const runClaim = new RunClaim();
  const runLifecycle = new RunLifecycle(
    (runState) => {
      running = runState !== "idle";
      if (runState === "cancelling") broadcast("run_cancelling", { runState });
    },
    // Durable run journal. Fire-and-forget on purpose: an unwritten journal
    // entry is a missed crash hint, while a journal write that throws inside
    // begin()/settle() would break run ownership itself.
    {
      started: (generation) =>
        void session.persistRunStarted(generation).catch((err) => {
          log("WARN", "app-sidecar", "failed to journal run start", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      finished: (generation, outcome) =>
        void session.persistRunFinished(generation, outcome).catch((err) => {
          log("WARN", "app-sidecar", "failed to journal run finish", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    },
  );
  const cancelledRunEndGenerations = new Set<number>();
  let pendingCancelDrain: { generation: number; text: string } | null = null;
  // Bumped by /cancel — a run whose cancel generation changed mid-flight was
  // canceled and earns no XP.
  let cancelGeneration = 0;
  // Autopilot (auto-review) toggle for THIS window's project. Loaded from
  // gg-app.json on boot; flipped via POST /autopilot. When on, POST /prompt runs
  // runAutopilotCycle after the user's turn settles — Ken auto-reviews the work
  // and drives the review→prompt→review loop. Ken is the sole verification
  // owner in this mode, so suppress the build session's redundant Ideal hook.
  let autopilot =
    mode === "code" && (await projectAutopilot.initialize(cwd, () => loadAutopilot(cwd)));
  session.setIdealReviewSuppressed(autopilot);
  // True while an autopilot review is in flight (used to defer kenAuto model
  // switches, like kenRunning does for chat Ken, and to drive the spinner).
  let autopilotReviewing = false;
  // True for the WHOLE autopilot cycle (reviews + injected runs). The build
  // `running` flag is false during the review windows between injected runs, so
  // this is the extra guard that makes a user /prompt queue as steering instead
  // of starting a run that would collide with an injected one on the same
  // session (AgentSession.prompt has no concurrency guard).
  let autopilotActive = false;
  const sessionBusyState = () => ({
    running,
    autopilotActive,
    runLifecycleRunning: runLifecycle.running,
  });
  // Set by /cancel to break out of an in-flight autopilot cycle between steps.
  let autopilotCancelled = false;
  // Hard cap on review→prompt→review rounds per user turn (loop safety).
  const MAX_AUTOPILOT_ROUNDS = 3;
  const CANCEL_TIMEOUT_MS = 5_000;
  // Prompt bodies Autopilot Ken injected into the BUILD session this
  // conversation. Passed into every Ken digest so injected prompts render as
  // "Ken autopilot (injected)" instead of `**User:**` — otherwise multi-round
  // cycles drift into Ken reviewing against his own last prompt. Cleared
  // whenever the conversation resets (new session / plan accept / task run).
  let injectedAutopilotPrompts: string[] = [];
  const planGateConflict = () => {
    const checkpoint = planGate.current();
    if (!checkpoint) return null;
    const gateConflict = planGateConflictCode(checkpoint);
    if (gateConflict) {
      return {
        error: gateConflict,
        checkpointId: checkpoint.checkpointId,
        generation: checkpoint.generation,
        state: checkpoint.state,
      };
    }
    const consumption = session.getApprovedPlanConsumption();
    const handoffCommitted =
      checkpoint.state === "human-approved" &&
      consumption?.checkpointId === checkpoint.checkpointId &&
      consumption.generation === checkpoint.generation &&
      consumption.state === "implementation-prompt-started";
    if (handoffCommitted || checkpoint.state !== "human-approved") return null;
    return {
      error: "plan-approval-handoff-pending",
      checkpointId: checkpoint.checkpointId,
      generation: checkpoint.generation,
      state: checkpoint.state,
    };
  };

  // Workflow (prompt-template) commands: built-in + the project's custom
  // `.gg/commands/*.md`. Used to gate autopilot off command turns and to label
  // expanded templates in Ken's digests. Loaded fresh so a newly added custom
  // command is picked up without a restart (mirrors GET /commands).
  async function loadWorkflowCommandSpecs(): Promise<WorkflowCommandSpec[]> {
    const custom = await loadCustomCommands(cwd).catch(() => []);
    return [
      ...PROMPT_COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases, prompt: c.prompt })),
      ...custom.map((c) => ({ name: c.name, aliases: [] as string[], prompt: c.prompt })),
    ];
  }

  // ── Telegram serve (remote control via Telegram) ───────────
  // A single embedded serve session lives in this sidecar process. Only the main
  // window's home screen exposes the controls, so there's one bot per app.
  let serveController: ServeController | null = null;

  // ── Ken Kai (mentor agent) ─────────────────────────────────
  // A second, read-only AgentSession on this same window. The user talks to him
  // with `@Ken …`; he reads GG Coder's transcript (one-way — GG Coder never sees
  // Ken's) and hands back runnable prompts + mentorship. Created lazily on the
  // first `@Ken` so windows that never use Ken pay zero cost. His events ride the
  // SAME SSE stream with `ken_`-prefixed types, routed to the Ken bubble.
  let kenSession: AgentSession | null = null;
  let kenAbort = new AbortController();
  let kenRunning = false;
  let pendingKenModel: { provider: Provider; model: string } | null = null;
  const kenToolCallNames = new Map<string, string>();

  // Ken's per-project model override. null → Ken (chat + autopilot) follows GG
  // Coder's model, including live switches (the historical behavior). Set → Ken
  // is pinned to his own model and GG Coder switches no longer touch him. A
  // stale persisted pin (model dropped from the registry / provider logged
  // out) validates to null so Ken degrades to following instead of erroring.
  let kenModelOverride: KenModelPref | null = validateKenModelPref(await loadKenModelPref(cwd), {
    modelExists: (id) => getModel(id) !== undefined,
    providerConnected: () => true, // async auth checked below
  });
  if (kenModelOverride && !(await auth.hasProviderAuth(kenModelOverride.provider))) {
    log("WARN", "app-sidecar", "ken model override provider not connected — following GG", {
      provider: kenModelOverride.provider,
      model: kenModelOverride.model,
    });
    kenModelOverride = null;
  }

  /** The model Ken uses next turn: the pin when set, else GG Coder's. */
  function kenCurrentModel(): { provider: Provider; model: string } {
    if (kenModelOverride) return kenModelOverride;
    const st = session.getState();
    return { provider: st.provider, model: st.model };
  }

  /** Footer payload: Ken's effective model + whether it's a pin. Merged into
   *  /state, the SSE ready frame, and every ken_model_change broadcast. */
  function kenStatePayload(): ReturnType<typeof effectiveKenModel> {
    const st = session.getState();
    return effectiveKenModel(kenModelOverride, { provider: st.provider, model: st.model });
  }

  async function syncKenModel(provider: Provider, model: string): Promise<void> {
    if (kenRunning) {
      pendingKenModel = { provider, model };
      return;
    }
    if (!kenSession) return;
    const st = kenSession.getState();
    if (st.provider === provider && st.model === model) return;
    await kenSession.switchModel(provider, model);
    log("INFO", "app-sidecar", "ken session model synced", { provider, model });
  }

  async function ensureKenSession(): Promise<AgentSession> {
    if (kenSession) return kenSession;
    const target = kenCurrentModel();
    const ken = new AgentSession({
      provider: target.provider,
      model: target.model,
      cwd,
      systemPrompt: await buildKenSystemPrompt(cwd),
      allowedTools: [...APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES],
      additionalTools: roadmapToolHost.createSessionTools("ken", () => kenSession!),
      allowedMcpServers: KEN_ALLOWED_MCP_SERVERS,
      sharedMcpPool,
      transient: true,
      signal: kenAbort.signal,
      // Ken belongs to THIS window, so its window is where an MCP prompt
      // should appear. Passing the bridge also keeps every session in the
      // daemon uniformly interactive, which is what lets them share ONE pooled
      // MCP connection: the pool separates interactive from headless callers,
      // because a connection declares its elicitation capability once, at
      // initialize (see core/mcp/shared-pool.ts).
      onMcpElicit: elicitations.onElicit,
      // Ken's bursty, spread-out turns (chat) outlast the default 5-min cache
      // TTL regardless of the user's global speedProfile pick.
      forceLongCacheRetention: true,
    });
    await ken.initialize();
    // Bridge Ken's bus to the shared SSE fan-out with ken_-prefixed types so the
    // webview routes them to the Ken bubble, never GG Coder's.
    ken.eventBus.on("text_delta", (d) => broadcast("ken_text_delta", d));
    ken.eventBus.on("thinking_delta", (d) => broadcast("ken_thinking_delta", d));
    ken.eventBus.on("tool_call_start", (d) => {
      kenToolCallNames.set(d.toolCallId, d.name);
      broadcast("ken_tool_call_start", d);
    });
    ken.eventBus.on("tool_call_update", (d) => broadcast("ken_tool_call_update", d));
    ken.eventBus.on("tool_call_end", (d) => {
      kenToolCallNames.delete(d.toolCallId);
      broadcast("ken_tool_call_end", d);
    });
    // Native server tools (Anthropic web_search) stream text both before AND
    // after them in the same turn; forward so the webview can break the bubble
    // (otherwise "...work.Local tools..." glues together). Mirrors the build bus.
    ken.eventBus.on("server_tool_call", (d) => broadcast("ken_server_tool_call", d));
    ken.eventBus.on("turn_end", (d) => broadcast("ken_turn_end", d));
    ken.eventBus.on("error", (d) => {
      broadcastError("ken_error", "ken error", d.error);
    });
    kenSession = ken;
    log("INFO", "app-sidecar", "ken session ready", {
      provider: target.provider,
      model: target.model,
    });
    return ken;
  }

  // ── Autopilot Ken (auto-reviewer) ──────────────────────────
  // A THIRD read-only AgentSession, separate from chat Ken. In autopilot mode
  // Ken silently reviews each finished GG Coder turn and returns a verdict
  // (PROMPT / ALL_CLEAR / HUMAN). Its bus is intentionally NOT bridged to the
  // ken_* chat bubbles — the review is silent; we read its final assistant text
  // and parse it. Uses the lean autopilot system prompt + the same read-only
  // tools. Created lazily on the first autopilot cycle.
  let kenAutoSession: AgentSession | null = null;
  let kenAutoAbort = new AbortController();
  let pendingKenAutoModel: { provider: Provider; model: string } | null = null;

  async function syncKenAutoModel(provider: Provider, model: string): Promise<void> {
    if (autopilotReviewing) {
      pendingKenAutoModel = { provider, model };
      return;
    }
    if (!kenAutoSession) return;
    const st = kenAutoSession.getState();
    if (st.provider === provider && st.model === model) return;
    await kenAutoSession.switchModel(provider, model);
    log("INFO", "app-sidecar", "ken autopilot session model synced", { provider, model });
  }

  async function ensureKenAutoSession(): Promise<AgentSession> {
    if (kenAutoSession) return kenAutoSession;
    const target = kenCurrentModel();
    const ken = new AgentSession({
      provider: target.provider,
      model: target.model,
      cwd,
      systemPrompt: await buildKenAutopilotSystemPrompt(cwd),
      allowedTools: [...APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES],
      additionalTools: roadmapToolHost.createSessionTools("ken-autopilot", () => kenAutoSession!),
      allowedMcpServers: KEN_ALLOWED_MCP_SERVERS,
      sharedMcpPool,
      transient: true,
      signal: kenAutoAbort.signal,
      // Same as Ken chat: this reviewer belongs to a window, so route prompts
      // there, and keep the daemon's sessions uniformly interactive so they
      // share one pooled MCP connection.
      onMcpElicit: elicitations.onElicit,
      // Autopilot review rounds routinely span the injected GG Coder run
      // (often >5 min) regardless of the user's global speedProfile pick.
      forceLongCacheRetention: true,
    });
    // Ken is already the independent autopilot reviewer; recursively running
    // his own Ideal self-review adds latency and can corrupt the verdict shape.
    ken.setIdealReviewSuppressed(true);
    await ken.initialize();
    // Deliberately no bus bridge: the review is silent. Errors surface via the
    // runAutopilotReview try/catch as autopilot_error frames.
    kenAutoSession = ken;
    log("INFO", "app-sidecar", "ken autopilot session ready", {
      provider: target.provider,
      model: target.model,
    });
    return ken;
  }

  function abortOwnedWork(): void {
    cancelGeneration++;
    abort.abort();
    // An MCP tool call parked on user input is not cancelled by the signal —
    // the promise lives in the bridge. Release it, or the aborted turn's tool
    // call never returns.
    elicitations.cancelAll();
    // Stop a run-all sweep and every async child through AgentSession's signal.
    taskRunAll = false;
    autopilotCancelled = true;
    kenAutoAbort.abort();
  }

  function installFreshRunControllers(): void {
    abort = new AbortController();
    session.setSignal(abort.signal);
    kenAutoAbort = new AbortController();
    kenAutoSession?.setSignal(kenAutoAbort.signal);
  }

  function finishOwnedGeneration(
    generation: number,
    emitCancelledFallback: boolean,
    outcome: RunOutcome = "completed",
  ): boolean {
    const cancelled = runLifecycle.isCancellationRequested(generation);
    const settlement = runLifecycle.settle(generation, outcome);
    if (!settlement.settled) return cancelled;
    // A replacement signal is safe only after the provider-backed owner settled.
    installFreshRunControllers();
    if (cancelled && emitCancelledFallback && !cancelledRunEndGenerations.has(generation)) {
      cancelledRunEndGenerations.add(generation);
      broadcast("run_end", { cancelled: true, runState: runLifecycle.state });
    }
    return cancelled;
  }

  async function commitActivePhaseImplementationStart(): Promise<void> {
    await commitImplementationRunStart({
      session,
      reconcileLifecycle: (signal, active) =>
        phaseLifecycle.enqueue(signal, {
          phaseId: active.phase.id,
          session: active.session,
          executionStage: active.executionStage,
        }),
    });
  }

  async function promptActiveSession(...args: Parameters<AgentSession["prompt"]>): Promise<void> {
    if (await session.willStartAgentRun(args[0])) {
      await commitActivePhaseImplementationStart();
    }
    await session.prompt(...args);
  }

  async function promptActiveSessionWithAttachments(
    ...args: Parameters<AgentSession["promptWithAttachments"]>
  ): Promise<void> {
    await commitActivePhaseImplementationStart();
    await session.promptWithAttachments(...args);
  }

  // Core provider-run bracket. Standalone runs own a lifecycle generation;
  // injected autopilot runs share the cycle's outer generation.
  async function runAgent(label: string, run: () => Promise<void>): Promise<void> {
    const ownsGeneration = !runLifecycle.running;
    const generation = ownsGeneration
      ? runLifecycle.begin(abortOwnedWork).generation
      : runLifecycle.generation;
    if (ownsGeneration) pendingCancelDrain = null;
    // Progress (Ranks): completed, non-canceled runs with ≥1 assistant turn earn
    // XP — prompt + any commits authored during the run window.
    const runStartedAt = Date.now();
    const cancelGenAtStart = cancelGeneration;
    const assistantsBeforeRun = countAssistantMessages(session.getMessages());
    let runSucceeded = false;
    broadcast("run_start", { text: label, runState: runLifecycle.state });
    try {
      if (!runLifecycle.isCancellationRequested(generation)) await run();
      runSucceeded = true;
    } catch (err) {
      if (!runLifecycle.isCancellationRequested(generation)) {
        broadcastError("error", "run failed", err);
      }
    } finally {
      const cancelled = runLifecycle.isCancellationRequested(generation);
      if (
        runSucceeded &&
        !cancelled &&
        cancelGeneration === cancelGenAtStart &&
        countAssistantMessages(session.getMessages()) > assistantsBeforeRun
      ) {
        // Fire-and-forget — XP must never delay or break run teardown.
        void progress.awardRun(cwd, runStartedAt, opts.id);
      }
      // A run may have switched branches, changed files, or spawned/finished
      // background tasks. Refresh the workspace extras once it settles.
      [gitBranch, gitIsRepo, gitDirtyFileCount] = await Promise.all([
        getGitBranch(cwd).catch(() => gitBranch),
        isGitRepo(cwd).catch(() => gitIsRepo),
        getGitDirtyFileCount(cwd).catch(() => gitDirtyFileCount),
      ]);
      // A run may have opened/closed issues or PRs — refresh fire-and-forget so
      // teardown isn't delayed by the network. Broadcasts itself on change.
      void refreshGitHubCounts();
      // Serialize behind any marker/tool-triggered refresh so the terminal
      // progress snapshot uses the live plan file. Persist the implementation
      // checkpoint before Autopilot Ken can review the settled run.
      const terminalPlanComplete =
        approvedPlanPath !== null ? await queueApprovedPlanProgressSync() : false;
      const activePhase = session.getActivePhaseContext();
      if (
        activePhase &&
        (activePhase.executionStage === "implementing" ||
          activePhase.executionStage === "reviewing")
      ) {
        await checkpointSettledPhaseImplementation({
          coordinator: phaseCompletion,
          tracker: phaseImplementationPlans,
          checkpointId: randomUUID(),
          phaseId: activePhase.phase.id,
          expectedSession: activePhase.session,
          currentPlanProgress: planProgressPayload(),
          runOutcome: cancelled ? "cancelled" : runSucceeded ? "succeeded" : "failed",
          timestamp: new Date().toISOString(),
        });
        const scheduledReview = await drainScheduledRoadmapReview(label);
        if (scheduledReview.attempted) {
          settledRoadmapReviewVerdict = { verdict: scheduledReview.verdict };
        }
      }
      // Once every canonical step is complete, remove the approved plan from
      // future system prompts and clear the widget before run_end paints idle.
      if (runSucceeded && !cancelled && approvedPlanPath !== null && terminalPlanComplete) {
        try {
          await session.completeApprovedPlanConsumption();
          deactivateApprovedPlan({ retainImplementationEvidence: true });
          broadcast("plan_progress", { total: 0, completed: [] });
        } catch (error) {
          // Keep tracking when prompt cleanup fails; hiding the widget here
          // would claim completion while the approved-plan contract remained.
          captureSidecarError(error, "app-sidecar.plan.cleanup");
          log("WARN", "app-sidecar", "completed plan cleanup failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (ownsGeneration) {
        finishOwnedGeneration(generation, false, runSucceeded ? "completed" : "failed");
      }
      // A cancelled injected run is still owned by the surrounding autopilot
      // cycle; its outer finalizer emits the one terminal cancelled run_end.
      if (!(cancelled && !ownsGeneration)) {
        if (cancelled) cancelledRunEndGenerations.add(generation);
        broadcast("run_end", {
          ...(cancelled ? { cancelled: true } : {}),
          runState: runLifecycle.state,
        });
      }
      // Autopilot's review loop is driven explicitly from POST /prompt (see
      // runAutopilotCycle), NOT from this shared finally — that keeps injected
      // runs from recursively entering the same review loop.
      broadcast("tasks_list", { tasks: pruneDoneTasksSync(cwd) });
      broadcast("queued", {
        count: session.getQueuedCount(),
        messages: session.listQueuedMessages(),
      });
      broadcast("extras", footerExtras());
    }
  }

  const planHandoff = new AppSidecarPlanHandoff({
    approve: (checkpointId, generation) => planGate.approve(checkpointId, generation),
    currentConsumption: (): ApprovedPlanConsumptionIdentity | null => {
      const consumption = session.getApprovedPlanConsumption();
      if (!consumption) return null;
      return {
        checkpointId: consumption.checkpointId,
        generation: consumption.generation,
        state: consumption.state,
      };
    },
    commitApproval: async (checkpoint) => {
      const approvedPlanPath = await persistApprovedPlanSnapshot(cwd, checkpoint);
      if (hasPlanOnlyBoundary(checkpoint.content)) {
        const activePhase = session.getActivePhaseContext();
        if (activePhase) {
          const checkpointOutcome = await phaseCompletion.checkpoint({
            checkpointId: checkpoint.checkpointId,
            phaseId: activePhase.phase.id,
            expectedSession: activePhase.session,
            // The phase deliverable is the reviewed plan itself. Its implementation
            // steps belong to later Roadmap phases and must not gate this contract phase.
            planStepTotal: 1,
            completedPlanSteps: [1],
            runOutcome: "succeeded",
            timestamp: checkpoint.timestamp,
          });
          if (
            checkpointOutcome.status !== "committed" &&
            checkpointOutcome.status !== "duplicate"
          ) {
            throw new Error(`Plan-only completion checkpoint failed: ${checkpointOutcome.status}`);
          }
        }
        const committed = await session.persistApprovedPlanConsumption({
          checkpointId: checkpoint.checkpointId,
          generation: checkpoint.generation,
          content: checkpoint.content,
          contentHash: checkpoint.contentHash,
          approvedPlanPath,
        });
        await session.completeApprovedPlanConsumption();
        await planGate.clearConsumed({
          checkpointId: committed.checkpointId,
          generation: committed.generation,
          state: "completed",
        });
        return {
          checkpointId: committed.checkpointId,
          generation: committed.generation,
          state: "completed" as const,
        };
      }

      const previousPhaseSessionPath = session.getActivePhaseContext()?.session.sessionPath;
      await commitPlanApprovalCheckpoint({
        session,
        repository: notesRepository,
        cwd,
        planPath: approvedPlanPath,
        prepareFreshSession: async () => {
          await session.newSession(true);
          injectedAutopilotPrompts = [];
          await session.persistApprovedPlanConsumption({
            checkpointId: checkpoint.checkpointId,
            generation: checkpoint.generation,
            content: checkpoint.content,
            contentHash: checkpoint.contentHash,
            approvedPlanPath,
          });
          return activateApprovedPlan(approvedPlanPath, checkpoint.content);
        },
        restorePreviousSession: previousPhaseSessionPath
          ? async () => {
              await session.loadSessionCheckpoint(previousPhaseSessionPath);
              deactivateApprovedPlan();
            }
          : undefined,
        onSnapshot: broadcastNotesSnapshot,
      });
      const consumption = session.getApprovedPlanConsumption();
      if (!consumption || consumption.state === "completed") {
        throw new Error("Approved plan consumption was not committed.");
      }
      return {
        checkpointId: consumption.checkpointId,
        generation: consumption.generation,
        state: consumption.state,
      };
    },
    launchImplementation: async (consumption) => {
      if (!runClaim.claim()) throw new Error("Another provider run already owns the session.");
      try {
        await runAgent(IMPLEMENT_PLAN_PROMPT, async () => {
          await commitActivePhaseImplementationStart();
          await session.runApprovedPlanImplementation(
            IMPLEMENT_PLAN_PROMPT,
            runLifecycle.generation,
          );
        });
        if (autopilot && settledRoadmapReviewVerdict) {
          await runAutopilotCycle(IMPLEMENT_PLAN_PROMPT);
        }
      } finally {
        try {
          const current = session.getApprovedPlanConsumption();
          if (
            !current ||
            (current.checkpointId === consumption.checkpointId &&
              current.generation === consumption.generation)
          ) {
            await planGate.clearConsumed(
              current ?? { ...consumption, state: "completed" as const },
            );
          }
        } finally {
          runClaim.release();
        }
      }
    },
    onLaunchFailure: (error) => {
      captureSidecarError(error, "app-sidecar.plan.resume-implementation");
      log("ERROR", "app-sidecar", "approved plan implementation resume failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const resumedApprovedPlan = planHandoff.resumePending();
  const recoverableApproval = planGate.current();
  if (!resumedApprovedPlan) {
    // Older builds could durably commit the human decision and Draft snapshot,
    // then fail before consumption/session persistence. There is no remaining UI
    // action in that state, so finish the idempotent handoff on session restore.
    void planHandoff
      .recoverApproved(recoverableApproval)
      .then((recovered) => {
        if (!recovered || recoverableApproval?.state !== "human-approved") return;
        broadcast("plan_accepted", {
          checkpointId: recoverableApproval.checkpointId,
          generation: recoverableApproval.generation,
          recovered: true,
        });
        if (!hasPlanOnlyBoundary(recoverableApproval.content)) {
          broadcast("session_reset", { planTotal: approvedPlanTotal, recovered: true });
          broadcast("plan_progress", planProgressPayload());
        }
      })
      .catch((error) => {
        captureSidecarError(error, "app-sidecar.plan.recover-approval");
        log("ERROR", "app-sidecar", "approved plan handoff recovery failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  // ── Autopilot orchestration ─────────────────────────────────
  // One review = prompt the existing kenAuto session with the normal digest,
  // including any bound Roadmap phase. In Review, only a persisted final_review
  // whose completion gate reports Done can become ALL_CLEAR.
  async function runAutopilotReview(
    originalRequest: string,
    trigger?: AppSidecarRoadmapReviewTrigger,
  ): Promise<AutopilotVerdict | null> {
    autopilotReviewing = true;
    broadcast("autopilot_review_start", {});
    try {
      let boundPhase: ReturnType<typeof boundPhaseForAutopilotReview> = null;
      let verificationException: ReturnType<typeof latestVerificationExceptionForReview> = null;
      const activePhase = session.getActivePhaseContext();
      if (activePhase) {
        const loaded = await notesRepository.load(cwd);
        if (loaded.status === "ok") {
          boundPhase = boundPhaseForAutopilotReview(loaded.snapshot, activePhase.phase.id, trigger);
          if (trigger && !boundPhase) {
            throw new Error(
              `Roadmap final-review trigger ${trigger.triggerId} is no longer eligible.`,
            );
          }
          if (!trigger && boundPhase?.status === "review") {
            throw new Error(
              `Roadmap phase ${activePhase.phase.id} requires a scheduled final-review claim.`,
            );
          }
          const persistedPhase = loaded.snapshot.document.phases.find(
            (phase) => phase.id === activePhase.phase.id,
          );
          verificationException = latestVerificationExceptionForReview(persistedPhase);
        }
      }
      if (boundPhase?.status === "review" && !projectAutopilot.isEnabled(cwd)) return null;

      const ken = await ensureKenAutoSession();
      const workflowCommands = await loadWorkflowCommandSpecs();
      const reviewDigest = () =>
        buildKenAutopilotContext({
          cwd,
          gitBranch,
          messages: session.getMessages(),
          originalRequest,
          injectedPrompts: [...injectedAutopilotPrompts],
          workflowCommands,
          boundPhase,
          verificationException,
        });
      const finalReviewAttempts = await roadmapReviewRuns.run(
        trigger ?? null,
        async (attempt) => {
          if (attempt === 1 && trigger) {
            const refreshed = await notesRepository.load(cwd);
            if (refreshed.status !== "ok") {
              throw new Error(
                `Roadmap final-review retry ${trigger.triggerId} cannot reload Notes.`,
              );
            }
            boundPhase = boundPhaseForAutopilotReview(refreshed.snapshot, trigger.phaseId, trigger);
            if (!boundPhase) {
              throw new Error(
                `Roadmap final-review retry ${trigger.triggerId} is no longer eligible.`,
              );
            }
            const persistedPhase = refreshed.snapshot.document.phases.find(
              (phase) => phase.id === trigger.phaseId,
            );
            verificationException = latestVerificationExceptionForReview(persistedPhase);
          }
          await ken.prompt(reviewDigest());
        },
        (attempts) =>
          !autopilotCancelled &&
          trigger !== undefined &&
          boundPhase !== null &&
          classifyAppSidecarFinalReviewAttempt(boundPhase.id, attempts).status === "stale-revision",
      );
      if (autopilotCancelled) return null;
      const textVerdict = parseAutopilotVerdict(lastAssistantText(ken.getMessages()));
      const verdict = phaseCompletionVerdict(boundPhase, finalReviewAttempts, textVerdict);
      if (trigger) {
        const classification = classifyAppSidecarFinalReviewAttempt(
          trigger.phaseId,
          finalReviewAttempts,
        );
        const attempt = classification.status === "missing" ? null : classification.attempt;
        log("INFO", "app-sidecar", "roadmap final-review completed", {
          traceId: trigger.triggerId,
          phaseId: trigger.phaseId,
          finalReviewResult: attempt?.result.result ?? "missing",
          completionGateOutcome:
            attempt?.result.result === "completion-review-committed" ||
            attempt?.result.result === "completion-review-duplicate"
              ? attempt.result.gateOutcome
              : "unavailable",
        });
      }
      return verdict;
    } catch (err) {
      if (!autopilotCancelled && !trigger) {
        broadcastError("autopilot_error", "autopilot review failed", err);
      }
      return null;
    } finally {
      autopilotReviewing = false;
      // Apply any model switch that landed mid-review.
      const pending = pendingKenAutoModel;
      pendingKenAutoModel = null;
      if (pending) await syncKenAutoModel(pending.provider, pending.model);
    }
  }

  async function replayEligibleRoadmapReview(): Promise<boolean> {
    if (!autopilot || autopilotCancelled || !projectAutopilot.isEnabled(cwd)) return false;
    const activePhase = session.getActivePhaseContext();
    if (!activePhase) return false;
    const loaded = await notesRepository.load(cwd);
    if (loaded.status !== "ok") return false;
    const persistedPhase = loaded.snapshot.document.phases.find(
      (phase) => phase.id === activePhase.phase.id,
    );
    if (
      !persistedPhase ||
      persistedPhase.session?.sessionId !== activePhase.session.sessionId ||
      persistedPhase.session.sessionPath !== activePhase.session.sessionPath
    ) {
      return false;
    }
    return roadmapReviewScheduler.replay([persistedPhase]).length > 0;
  }

  async function reportRoadmapReviewSchedulingFailure(
    trigger: AppSidecarRoadmapReviewTrigger,
    error: unknown,
  ): Promise<void> {
    const loaded = await notesRepository.load(cwd);
    const observedRevision = loaded.status === "ok" ? loaded.snapshot.revision : null;
    const failure = appSidecarRoadmapReviewSchedulingFailure(trigger, observedRevision);
    captureSidecarError(error, "app-sidecar.roadmap-final-review-scheduling", {
      code: failure.code,
      traceId: trigger.triggerId,
      phaseId: trigger.phaseId,
      observedRevision: observedRevision === null ? "unavailable" : String(observedRevision),
    });
    log("ERROR", "app-sidecar", "roadmap final-review scheduling failed", {
      code: failure.code,
      traceId: trigger.triggerId,
      phaseId: trigger.phaseId,
      observedRevision,
      queueOutcome: "failed",
    });
    broadcast("autopilot_error", {
      code: failure.code,
      phaseId: trigger.phaseId,
      triggerId: trigger.triggerId,
      revision: observedRevision,
      headline: failure.headline,
      message: failure.message,
      guidance: failure.guidance,
    });
    await session
      .persistAppMarker("error", {
        scope: "autopilot_error",
        headline: failure.headline,
        message: failure.message,
        guidance: failure.guidance,
      })
      .catch(() => {});
    await phaseLifecycle.enqueue({
      type: "autopilot-stopped",
      reason: `${failure.code}: retry final review for trigger ${trigger.triggerId}`,
    });
  }

  async function drainScheduledRoadmapReview(
    originalRequest: string,
  ): Promise<{ attempted: boolean; verdict: AutopilotVerdict | null }> {
    await replayEligibleRoadmapReview();
    const result: { verdict: AutopilotVerdict | null } = { verdict: null };
    const outcomes = await roadmapReviewScheduler.drain(async (trigger) => {
      const activePhase = session.getActivePhaseContext();
      if (!activePhase || activePhase.phase.id !== trigger.phaseId) {
        throw new Error(
          `Roadmap final-review trigger ${trigger.triggerId} has no matching session.`,
        );
      }
      const loaded = await notesRepository.load(cwd);
      if (loaded.status !== "ok") {
        throw new Error(
          `Roadmap final-review trigger ${trigger.triggerId} cannot load Project Notes.`,
        );
      }
      log("INFO", "app-sidecar", "roadmap final-review reviewer starting", {
        traceId: trigger.triggerId,
        phaseId: trigger.phaseId,
        observedRevision: loaded.snapshot.revision,
        transition: "review",
        queueOutcome: "started",
      });
      const persistedPhase = loaded.snapshot.document.phases.find(
        (phase) => phase.id === trigger.phaseId,
      );
      const currentTrigger = persistedPhase ? appSidecarRoadmapReviewTrigger(persistedPhase) : null;
      if (currentTrigger?.triggerId !== trigger.triggerId) return;
      result.verdict = await runAutopilotReview(originalRequest, trigger);
      if (!result.verdict) {
        throw new Error(
          `Roadmap final-review trigger ${trigger.triggerId} did not produce a verdict.`,
        );
      }
    });
    const failed = outcomes.find((outcome) => outcome.status === "failed");
    if (failed?.status === "failed") {
      await reportRoadmapReviewSchedulingFailure(failed.trigger, failed.error);
    }
    return {
      attempted: outcomes.some((outcome) => outcome.status === "started"),
      verdict: result.verdict,
    };
  }

  // One PLAN review: like runAutopilotReview but the digest carries the
  // submitted plan's markdown (`## Plan under review`) and the plan-review
  // instruction — Ken judges the plan itself, not finished work. Returns null
  // on failure; a failure caused by the user's own action racing the review
  // SILENT when a human action wins the checkpoint race.
  async function runAutopilotPlanReview(originalRequest: string): Promise<AutopilotVerdict | null> {
    const checkpoint = planGate.current();
    if (!checkpoint || checkpoint.state !== "pending-review") return null;
    autopilotReviewing = true;
    broadcast("autopilot_review_start", {});
    try {
      const ken = await ensureKenAutoSession();
      const digest = buildKenAutopilotPlanContext({
        cwd,
        gitBranch,
        messages: session.getMessages(),
        originalRequest,
        injectedPrompts: [...injectedAutopilotPrompts],
        workflowCommands: await loadWorkflowCommandSpecs(),
        planContent: checkpoint.content,
      });
      await ken.prompt(digest);
      const current = planGate.current();
      if (
        autopilotCancelled ||
        current?.checkpointId !== checkpoint.checkpointId ||
        current.generation !== checkpoint.generation ||
        current.state !== "pending-review"
      )
        return null;
      return parseAutopilotVerdict(lastAssistantText(ken.getMessages()));
    } catch (err) {
      const current = planGate.current();
      if (
        autopilotCancelled ||
        current?.checkpointId !== checkpoint.checkpointId ||
        current.generation !== checkpoint.generation ||
        current.state !== "pending-review"
      )
        return null;
      broadcastError("autopilot_error", "autopilot plan review failed", err);
      return null;
    } finally {
      autopilotReviewing = false;
      // Apply any model switch that landed mid-review.
      const pending = pendingKenAutoModel;
      pendingKenAutoModel = null;
      if (pending) await syncKenAutoModel(pending.provider, pending.model);
    }
  }

  // The prompt fed to the fresh session after a plan is accepted — the SAME
  // string the webview sends on a manual Accept (see PlanReviewModal's accept
  // handler in gg-app/src/App.tsx). Keep the two in lockstep so auto- and
  // manual approval produce identical implementation turns.
  const IMPLEMENT_PLAN_PROMPT =
    "The plan has been approved. Implement it now, following each step in order.";

  async function startRoadmapPhase(
    phaseId: string,
    respond: (status: number, body: PhaseStartResponseBody) => void,
    advancementConfirmation?: {
      checkpointId: string;
      nextPhaseId: string;
      action: "start-next-phase";
    },
  ): Promise<void> {
    const gateConflict = planGateConflict();
    if (gateConflict) {
      respond(409, {
        status: "failed",
        code: "session-busy",
        message: "Resolve the pending plan review before replacing this session.",
        operationId: "plan-gate",
      });
      return;
    }
    await launchBoundPhase({
      phaseId,
      advancementConfirmation,
      mode,
      busyState: sessionBusyState(),
      mutations: sessionMutations,
      reconciliations: roadmapReconciliations,
      repository: notesRepository,
      cwd,
      candidates: phaseCandidates,
      getSession: () => session,
      getThinkingLevel: () => session.getThinkingLevel(),
      createSession: (active) => createCodingSession(undefined, active),
      replaceSession: (replacement) => {
        session = replacement;
        planGate = new AppSidecarPlanGate(replacement.getAppMarkers(), persistPlanGateMarker);
      },
      bindSessionEvents,
      autopilotEnabled: projectAutopilot.isEnabled(cwd),
      broadcastNotesSnapshot,
      broadcast,
      resetSessionState: () => {
        deactivateApprovedPlan();
        injectedAutopilotPrompts = [];
      },
      enterPlanMode: async (reason) => {
        await session.setPlanMode(true);
        broadcast("plan_progress", { total: 0, completed: [] });
        broadcast("plan_enter", { reason });
      },
      startPrompt: (label, run, onFailure) => {
        void runAgent(label, async () => {
          try {
            await run();
          } catch (error) {
            await onFailure(error);
            throw error;
          }
        });
      },
      respond,
      onLaunchFailure: (error, metadata) =>
        captureSidecarError(error, "app-sidecar.phase.launch", metadata),
      onAttentionFailure: (error, metadata) =>
        captureSidecarError(error, "app-sidecar.phase.launch-attention", metadata),
    });
  }

  // Drive the review→prompt→review loop for one finished user turn. Only ever
  // called after shouldStartAutopilotCycle approves the turn (POST /prompt or
  // the stranded-queue drain) — never from the task runner, resume, /ken, or
  // error paths, so there's no recursion and no guard tangle. The loop's
  // control flow lives in driveAutopilotCycle (core/autopilot-cycle.ts) so
  // every exit path is unit-tested; this only wires the real dependencies.

  async function runAutopilotCycle(originalRequest: string): Promise<void> {
    if (!autopilot || autopilotCancelled) return;
    const generation = runLifecycle.begin(abortOwnedWork).generation;
    pendingCancelDrain = null;
    autopilotActive = true;
    session.setIdealReviewSuppressed(true);
    let planReviewIdentity: { checkpointId: string; generation: number } | null = null;
    try {
      await driveAutopilotCycle({
        maxRounds: MAX_AUTOPILOT_ROUNDS,
        isCancelled: () => autopilotCancelled,
        isPlanMode: () => session.getPlanMode(),
        planPending: () => planGate.pending()?.state === "pending-review",
        reviewPlan: async () => {
          const checkpoint = planGate.current();
          planReviewIdentity = checkpoint
            ? { checkpointId: checkpoint.checkpointId, generation: checkpoint.generation }
            : null;
          return runAutopilotPlanReview(originalRequest);
        },
        markPlanReady: async () => {
          const identity = planReviewIdentity;
          if (!identity) return null;
          const result = await planGate.markReady(identity.checkpointId, identity.generation);
          return result.status === "committed" ? identity : null;
        },
        requestPlanRevision: async (feedback) => {
          if (!planReviewIdentity) return false;
          const result = await planGate.requestRevision(
            planReviewIdentity.checkpointId,
            planReviewIdentity.generation,
            "ken-autopilot",
            feedback,
          );
          if (result.status !== "committed") return false;
          broadcast("plan_revision_requested", {
            checkpointId: planReviewIdentity.checkpointId,
            generation: planReviewIdentity.generation,
            feedback,
            actor: "ken-autopilot",
          });
          return true;
        },
        // Lean context per user turn: wipe prior review history so each new
        // turn starts cheap, while within this cycle the few review messages
        // persist so Ken remembers what he already asked GG Coder to fix.
        resetReviewer: async () => {
          await kenAutoSession?.newSession().catch(() => {});
        },
        review: async () => {
          const settled = settledRoadmapReviewVerdict;
          settledRoadmapReviewVerdict = null;
          if (settled) return settled.verdict;
          const scheduled = await drainScheduledRoadmapReview(originalRequest);
          return scheduled.attempted ? scheduled.verdict : runAutopilotReview(originalRequest);
        },
        // prompt → record the injected body (so later digests label it as
        // Ken's, not the user's), show a compact Ken-tinted marker (not the
        // prompt body), then feed GG Coder bracketed by runAgent so the run
        // streams normally; the shared finally never re-triggers autopilot,
        // so this can't recurse.
        onInjected: (body, round) => {
          // Record the FRAMED string (what actually lands in the build session,
          // see runPrompt) so Ken's digest matches and labels it as injected.
          // The webview marker + persisted body stay the CLEAN prompt so the UI
          // shows Ken's actual instruction, not the autopilot preamble.
          injectedAutopilotPrompts.push(frameAutopilotInjection(body));
          broadcast("autopilot_prompted", { round, body });
          void session.persistAutopilotMarker("prompted", { body });
        },
        // Autopilot-injected run: GG Coder receives the framed prompt (no human
        // is watching this turn) while run_start keeps the clean label.
        runPrompt: (body) =>
          runAgent(body, () =>
            promptActiveSession(frameAutopilotInjection(body), AUTOMATION_PROVENANCE),
          ),
        emit: (event) => {
          // Persist the terminal verdict marker so a resumed session renders the
          // same Ken bubble the live run showed instead of dropping it or
          // falling back to the raw verdict text (e.g. ALL_CLEAR).
          if (event.type === "autopilot_done") {
            // Broadcast the SAME copySeed the persisted marker will produce on
            // resume, so the live all-clear wording matches the resumed one.
            // Must use the PERSISTED count — that's what persistAutopilotMarker
            // anchors against, and it trails the in-memory list after a run
            // whose messages never made it to disk.
            const seed = autopilotMarkerCopySeed({
              version: 1,
              phase: "done",
              afterMessageCount: session.getPersistedTranscriptCount(),
            });
            broadcast(event.type, { ...event.data, copySeed: seed });
            void session.persistAutopilotMarker("done");
            return;
          }
          broadcast(event.type, event.data);
          if (event.type === "autopilot_human") {
            void session.persistAutopilotMarker("human", { reason: event.data.reason });
          } else if (event.type === "autopilot_capped") {
            void session.persistAutopilotMarker("capped");
          }
          // autopilot_ignored renders nothing live, so nothing is persisted either.
        },
      });
    } finally {
      autopilotActive = false;
      session.setIdealReviewSuppressed(autopilot);
      finishOwnedGeneration(generation, true);
      queueMicrotask(() => {
        void runStrandedQueue();
      });
    }
  }

  queueMicrotask(() => {
    void replayEligibleRoadmapReview()
      .then(async (eligible) => {
        if (!eligible || sessionBusyState().running || sessionBusyState().autopilotActive) return;
        if (!runClaim.claim()) return;
        try {
          await runAutopilotCycle("Resume the unresolved Roadmap final review.");
        } finally {
          runClaim.release();
        }
      })
      .catch((error) => {
        captureSidecarError(error, "app-sidecar.roadmap-review-replay");
        log("ERROR", "app-sidecar", "roadmap final-review replay failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });

  // ── Stranded-queue drain ───────────────────────────────
  // A prompt POSTed while an autopilot cycle is between injected runs (build
  // idle, Ken reviewing) queues — but the queue only drains INTO a running
  // turn as steering. If the cycle ends without another run (ALL_CLEAR /
  // IGNORE / HUMAN / error), that message would sit stranded until the next
  // unrelated prompt, then land mislabeled as "concurrent steering" of an
  // unrelated run. Drain it here as a fresh turn of its own (with its own
  // gated review). Also covers the non-autopilot tail window: a message queued
  // after the run's last steering drain but before run_end.
  let drainingStrandedQueue = false;
  async function runStrandedQueue(): Promise<void> {
    if (drainingStrandedQueue || planGate.pending()) return;
    drainingStrandedQueue = true;
    try {
      for (;;) {
        if (running || autopilotActive) return;
        const next = session.takeNextQueuedMessage();
        if (!next) return;
        broadcast("queued", {
          count: session.getQueuedCount(),
          messages: session.listQueuedMessages(),
        });
        if (!next.text.trim() && next.attachments.length === 0) continue;
        const workflowCommand =
          next.attachments.length === 0 &&
          isWorkflowCommandText(next.text, await loadWorkflowCommandSpecs());
        const assistantsBefore = countAssistantMessages(session.getMessages());
        const messagesBefore = session.getMessages().length;
        await runAgent(next.text, async () => {
          if (next.attachments.length > 0) {
            await promptActiveSessionWithAttachments(next.text, next.attachments);
          } else {
            await promptActiveSession(next.text);
          }
        });
        const decision = shouldStartAutopilotCycle({
          enabled: autopilot,
          cancelled: autopilotCancelled,
          planMode: session.getPlanMode(),
          // A submitted plan (exit_plan fired) routes into the PLAN review
          // branch — the cycle reviews the plan itself instead of skipping.
          planPending: planGate.pending() !== null,
          workflowCommand,
          assistantMessagesAdded: countAssistantMessages(session.getMessages()) - assistantsBefore,
          // Skip the review API call outright for turns that only started a
          // background process (dev server/watcher), ran a read-only lookup, or
          // committed/pushed — Ken's autopilot contract already IGNOREs these,
          // so there's no reason to pay for that verdict.
          mechanicalOnly: isMechanicalOnlyTurn(
            extractTurnToolCalls(session.getMessages(), messagesBefore),
          ),
        });
        if (decision.start) {
          log("INFO", "app-sidecar", "autopilot cycle starting (queued turn)", {
            kind: decision.kind,
          });
          await runAutopilotCycle(next.text);
        } else if (autopilot) {
          log("INFO", "app-sidecar", "autopilot skipped (queued turn)", {
            reason: decision.reason,
          });
        }
      }
    } finally {
      drainingStrandedQueue = false;
    }
  }

  // ── Task runner (project task list → sessions) ──────────────
  // Mirrors the CLI's task flow: each task runs in its OWN fresh session, with a
  // completion hint instructing the agent to mark the task done via the tasks
  // tool. Run-all advances to the next pending task after each run finishes.
  let taskRunAll = false;

  async function runTaskById(taskId: string): Promise<boolean> {
    const task = loadTasksSync(cwd).find((t) => t.id === taskId || t.id.startsWith(taskId));
    if (!task) return false;
    // Fresh session per task so one task's context never bleeds into the next.
    await session.newSession();
    deactivateApprovedPlan();
    injectedAutopilotPrompts = [];
    planGate = new AppSidecarPlanGate(session.getAppMarkers(), persistPlanGateMarker);
    broadcast("session_reset", {});
    markTaskInProgress(cwd, task.id);
    broadcast("tasks_list", { tasks: loadTasksSync(cwd) });
    broadcast("task_start", { id: task.id, title: task.title });
    // Persist the task header so a resumed task session shows what ran.
    void session.persistAppMarker("task", { title: task.title }).catch(() => {});
    const shortId = task.id.slice(0, 8);
    const completionHint =
      `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
      `tasks({ action: "done", id: "${shortId}" })`;
    await runAgent(task.title, () =>
      promptActiveSession(task.prompt + completionHint, AUTOMATION_PROVENANCE),
    );
    // The agent typically marks the task done via the tasks tool during the run;
    // prune completed tasks and push the refreshed list so the modal drops them.
    broadcast("tasks_list", { tasks: pruneDoneTasksSync(cwd) });
    return true;
  }

  async function runTasks(startId: string | null, all: boolean): Promise<void> {
    taskRunAll = all;
    let currentId: string | null = startId ?? getNextPendingTask(cwd)?.id ?? null;
    while (currentId) {
      const ran = await runTaskById(currentId);
      if (!ran || !taskRunAll) break;
      const next = getNextPendingTask(cwd);
      currentId = next ? next.id : null;
      // Brief pause between tasks (mirrors the CLI cadence).
      if (currentId) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    taskRunAll = false;
    broadcast("tasks_run_done", {});
  }

  // ── Provider auth (login) bridge ───────────────────────────
  // OAuth login functions are interactive (open a URL, sometimes prompt for a
  // pasted code). We run one at a time and surface every step over SSE so the
  // webview can open the URL and collect a code via a modal. `pendingCode`
  // resolves when the webview POSTs /auth/oauth/code.
  let oauthInFlight = false;
  let pendingCode: ((code: string) => void) | null = null;

  function authCallbacks(): OAuthLoginCallbacks {
    return {
      onOpenUrl: (url) => broadcast("auth_url", { url }),
      onStatus: (message) => broadcast("auth_status", { message }),
      onPromptCode: (message) =>
        new Promise<string>((resolve) => {
          pendingCode = resolve;
          broadcast("auth_need_code", { message });
        }),
    };
  }

  async function authStatusPayload(): Promise<{
    providers: (AuthProviderMeta & {
      connected: boolean;
      connectedMethods: AuthMethod[];
      activeMethod?: AuthMethod;
      oauthExhaustedUntil?: number;
      priorityNote?: string;
      methodGuidance: AuthMethodMeta[];
    })[];
  }> {
    const providers = await Promise.all(
      AUTH_PROVIDERS.map(async (p) => {
        const dual = dualAuthProvider(p.value);
        // Which methods hold a credential right now. Dual-auth providers can hold
        // both at once, and the app needs them separately: one "connected" bit
        // cannot express "OAuth signed in, key also on file as backup", nor offer
        // a per-method disconnect.
        const oauthKey = dual?.oauthKey;
        const hasOAuth = oauthKey ? await auth.hasCredentials(oauthKey) : false;
        const apiKeyKeys = p.apiKeyVariants?.map((v) => v.key) ?? [p.value];
        const hasApiKey = p.methods.includes("apikey")
          ? (await Promise.all(apiKeyKeys.map((k) => auth.hasCredentials(k)))).some(Boolean)
          : false;
        const connectedMethods: AuthMethod[] = [];
        // OAuth-only providers (Anthropic/OpenAI/Gemini) store under the provider
        // id itself, so `hasProviderAuth` is what proves their OAuth connection.
        if (
          p.methods.includes("oauth") &&
          (hasOAuth || (!dual && (await auth.hasCredentials(p.value))))
        )
          connectedMethods.push("oauth");
        if (hasApiKey) connectedMethods.push("apikey");

        // Which one a request would actually use, mirroring AuthStorage's
        // resolution: OAuth wins unless its usage window is exhausted AND a key
        // is configured to cover it.
        const exhaustedUntil = oauthKey
          ? ((await auth.getCredentials(oauthKey))?.usageExhaustedUntil ?? 0)
          : 0;
        const oauthSidelined = hasOAuth && Date.now() < exhaustedUntil && hasApiKey;
        const activeMethod = connectedMethods.includes("oauth")
          ? oauthSidelined
            ? ("apikey" as const)
            : ("oauth" as const)
          : connectedMethods[0];

        // `methodDetails` is the server-side lookup table behind
        // `methodGuidance` — shipping both would duplicate every string on the
        // wire for no consumer.
        const { methodDetails: _table, ...wireMeta } = p;
        return {
          ...wireMeta,
          connected: await auth.hasProviderAuth(p.value),
          connectedMethods,
          ...(activeMethod ? { activeMethod } : {}),
          ...(oauthSidelined ? { oauthExhaustedUntil: exhaustedUntil } : {}),
          ...(authPriorityNote(p.value) ? { priorityNote: authPriorityNote(p.value)! } : {}),
          methodGuidance: describeAuthMethods(p.value),
        };
      }),
    );
    return { providers };
  }

  // Background tasks have no event source (the bash tool just spawns them), so
  // poll the process manager and broadcast only when the snapshot changes. This
  // keeps the webview footer live without a busy render loop. Adaptive cadence:
  // tasks can only change while a run is active (the bash tool spawns them), so
  // poll fast (1500ms) while running or while tasks exist, and back off to
  // 5000ms when fully idle — fewer wakeups per idle window.
  let lastTasksJson = "[]";
  let tasksPoll: NodeJS.Timeout | undefined;
  let tasksPollStopped = false;
  const scheduleTasksPoll = (delay: number): void => {
    if (tasksPollStopped) return;
    tasksPoll = setTimeout(() => {
      const tasks = session.listBackgroundProcesses();
      const next = JSON.stringify(tasks);
      if (next !== lastTasksJson) {
        lastTasksJson = next;
        broadcast("tasks", { tasks });
      }
      const active = running || tasks.length > 0;
      scheduleTasksPoll(active ? 1500 : 5000);
    }, delay);
    tasksPoll.unref?.();
  };
  scheduleTasksPoll(1500);

  // Files can change outside the agent (editor saves, terminal commits), so keep
  // the dirty count current while idle. Branch/repo state already refreshes after
  // agent runs; polling only the count avoids spawning three git processes per tick.
  let gitPoll: NodeJS.Timeout | undefined;
  let gitPollStopped = false;
  const scheduleGitPoll = (delay: number): void => {
    if (gitPollStopped) return;
    gitPoll = setTimeout(() => {
      void getGitDirtyFileCount(cwd)
        .catch(() => gitDirtyFileCount)
        .then((nextDirtyFileCount) => {
          if (gitPollStopped) return;
          if (nextDirtyFileCount !== gitDirtyFileCount) {
            gitDirtyFileCount = nextDirtyFileCount;
            broadcast("extras", footerExtras());
          }
          scheduleGitPoll(5000);
        });
    }, delay);
    gitPoll.unref?.();
  };
  scheduleGitPoll(5000);

  // GitHub issue/PR counts change outside the app (web UI, teammates), so poll
  // on a slow cadence. Network-bound, so keep it well under the search API's
  // rate budget (2 calls per tick). No-op when the origin isn't a GitHub repo.
  let gitHubPoll: NodeJS.Timeout | undefined;
  let gitHubPollStopped = false;
  const scheduleGitHubPoll = (delay: number): void => {
    if (gitHubPollStopped) return;
    gitHubPoll = setTimeout(() => {
      void refreshGitHubCounts().finally(() => scheduleGitHubPoll(60_000));
    }, delay);
    gitHubPoll.unref?.();
  };
  scheduleGitHubPoll(2000);

  const continuationHandoffService = new AppSidecarContinuationHandoffService({
    createSynthesisSession: (options: ContinuationSynthesisSessionOptions) =>
      new AgentSession(options),
  });
  const decisionSummaryService = new AppSidecarDecisionSummaryService(
    (options: DecisionSummarySessionOptions) => new AgentSession(options),
  );

  function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
    return readCappedBody(req, res);
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(redactValue(body, { secrets: environmentSecrets(process.env) }));
    res.writeHead(status, {
      "content-type": "application/json",
    });
    res.end(payload);
  }

  async function cancelActiveOperation(): Promise<
    ActiveOperationCancellationResult & { drained: string; runState: RunState }
  > {
    // A task/autopilot sweep remains an active operation between provider runs,
    // even though RunLifecycle is briefly idle during that gap.
    const operationWasActive = running || autopilotActive || runLifecycle.running;
    // Even between task runs, cancellation stops the sweep. Active provider
    // ownership invokes the full abort hook exactly once through lifecycle.
    taskRunAll = false;
    autopilotCancelled = true;
    if (!runLifecycle.running) {
      kenAutoAbort.abort();
      kenAutoAbort = new AbortController();
      kenAutoSession?.setSignal(kenAutoAbort.signal);
    }

    const generation = runLifecycle.generation;
    if (!pendingCancelDrain || pendingCancelDrain.generation !== generation) {
      pendingCancelDrain = { generation, text: session.drainQueue() };
      broadcast("queued", { count: 0, messages: [] });
    }
    const result = await runLifecycle.cancel(CANCEL_TIMEOUT_MS);
    const drained = pendingCancelDrain.text;
    if (result.status === "failed") {
      broadcast("cancel_failed", {
        error: "cancel_failed",
        reason: result.reason,
        runState: runLifecycle.state,
      });
      return {
        status: "failed",
        reason: result.reason,
        runState: runLifecycle.state,
        drained,
      };
    }
    return {
      status: result.status === "idle" && operationWasActive ? "cancelled" : result.status,
      runState: runLifecycle.state,
      drained,
    };
  }

  function stateSnapshot(): Record<string, unknown> {
    const state = session.getState();
    return {
      ...state,
      mode,
      chatAgent,
      running,
      runState: runLifecycle.state,
      ready: true,
      thinkingLevel: session.getThinkingLevel() ?? null,
      supportedThinkingLevels: getSupportedThinkingLevels(state.provider, state.model),
      supportsVideo: getModel(state.model)?.supportsVideo ?? false,
      autopilot,
      ...kenStatePayload(),
      ...footerExtras(),
      pendingPlanReview: planGate.pending(),
    };
  }

  // OPTIONS/CORS preflight is handled at the daemon level before delegation.
  function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): void {
    if (notes.handle(req, res, { cwd }, url, method)) return;
    if (reminders.handle(req, res, { id: opts.id, cwd }, url, method)) return;

    const draftRoute = parseRoadmapPhaseDraftRoute(method, url);
    if (draftRoute.status === "invalid-path") {
      json(res, 400, { error: "invalid draft id" });
      return;
    }
    if (draftRoute.status === "matched") {
      if (draftRoute.route.action === "pending") {
        json(res, 200, { status: "ok", draft: roadmapDraftDecisions.pending(cwd) });
        return;
      }
      if (draftRoute.route.action === "approve") {
        void roadmapDraftDecisions
          .approve(cwd, draftRoute.route.draftId)
          .then((result) => json(res, roadmapPhaseDraftApprovalHttpStatus(result), result))
          .catch((error) => {
            captureSidecarError(error, "app-sidecar.roadmap-draft.approve");
            json(res, 500, { status: "storage-failed", message: "phase creation failed" });
          });
        return;
      }
      const draftId = draftRoute.route.draftId;
      void readBody(req, res)
        .then(async (raw) => {
          if (raw === null) return;
          const parsed = parseRoadmapPhaseDraftRejectBody(raw);
          if (parsed.status === "invalid") {
            json(res, 422, { error: parsed.message });
            return;
          }
          const result = await roadmapDraftDecisions.reject(cwd, draftId, parsed.feedback);
          json(res, roadmapPhaseDraftRejectionHttpStatus(result), result);
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.roadmap-draft.reject");
          json(res, 500, { error: "phase rejection failed" });
        });
      return;
    }

    if (method === "GET" && url === "/state") {
      json(res, 200, stateSnapshot());
      return;
    }

    if (method === "GET" && url === "/progress") {
      json(res, 200, progress.snapshot());
      return;
    }

    if (method === "GET" && url === "/memories") {
      void memoryStore
        .snapshot()
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.memory.snapshot");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "DELETE" && url.startsWith("/memories/")) {
      const id = decodeURIComponent(url.slice("/memories/".length));
      if (!id) {
        json(res, 400, { error: "memory id is required" });
        return;
      }
      void memoryStore
        .forget(id)
        .then(() => memoryStore.snapshot())
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.memory.forget");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "GET" && url === "/jiwa") {
      void jiwaStore
        .snapshot()
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.jiwa.snapshot");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "DELETE" && url.startsWith("/jiwa/")) {
      const id = decodeURIComponent(url.slice("/jiwa/".length));
      if (!id) {
        json(res, 400, { error: "Jiwa entry id is required" });
        return;
      }
      void jiwaStore
        .forget(id)
        .then(() => jiwaStore.snapshot())
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.jiwa.forget");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }
    if (method === "GET" && (url === "/events" || url.startsWith("/events?"))) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`retry: 1000\n\n`);
      const client: SseClient = { id: ++clientSeq, res };
      clients.add(client);
      let keepAlive: NodeJS.Timeout | undefined;
      let closed = false;
      const cleanup = (): void => {
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        clients.delete(client);
      };
      res.once("error", cleanup);
      res.once("close", cleanup);
      try {
        res.write(sseFrame("ready", stateSnapshot()));
      } catch {
        cleanup();
      }
      if (!closed) {
        keepAlive = setInterval(() => {
          try {
            if (res.destroyed) cleanup();
            else res.write(`: ping\n\n`);
          } catch {
            cleanup();
          }
        }, 15000);
      }
      req.once("close", cleanup);
      return;
    }

    if (method === "GET" && url === "/plugins") {
      void listInstalledPlugins(paths.extensionsDir)
        .then((plugins) => json(res, 200, { plugins }))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.plugins.list");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "POST" && url === "/plugins/install") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        try {
          const bundlePath = (JSON.parse(raw) as { bundlePath?: unknown }).bundlePath;
          if (typeof bundlePath !== "string" || !path.isAbsolute(bundlePath)) {
            json(res, 400, { error: "bundlePath must be an absolute path" });
            return;
          }
          const plugin = await installPlugin(bundlePath, paths.extensionsDir);
          json(res, 200, { plugin, restartRequired: true });
        } catch (error) {
          captureSidecarError(error, "app-sidecar.plugins.install");
          json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      });
      return;
    }

    if (method === "DELETE" && url.startsWith("/plugins/")) {
      const pluginId = decodeURIComponent(url.slice("/plugins/".length));
      void removePlugin(pluginId, paths.extensionsDir)
        .then(() => json(res, 200, { removed: pluginId, restartRequired: true }))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.plugins.remove");
          json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "GET" && url === "/settings") {
      // `configured` is true only when the user explicitly saved a projects root
      // (the gg-app.json file exists with a value) — not when we fall back to the
      // default. The home screen gates "Your Projects" on this.
      void (async () => {
        const s = await loadAppSettings();
        let configured: boolean;
        try {
          const raw = JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as {
            projectsRoot?: string;
          };
          configured = typeof raw.projectsRoot === "string" && raw.projectsRoot.trim().length > 0;
        } catch {
          configured = false;
        }
        // Only projectsRoot + configured flag are webview-facing; the
        // per-project model map is internal persistence, never shipped out.
        json(res, 200, { projectsRoot: s.projectsRoot, configured });
      })();
      return;
    }

    if (method === "POST" && url === "/settings") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let projectsRoot: string;
        try {
          projectsRoot = (JSON.parse(raw) as { projectsRoot?: string }).projectsRoot ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!projectsRoot.trim()) {
          json(res, 400, { error: "projectsRoot is required" });
          return;
        }
        // Read-modify-write so the per-project model map survives a projectsRoot
        // change (a naive overwrite would drop every window's saved model).
        const s = await loadAppSettings();
        s.projectsRoot = projectsRoot;
        await saveAppSettings(s);
        json(res, 200, { projectsRoot });
      });
      return;
    }

    if (method === "POST" && url === "/create-project") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let name: string;
        try {
          name = (JSON.parse(raw) as { name?: string }).name ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        name = name.trim();
        if (!isValidProjectName(name)) {
          json(res, 400, {
            error: "Project name must be lowercase letters, digits, and dashes (e.g. my-project).",
          });
          return;
        }
        const { projectsRoot } = await loadAppSettings();
        const dir = path.join(projectsRoot, name);
        try {
          // Refuse to clobber an existing directory.
          const exists = await fs
            .stat(dir)
            .then(() => true)
            .catch(() => false);
          if (exists) {
            json(res, 409, { error: `A folder named "${name}" already exists.` });
            return;
          }
          await fs.mkdir(dir, { recursive: true });
          json(res, 200, { path: dir });
        } catch (err) {
          captureSidecarError(err, "app-sidecar.project.create");
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    // Dismiss a project from the picker (or restore it with hidden:false). The
    // path is kept rather than the row: sessions in scratch dirs keep
    // re-surfacing, so the user's decision has to outlive any one scan.
    if (method === "POST" && url === "/projects/hidden") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let body: { path?: string; hidden?: boolean };
        try {
          body = JSON.parse(raw) as { path?: string; hidden?: boolean };
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const target = body.path?.trim();
        if (!target) {
          json(res, 400, { error: "path is required" });
          return;
        }
        const key = path.resolve(target);
        try {
          const settings = await loadAppSettings();
          const current = new Set((settings.hiddenProjects ?? []).map((p) => path.resolve(p)));
          if (body.hidden === false) current.delete(key);
          else current.add(key);
          settings.hiddenProjects = current.size > 0 ? Array.from(current) : undefined;
          await saveAppSettings(settings);
          json(res, 200, { hidden: Array.from(current) });
        } catch (err) {
          captureSidecarError(err, "app-sidecar.projects.hidden");
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    if (method === "GET" && url === "/projects") {
      // Session stores plus configured/inferred filesystem roots, with hidden
      // projects filtered by the canonical discovery implementation.
      void loadAppSettings()
        .then(({ projectsRoot, projectRoots, hiddenProjects }) =>
          discoverProjects({
            projectsRoot,
            extraRoots: projectRoots,
            hiddenPaths: hiddenProjects,
          }),
        )
        .then((projects) => json(res, 200, { projects }))
        .catch((err) => {
          captureSidecarError(err, "app-sidecar.projects.discover");
          log("ERROR", "app-sidecar", "discoverProjects failed", {
            message: err instanceof Error ? err.message : String(err),
          });
          json(res, 200, { projects: [] });
        });
      return;
    }

    if (method === "GET" && url.startsWith("/sessions")) {
      const target = new URL(url, `http://${host}`).searchParams.get("cwd");
      if (!target) {
        json(res, 400, { error: "missing cwd query param" });
        return;
      }
      const requestedAgent = new URL(url, `http://${host}`).searchParams.get("chatAgent");
      // An omitted chatAgent means coding history; chat callers identify one
      // agent or request the combined, recency-sorted "all" listing.
      void listSidecarSessions(target, requestedAgent, paths.sessionsDir)
        .then((sessions) => json(res, 200, { sessions }))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.sessions.list");
          json(res, 200, { sessions: [] });
        });
      return;
    }

    if (method === "GET" && url.startsWith("/files")) {
      const q = new URL(url, `http://${host}`).searchParams.get("q") ?? "";
      void searchProjectFiles(cwd, q)
        .then((files) => json(res, 200, { files }))
        .catch((err) => {
          captureSidecarError(err, "app-sidecar.files.search");
          log("ERROR", "app-sidecar", "searchProjectFiles failed", {
            message: err instanceof Error ? err.message : String(err),
          });
          json(res, 200, { files: [] });
        });
      return;
    }

    // Markdown transcript export for the app's download button. Serialized
    // here rather than in the webview because the webview's transcript model
    // deliberately keeps tool activity in the LiveToolPanel — exporting from
    // there would hand the user a coding session with the coding missing.
    // `?name=1` asks for the suggested filename only (the save dialog needs it
    // before there is a path), so the markdown never crosses IPC twice.
    if (method === "GET" && (url === "/export" || url.startsWith("/export?"))) {
      const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const st = session.getState();
      const filename = defaultExportFilename(mode);
      if (query.get("name") === "1") {
        json(res, 200, { filename });
        return;
      }
      const markdown = sessionToMarkdown(
        {
          mode,
          cwd,
          provider: st.provider,
          model: st.model,
          ...(st.sessionId ? { sessionId: st.sessionId } : {}),
        },
        session.getMessages(),
        { toolDetail: parseToolDetail(query.get("tools")) },
      );
      json(res, 200, { filename, markdown });
      return;
    }

    if (method === "GET" && url === "/history") {
      // Reconstruct the transcript from persisted messages so resume is 1:1 with
      // the live SSE stream. Walks ALL message types (not just user/assistant):
      // tool result messages carry ImageContent blocks (screenshots,
      // generate_image) that must re-render inline, and assistant tool_call
      // blocks carry sub-agent delegations that must re-appear as group items.
      //
      // The `details` object (imagePreviews with path + downscaled preview) is
      // event-only and never persisted — we reconstruct from the raw
      // ImageContent in the tool result, downsampling on the sidecar side and
      // extracting the path from the text block ("Generated image → /path").
      void (async () => {
        const commandCandidates = [...PROMPT_COMMANDS, ...(await loadCustomCommands(cwd))];
        const messages = session.getMessages();

        // An Ideal hook is injected immediately after the assistant's candidate
        // no-tool response. That response is review scratch, not a user-visible
        // final answer. Live SSE drops it when the hook event arrives; mark the
        // same assistant message here so resumed history stays identical.
        const hiddenIdealDrafts = new Set<(typeof messages)[number]>();
        for (let i = 0; i < messages.length - 1; i++) {
          const draft = messages[i];
          const hookPrompt = messages[i + 1];
          if (draft?.role !== "assistant" || hookPrompt?.role !== "user") continue;
          const restored = restoreUserRow(hookPrompt.content);
          if (detectHookKind(restored.text) === "ideal") hiddenIdealDrafts.add(draft);
        }

        // Pre-index tool results by toolCallId so we can pair tool calls with
        // their results (for sub-agent status + image extraction).
        const toolResultMap = new Map<string, { content: ToolResultContent; isError: boolean }>();
        for (const msg of messages) {
          if (msg.role !== "tool") continue;
          for (const tr of msg.content) {
            toolResultMap.set(tr.toolCallId, {
              content: tr.content,
              isError: tr.isError ?? false,
            });
          }
        }

        const persistedMcpFailures = collectPersistedMcpToolFailures(
          messages,
          environmentSecrets(process.env),
        );
        const history: HistoryEntryForWire[] = [];

        // Ken (mentor) turns to interleave: group by the non-system message count
        // they were recorded after, so each lands right after that message. A
        // turn becomes two wire rows: the `@Ken` question (user) + Ken's reply
        // (assistant), both flagged `ken` so the webview tints them.
        // Deduped; stale anchors are clamped to the last message (Ken turns
        // carry real conversation, so they render at the end instead of
        // vanishing).
        const kenByCount = new Map<number, KenTurnPayload[]>();
        for (const turn of normalizeKenTurnsForHistory(
          session.getKenTurns(),
          messages.filter((m) => m.role !== "system").length,
        )) {
          const list = kenByCount.get(turn.afterMessageCount) ?? [];
          list.push(turn);
          kenByCount.set(turn.afterMessageCount, list);
        }
        const flushKen = (count: number): void => {
          const turns = kenByCount.get(count);
          if (!turns) return;
          kenByCount.delete(count);
          for (const turn of turns) {
            history.push({ role: "user", text: `@Ken ${turn.question}`, ken: true });
            history.push({ role: "assistant", text: turn.reply, ken: true });
          }
        };

        // Autopilot verdict markers to interleave, same anchor scheme as Ken
        // turns — each becomes a single assistant row the webview renders
        // exactly like the live `autopilot` item (never a raw verdict string).
        // Normalization pulls anchors left over from an unrebased compaction
        // back to where the marker was actually written, so stale all-clear
        // bubbles no longer bunch at the bottom of a reopened session.
        const restoredMessageCount = messages.filter((m) => m.role !== "system").length;
        const autopilotByCount = new Map<
          number,
          ReturnType<typeof normalizeAutopilotMarkersForHistory>
        >();
        for (const marker of normalizeAutopilotMarkersForHistory(
          session.getAutopilotMarkers(),
          restoredMessageCount,
        )) {
          const list = autopilotByCount.get(marker.afterMessageCount) ?? [];
          list.push(marker);
          autopilotByCount.set(marker.afterMessageCount, list);
        }
        const flushAutopilot = (count: number): void => {
          const markers = autopilotByCount.get(count);
          if (!markers) return;
          autopilotByCount.delete(count);
          for (const marker of markers) {
            history.push({
              role: "assistant",
              text: "",
              autopilot: {
                phase: marker.phase,
                ...(marker.reason !== undefined ? { reason: marker.reason } : {}),
                ...(marker.body !== undefined ? { body: marker.body } : {}),
                copySeed: marker.copySeed,
              },
            });
          }
        };

        // App transcript markers (plan banner / task header / error rows /
        // user-bubble hints), same anchor scheme. user_hint markers don't
        // become rows — they decorate the user row at their anchor instead.
        const appMarkersByCount = new Map<number, AppMarkerPayload[]>();
        const userHintByCount = new Map<number, Record<string, unknown>>();
        // Compaction-count markers pair with compacted summary rows in file
        // order (FIFO), not by anchor — the summary user message is what
        // positions the notice.
        const compactionCounts: Array<{ originalCount: number; newCount: number }> = [];
        for (const marker of normalizeAppMarkersForHistory(
          session.getAppMarkers(),
          restoredMessageCount,
        )) {
          if (marker.kind === "user_hint") {
            userHintByCount.set(marker.afterMessageCount, marker.data);
            continue;
          }
          if (marker.kind === "compaction") {
            const d = marker.data;
            if (typeof d.originalCount === "number" && typeof d.newCount === "number") {
              compactionCounts.push({ originalCount: d.originalCount, newCount: d.newCount });
            }
            continue;
          }
          const list = appMarkersByCount.get(marker.afterMessageCount) ?? [];
          list.push(marker);
          appMarkersByCount.set(marker.afterMessageCount, list);
        }
        const flushAppMarkers = (count: number): void => {
          const markers = appMarkersByCount.get(count);
          if (!markers) return;
          appMarkersByCount.delete(count);
          for (const marker of markers) {
            const d = marker.data;
            if (marker.kind === "plan") {
              history.push({
                role: "assistant",
                text: "",
                plan: { reason: typeof d.reason === "string" ? d.reason : "" },
              });
            } else if (marker.kind === "task") {
              history.push({
                role: "assistant",
                text: "",
                task: { title: typeof d.title === "string" ? d.title : "" },
              });
            } else if (marker.kind === "error" && typeof d.headline === "string") {
              history.push({
                role: "assistant",
                text: "",
                error: {
                  scope: typeof d.scope === "string" ? d.scope : "error",
                  headline: d.headline,
                  ...(typeof d.message === "string" ? { message: d.message } : {}),
                  ...(typeof d.guidance === "string" ? { guidance: d.guidance } : {}),
                },
              });
            } else if (marker.kind === "interrupted_run") {
              // Rendered as an error row: the run's tools already changed the
              // repo, so the user needs to see it and decide what to do. We
              // never replay it — that would duplicate those changes.
              history.push({
                role: "assistant",
                text: "",
                error: {
                  scope: "interrupted_run",
                  headline: "A run was interrupted",
                  message:
                    "Supah Coder stopped mid-run, so this turn is incomplete. Any files its tools already changed are still on disk.",
                  guidance:
                    "Review the working tree, then re-send the request if you still want it.",
                },
              });
            }
          }
        };
        let nonSystemCount = 0;
        // Turns/markers recorded before any build message (anchor 0) render at
        // the top.
        flushKen(0);
        flushAutopilot(0);
        flushAppMarkers(0);

        await replayMessagesInOrder(
          messages,
          async (msg, count) => {
            nonSystemCount = count;
            const visibility = getHistoryMessageVisibility(msg);
            if (visibility === "hidden") return;

            if (msg.role === "tool") {
              // Explicit MCP failures stay visible after the temporary live-tool
              // panel clears and after a full session reload.
              for (const tr of msg.content) {
                const failure = persistedMcpFailures.get(tr.toolCallId);
                if (failure) {
                  history.push({
                    role: "assistant",
                    text: "",
                    mcpToolFailure: { name: failure.name, result: failure.result },
                  });
                }
              }
              // Tool result messages: check for ImageContent blocks (screenshots,
              // generated images) and emit a toolImages entry.
              for (const tr of msg.content) {
                if (typeof tr.content === "string") continue;
                const imageBlocks = tr.content.filter((c) => c.type === "image");
                if (imageBlocks.length === 0) continue;
                // Extract the path from the text block (e.g. "Generated image → /path").
                const textBlock = tr.content.find(
                  (c) => c.type === "text" && "text" in c && typeof c.text === "string",
                );
                const textContent = textBlock && textBlock.type === "text" ? textBlock.text : "";
                const pathMatch = textContent.match(/→\s*(\S+)/);
                const imgPath = pathMatch?.[1];

                // Downscale each image for the webview preview.
                const toolImages: Array<{ src: string; path?: string }> = [];
                for (const block of imageBlocks) {
                  if (block.type !== "image") continue;
                  try {
                    const rawBuf = Buffer.from(block.data, "base64");
                    const previewBuf = await downscaleForPreview(rawBuf);
                    toolImages.push({
                      src: `data:${block.mediaType};base64,${previewBuf.toString("base64")}`,
                      path: imgPath,
                    });
                  } catch {
                    // Downscale failed — use the raw data.
                    toolImages.push({
                      src: `data:${block.mediaType};base64,${block.data}`,
                      path: imgPath,
                    });
                  }
                }
                if (toolImages.length > 0) {
                  history.push({
                    role: "assistant",
                    text: "",
                    toolImages,
                  });
                }
              }
              return;
            }

            // User or assistant message — text/hook/command/compacted extraction,
            // plus sub-agent group detection for assistant tool_calls.
            if (msg.role === "user") {
              // Rebuild the live bubble: strip the steering wrapper, drop
              // attachment/file notes the model saw but the bubble never showed.
              const restored = restoreUserRow(msg.content, msg.provenance);
              const text = restored.text;
              const hook = msg.provenance ? null : detectHookKind(text);
              const compacted =
                visibility === "summary" ||
                (!msg.provenance && !hook && text.startsWith("[Previous conversation summary]"));
              const hint = userHintByCount.get(nonSystemCount);
              // The typed invocation persisted alongside the prompt is
              // authoritative. Reversing the expanded body only works while the
              // template is byte-identical, and templates drift (edited
              // `.gg/commands/*.md`, reworded built-ins, app-vs-CLI phrasing) —
              // after which the resumed session dumped the raw multi-KB body
              // instead of the `/name` chip. Older sessions have no hint, so the
              // body match stays as the fallback.
              const command =
                !hook && !compacted
                  ? resolveRestoredCommand(
                      typeof hint?.command === "string" ? hint.command : null,
                      text,
                      commandCandidates,
                    )
                  : null;
              // Autopilot injected this turn — live showed only the Ken-tinted
              // marker for it, never a user bubble. Emitting one here would print
              // the injected instruction a second time, unstyled.
              //
              // Pushed background-status updates are skipped for the same reason:
              // the live run rendered no bubble for them, so showing them here
              // would fill a reopened session with machine-facing status lines
              // the user never saw while working.
              if (
                (!msg.provenance || (!restored.autopilotInjected && !restored.notification)) &&
                (text.trim() || restored.images.length > 0)
              ) {
                history.push({
                  role: "user",
                  text: command ?? text,
                  images: restored.images,
                  hook,
                  command: command !== null,
                  compacted,
                  // Markers accumulate across continuation files (each rewrite
                  // re-persists prior ones) but only the LATEST summary row
                  // survives compaction — so consume from the newest end.
                  ...(compacted && compactionCounts.length > 0
                    ? { compactionCounts: compactionCounts.pop() }
                    : {}),
                  ...(hint?.kenSent === true ? { kenSent: true } : {}),
                  ...(Array.isArray(hint?.enhancements) ? { enhancements: hint.enhancements } : {}),
                });
                // Live showed the video-capability warning right after the bubble.
                if (restored.videoWarning) {
                  history.push({ role: "assistant", text: "", infoKind: "video_warning" });
                }
              }
            } else if (!hiddenIdealDrafts.has(msg)) {
              // Assistant: one wire row per persisted text block — live streaming
              // splits bubbles at server_tool_call boundaries, and the persisted
              // content keeps those blocks separate. Ideal-review candidate drafts
              // are intentionally omitted to match the live pre-final hook flow.
              for (const blockText of restoreAssistantTexts(msg.content)) {
                history.push({
                  role: "assistant",
                  text: blockText,
                  images: [],
                  hook: null,
                  command: false,
                  compacted: false,
                });
              }
            }

            // Assistant tool_call blocks: detect sub-agent delegations.
            if (msg.role === "assistant" && typeof msg.content !== "string") {
              const subagentCalls = msg.content.filter(
                (
                  c,
                ): c is typeof c & {
                  type: "tool_call";
                  id: string;
                  name: string;
                  args: Record<string, unknown>;
                } => c.type === "tool_call" && (c.name === "subagent" || c.name === "spawn_agent"),
              );
              if (subagentCalls.length > 0) {
                const agents = subagentCalls.map((c) => {
                  const result = toolResultMap.get(c.id);
                  return {
                    agentName:
                      c.name === "spawn_agent" && typeof c.args?.task_name === "string"
                        ? c.args.task_name
                        : typeof c.args?.agent === "string"
                          ? c.args.agent
                          : undefined,
                    // Async workers are intentionally non-resumable; restored rows are historical.
                    status: result?.isError ? ("error" as const) : ("done" as const),
                    toolUseCount: 0,
                  };
                });
                history.push({
                  role: "assistant",
                  text: "",
                  subagentGroup: agents,
                });
              }
            }
          },
          (count) => {
            // Markers flush after every physical message, including tools and
            // provenance-hidden runtime context.
            flushKen(count);
            flushAutopilot(count);
            flushAppMarkers(count);
          },
        );

        // Flush remaining Ken turns whose anchor is at/after the message count so
        // none are dropped. Autopilot/app markers beyond the restored message
        // count were already filtered above; any remaining marker here is valid.
        for (const count of [...kenByCount.keys()].sort((a, b) => a - b)) flushKen(count);
        for (const count of [...autopilotByCount.keys()].sort((a, b) => a - b))
          flushAutopilot(count);
        for (const count of [...appMarkersByCount.keys()].sort((a, b) => a - b))
          flushAppMarkers(count);

        json(res, 200, { history });
      })();
      return;
    }

    if (method === "GET" && url === "/commands") {
      const chatCommands = appSidecarChatCommandsResponse(mode);
      if (chatCommands) {
        json(res, 200, chatCommands);
        return;
      }
      // Workflow commands with agent functionality: built-in prompt templates +
      // the user's own `.gg/commands/*.md`.
      void (async () => {
        const builtins = PROMPT_COMMANDS.map((c) => ({
          name: c.name,
          aliases: c.aliases,
          description: c.description,
          source: "built-in" as const,
        }));
        // Desktop-safe registry actions belong in the same picker as workflows.
        // Most registry commands have dedicated app controls or TUI-only flows;
        // multi-root management has no other affordance, so expose only these.
        const workspaceActions = [
          {
            name: "add-dir",
            aliases: ["adddir"],
            description: "Add another project folder to this workspace",
            source: "built-in" as const,
          },
          {
            name: "remove-dir",
            aliases: ["removedir"],
            description: "Remove an added project folder from this workspace",
            source: "built-in" as const,
          },
        ];
        const custom = (await loadCustomCommands(cwd))
          // A custom command can't shadow a built-in name or app action.
          .filter(
            (c) =>
              !PROMPT_COMMANDS.some((b) => b.name === c.name) &&
              !workspaceActions.some((action) => action.name === c.name),
          )
          .map((c) => ({
            name: c.name,
            aliases: [] as string[],
            description: c.description,
            source: "custom" as const,
          }));
        json(res, 200, { commands: [...workspaceActions, ...builtins, ...custom] });
      })();
      return;
    }

    if (method === "POST" && url === "/decision-summary") {
      void readCappedBody(req, res, DECISION_SUMMARY_CONTEXT_MAX_BYTES)
        .then(async (raw) => {
          if (raw === null) return;
          const response = await handleDecisionSummaryRequest(raw, session, decisionSummaryService);
          json(res, response.status, response.body);
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.decision-summary.route");
          json(res, 500, { error: "decision summary unavailable" });
        });
      return;
    }

    if (method === "POST" && url === "/continuation-handoff") {
      void readBody(req, res)
        .then(async (raw) => {
          if (raw === null) return;
          let nextInstruction: string;
          try {
            const body = JSON.parse(raw) as { nextInstruction?: unknown };
            nextInstruction = typeof body.nextInstruction === "string" ? body.nextInstruction : "";
          } catch {
            json(res, 400, { error: "invalid JSON body" });
            return;
          }
          if (!nextInstruction.trim()) {
            json(res, 400, { error: "empty next instruction" });
            return;
          }
          if (nextInstruction.length > CONTINUATION_HANDOFF_LIMITS.nextInstructionChars) {
            json(res, 413, { error: "next instruction is too long" });
            return;
          }
          try {
            const prepared = await continuationHandoffService.prepare(session, nextInstruction);
            json(res, 200, { version: prepared.version, prompt: prepared.prompt });
          } catch (error) {
            captureSidecarError(error, "app-sidecar.continuation-handoff");
            json(res, 502, {
              error: error instanceof Error ? error.message : "continuation handoff failed",
            });
          }
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.continuation-handoff.route");
          json(res, 500, { error: "continuation handoff failed" });
        });
      return;
    }

    if (method === "POST" && url === "/prompt") {
      const conflict = planGateConflict();
      if (conflict) {
        req.resume();
        json(res, 409, conflict);
        return;
      }
      // Per-request: only the prompt that actually claimed the start may release
      // it. A bare release would let an early-returning request (bad JSON, or a
      // prompt that queued) clear a claim another request is still holding.
      let claimedStart = false;
      void readBody(req, res)
        .then(async (raw) => {
          if (raw === null) return;
          let text: string;
          let attachments: AppAttachment[];
          let meta: { kenSent?: boolean; enhancements?: unknown[] } | undefined;
          try {
            const body = JSON.parse(raw) as {
              text?: string;
              attachments?: AppAttachment[];
              meta?: { kenSent?: boolean; enhancements?: unknown[] };
            };
            text = body.text ?? "";
            attachments = Array.isArray(body.attachments) ? body.attachments : [];
            meta = typeof body.meta === "object" && body.meta !== null ? body.meta : undefined;
          } catch {
            json(res, 400, { error: "invalid JSON body" });
            return;
          }
          if (!text.trim() && attachments.length === 0) {
            json(res, 400, { error: "empty prompt" });
            return;
          }

          // Classify the raw, case-sensitive built-in token before any generic
          // workflow/custom-command lookup can expand a conflicting research.md.
          const researchRoute = resolveChatResearchCommandRoute({
            mode,
            text,
            attachmentCount: attachments.length,
            busy: running || runClaim.active || autopilotActive || runLifecycle.running,
          });
          const handledResearch = await handleAppSidecarChatResearchPrompt({
            route: researchRoute,
            claimStart: () => {
              // `/research` is a fail-fast transition, never mid-run steering. Claim
              // synchronously before any switch or persistence operation can yield.
              claimedStart = runClaim.claim();
              return claimedStart;
            },
            respond: ({ status, body }) => json(res, status, body),
            runAgent,
            operations: {
              session,
              commitResearchTransition: (activeSession) =>
                commitChatResearchTransition({
                  session: activeSession,
                  previousAgent: chatAgent,
                  researchAgent: "research" as const,
                  switchAgent: (targetSession, nextAgent) =>
                    switchChatAgent(targetSession, nextAgent, false),
                  persistAgentHandoff: (targetSession) =>
                    targetSession.persistAppMarker("agent_handoff", {
                      chatAgent: "research",
                    }),
                  onCommitted: (changed) => {
                    chatAgent = "research";
                    if (changed) broadcast("chat_agent_change", { chatAgent });
                  },
                }),
              persistUserHint: (activeSession, displayText) =>
                activeSession.persistAppMarker("user_hint", { command: displayText }, 1),
              prompt: async (activeSession, continuationPrompt) => {
                if (activeSession !== session) {
                  throw new Error("Research handoff changed logical sessions");
                }
                await promptActiveSession(continuationPrompt);
              },
            },
          });
          if (handledResearch) return;

          if (
            runLifecycle.running &&
            runLifecycle.isCancellationRequested(runLifecycle.generation)
          ) {
            json(res, 409, {
              error: runLifecycle.state === "cancelling" ? "run_cancelling" : "cancel_failed",
              runState: runLifecycle.state,
            });
            return;
          }
          // `runClaim` covers the gap before `runAgent` flips `running`: a
          // prompt arriving in that window must queue, not start a second run.
          if (running || runClaim.active || autopilotActive) {
            // Queue prompts as mid-run steering (mirrors the CLI). Also queue while
            // an autopilot cycle is active but between injected runs (build idle,
            // Ken reviewing) so the message never starts a run that collides with
            // an injected one on the same session. Attachments are persisted to
            // .gg/uploads first so the queued media rides the same native-block
            // path as a non-queued attachment prompt when it drains.
            const prepared =
              attachments.length > 0 ? await prepareAttachments(cwd, attachments) : [];
            const count = session.queueMessage(text, prepared);
            broadcast("queued", { count, messages: session.listQueuedMessages() });
            json(res, 202, { queued: true, count });
            return;
          }
          // Claim the run NOW, synchronously. Everything below this line may
          // yield, and `running` does not flip until runAgent begins.
          claimedStart = runClaim.claim();
          json(res, 202, { queued: false, count: 0 });
          // Gate inputs captured around the run: whether this turn is a workflow
          // slash command (attachment prompts skip slash expansion entirely), and
          // how many assistant messages the run actually adds. Computed even when
          // autopilot is currently off — the toggle can flip ON mid-run, and the
          // gate reads the post-run value.
          const workflowCommand =
            attachments.length === 0 &&
            isWorkflowCommandText(text, await loadWorkflowCommandSpecs());
          // Does this input actually expand into a persisted user message? Asked
          // of the session itself, because only it knows whether the command
          // resolves here (name/alias casing, custom `.gg/commands`, non-coder
          // agents that don't expand at all). A looser guess would anchor the
          // hint at +1 with no message to land on — decorating an unrelated
          // later bubble with the wrong `/name`.
          const expandsToTemplate =
            attachments.length === 0 && (await session.willExpandPromptTemplate(text));
          // Webview display hint for this prompt's user bubble (kenSent shimmer
          // label / enhancer highlight segments / the `/name` a command was typed
          // as). Anchored +1 so it attaches to the user message the prompt below
          // is about to push. Queued prompts skip this (their position in the run
          // is unpredictable).
          //
          // Recording the invocation matters because the agent persists the
          // EXPANDED template as the user message. Resume used to recover
          // `/name` by matching that body against the current templates, which
          // silently fails the moment a template is edited or reworded — the
          // reopened session then rendered the raw multi-KB prompt instead of
          // the command chip.
          if (
            expandsToTemplate ||
            (meta && (meta.kenSent === true || Array.isArray(meta.enhancements)))
          ) {
            void session
              .persistAppMarker(
                "user_hint",
                {
                  ...(expandsToTemplate ? { command: text.trim() } : {}),
                  ...(meta?.kenSent === true ? { kenSent: true } : {}),
                  ...(Array.isArray(meta?.enhancements) ? { enhancements: meta.enhancements } : {}),
                },
                1,
              )
              .catch(() => {});
          }
          // Fresh user turn: clear any cancel flag left from a prior cycle so this
          // turn's autopilot review can run.
          autopilotCancelled = false;
          const assistantsBefore = countAssistantMessages(session.getMessages());
          const messagesBefore = session.getMessages().length;
          await runAgent(text, async () => {
            if (attachments.length > 0) {
              // Persist each attachment under .gg/uploads so files are inspectable
              // by the agent's tools, then prompt with the media as native blocks.
              const prepared = await prepareAttachments(cwd, attachments);
              await promptActiveSessionWithAttachments(text, prepared);
            } else {
              // Pass the raw text straight through. AgentSession.prompt() is the
              // single source of truth for slash-command expansion (built-in +
              // `.gg/commands/*.md` custom), so the agent gets the right body
              // while the webview keeps showing the short `/name`.
              await promptActiveSession(text);
            }
          });
          // After the user's run settles, kick off Ken's auto-review loop — but
          // only when the turn is actually reviewable (shouldStartAutopilotCycle):
          // workflow commands (/compare, /expand, …) end with reports or
          // A/B/C choices reserved for the USER; registry commands (/help) and
          // failed runs add no assistant work to judge; a turn that ended in plan
          // mode has a pending Accept/Reject modal Ken must not preempt. This is
          // the ONLY entry point into the cycle besides the stranded-queue drain —
          // it drives any follow-up GG Coder runs itself, so the shared runAgent
          // finally never recurses.
          const decision = shouldStartAutopilotCycle({
            enabled: autopilot,
            cancelled: autopilotCancelled,
            planMode: session.getPlanMode(),
            // A submitted plan (exit_plan fired) routes into the PLAN review
            // branch — the cycle reviews the plan itself instead of skipping.
            planPending: planGate.pending() !== null,
            workflowCommand,
            assistantMessagesAdded:
              countAssistantMessages(session.getMessages()) - assistantsBefore,
            // Skip the review API call outright for turns that only started a
            // background process (dev server/watcher), ran a read-only lookup, or
            // committed/pushed — Ken's autopilot contract already IGNOREs these,
            // so there's no reason to pay for that verdict.
            mechanicalOnly: isMechanicalOnlyTurn(
              extractTurnToolCalls(session.getMessages(), messagesBefore),
            ),
          });
          if (decision.start || settledRoadmapReviewVerdict) {
            log("INFO", "app-sidecar", "autopilot cycle starting", {
              kind: decision.start ? decision.kind : "roadmap-final-review",
            });
            await runAutopilotCycle(text);
          } else if (autopilot) {
            log("INFO", "app-sidecar", "autopilot skipped", { reason: decision.reason });
          }
          // A prompt sent while Ken was reviewing (build idle) queued but had no
          // run to steer into — run it now as a fresh turn so it never strands.
          await runStrandedQueue();
        })
        .finally(() => {
          if (claimedStart) runClaim.release();
        });
      return;
    }

    // Ken Kai (mentor): an independent read-only advisory run on the kenSession.
    // Runs concurrently with a build run — its events are ken_-prefixed so the
    // webview keeps the bubbles separate. The context digest is assembled fresh
    // from the BUILD session's transcript each turn (one-way mirror).
    if (method === "POST" && url === "/ken/prompt") {
      if (mode === "chat") {
        json(res, 404, { error: "Ken is not available in GG Chat." });
        return;
      }
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let text: string;
        try {
          text = (JSON.parse(raw) as { text?: string }).text ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!text.trim()) {
          json(res, 400, { error: "empty prompt" });
          return;
        }
        if (kenRunning) {
          json(res, 409, { error: "Ken is already thinking — wait for his reply." });
          return;
        }
        json(res, 202, { accepted: true });
        kenRunning = true;
        broadcast("ken_run_start", { text });
        try {
          const ken = await ensureKenSession();
          const digest = await buildKenContext(
            session,
            cwd,
            gitBranch,
            text,
            await loadWorkflowCommandSpecs(),
            injectedAutopilotPrompts,
          );
          await ken.prompt(digest);
          // Record the turn against the BUILD session so it persists + survives
          // resume (advisory custom entry, never an LLM message). Reply is Ken's
          // last assistant message; skip persistence if he produced nothing.
          const reply = lastAssistantText(ken.getMessages());
          if (reply.trim()) await session.persistKenTurn(text, reply);
        } catch (err) {
          broadcastError("ken_error", "ken run failed", err);
        } finally {
          kenRunning = false;
          broadcast("ken_run_end", {});
          const pending = pendingKenModel;
          pendingKenModel = null;
          if (pending) await syncKenModel(pending.provider, pending.model);
        }
      });
      return;
    }

    if (method === "POST" && url === "/ken/cancel") {
      kenAbort.abort();
      kenAbort = new AbortController();
      kenSession?.setSignal(kenAbort.signal);
      kenRunning = false;
      broadcast("ken_run_end", { cancelled: true });
      json(res, 200, { cancelled: true });
      return;
    }

    if (method === "POST" && url === "/autopilot") {
      if (mode === "chat") {
        json(res, 404, { error: "Autopilot is not available in GG Chat." });
        return;
      }
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let enabled: boolean;
        try {
          enabled = Boolean((JSON.parse(raw) as { enabled?: boolean }).enabled);
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        autopilot = enabled;
        projectAutopilot.set(cwd, enabled);
        // A toggle-off during an active cycle takes effect after Ken finishes;
        // until then, injected build runs must not re-enable Ideal self-review.
        session.setIdealReviewSuppressed(enabled || autopilotActive);
        await saveAutopilot(cwd, enabled);
        log("INFO", "app-sidecar", "autopilot toggled", { enabled: String(enabled) });
        broadcast("autopilot", { autopilot: enabled });
        json(res, 200, { autopilot: enabled });
      });
      return;
    }

    if (method === "POST" && url === "/enhance") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let text: string;
        try {
          text = (JSON.parse(raw) as { text?: string }).text ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!text.trim()) {
          json(res, 400, { error: "empty prompt" });
          return;
        }
        // An independent read-only LLM call — touches no session state, so it's
        // allowed even while a run is in flight.
        try {
          const result = await session.enhancePrompt(text);
          json(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          captureSidecarError(err, "app-sidecar.prompt-enhancer");
          log("ERROR", "app-sidecar", "enhance failed", { message });
          json(res, 500, { error: message });
        }
      });
      return;
    }

    if (method === "GET" && url === "/tasks") {
      json(res, 200, { tasks: pruneDoneTasksSync(cwd) });
      return;
    }

    // ── Radio (app-wide) ──────────────────────────────────────
    // Radio is now APP-WIDE: all windows share one daemon process, and the
    // player lives in `core/radio.ts` module-level singletons (one stream for
    // the whole app). Any window's /radio reads/controls that single stream —
    // starting a station in one window replaces whatever was playing, and every
    // window's footer reflects the same `current`. This intentionally prevents
    // duplicate audio across windows (the original per-window goal), now for
    // free. (To restore per-window radio, key playback by sessionId.)
    if (method === "GET" && url === "/radio") {
      json(res, 200, {
        stations: RADIO_STATIONS,
        current: getCurrentStation(),
        volume: getRadioVolume(),
      });
      return;
    }

    if (method === "POST" && url === "/radio/volume") {
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let volume: number;
        try {
          volume = Number((JSON.parse(raw) as { volume?: number }).volume);
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!Number.isFinite(volume)) {
          json(res, 400, { error: "volume must be a number" });
          return;
        }
        const result = setRadioVolume(volume);
        if (!result.ok) {
          json(res, 400, { error: result.error ?? "Radio volume failed to update." });
          return;
        }
        json(res, 200, { current: getCurrentStation(), volume: getRadioVolume() });
      });
      return;
    }

    if (method === "POST" && url === "/radio") {
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let station: string;
        try {
          station = (JSON.parse(raw) as { station?: string }).station ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!station || station === "off") {
          stopRadio();
          json(res, 200, { current: null });
          return;
        }
        const result = playRadio(station);
        if (!result.ok) {
          json(res, 400, { error: result.error ?? "Radio failed to start." });
          return;
        }
        json(res, 200, { current: getCurrentStation() });
      });
      return;
    }

    if (method === "POST" && url === "/tasks/run") {
      const conflict = planGateConflict();
      if (conflict) {
        req.resume();
        json(res, 409, conflict);
        return;
      }
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let id: string | null;
        let all: boolean;
        try {
          const body = JSON.parse(raw) as { id?: string | null; all?: boolean };
          id = body.id ?? null;
          all = Boolean(body.all);
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (running) {
          json(res, 409, { error: "cannot run a task while the agent is running" });
          return;
        }
        const releaseOperation = reloadCoordinator.tryAcquireOperationMutation();
        if (!releaseOperation) {
          json(res, 409, { error: "configuration refresh in progress" });
          return;
        }
        json(res, 202, { accepted: true });
        void runTasks(id, all)
          .catch((error) => {
            log("ERROR", "app-sidecar", "accepted task continuation failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(releaseOperation);
      });
      return;
    }

    if (method === "POST" && url === "/tasks/delete") {
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let id: string;
        try {
          id = (JSON.parse(raw) as { id?: string }).id ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!id.trim()) {
          json(res, 400, { error: "missing task id" });
          return;
        }
        const remaining = loadTasksSync(cwd).filter((t) => t.id !== id && !t.id.startsWith(id));
        saveTasksSync(cwd, remaining);
        json(res, 200, { tasks: remaining });
      });
      return;
    }

    if (method === "GET" && url === "/models") {
      void (async () => {
        const loggedIn: Provider[] = [];
        for (const p of ALL_PROVIDERS) {
          if (await auth.hasProviderAuth(p)) loggedIn.push(p);
        }
        // Just the names, grouped by provider in registry order — the UI shows
        // a clean multi-column list of model ids. Local models come from the
        // runtime registry (populated by the background scan) and are always
        // listed: their "login" is the endpoint answering a probe.
        const models = getAllModels()
          .filter((m) => m.provider === "local" || loggedIn.includes(m.provider))
          .map((m) => {
            if (m.provider !== "local") {
              return { id: m.id, name: m.name, provider: m.provider };
            }
            const probed = findProbedModel(localProbes, m.id);
            return {
              id: m.id,
              name: m.name,
              provider: m.provider,
              local: true,
              endpoint: probed?.endpoint.label ?? parseLocalModelId(m.id)?.endpointId,
              // A local model that can't call tools can't run the agent — the UI
              // renders it disabled rather than hiding it, so the user learns why.
              supportsTools: probed?.model.supportsTools ?? true,
              contextWindow: m.contextWindow,
              contextWindowKnown: probed?.model.contextWindowKnown ?? false,
              supportsThinking: m.supportsThinking,
            };
          });
        json(res, 200, { models });
      })();
      return;
    }

    if (method === "POST" && url === "/model") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let modelId: string;
        try {
          modelId = (JSON.parse(raw) as { model?: string }).model ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const target = getModel(modelId);
        if (!target) {
          json(res, 404, { error: `unknown model: ${modelId}` });
          return;
        }
        if (running) {
          json(res, 409, { error: "cannot switch model while running" });
          return;
        }
        if (target.provider === "local") {
          const problem = await localModelBlocker(target.id);
          if (problem) {
            json(res, 409, { error: problem });
            return;
          }
        }
        await session.switchModel(target.provider, target.id);
        // Ken follows GG Coder's model only while un-pinned; a user-set Ken
        // override survives GG model switches untouched.
        if (!kenModelOverride) {
          await syncKenModel(target.provider, target.id);
          await syncKenAutoModel(target.provider, target.id);
        }
        // Clamp the reasoning level to what the new model supports (mirrors the
        // CLI): keep thinking on at the first supported tier if it was on but
        // the prior level is unsupported here; leave it off if it was off.
        const prevLevel = session.getThinkingLevel();
        const clampedLevel = clampThinkingLevel(target.provider, target.id, prevLevel);
        if (clampedLevel !== prevLevel) session.setThinkingLevel(clampedLevel);
        // Persist per-project so THIS window/project restores its own model on
        // restart (not the single global slot every window shares). Keep the
        // global write too as a "last used" fallback for never-opened projects
        // and so the CLI stays in sync.
        await saveProjectModelPrefs(cwd, {
          provider: target.provider,
          model: target.id,
          thinkingEnabled: !!session.getThinkingLevel(),
          thinkingLevel: session.getThinkingLevel() ?? undefined,
        });
        await persistModelSelection(paths.settingsFile, target.provider, target.id);
        await persistThinkingLevel(paths.settingsFile, session.getThinkingLevel());
        const payload = {
          thinkingLevel: session.getThinkingLevel() ?? null,
          supportedThinkingLevels: getSupportedThinkingLevels(target.provider, target.id),
        };
        // model_change is emitted by switchModel; follow with thinking_change so
        // the footer toggle reflects the new model's supported levels.
        broadcast("thinking_change", payload);
        // Un-pinned Ken just followed the switch — update his footer chip too.
        // When Ken is pinned, his effective model did not change, so skip the
        // no-op event (keeps footer/event tests from treating a GG switch as a
        // Ken switch).
        if (!kenModelOverride) broadcast("ken_model_change", kenStatePayload());
        // The new model usually has a different context window — push extras so
        // the footer's context meter rescales immediately.
        broadcast("extras", footerExtras());
        json(res, 200, { provider: target.provider, model: target.id, ...payload });
      });
      return;
    }

    // Set or clear Ken's model pin. Body: { model: "<id>" } to pin, or
    // { model: null } / "" to clear (Ken resumes following GG Coder). Applies
    // to BOTH Ken sessions (chat + autopilot reviewer); a switch landing while
    // either is mid-run defers via the pending-model mechanics.
    if (method === "POST" && url === "/ken/model") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let modelId: string | null;
        try {
          const parsed = (JSON.parse(raw) as { model?: string | null }).model;
          modelId = typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        // Same lock as POST /model, for the same reason: this retargets Ken's
        // chat session AND the autopilot reviewer, and `switchModel` on a
        // session mid-turn races the stream it is already consuming. The
        // footer picker is disabled to match; this is the enforcement.
        if (running || kenRunning || autopilotReviewing) {
          json(res, 409, { error: "cannot switch Ken's model while running" });
          return;
        }
        if (modelId === null) {
          // Clear the pin → follow GG Coder again, syncing both sessions back.
          kenModelOverride = null;
          await saveKenModelPref(cwd, null);
          const st = session.getState();
          await syncKenModel(st.provider, st.model);
          await syncKenAutoModel(st.provider, st.model);
          log("INFO", "app-sidecar", "ken model pin cleared — following GG", {
            provider: st.provider,
            model: st.model,
          });
        } else {
          const target = getModel(modelId);
          if (!target) {
            json(res, 404, { error: `unknown model: ${modelId}` });
            return;
          }
          kenModelOverride = { provider: target.provider, model: target.id };
          await saveKenModelPref(cwd, kenModelOverride);
          await syncKenModel(target.provider, target.id);
          await syncKenAutoModel(target.provider, target.id);
          log("INFO", "app-sidecar", "ken model pinned", {
            provider: target.provider,
            model: target.id,
          });
        }
        const payload = kenStatePayload();
        broadcast("ken_model_change", payload);
        json(res, 200, payload);
      });
      return;
    }

    // Pending queued steering, for the composer's cancel affordance.
    if (method === "GET" && url === "/queued") {
      json(res, 200, { queued: session.listQueuedMessages() });
      return;
    }

    // Cancel one pending queued message by id.
    if (method === "POST" && url === "/queued/cancel") {
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let id: string;
        try {
          id = (JSON.parse(raw) as { id?: string }).id ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!id.trim()) {
          json(res, 400, { error: "missing queued message id" });
          return;
        }
        // `false` means it already drained into the run between render and
        // click. That is a race, not an error, so report it as a normal result
        // and let the client reconcile from the fresh list.
        const cancelled = session.cancelQueuedMessage(id);
        const queued = session.listQueuedMessages();
        broadcast("queued", { count: queued.length, messages: queued });
        json(res, 200, { cancelled, queued });
      });
      return;
    }

    if (method === "POST" && url === "/kill") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let id: string;
        try {
          id = (JSON.parse(raw) as { id?: string }).id ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!id.trim()) {
          json(res, 400, { error: "missing task id" });
          return;
        }
        const message = await session.killBackgroundProcess(id);
        // Push the updated task list right away rather than waiting for the poll.
        broadcast("tasks", { tasks: session.listBackgroundProcesses() });
        json(res, 200, { message });
      });
      return;
    }

    // Import a Claude Code / Codex / Cursor transcript into a resumable GG
    // Coder session. The importer never throws — it returns a typed failure so
    // the app can show the reason verbatim.
    if (method === "POST" && url === "/import-transcript") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let body: { path?: string; cwd?: string };
        try {
          body = JSON.parse(raw) as { path?: string; cwd?: string };
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const filePath = body.path?.trim();
        if (!filePath) {
          json(res, 400, { error: "missing transcript path" });
          return;
        }
        const result = await session.importForeignTranscript(filePath, {
          ...(body.cwd ? { cwd: body.cwd } : {}),
        });
        json(res, result.ok ? 200 : 400, result);
      });
      return;
    }

    if (method === "POST" && url === "/thinking") {
      // The in-flight request already carries its reasoning config, so a
      // mid-run cycle cannot affect the turn the user is watching — it just
      // persists a level the footer then reports for a run that never used it.
      // Locked like POST /model; the footer button is disabled to match.
      if (running) {
        json(res, 409, { error: "cannot change reasoning level while running" });
        return;
      }
      const st = session.getState();
      const previous = session.getThinkingLevel();
      const next = getNextThinkingLevel(st.provider, st.model, previous);
      const releaseOperation = reloadCoordinator.tryAcquireOperationMutation();
      if (!releaseOperation) {
        json(res, 409, { error: "configuration refresh in progress" });
        return;
      }
      session.setThinkingLevel(next);
      // Report completion only after both project and global preferences persist.
      void (async () => {
        try {
          await saveProjectModelPrefs(cwd, {
            provider: st.provider,
            model: st.model,
            thinkingEnabled: !!next,
            thinkingLevel: next ?? undefined,
          });
          await persistThinkingLevel(paths.settingsFile, next);
          const payload = {
            thinkingLevel: next ?? null,
            supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
          };
          broadcast("thinking_change", payload);
          json(res, 200, payload);
        } catch (error) {
          session.setThinkingLevel(previous);
          log("ERROR", "app-sidecar", "thinking preference persistence failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          json(res, 500, { error: "thinking preference persistence failed" });
        } finally {
          releaseOperation();
        }
      })();
      return;
    }

    if (method === "POST" && url === "/cancel") {
      void cancelActiveOperation()
        .then((result) => {
          if (result.status === "failed") {
            json(res, 504, {
              error: "cancel_failed",
              reason: result.reason,
              runState: result.runState,
              drained: result.drained,
            });
            return;
          }
          json(res, 200, {
            cancelled: result.status === "cancelled",
            runState: result.runState,
            drained: result.drained,
          });
        })
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.run.cancel");
          broadcast("cancel_failed", { error: "cancel_failed", runState: runLifecycle.state });
          json(res, 500, {
            error: "cancel_failed",
            message: error instanceof Error ? error.message : String(error),
            runState: runLifecycle.state,
          });
        });
      return;
    }

    const advancementRoute = parsePhaseAdvancementStartRoute(method, url);
    if (advancementRoute) {
      if (!hasDaemonAuth(req, nativeAuthorityToken)) {
        req.resume();
        json(res, 401, { error: "native human authority required" });
        return;
      }
      void (async () => {
        try {
          const body = parsePhaseAdvancementStartBody(await readJsonBody(req, 8_192));
          if (!body) {
            json(res, 400, { error: "invalid Start next phase confirmation" });
            return;
          }
          await startRoadmapPhase(
            body.nextPhaseId,
            (status, responseBody) => json(res, status, responseBody),
            { checkpointId: advancementRoute.checkpointId, ...body },
          );
        } catch (error) {
          if (error instanceof AppSidecarJsonBodyError) {
            json(res, error.kind === "too-large" ? 413 : 400, {
              error: `JSON request body ${error.kind}`,
            });
            return;
          }
          captureSidecarError(error, "app-sidecar.phase.advancement-confirmation");
          json(res, 500, { error: "Start next phase failed" });
        }
      })();
      return;
    }

    if (
      handlePhaseStartRoute({
        method,
        url,
        host,
        respond: (status, body) => json(res, status, body),
        start: (phaseId) => {
          void startRoadmapPhase(phaseId, (status, body) => json(res, status, body));
        },
      })
    ) {
      return;
    }

    if (method === "POST" && url === "/new-session") {
      const conflict = planGateConflict();
      if (conflict) {
        req.resume();
        json(res, 409, conflict);
        return;
      }
      void runAppSidecarNewSessionMutation({
        busyState: sessionBusyState(),
        mutations: sessionMutations,
        perform: async (mutation) => {
          await session.newSession();
          if (mode === "chat") {
            await session.persistAppMarker("agent_handoff", { chatAgent });
          }
          deactivateApprovedPlan();
          injectedAutopilotPrompts = [];
          planGate = new AppSidecarPlanGate(session.getAppMarkers(), persistPlanGateMarker);
          log("INFO", "app-sidecar", "new session accepted", {
            logicalSessionId: opts.id,
            operationId: mutation.operationId,
          });
          broadcast("session_reset", {
            operationId: mutation.operationId,
            kind: mutation.kind,
          });
        },
      }).then((result) => {
        if (result.status === 500) {
          captureSidecarError(result.error, "app-sidecar.session.new");
        }
        json(res, result.status, result.body);
      });
      return;
    }

    // Accept an approved plan and begin implementation in a FRESH session
    // Only a human IPC carrying the exact persisted checkpoint identity may approve.
    if (method === "POST" && url === "/plan/accept") {
      if (!hasDaemonAuth(req, nativeAuthorityToken)) {
        req.resume();
        json(res, 401, { error: "native human authority required" });
        return;
      }
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let checkpointId: string;
        let generation: number;
        try {
          const body = JSON.parse(raw) as Record<string, unknown>;
          if (
            Object.keys(body).length !== 2 ||
            typeof body.checkpointId !== "string" ||
            !Number.isSafeInteger(body.generation)
          ) {
            throw new Error("invalid");
          }
          checkpointId = body.checkpointId;
          generation = body.generation as number;
        } catch {
          json(res, 400, { error: "invalid plan approval body" } satisfies PlanMutationFailure);
          return;
        }
        if (running || runClaim.active || autopilotActive || runLifecycle.running) {
          json(res, 409, {
            error: "cannot accept a plan while the agent is running",
          } satisfies PlanMutationFailure);
          return;
        }
        const mutation = sessionMutations.tryAcquire("manual-plan-accept");
        if (!mutation) {
          json(res, 409, sessionMutations.conflictBody());
          return;
        }
        try {
          autopilotCancelled = true;
          kenAutoAbort.abort();
          kenAutoAbort = new AbortController();
          kenAutoSession?.setSignal(kenAutoAbort.signal);
          if (autopilotReviewing) {
            autopilotReviewing = false;
            broadcast("autopilot_ignored", {});
          }
          const accepted = await planHandoff.accept(checkpointId, generation);
          if (accepted.status !== "committed") {
            json(res, 409, {
              error: "stale-plan-checkpoint",
              pendingPlanReview: planGate.pending(),
            } satisfies PlanMutationFailure);
            return;
          }
          const planTotal = approvedPlanTotal;
          const approvedCheckpoint = planGate.current();
          const planOnly =
            approvedCheckpoint?.state === "human-approved" &&
            hasPlanOnlyBoundary(approvedCheckpoint.content);
          broadcast("plan_accepted", {
            checkpointId,
            generation,
            operationId: mutation.operationId,
          });
          if (!planOnly) {
            broadcast("session_reset", { planTotal, operationId: mutation.operationId });
            broadcast("plan_progress", planProgressPayload());
          }
          json(res, 200, {
            ok: true,
            planTotal,
            operationId: mutation.operationId,
          } satisfies PlanAcceptResult);
        } catch (err) {
          captureSidecarError(err, "app-sidecar.plan.accept");
          if (err instanceof PhaseCheckpointError) {
            json(res, 409, {
              status: "failed",
              operationId: mutation.operationId,
              ...phaseCheckpointFailurePayload(err),
            } satisfies PlanMutationFailure);
          } else {
            json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        } finally {
          mutation.release();
        }
      });
      return;
    }

    if (method === "POST" && url === "/plan/revise") {
      if (!hasDaemonAuth(req, nativeAuthorityToken)) {
        req.resume();
        json(res, 401, { error: "native human authority required" });
        return;
      }
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        const body = parsePlanRevisionBody(raw);
        if (body === null) {
          json(res, 400, { error: "invalid plan revision body" } satisfies PlanMutationFailure);
          return;
        }
        const { checkpointId, generation, feedback } = body;
        if (isPlanRevisionSessionBusy({ running, autopilotActive, autopilotReviewing })) {
          json(res, 409, { error: "session_busy" } satisfies PlanMutationFailure);
          return;
        }
        const mutation = sessionMutations.tryAcquire("plan-revise");
        if (!mutation) {
          json(res, 409, sessionMutations.conflictBody());
          return;
        }
        void executePlanRevisionRequest(
          { checkpointId, generation, actor: "user", feedback },
          {
            requestRevision: planGate.requestRevision.bind(planGate),
            supersedeAutopilot: async () => {
              if (!autopilotActive) return;
              // The exact checkpoint transition committed first, so a stale
              // feedback request can never cancel the authoritative review.
              // Cancellation then waits for the Autopilot lifecycle owner to
              // settle and install fresh controllers before runAgent starts.
              autopilotCancelled = true;
              if (autopilotReviewing) {
                autopilotReviewing = false;
                broadcast("autopilot_ignored", {});
              }
              const cancellation = await runLifecycle.cancel(CANCEL_TIMEOUT_MS);
              if (cancellation.status === "failed") {
                throw new Error("Autopilot review did not settle before plan revision");
              }
            },
            onCommitted: (checkpoint) => {
              // Persisted feedback is the run identity. Exact retries reuse it
              // without writing another authority marker.
              broadcast("plan_revision_requested", {
                checkpointId: checkpoint.checkpointId,
                generation: checkpoint.generation,
                feedback: checkpoint.feedback,
              });
              json(res, 202, {
                ok: true,
                operationId: mutation.operationId,
              } satisfies PlanRevisionResult);
            },
            run: async (prompt) => {
              await runAgent(prompt, async () => {
                await session.setPlanMode(true);
                broadcast("plan_enter", { reason: "Revise the submitted plan" });
                await promptActiveSession(prompt);
              });
            },
          },
        )
          .then((result) => {
            if (result.status === "conflict") {
              json(res, 409, {
                error: "stale-plan-checkpoint",
                pendingPlanReview: planGate.pending(),
              } satisfies PlanMutationFailure);
            }
          })
          .catch((error) => {
            captureSidecarError(error, "app-sidecar.plan.revise");
            if (!res.headersSent) {
              json(res, 500, { error: "plan-revision-failed" });
            }
          })
          .finally(() => mutation.release());
      });
      return;
    }

    // ── Provider auth (login) ───────────────────────────────
    if (method === "GET" && url === "/auth/status") {
      void authStatusPayload().then((payload) => json(res, 200, payload));
      return;
    }

    if (method === "POST" && url === "/auth/apikey") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let provider = "";
        let key: string;
        let variant: string | undefined;
        try {
          const body = JSON.parse(raw) as { provider?: string; key?: string; variant?: string };
          provider = body.provider ?? "";
          key = (body.key ?? "").trim();
          variant = body.variant;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const meta = AUTH_PROVIDERS.find((p) => p.value === provider);
        if (!meta || !meta.methods.includes("apikey")) {
          json(res, 400, { error: "provider does not support API key auth" });
          return;
        }
        if (!key) {
          json(res, 400, { error: "API key is required" });
          return;
        }
        // Providers with multiple API-key variants (currently only Xiaomi: Token
        // Plan vs. API Credits) store under the chosen variant's key/baseUrl,
        // defaulting to the first variant. Single-variant providers fall back to
        // the legacy provider-id storage key + flat apiKeyBaseUrl.
        const chosenVariant =
          meta.apiKeyVariants?.find((v) => v.key === variant) ?? meta.apiKeyVariants?.[0];
        const storageKey = chosenVariant?.key ?? provider;
        const baseUrl = chosenVariant?.baseUrl ?? meta.apiKeyBaseUrl;
        const creds: OAuthCredentials = {
          accessToken: key,
          refreshToken: "",
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100y
          ...(baseUrl ? { baseUrl } : {}),
        };
        await auth.setCredentials(storageKey, creds);
        // auth.json is shared by every window, so this is a global change:
        // close their login modals and refresh their provider lists too.
        broadcastAll("auth_done", { provider });
        // `auth_done` means "a login succeeded" (modals close on it).
        // `auth_change` means "auth.json changed" — which a DISCONNECT also is,
        // so connection state has one signal that covers both directions.
        broadcastAll("auth_change", { provider });
        // A newly connected provider unlocks its models. `/models` filters on
        // who is logged in, so every window's picker is now stale — without
        // this the new models don't appear until the session is reopened.
        broadcastAll("models_change", {});
        json(res, 200, { ok: true });
      });
      return;
    }

    if (method === "POST" && url === "/auth/oauth/start") {
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let provider = "";
        try {
          provider = (JSON.parse(raw) as { provider?: string }).provider ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const meta = AUTH_PROVIDERS.find((p) => p.value === provider);
        if (!meta || !meta.methods.includes("oauth")) {
          json(res, 400, { error: "provider does not support OAuth" });
          return;
        }
        if (oauthInFlight) {
          json(res, 409, { error: "a login is already in progress" });
          return;
        }
        // A login writes the shared ~/.gg/auth.json, so two windows racing the
        // same provider means two browser tabs and two token exchanges whose
        // writes clobber each other. The per-session flag above cannot see
        // that — guard the provider daemon-wide as well.
        if (oauthInFlightProviders.has(provider)) {
          json(res, 409, {
            error: `a ${meta.label} login is already in progress in another window`,
          });
          return;
        }
        oauthInFlight = true;
        oauthInFlightProviders.add(provider);
        json(res, 202, { accepted: true });
        void (async () => {
          const cb = authCallbacks();
          try {
            let creds: OAuthCredentials;
            let storageKey = provider;
            if (provider === "anthropic") creds = await loginAnthropic(cb);
            else if (provider === "openai") creds = await loginOpenAI(cb);
            else if (provider === "gemini") creds = await loginGemini(cb);
            else if (provider === "moonshot" || provider === "xai") {
              // Subscription OAuth (Kimi plan / SuperGrok-X Premium) stores under
              // a distinct key so it can coexist with the provider's API key.
              creds = provider === "moonshot" ? await loginKimi(cb) : await loginXai(cb);
              storageKey = dualAuthProvider(provider)!.oauthKey;
            } else {
              throw new Error(`OAuth not implemented for ${provider}`);
            }
            await auth.setCredentials(storageKey, creds);
            // Terminal outcome of a GLOBAL change: every window's login modal
            // should close and its provider list refresh, not just the one
            // that started the flow.
            broadcastAll("auth_done", { provider });
            broadcastAll("auth_change", { provider });
            // The OAuth provider's models just became selectable everywhere.
            broadcastAll("models_change", {});
          } catch (err) {
            captureSidecarError(err, "app-sidecar.auth.oauth", { provider });
            // Deliberately session-scoped: this is the outcome of ONE window's
            // attempt. Another window that never pressed Connect has nothing to
            // show an error about, and its modal correctly still offers login.
            broadcast("auth_error", {
              provider,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            oauthInFlight = false;
            oauthInFlightProviders.delete(provider);
            pendingCode = null;
          }
        })();
      });
      return;
    }

    if (method === "POST" && url === "/auth/oauth/code") {
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let code: string;
        try {
          code = (JSON.parse(raw) as { code?: string }).code ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!pendingCode) {
          json(res, 409, { error: "no login is awaiting a code" });
          return;
        }
        pendingCode(code.trim());
        pendingCode = null;
        json(res, 200, { ok: true });
      });
      return;
    }

    if (method === "POST" && url.startsWith("/mcp/elicit/")) {
      const id = decodeURIComponent(url.slice("/mcp/elicit/".length));
      void readBody(req, res).then((raw) => {
        if (raw === null) return;
        let result: ElicitResult;
        try {
          const parsed = JSON.parse(raw) as {
            action?: string;
            content?: Record<string, unknown>;
          };
          if (
            parsed.action !== "accept" &&
            parsed.action !== "decline" &&
            parsed.action !== "cancel"
          ) {
            json(res, 400, { error: "action must be accept, decline, or cancel" });
            return;
          }
          result =
            parsed.action === "accept"
              ? ({ action: "accept", content: parsed.content ?? {} } as ElicitResult)
              : { action: parsed.action };
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        // Unknown id means it already timed out or was cancelled by an abort —
        // the tool call has moved on, so the answer has nowhere to go.
        if (!elicitations.settle(id, result)) {
          json(res, 409, { error: "no elicitation is awaiting a response" });
          return;
        }
        json(res, 200, { ok: true });
      });
      return;
    }

    if (method === "POST" && url === "/auth/logout") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let provider: string;
        let logoutMethod: AuthMethod | undefined;
        try {
          const body = JSON.parse(raw) as { provider?: string; method?: string };
          provider = body.provider ?? "";
          logoutMethod =
            body.method === "oauth" || body.method === "apikey" ? body.method : undefined;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const dual = dualAuthProvider(provider);
        // A dual-auth provider can be disconnected one method at a time: dropping
        // a spent API key should not sign the user out of their subscription, and
        // vice versa. Omitting `method` still clears everything (the plain
        // "Disconnect" action).
        if (logoutMethod !== "apikey") {
          await auth.clearCredentials(dual ? dual.oauthKey : provider);
        }
        if (logoutMethod !== "oauth") {
          // Non-dual providers store their only credential under the provider id,
          // so this covers both them and a dual provider's API key.
          await auth.clearCredentials(provider);
          // Xiaomi's API Credits credential lives under a distinct key — clear it
          // too so "disconnect" fully removes both the Token Plan and Credits keys.
          if (provider === "xiaomi") await auth.clearCredentials(XIAOMI_CREDITS_KEY);
        }
        broadcast("auth_done", { provider });
        json(res, 200, { ok: true });
      });
      return;
    }

    // ── Telegram config (mirrors `ggcoder telegram`) ─────────
    // ── Local models ──────────────────────────────────────
    // GET returns the last scan (cheap, no probing) so opening the modal is
    // instant; POST /local/scan is the explicit refresh.
    if (method === "GET" && url === "/local") {
      json(res, 200, localStatePayload());
      return;
    }

    if (method === "POST" && url === "/local/scan") {
      void scanLocalModels(true)
        .then(() => {
          broadcast("models_change", { local: localStatePayload() });
          json(res, 200, localStatePayload());
        })
        .catch((err: unknown) => {
          broadcastError("error", "local model scan failed", err);
          json(res, 500, { error: "Local model scan failed — see the sidecar log." });
        });
      return;
    }

    if (method === "POST" && url === "/local/endpoints") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let body: { label?: string; baseUrl?: string; apiKey?: string };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        try {
          const endpoint = await addCustomEndpoint({
            baseUrl: body.baseUrl ?? "",
            ...(body.label ? { label: body.label } : {}),
            ...(body.apiKey ? { apiKey: body.apiKey } : {}),
          });
          await scanLocalModels(true);
          broadcast("models_change", { local: localStatePayload() });
          json(res, 200, {
            endpoint: { id: endpoint.id, label: endpoint.label },
            ...localStatePayload(),
          });
        } catch (err) {
          // Validation errors are the user's typo, not a system fault — 400 with
          // the exact reason, and nothing in the transcript.
          if (err instanceof LocalEndpointError) {
            json(res, 400, { error: err.message });
            return;
          }
          broadcastError("error", "add local endpoint failed", err);
          json(res, 500, { error: "Could not save the endpoint — see the sidecar log." });
        }
      });
      return;
    }

    if (method === "DELETE" && url.startsWith("/local/endpoints/")) {
      const id = decodeURIComponent(url.slice("/local/endpoints/".length));
      void (async () => {
        try {
          await removeCustomEndpoint(id);
          clearRuntimeModels(
            (m) => m.provider === "local" && parseLocalModelId(m.id)?.endpointId === id,
          );
          await scanLocalModels(true);
          broadcast("models_change", { local: localStatePayload() });
          json(res, 200, localStatePayload());
        } catch (err) {
          if (err instanceof LocalEndpointError) {
            json(res, 400, { error: err.message });
            return;
          }
          broadcastError("error", "remove local endpoint failed", err);
          json(res, 500, { error: "Could not remove the endpoint — see the sidecar log." });
        }
      })();
      return;
    }

    // ── Hugging Face search & pull (the "Add from Hugging Face" modal) ──
    if (method === "GET" && url === "/hf/pull") {
      json(res, 200, hfPull ? { active: hfPullPayload(hfPull) } : { active: null });
      return;
    }

    if (method === "POST" && url === "/hf/search") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let body: { query?: unknown };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        // Strip control characters and cap length — this goes into a URL query.
        const query = String(body.query ?? "")
          // eslint-disable-next-line no-control-regex -- stripping control characters is the point
          .replace(/[\u0000-\u001f]/g, "")
          .trim()
          .slice(0, 100);
        if (!query) {
          json(res, 400, { error: "Type something to search for." });
          return;
        }
        try {
          json(res, 200, { models: await hfSearch(query) });
        } catch (err) {
          broadcastError("error", "hugging face search failed", err);
          json(res, 502, {
            error: `Hugging Face search failed — ${err instanceof Error ? err.message : "network error"}.`,
          });
        }
      });
      return;
    }

    if (method === "POST" && url === "/hf/pull") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let body: { repo?: unknown };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const repo = String(body.repo ?? "").trim();
        if (!isValidHfRepoId(repo)) {
          json(res, 400, { error: 'Expected a Hugging Face repo like "org/model".' });
          return;
        }
        try {
          json(res, 200, await startHfPull(repo));
        } catch (err) {
          const status =
            err instanceof Error && "status" in err && typeof err.status === "number"
              ? err.status
              : 502;
          if (status >= 500) broadcastError("error", "hugging face pull failed", err);
          json(res, status, { error: err instanceof Error ? err.message : "Pull failed." });
        }
      });
      return;
    }

    if (method === "POST" && url === "/hf/pull/cancel") {
      json(res, 200, { ok: cancelHfPull() });
      return;
    }

    if (method === "GET" && url === "/telegram") {
      void loadTelegramConfig().then((cfg) => {
        if (!cfg) {
          json(res, 200, { configured: false });
          return;
        }
        // Never return the raw token to the webview — a short masked preview is
        // enough to show "already set".
        const t = cfg.botToken;
        const tokenPreview = t.length > 14 ? `${t.slice(0, 10)}\u2026${t.slice(-4)}` : "set";
        json(res, 200, { configured: true, userId: cfg.userId, tokenPreview });
      });
      return;
    }

    if (method === "POST" && url === "/telegram") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let botTokenInput: string;
        let userIdInput: string;
        try {
          const body = JSON.parse(raw) as { botToken?: string; userId?: string | number };
          botTokenInput = (body.botToken ?? "").trim();
          userIdInput = String(body.userId ?? "").trim();
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        // Keep the existing token when the field is left blank (the webview shows
        // a masked preview, not the real token).
        const existing = await loadTelegramConfig();
        const botToken = botTokenInput || existing?.botToken || "";
        if (!botToken) {
          json(res, 400, { error: "Bot token is required." });
          return;
        }
        const userId = userIdInput ? parseInt(userIdInput, 10) : existing?.userId;
        if (!userId || Number.isNaN(userId)) {
          json(res, 400, { error: "A numeric Telegram user ID is required." });
          return;
        }
        const verified = await verifyBotToken(botToken);
        if (!verified.ok) {
          json(res, 400, { error: "Invalid bot token — Telegram rejected it." });
          return;
        }
        await saveTelegramConfig({ botToken, userId });
        json(res, 200, { ok: true, userId, username: verified.username ?? null });
      });
      return;
    }

    // ── Serve lifecycle (mirrors `ggcoder serve`) ───────────
    if (method === "GET" && url === "/serve") {
      void loadTelegramConfig().then((cfg) =>
        json(res, 200, { running: serveController !== null, configured: cfg !== null }),
      );
      return;
    }

    if (method === "POST" && url === "/serve/start") {
      void (async () => {
        if (serveController) {
          json(res, 200, { running: true });
          return;
        }
        const cfg = await loadTelegramConfig();
        if (!cfg) {
          json(res, 400, { error: "Telegram isn't set up yet. Open Serve settings first." });
          return;
        }
        const st = session.getState();
        try {
          serveController = await startServeMode({
            provider: st.provider,
            model: st.model,
            cwd,
            version: "app",
            thinkingLevel: session.getThinkingLevel() ?? undefined,
            telegram: { botToken: cfg.botToken, userId: cfg.userId },
            embedded: true,
          });
          broadcast("serve_change", { running: true });
          log("INFO", "app-sidecar", "serve started", { userId: cfg.userId });
          json(res, 200, { running: true });
        } catch (err) {
          serveController = null;
          captureSidecarError(err, "app-sidecar.serve.start", { provider: st.provider });
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }

    if (method === "POST" && url === "/serve/stop") {
      void (async () => {
        if (serveController) {
          await serveController.stop().catch(() => {});
          serveController = null;
          broadcast("serve_change", { running: false });
          log("INFO", "app-sidecar", "serve stopped");
        }
        json(res, 200, { running: false });
      })();
      return;
    }

    // ── MCP server management (mirrors `ggcoder mcp`) ──────────────────
    // `targetCwd` (project scope) overrides the window cwd so a server can be
    // added/removed for ANY discovered project, not just this window's. Global
    // scope ignores it (always ~/.gg/mcp.json).
    if (method === "GET" && (url === "/mcp" || url.startsWith("/mcp?"))) {
      const targetCwd = new URL(url, `http://${host}`).searchParams.get("cwd") ?? cwd;
      void buildMcpRows(targetCwd, paths.settingsFile)
        .then((servers) => json(res, 200, { servers }))
        .catch((err) => {
          captureSidecarError(err, "app-sidecar.mcp.list");
          log("ERROR", "app-sidecar", "buildMcpRows failed", {
            message: err instanceof Error ? err.message : String(err),
          });
          const failure = mcpManagementRouteFailure("list", err);
          json(res, failure.status, { error: failure.error });
        });
      return;
    }

    if (method === "POST" && url === "/mcp/add") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let line: string;
        let scopeValue: string;
        let bodyCwd: string | undefined;
        try {
          const body = JSON.parse(raw) as {
            line?: string;
            scope?: string;
            cwd?: string;
          };
          line = body.line ?? "";
          scopeValue = body.scope ?? "global";
          bodyCwd = body.cwd;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const scope: MCPScope = scopeValue === "project" ? "project" : "global";
        if (scope === "project" && !bodyCwd) {
          json(res, 400, { error: "project scope requires a project (cwd)." });
          return;
        }
        const targetCwd = bodyCwd ?? cwd;
        const parsed = parseMcpAddCommand(line);
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return;
        }
        const config = parsed.value.config;
        try {
          // Best-effort probe — never blocks the save. A failed connect is
          // surfaced to the UI but the config is still persisted (mirrors the
          // CLI). probeMcp swallows connect errors; the try/catch guards the
          // persist step so a write failure returns a 500 instead of becoming
          // an unhandled rejection that would crash the sidecar.
          const probe = await probeMcp(config);
          const saved = await applyDesktopMcpMutation(
            () => session,
            () => addServer(config, scope, targetCwd, true),
            (result) => result.ok,
          );
          if (!saved.ok) {
            json(res, 400, { error: saved.error });
            return;
          }
          // Adding a project-scope server is an explicit trust signal — the
          // user chose to put a server in this repo's .gg/mcp.json. Auto-trust
          // the project so all project-scope servers connect on next load.
          if (scope === "project") {
            await session.trustProject(targetCwd);
          }
          json(res, 200, {
            ok: true,
            name: config.name,
            connected: probe.ok,
            toolCount: probe.toolCount,
            error: probe.error,
            requiresAuth: probe.requiresAuth,
          });
        } catch (err) {
          captureSidecarError(err, "app-sidecar.mcp.add", { server: config.name });
          const failure = mcpManagementRouteFailure("add", err);
          json(res, failure.status, { error: failure.error });
        }
      });
      return;
    }

    if (method === "POST" && url === "/mcp/remove") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let name: string;
        let scopeValue: string;
        let bodyCwd: string | undefined;
        try {
          const body = JSON.parse(raw) as {
            name?: string;
            scope?: string;
            cwd?: string;
          };
          name = body.name ?? "";
          scopeValue = body.scope ?? "global";
          bodyCwd = body.cwd;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!name.trim()) {
          json(res, 400, { error: "missing server name" });
          return;
        }
        const scope: MCPScope = scopeValue === "project" ? "project" : "global";
        if (scope === "project" && !bodyCwd) {
          json(res, 400, { error: "project scope requires a project (cwd)." });
          return;
        }
        const targetCwd = bodyCwd ?? cwd;
        try {
          const { removed } = await applyDesktopMcpMutation(
            () => session,
            async () => {
              // Clear OAuth first: if credential cleanup fails, preserve the
              // server config rather than reporting a partial removal as success.
              await new McpOAuthStore().clear(name);
              const removed = await removeServer(name, scope, targetCwd);
              return { removed };
            },
            (result) => result.removed,
          );
          json(res, 200, { removed });
        } catch (err) {
          captureSidecarError(err, "app-sidecar.mcp.remove", { server: name });
          const failure = mcpManagementRouteFailure("remove", err);
          json(res, failure.status, { error: failure.error });
        }
      });
      return;
    }

    // Interactive OAuth login for a remote (HTTP) MCP server. The browser is
    // opened by the webview in response to the broadcast `mcp_auth_url` event;
    // progress + outcome stream via `mcp_auth_status` / `mcp_auth_done` /
    // `mcp_auth_error`. Responds 202 immediately and runs the flow in the
    // background (the browser round-trip can take a while).
    if (method === "POST" && url === "/mcp/login") {
      void readBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let name: string;
        let scopeValue: string;
        let bodyCwd: string | undefined;
        try {
          const body = JSON.parse(raw) as { name?: string; scope?: string; cwd?: string };
          name = body.name ?? "";
          scopeValue = body.scope ?? "global";
          bodyCwd = body.cwd;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!name.trim()) {
          json(res, 400, { error: "missing server name" });
          return;
        }
        const scope: MCPScope = scopeValue === "project" ? "project" : "global";
        const targetCwd = bodyCwd ?? cwd;
        let scoped: Awaited<ReturnType<typeof getServer>>;
        try {
          scoped = await getServer(name, targetCwd);
        } catch (err) {
          captureSidecarError(err, "app-sidecar.mcp.login.config", { server: name });
          const failure = mcpManagementRouteFailure("login", err);
          json(res, failure.status, { error: failure.error });
          return;
        }
        if (!scoped || scoped.scope !== scope) {
          json(res, 404, { error: `No "${name}" server found.` });
          return;
        }
        if (!scoped.config.url) {
          json(res, 400, { error: "Login is only supported for HTTP MCP servers." });
          return;
        }
        json(res, 202, { accepted: true });
        broadcast("mcp_auth_status", { name, message: "Starting login\u2026" });
        const manager = new MCPClientManager();
        try {
          const result = await applyDesktopMcpMutation(
            () => session,
            () =>
              manager.login(scoped.config, (authUrl) => {
                broadcast("mcp_auth_url", { name, url: authUrl });
              }),
            (loginResult) => loginResult.ok,
          );
          if (result.ok) {
            broadcast("mcp_auth_done", { name, toolCount: result.toolCount });
          } else {
            broadcast("mcp_auth_error", {
              name,
              message: "The OAuth flow did not complete. Retry sign-in.",
            });
          }
        } catch (err) {
          captureSidecarError(err, "app-sidecar.mcp.login", { server: name });
          broadcast("mcp_auth_error", {
            name,
            message: "The OAuth flow did not complete. Retry sign-in.",
          });
        } finally {
          await manager.dispose().catch(() => {});
        }
      });
      return;
    }

    json(res, 404, { error: "not found" });
  }

  async function dispose(): Promise<void> {
    reminderCoordinator.unwatchSession(opts.id);
    await phaseCandidates.dispose();
    elicitations.cancelAll();
    tasksPollStopped = true;
    if (tasksPoll) clearTimeout(tasksPoll);
    gitPollStopped = true;
    if (gitPoll) clearTimeout(gitPoll);
    gitHubPollStopped = true;
    if (gitHubPoll) clearTimeout(gitHubPoll);
    // Stop the Telegram serve loop + dispose its per-chat sessions.
    if (serveController) await serveController.stop().catch(() => {});
    for (const c of clients) c.res.end();
    kenAbort.abort();
    kenAutoAbort.abort();
    await kenSession?.dispose().catch(() => {});
    await kenAutoSession?.dispose().catch(() => {});
    await session.dispose().catch(() => {});
  }

  return {
    id: opts.id,
    mode,
    get chatAgent() {
      return chatAgent;
    },
    cwd,
    sessionPath: opts.sessionPath,
    session,
    clients,
    broadcast,
    broadcastNotesChange,
    getActivePhaseContext: () => session.getActivePhaseContext(),
    cancelActiveOperation,
    handle,
    dispose,
    isRunning: () => running || autopilotActive || runLifecycle.running,
  };
}

main().catch(async (err) => {
  log("ERROR", "app-sidecar", "daemon lifecycle exit", {
    daemonPid: process.pid,
    shellPid: process.ppid,
    reason: "startup_failure",
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  captureSidecarError(err, "app-sidecar.main", { severity: "fatal" });
  await flushSidecarErrors();
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`GG_APP_FATAL ${message}\n`);
  process.exit(1);
});
