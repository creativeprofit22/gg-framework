import { nativeDevAuthFile } from "../app-sidecar-native-auth.js";
import { assertProviderExecutionAllowed, runUnattended } from "./provider-execution-policy.js";
import {
  agentLoop,
  isAbortError,
  isUsageLimitError,
  repairToolPairingAdjacent,
  type AgentEvent,
  type AgentTool,
  type AgentTurnEndEvent,
  type ToolExecuteResult,
} from "@kenkaiiii/gg-agent";
import {
  ProviderError,
  resolveToolSchema,
  stream,
  type Message,
  type MessageProvenance,
  type Provider,
  type Usage,
  type ThinkingLevel,
  type TextContent,
  type ImageContent,
  type VideoContent,
  type ToolCall,
  type ToolResult,
} from "@kenkaiiii/gg-ai";
import { EventBus, type McpToolEventIdentity } from "./event-bus.js";
import { flagUntrustedToolResult } from "./injection-detect.js";
import {
  parseContinuationReviewRecord,
  type ContinuationReviewRecord,
} from "./continuation-review-context.js";
import {
  sameStamp,
  scanProjectLockfiles,
  stampProjectLockfiles,
  type InstalledThreat,
  type LockfileStamp,
} from "./installed-threats.js";
import { onThreatFeedUpdated } from "./threat-feed.js";
import type { PackageCheckOptions } from "./package-threats.js";
import { parseSafetyBlock } from "./action-threats.js";
import { recordBlockedPackages } from "./blocked-packages-file.js";
import type { BlockedPackage } from "./shell-threats.js";
import {
  COMPLETION_REVIEW_STATE_KIND,
  type CompletionReview,
  type CompletionReviewRequest,
  type CompletionReviewResponse,
} from "./completion-review.js";
import {
  SlashCommandRegistry,
  createBuiltinCommands,
  type SlashCommandContext,
} from "./slash-commands.js";
import { CUSTOM_OVERRIDABLE_PROMPT_COMMANDS, getPromptCommand } from "./prompt-commands.js";
import {
  appendCommandArguments,
  loadWorkspaceCustomCommands,
  type CustomCommand,
} from "./custom-commands.js";
import { workflowQueuePolicyError } from "./workflow-busy-policy.js";
import {
  createProgrammaticReadinessReader,
  discoverCommands,
  registryCommandListings,
  programmaticReadinessGuidance,
  type ProgrammaticReadiness,
} from "./command-discovery.js";
import {
  buildProgrammaticAdvisoryContext,
  parseProgrammaticAssessmentInput,
  renderProgrammaticAdvisoryContext,
} from "./programmatic/advisory-context.js";
import { AdvisoryEvidence, type ProgrammaticAdvisoryTurn } from "./programmatic/advisory.js";
import type { DiscoveryReviewBoundary } from "./programmatic/discovery-review.js";
import type {
  DiscoveryReviewRequest,
  DiscoveryReview,
} from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { expandPromptCommand } from "./prompt-command-expansion.js";
import { SettingsManager } from "./settings-manager.js";
import { AuthStorage } from "./auth-storage.js";
import {
  dualAuthProvider,
  parseReferencedFiles,
  type NotesWorkspaceSnapshotV1,
  type SlashCommandListing,
} from "@kenkaiiii/gg-core";
import { getClaudeCliUserAgent, noteRequiredClaudeCodeVersion } from "./claude-code-version.js";
import { kimiCodingHeaders, isKimiCodingEndpoint } from "./oauth/kimi.js";
import { isGrokCliEndpoint } from "./oauth/xai.js";
import {
  SessionManager,
  RequiredSessionPersistenceError,
  KEN_TURN_CUSTOM_KIND,
  AUTOPILOT_MARKER_CUSTOM_KIND,
  APP_MARKER_CUSTOM_KIND,
  type ApprovedPlanConsumptionInput,
  type ApprovedPlanConsumptionRecord,
  type MessageEntry,
  type BranchInfo,
  type CustomEntry,
  type KenTurnPayload,
  type AutopilotMarkerPayload,
  type AppMarkerPayload,
  type RunJournalEntry,
  type RunOutcome,
  type SessionHeader,
  type TurnMetricPayload,
} from "./session-manager.js";
import { ExtensionLoader } from "./extensions/loader.js";
import type { ExtensionContext } from "./extensions/types.js";
import {
  shouldCompact,
  compact,
  type CompactionAnchorRemap,
  type CompactionContextSelection,
  type CompactionResult,
} from "./compaction/compactor.js";
import {
  getHistoryMessageVisibility,
  remapAnchorForCompaction,
  stripRecordedPosition,
} from "./session-history.js";
import { sourceFingerprint as computeSourceFingerprint } from "./session-compaction.js";
import {
  assertOpenAICodexContextProfileFitsUsage,
  getAuthStorageKeys,
  getContextWindow,
  getModel,
  getModelDisplayId,
  getToolResultCharLimit,
  MODELS,
  resolveTransportModel,
  type OpenAICodexContextProfile,
} from "./model-registry.js";
import { discoverSkillsWithBlocked, type BlockedSkill, type Skill } from "./skills.js";
import { ensureAppDirs } from "../config.js";
import {
  buildSubAgentSystemPrompt,
  buildSystemPrompt,
  type SystemPromptEnvironment,
} from "../system-prompt.js";
import {
  createTools,
  createWebSearchTool,
  type LspManager,
  type ProcessManager,
  type CreateToolsResult,
} from "../tools/index.js";
import { ADVISORY_ONLY_TOOL_NAMES, partitionToolsByTier } from "../tools/tool-tiers.js";
import type { CommandCreationReviewer } from "./programmatic/command-creation.js";
import type { ProgrammaticAssessmentOutcome } from "./programmatic/assessment.js";
import type { ProgrammaticSetupInspection } from "./programmatic/setup-inspection.js";
import type { DirectCommandExecutor } from "./programmatic/execution.js";
import type { BackgroundProcess } from "./process-manager.js";
import type { DebugManager } from "../tools/debug.js";
import { REVIEW_REJECTED_BEFORE_START } from "../tools/bash.js";
import { buildProcessCompletionFollowUp } from "./process-gate.js";
import { PLAN_SUBMISSION_NUDGE, shouldNudgePlanSubmission } from "./plan-submission-gate.js";
import { canonicalProjectKey } from "../project-notes-repository.js";
import {
  buildSubAgentCompletionFollowUp,
  type ChildModelPick,
  type SubAgentManager,
  type SubAgentSnapshot,
} from "./subagent-manager.js";
import { applyAsyncSubagentPolicy } from "./subagent-policy.js";
import {
  resolveResponsesLite,
  resolveStrictTools,
  type CodexShapeSetting,
} from "./codex-request-shape.js";
import { subAgentDescription } from "../tools/subagent.js";
import { z } from "zod";
import { MCPClientManager, getAllMcpServers } from "./mcp/index.js";
import type { MCPElicitHandler } from "./mcp/index.js";
import type { MCPServerConfig } from "./mcp/types.js";
import type { SharedMcpClientLease, SharedMcpClientPool } from "./mcp/shared-client-pool.js";
import { guardSessionTool, type SessionToolGuardHost } from "./agent-session-tool-guard.js";
import { clampMcpToolDescription, DeferredToolCatalog } from "./mcp/deferred-catalog.js";
import {
  CONTEXT_LIMITS,
  resolveSessionContextLimits,
  type ContextLimits,
} from "./context-limits.js";
import { McpCatalogCache, type CachedTool } from "./mcp/catalog-cache.js";
import {
  createMcpToolIdentity,
  getMcpToolIdentity,
  sameMcpToolIdentity,
  withMcpToolIdentity,
  type McpToolIdentity,
} from "./mcp/tool-identity.js";
import {
  describeDropped,
  importForeignSession,
  type ImportForeignTranscriptResult,
} from "./foreign-session-import.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { createSessionStatsTool } from "../tools/session-stats.js";
import {
  createDiagnoseCommand,
  isInternalDiagnosticsEnabled,
  SessionDiagnosticsRecorder,
} from "./internal-diagnostics.js";
import { log } from "./logger.js";
import { CacheDiagnostics } from "./cache-diagnostics.js";
import { assessCacheExpiry, resolveCacheTtl, type CacheExpiryStatus } from "./cache-expiry.js";
import {
  setEstimatorModel,
  calibrateEstimatorFromUsage,
  estimateConversationTokens,
} from "./compaction/token-estimator.js";
import { calculateActiveContextTokens } from "./compaction/active-context.js";
import { resolveCompactionPolicy } from "./compaction/policy.js";
import {
  decidePlanStepCompaction,
  DEFAULT_CACHE_WRITE_READ_RATIO,
  PLAN_STEP_KEEP_TOKENS,
  type PlanStepCompactionDecision,
} from "./compaction/plan-step-policy.js";
import { extractPlanSteps, findCompletedMarkers } from "../utils/plan-steps.js";
import { readFileSync } from "node:fs";
import { clampThinkingForPlanMode } from "./thinking-level.js";
import { pruneStaleToolResults, shouldPruneToolResults } from "./compaction/tool-result-pruner.js";
import { discoverAgents, type AgentDefinition } from "./agents.js";
import { enhancePrompt, type EnhanceResult } from "../utils/prompt-enhancer.js";
import { detectLanguages, detectProjectStack, type LanguageId } from "./language-detector.js";
import {
  evaluateLoopBreak,
  buildLoopBreakMessage,
  CycleDetector,
  ToolCallProgressTracker,
  detectTextRepetition,
  type CycleDetection,
} from "./loop-breaker.js";
import { buildRegroundingMessage, requestTextForRegrounding } from "./regrounding.js";
import {
  buildSemanticLoopJudgePrompt,
  buildSemanticLoopMessage,
  MAX_SEMANTIC_LOOP_CALLS,
  parseSemanticLoopVerdict,
  shouldRunSemanticLoopCheck,
  withJudgeTimeout,
  type SemanticCallDigest,
  type SemanticLoopVerdict,
} from "./semantic-loop-check.js";
import { buildEnvDeltaMessage, buildLanguageUpdateMessage } from "./env-delta.js";
import {
  wrapSteeringText,
  buildNotificationSteeringText,
  buildIdleWakeNotificationText,
  STEERING_PREFIX,
} from "./steering.js";
import { AgentNotificationQueue } from "./agent-notifications.js";
import {
  SessionVerificationEvidenceLedger,
  classifyVerificationCommand,
  type SessionVerificationEvidenceLedgerSnapshot,
} from "./verification-evidence.js";

import { findUserSessionPrompt, getUserSessionPrompt } from "./session-preview.js";
import { sameSessionFile } from "./session-storage.js";
import { normalizeMessageImages } from "./message-images.js";
import {
  renderActivePhasePackage,
  type ActivePhaseContextClearReason,
  type ActivePhaseContextV1,
  type ActivePhaseExecutionStage,
  type RoadmapPhaseLeaseMarkerV1,
} from "../phase-context.js";
import {
  clearActivePhaseContext,
  ensureActivePhaseSessionMetadata,
  rePersistActivePhaseContext,
  rePersistRoadmapPhaseLeaseMarker,
  restorePlanStateFromActivePhase,
  setActivePhaseContext,
  setRoadmapPhaseLeaseMarker,
  updateActivePhaseStage,
  type SessionPhaseContextHost,
} from "./agent-session-phase-context.js";
import {
  completeApprovedPlanConsumption,
  hydrateCanonicalApprovedPlan,
  markApprovedPlanImplementationPromptStarted,
  persistApprovedPlanConsumption,
  runApprovedPlanImplementation,
  type SessionApprovedPlanHost,
} from "./agent-session-approved-plan.js";
import {
  assessProgrammatic,
  reviewDiscoveryCandidate,
  type SessionProgrammaticHost,
} from "./agent-session-programmatic.js";
import { loadStreamRules } from "./stream-rules.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResearchSourceLedger } from "./research-sources.js";

/**
 * A run whose tool calls fail more often than this is thrashing, not
 * progressing — refuse to extend its turn budget.
 */
const TURN_EXTENSION_MAX_FAILURE_RATIO = 0.5;
/** Compaction rotations remembered for phase-lease hand-off between renewals. */
const COMPACTION_PREDECESSOR_LIMIT = 32;

// ── Output cap ─────────────────────────────────────────────

/**
 * The output cap to send on a request. A model's output ceiling can equal its
 * whole window (Kimi K2.7 Code: 262,144 of 262,144), and providers that count
 * prompt + max_tokens against the window reject every request with a real
 * prompt. Cap it at the room the model's TOTAL window leaves once the context
 * reaches this session's compaction trigger — the largest prompt it lets build
 * up. The total window, not the route's: the ChatGPT/Codex route's 272K
 * window is an input budget, and GPT-6's 128K output sits outside it.
 */
export function outputCapForRequest(options: {
  provider: Provider;
  model: string;
  maxTokens: number;
  threshold: number;
  accountId?: string;
}): number {
  const totalWindow = getContextWindow(options.model, { provider: options.provider });
  const { targetTokens } = resolveCompactionPolicy({
    provider: options.provider,
    model: options.model,
    contextWindow: getContextWindow(options.model, {
      provider: options.provider,
      accountId: options.accountId,
    }),
    threshold: options.threshold,
    accountId: options.accountId,
  });
  const room = totalWindow - targetTokens;
  return room > 0 ? Math.min(options.maxTokens, room) : options.maxTokens;
}

// ── Paid models ────────────────────────────────────────────

/**
 * Reply for chat bridges (Telegram, agent home) that have no confirmation step.
 * Generic on purpose: every paid model (Claude fast mode, MiMo UltraSpeed) is
 * refused here, so the reason must not name one of them.
 */
export function paidModelRefusal(modelName: string): string {
  return `${modelName} spends real money, so it can't be switched to from chat. Switch to it in the GG Coder app or CLI, where you confirm it.`;
}

/**
 * Thrown by {@link AgentSession.switchModel} when the target model spends real
 * money and the caller didn't pass the user's explicit confirmation.
 */
export class PaidModelConfirmationError extends Error {
  readonly modelName: string;
  readonly detail: string;
  constructor(modelName: string, detail: string) {
    super(`${modelName} spends real money. ${detail} Confirm before switching to it.`);
    this.name = "PaidModelConfirmationError";
    this.modelName = modelName;
    this.detail = detail;
  }
}

// ── Options ────────────────────────────────────────────────

/** A chat attachment (image / video / other file) prepared for the model. The
 *  raw base64 `data` rides native blocks; `path` (when persisted to disk) lets
 *  the agent's tools open the file directly. */
export interface SessionAttachment {
  kind: "image" | "video" | "file";
  mediaType: string;
  data: string;
  name: string;
  path?: string;
}

/** Per-prompt run controls. */
export interface PromptRunOptions {
  /** Offer the model no tools for this prompt. */
  disableTools?: boolean;
  /** Hold reasoning effort at the plan-mode ceiling for this prompt. */
  capThinking?: boolean;
}

export interface AgentSessionOptions {
  /** Headless/batch host intent; independent of MCP interactivity and tool permissions. */
  unattended?: boolean;
  reviewCommandCreation?: CommandCreationReviewer;
  reviewProgrammaticSetup?: CommandCreationReviewer;
  executeReviewedCommand?: DirectCommandExecutor;
  provider: Provider;
  model: string;
  cwd: string;
  baseUrl?: string;
  /** Replaces the whole system prompt — nothing else is rendered. */
  systemPrompt?: string;
  /**
   * A sub-agent definition's body, COMPOSED with the standard scaffolding
   * (Tools, project context, return contract, Environment) instead of replacing
   * it — see `buildSubAgentSystemPrompt`.
   *
   * Prefer this over `systemPrompt` for delegated children: a bare replacement
   * leaves the child with no Tools section and no Environment facts, which is
   * precisely how a sub-agent ends up misusing tools it was never told it had.
   * Ignored when `systemPrompt` is set.
   */
  agentPrompt?: string;
  /** Whether `agentPrompt` composition includes project instruction files. Default `"project"`. */
  agentContext?: "project" | "none";
  /**
   * Who `agentPrompt` speaks to. `"subagent"` (default) appends the delegated
   * child's return contract; `"primary"` is a user-facing specialist (Motion)
   * that keeps the Tools/Environment scaffolding but answers the user directly.
   */
  agentRole?: "subagent" | "primary";
  /** Synchronous volatile prompt suffix, refreshed immediately before every run. */
  getSystemPromptTail?: () => string;
  sessionId?: string;
  continueRecent?: boolean;
  maxTokens?: number;
  maxTurns?: number;
  /**
   * How many times the turn budget may be extended when the agent is still
   * making progress. Defaults to the agent-loop default (2); sub-agents pass a
   * stricter cap because a child's extensions multiply against the parent's
   * own budget.
   */
  maxTurnExtensions?: number;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  /** Prefix used for provider prompt-cache routing keys. */
  promptCacheKeyPrefix?: string;
  /**
   * Explicit prompt-cache routing key. When set, overrides the
   * `${promptCacheKeyPrefix}:${sessionId}` default so spawned sub-agents can
   * inherit a stable parent-scoped key — without this, each sub-agent process
   * generates a fresh sessionId and starts with a cold cache.
   */
  promptCacheKey?: string;
  /**
   * If true, this session does NOT create a `.jsonl` session file or persist
   * any messages. Used by subagent spawns (`--json` mode) so their transcripts
   * don't leak into `ggcoder continue` for the parent project. Subagent runs
   * are one-shot, NDJSON-streamed to the parent over stdout, and have no
   * resumable identity.
   */
  transient?: boolean;
  /**
   * Told when an agent loop starts (true) and when the outermost one ends
   * (false), however it ended. Nested loops (a template prompt inside a run)
   * don't repeat it. GG Goals uses it to tell other processes the goal is
   * being worked on (`core/goal-run-marker.ts`). A throwing listener is
   * ignored: it must never fail or wedge a run.
   */
  onRunActive?: (active: boolean) => void;
  /**
   * If true, `initialize()` returns WITHOUT waiting for MCP servers to connect —
   * the connection runs in the background and tools are appended when ready.
   * Hosts whose readiness is gated on `initialize()` (the gg-app sidecar, which
   * can't emit its listening handshake until init resolves) set this so a slow
   * or hanging stdio MCP server (e.g. a first-run `npx -y …` download) can't
   * delay the session from becoming usable. Default (false) keeps the CLI's
   * connect-before-ready behavior so MCP tools are present on the first turn.
   */
  backgroundMcpConnect?: boolean;
  /** Disable MCP discovery and connections for isolated one-shot sessions. */
  mcpEnabled?: boolean;
  /**
   * Handler for a server-initiated MCP `elicitation/create` — a request for user
   * input in the middle of a tool call. Hosts that can render a form (the
   * gg-app sidecar) supply this; without it the session declares no elicitation
   * capability and servers fall back to their no-input behavior.
   */
  onMcpElicit?: MCPElicitHandler;
  /**
   * If true, an over-context restored session is NOT compacted inline during
   * `loadExistingSession()` — the existing pre-run auto-compaction in
   * `runLoop()` handles it on the first prompt instead (with proper
   * compaction_start/_end events). The inline load compaction makes a summary
   * LLM call with a 30s timeout, and hosts whose readiness is gated on
   * `initialize()` (the gg-app sidecar: waitForReady blocks the whole webview)
   * would freeze the UI for that entire call. Default (false) keeps the
   * compact-on-load behavior for CLI resume/`ggcoder continue`.
   */
  deferLoadCompaction?: boolean;
  /** Keep restored plan content out of prompts until its durable artifact is validated. */
  deferApprovedPlanHydration?: boolean;
  /**
   * Plan-mode callbacks. When provided, the `enter_plan`/`exit_plan` tools are
   * registered and the session manages plan-mode restrictions + system-prompt
   * rebuilds. Hosts (e.g. the gg-app sidecar) use these to surface plan-mode
   * UI. Omitted by callers that don't want plan mode (CLI wires its own).
   */
  onEnterPlan?: (reason?: string) => void | Promise<void>;
  onExitPlan?: (planPath: string, content: string) => Promise<ToolExecuteResult>;
  /** Captures exact Git state when a bounded verification command settles. */
  captureVerificationWorkspace?: () => Promise<NotesWorkspaceSnapshotV1>;
  /**
   * Built-in tools to keep in the core set instead of the deferred
   * tool_search catalog: for a specialist whose job is a deferred tool (GG
   * Goals orchestrates with spawn_agent and friends). Fixed for the session.
   */
  coreTools?: readonly string[];
  /**
   * Default provider/model for the workers this session spawns, when their
   * agent names no model of its own. Read at spawn time.
   */
  getChildModel?: () => ChildModelPick | undefined;
  /**
   * Wrap each built-in tool once, at registration. Must keep the tool's name,
   * description and parameters (only `execute` may change), so the tool block
   * stays prompt-cache stable. Used by GG Goals to gate its own editing.
   */
  wrapTool?: (tool: AgentTool) => AgentTool;
  /**
   * Built-in tools this session never has, removed at registration (before
   * tiering) and left out of the system prompt's Tools section. Unlike
   * `allowedTools`, the rest of the tool set and its tiering are untouched.
   * Fixed for the session, so the cached tool block never changes. Used by
   * GG Goals, which never edits or runs anything itself.
   */
  withoutTools?: readonly string[];
  /**
   * A fixed team of sub-agents, replacing agent discovery (project, global
   * and bundled): the only agents spawn_agent and subagent can start. Used by
   * GG Goals, whose workers follow their own rules (goals-agent/goal-team.ts).
   */
  subAgents?: readonly AgentDefinition[];
  /**
   * Start every spawned child with this session's extra workspace roots too
   * (less the folder it works in), so it can read and change all of them.
   * GG Goals' workers work across all of a goal's attached folders.
   */
  shareRootsWithSubAgents?: boolean;
  /** The sub-agent a spawned child is when the spawn names none (one of `subAgents`). */
  defaultSubAgent?: string;
  /**
   * If provided, the session's tool set is filtered to ONLY these tool names
   * after `createTools()` runs, and the system prompt's Tools section lists only
   * them. Used by read-only advisory sessions (e.g. the Ken mentor agent) to
   * register a safe subset — excluded mutating tools (write/edit/bash/…) are
   * never registered, so a hallucinated call can't change the repo. Default
   * (undefined) = all tools, preserving every existing caller's behavior.
   */
  allowedTools?: string[];
  /**
   * MCP server names whose tools are allowed in an allow-listed session. Only
   * meaningful alongside `allowedTools`. With it set, the session connects ONLY
   * these named MCP servers (not the full configured set) and every tool they
   * expose (`mcp__<server>__*`) passes the allow-list, so a read-only agent can
   * be handed one research server while still being barred from every mutating
   * tool. Empty/undefined → an allow-listed session skips
   * MCP entirely (its dynamic tool names could never match a fixed allow-list).
   */
  allowedMcpServers?: string[];
  /**
   * Optional daemon-scoped owner for shareable read-only MCP processes.
   * Tool registration and allow-lists remain local to this AgentSession.
   */
  sharedMcpPool?: SharedMcpClientPool;
  /**
   * Force 1-h prompt-cache TTL + pre-warm regardless of the user's global
   * `speedProfile` setting. Bursty read-only advisory sessions (the Ken
   * mentor + autopilot reviewer) call the same static system prompt on a
   * schedule that routinely exceeds the default 5-min cache window — a
   * dropped cache there resends the whole cached prefix at full price right
   * when it matters most, independent of whatever the user picked for the
   * main build session. Default (undefined) = follow `speedProfile`.
   */
  forceLongCacheRetention?: boolean;
  /** Hidden persistent subagent workers omit the async orchestration tool suite. */
  subagentWorker?: boolean;
  /** Session storage root override. Chat agents use a dedicated namespace. */
  sessionRootDir?: string;
  /** Register GG Coder built-in/prompt/custom slash commands. Defaults to true. */
  coderSlashCommands?: boolean;
  /** Actions intercepted by the owning host, not executable prompt specialists. */
  workspaceCommands?: SlashCommandListing[];
  /** Client-owned names/aliases reserved for creation, without backend handlers. */
  reservedCommandIdentities?: readonly string[];
  workspaceCommandCaseInsensitive?: boolean;
  advertiseRegistryCommands?: boolean;
  /** Enable loop-break and re-grounding hooks. Defaults to true. */
  selfCorrectionHooks?: boolean;
  /** Override the semantic-loop judge LLM call (tests). Receives the finished
   *  prompt, returns the model's raw reply. Default: one-shot `stream()` call
   *  on the session's ACTIVE model. */
  semanticLoopJudge?: (prompt: string, signal: AbortSignal) => Promise<string>;
  /** Load project skills/agents and create local .gg directories. Defaults to true. */
  projectCustomization?: boolean;
  /**
   * Use exactly this skill set instead of discovering bundled/global/project
   * skills. A mode with a private skill bundle (Motion) passes its own list so
   * its skills stay invisible to every other mode, and vice versa.
   */
  skills?: readonly Skill[];
  /**
   * Background check of the project's lockfiles for packages flagged as
   * malware after install. Default on, except under vitest.
   */
  installedPackageWatch?: boolean;
  /** Delay before the first installed-package check (default 5 s). */
  installedPackageWatchDelayMs?: number;
  /** Options for the installed-package check (tests inject fetch/feed). */
  installedPackageCheck?: PackageCheckOptions;
  /**
   * Record refused packages in the project's instruction file (AGENTS.md /
   * CLAUDE.md) so later sessions know them. Default on for project sessions,
   * except under vitest.
   */
  blockedPackagesFile?: boolean;
  /**
   * Mode-specific defaults for prompt byte budgets. The user's `contextLimits`
   * setting still overrides these. Motion raises its skill-catalog budget
   * because its skill set is a fixed, bundled one (never untrusted files).
   */
  contextLimits?: Partial<ContextLimits>;
  /** Register global + bundled subagents without loading project customization. */
  globalSubagents?: boolean;
  /** Load GG Coder extensions. Defaults to true. */
  loadExtensions?: boolean;
  /** Inject GG Coder's model-specific subagent orchestration prompt. Defaults to true. */
  orchestrationPrompt?: boolean;
  /** Host-provided tools appended to this session only (for example, chat delegation). */
  additionalTools?: AgentTool[];
  /** Host approval gate, applied to every registered tool including stale references. */
  approveToolExecution?: (name: string, args: unknown, signal?: AbortSignal) => Promise<boolean>;
  /** Host freshness check after approval/receipt waits, immediately before guarded dispatch. */
  validateToolExecution?: () => Promise<void>;
  /** Host-provided broadcast hook fired after the `tasks` tool adds, completes, or removes a task. */
  onTasksChanged?: () => void;
  /** Mode-owned completion policy; absent in Coder/chat/worker sessions. */
  completionReview?: CompletionReview;
  /** Remind the agent to submit its plan (exit_plan) when a run is about to
   *  stop still in plan mode. Desktop only: an unsubmitted plan there leaves
   *  nothing to review. See plan-submission-gate.ts. */
  planSubmissionGate?: boolean;
}

// ── Tool-result policy ─────────────────────────────────────

/** Resolve the per-result cap passed to the agent loop for the active transport. */
export function resolveSessionToolResultCharLimit(
  model: string,
  provider: Provider,
  accountId?: string,
  openAICodexContextProfile?: OpenAICodexContextProfile,
): number {
  const contextOptions = { provider, accountId, openAICodexContextProfile };
  return (
    getToolResultCharLimit(model, contextOptions) ??
    Math.floor(getContextWindow(model, contextOptions) * 3.5 * 0.3)
  );
}

/**
 * Aggregate budget for ALL tool results produced in one assistant turn.
 * Individual results are already capped, but wide parallel fan-outs (GPT-5.6's
 * signature behavior) were observed injecting 100k+ uncached tokens in a single
 * turn. ~15% of the context window in chars (1 token ≈ 3.5 chars), floored at
 * 100KB so small windows still fit two full-size reads, ceilinged at 240KB so
 * 1M-context models don't waive the budget entirely.
 */
export function resolveSessionTurnToolResultCharLimit(
  model: string,
  provider: Provider,
  accountId?: string,
  openAICodexContextProfile?: OpenAICodexContextProfile,
): number {
  const contextChars =
    getContextWindow(model, { provider, accountId, openAICodexContextProfile }) * 3.5;
  return Math.max(100_000, Math.min(Math.floor(contextChars * 0.15), 240_000));
}

/** Marker the compactor prepends to the summary message it injects. */
/**
 * True when an assistant message ends a turn with tool calls still awaiting
 * their results. Inserting a user message there would orphan the tool_use
 * blocks and the provider rejects the next request.
 */
function hasUnresolvedToolCalls(message: Message): boolean {
  if (typeof message.content === "string" || !Array.isArray(message.content)) return false;
  return message.content.some((part) => part.type === "tool_call");
}

// ── State ──────────────────────────────────────────────────

import {
  normalizePromptMeta,
  type PromptMeta,
  type ContinuationSourceRevision,
  type OpenAICodexContextProfileEligibility,
} from "@kenkaiiii/gg-core/desktop-session-ux";

interface QueuedPrompt {
  /** Display identity: what the user typed, shown in the queue and restored on cancel. */
  id: string;
  text: string;
  attachments: SessionAttachment[];
  meta?: PromptMeta;
  /**
   * Steering entries only: set when `text` is a prompt-template command, holding
   * the expanded body the model receives as steering, matching what an idle send
   * would run. Always unset on deferred entries, which the host runs later from
   * the raw `text` as a normal send that expands the command itself.
   */
  modelText?: string;
  /**
   * Wait for the current run to finish and run as its own turn instead of
   * steering the run in flight. Deferred entries never interrupt tools and are
   * skipped by the mid-run steering drain, so they stay cancellable until the
   * host takes them with {@link AgentSession.takeNextQueuedMessage}.
   */
  deferred?: boolean;
}

/** Display hints persisted with a consumed user message; `command` restores the `/name` chip. */
type PromptHint = PromptMeta & { command?: string };

export interface AgentSessionState {
  provider: Provider;
  model: string;
  cwd: string;
  sessionId: string;
  conversationId: string;
  sessionPath: string;
  messageCount: number;
  planMode: boolean;
  /** accountId from the most recently resolved credentials, if any — lets
   *  callers compute the transport-specific context window (e.g. OpenAI Codex
   *  OAuth) without re-resolving credentials. */
  accountId?: string;
  openAICodexContextProfile: OpenAICodexContextProfile;
  openAICodexContextProfileEligibility: OpenAICodexContextProfileEligibility;
}

// ── Agent Session ──────────────────────────────────────────

/** A prompt that asks for the live web (see AgentSession.attachWebSearchIfAsked). */
const WEB_INTENT =
  /\b(?:web|internet|online|google|googling|website|look (?:it |this |that )?up|(?:latest|newest|current) (?:version|release|news|docs?|documentation)|release notes|news)\b/i;

/** Distinct security rows one run may add to the chat (and session file). */
const MAX_SECURITY_ROWS_PER_RUN = 20;

/**
 * A chat row's target: first line, no control or bidi-override characters
 * (they could make a command look like another), at most 120 chars.
 */
export function securityRowTarget(raw: string): string {
  const first = (raw.slice(0, 1024).split(/\r?\n/, 1)[0] ?? "")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return first.length > 120 ? `${first.slice(0, 119)}\u2026` : first;
}

/** Not the home folder or a filesystem root (those are never a project). */
export function isScannableProjectDir(dir: string, home: string = os.homedir()): boolean {
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return false;
  const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  return !home || norm(path.resolve(home)) !== norm(resolved);
}

/**
 * Windows on the same project in this process share one in-flight scan
 * (session start and a feed update otherwise fire N identical scans).
 */
const inflightLockfileScans = new Map<
  string,
  Promise<{ stamp: LockfileStamp; found: InstalledThreat[] }>
>();

function sharedLockfileScan(
  cwd: string,
  options: PackageCheckOptions | undefined,
): Promise<{ stamp: LockfileStamp; found: InstalledThreat[] }> {
  const run = async (): Promise<{ stamp: LockfileStamp; found: InstalledThreat[] }> => {
    const stamp = await stampProjectLockfiles(cwd);
    const found = stamp.size === 0 ? [] : await scanProjectLockfiles(cwd, options);
    return { stamp, found };
  };
  // Test-specific check options are never shared.
  if (options) return run();
  const key = path.resolve(cwd);
  const existing = inflightLockfileScans.get(key);
  if (existing) return existing;
  const promise = run().finally(() => inflightLockfileScans.delete(key));
  inflightLockfileScans.set(key, promise);
  return promise;
}

export class AgentSession {
  readonly eventBus = new EventBus();
  readonly slashCommands = new SlashCommandRegistry();

  private settingsManager!: SettingsManager;
  private authStorage!: AuthStorage;
  private sessionManager!: SessionManager;
  private extensionLoader = new ExtensionLoader();

  private messages: Message[] = [];
  // Ken Kai (mentor agent) turns recorded against this build session. Advisory
  // only — NEVER part of `messages` (GG Coder must not see them), but persisted
  // alongside the session and reloaded on resume so they reappear in the
  // transcript. Each carries the non-system message count at record time so the
  // webview can interleave them chronologically.
  private kenTurns: KenTurnPayload[] = [];
  // Autopilot Ken (auto-reviewer) markers recorded against this build session:
  // the review verdict shown in the transcript (prompted / done / human /
  // capped). Same not-on-the-DAG treatment as kenTurns — advisory only,
  // persisted + reloaded so a resumed session shows the identical Ken bubble
  // the live run showed instead of dropping it or replaying a raw verdict.
  private autopilotMarkers: AutopilotMarkerPayload[] = [];
  // Generic app transcript markers (plan-mode banner, task header, error rows,
  // user-bubble display hints). Same not-on-the-DAG treatment as kenTurns —
  // display only, persisted + reloaded so a resumed session shows the same
  // transcript rows the live run showed.
  private appMarkers: AppMarkerPayload[] = [];
  private turnMetrics: TurnMetricPayload[] = [];
  private readonly cacheDiagnostics = new CacheDiagnostics();
  /** Internal-only (GG_INTERNAL): live per-session cost/reliability recorder.
   * Absent entirely in public builds — see core/internal-diagnostics.ts. */
  private diagnosticsRecorder?: SessionDiagnosticsRecorder;
  private tools: AgentTool[] = [];
  /** Canonical guarded tool registry; `tools` is the policy-filtered live view used by the loop. */
  private registeredTools = new Map<string, AgentTool>();
  private unavailableToolNames = new Set<string>();
  private advisoryTurn?: ProgrammaticAdvisoryTurn;
  private pendingAdvisoryPresentation:
    { turn: ProgrammaticAdvisoryTurn; text: string; signal: AbortSignal } | undefined;
  private advisoryEvidence = new AdvisoryEvidence();
  private toolCapabilityPolicy: {
    allowedNames: Set<string>;
    allowedPrefixes: string[];
    unavailableMessage: (toolName: string) => string;
  } | null = null;
  /** Rebuilds the read tool for a new model (video byte cap is baked in at
   *  creation). Called from switchModel so video-capable models get the
   *  read-tool's native-video path after a mid-session model change. */
  private rebuildReadTool: ((model: string) => AgentTool) | undefined;
  /** Forgets every file read; called whenever the conversation is replaced or
   *  rewound, so the model must re-read a file before changing it. */
  private clearReadTracker: (() => void) | undefined;
  private recordBashReads:
    | ((toolCalls: readonly ToolCall[], toolResults: readonly ToolResult[]) => Promise<void>)
    | undefined;
  private skills: Skill[] = [];
  /** Skills discovery refused to load (safety scan); shown to the user, named by the skill tool. */
  private blockedSkills: BlockedSkill[] = [];
  /** Lockfile entries now known to be malware (background check), for the app/CLI to show. */
  private installedThreats: InstalledThreat[] = [];
  private installedWatchStop: (() => void) | undefined;
  private installedStamp: LockfileStamp | undefined;
  private installedScanRunning = false;
  private installedWatchStopped = false;
  /** rule\0target of the security rows already shown this run. */
  private securityRowsThisRun = new Set<string>();
  /** Project session (code mode): the only kind that writes the "don't install" list. */
  private projectSession = false;
  private cacheKeyLogged = false;
  // ── Self-correction hook state (mirrors the TUI's useAgentLoop refs) ──
  // Reset at the start of every run; observed from the event stream; read by
  // the loop-break (mid-loop) callback.
  private hookStats = { toolCalls: 0, toolFailures: 0, turns: 0 };
  private hookText = "";
  private hookConsecutiveFailures = 0;
  private hookRepeatedNoProgressCalls = 0;
  private hookProgressTracker = new ToolCallProgressTracker();
  private hookCycleDetector = new CycleDetector();
  private hookCyclicPattern: CycleDetection | null = null;
  private hookFileEditCounts = new Map<string, number>();
  private hookToolCalls = new Map<
    string,
    {
      name: string;
      args: Record<string, unknown>;
      revision: number;
      evidenceRevision: number;
      evidenceRun: number;
    }
  >();
  private readonly verificationEvidenceLedger = new SessionVerificationEvidenceLedger();
  /** 0 = none; 1 = first nudge sent; 2 = final stop-and-report injected. */
  private loopBreakInjected: 0 | 1 | 2 = 0;
  private regroundingInjected = false;
  /** Recent tool-call digests for the semantic loop judge — bounded ring. */
  private hookRecentCalls: SemanticCallDigest[] = [];
  /** LLM-judged loop detection state. `verdict` holds a LOOP verdict awaiting
   *  injection at the next steering poll; judge failures fail open (no
   *  injection) and still consume budget + cooldown. */
  private semanticLoop: {
    checksUsed: number;
    lastCheckTurn: number;
    pending: boolean;
    verdict: SemanticLoopVerdict | null;
    injected: boolean;
    controller?: AbortController;
  } = { checksUsed: 0, lastCheckTurn: 0, pending: false, verdict: null, injected: false };
  /**
   * The environment as the cached system prompt currently describes it.
   * Re-recorded on every prompt build, so a rebuild (e.g. `/add-dir`) needs no
   * delta; anything that changes WITHOUT one is caught by the hook below.
   */
  private renderedEnvironment: SystemPromptEnvironment = {};
  /** Wall-clock start of the current run; scopes the background-process gate. */
  private runStartedAt = 0;
  /** Gate injections spent this run, capped by MAX_PROCESS_GATE_INJECTIONS. */
  private processGateInjected = 0;
  /** Plan-submission reminders spent this run (plan-submission-gate.ts). */
  private planSubmissionNudges = 0;
  /** Mirror of the last `hook_armed` value, so the event fires only on an edge. */
  private preFinalArmed = false;
  private compactionOccurred = false;
  /**
   * Re-grounding carry-over for post-turn compaction. `resetHookState` clears
   * `compactionOccurred` at run start — before the injection point — so a
   * background compaction that finished after the final response parks its
   * "re-ground next turn" signal here for pickup at the next run start.
   */
  private compactionArmedForNextRun = false;
  /** In-flight post-turn (background) compaction, if any. */
  private postTurnCompaction?: Promise<void>;
  private lastCompactionCompacted = false;
  private compactionRetryAfter = 0;
  /**
   * SoL-Pi plan-step compaction bookkeeping (see compaction/plan-step-policy.ts).
   * Step progress comes from `[DONE:n]` markers in assistant text — the same
   * contract the approved-plan UI tracks.
   */
  private planStepState = {
    planPath: undefined as string | undefined,
    scanIndex: 0,
    doneSteps: new Set<number>(),
    requestsInCompletedSteps: 0,
    requestsThisStep: 0,
    requests: 0,
    grownTokens: 0,
    lastContextTokens: 0,
    compactions: 0,
    writeCostBalance: 0,
    savingPerRequest: 0,
    requestsSinceLastCompaction: 0,
  };
  /** A restored oversized checkpoint must be canonicalized before its first prompt is persisted. */
  private deferredCompactionPending = false;
  /** Latest provider count, anchored to the assistant response it measured. */
  private providerContext: { usage: Usage; anchor: Message } | null = null;
  /** See {@link toolDefinitionChars}. */
  private toolCharsCache: { count: number; chars: number } | null = null;
  private originalRequest = "";
  // Messages queued by the user while a run is in flight. Drained at the
  // mid-loop steering boundary (user steering wins over the hooks), mirroring
  // the TUI's getSteeringMessages. Each entry carries its own attachments so a
  // user can queue media (images/video/files) mid-run, not just plain text.
  // Each entry carries a stable id so a client can cancel one specific pending
  // message by identity. Index-based removal would race: the queue drains at
  // every turn boundary, so an index captured by the UI can point at a
  // different message (or past the end) by the time the cancel arrives.
  private userQueue: QueuedPrompt[] = [];
  // Associate hints with the exact consumed object, never with enqueue-time offsets
  // or model-visible fields. Weak keys also release abandoned run messages.
  private promptHints = new WeakMap<Message, PromptHint>();
  /** Serializes {@link queuePrompt} so entries are queued in arrival order. */
  private queuePromptChain: Promise<unknown> = Promise.resolve();
  private queueSeq = 0;
  /** Monotonic count of human-originated prompts; idle-wake budgets reset on it. */
  private humanPromptSeq = 0;
  /** Instant interrupt: the running loop's preempt listeners, fired on queueMessage. */
  private steeringListeners = new Set<() => void>();
  private processManager?: ProcessManager;
  private lspManager?: LspManager;
  private commandCreation?: CreateToolsResult["commandCreation"];
  private programmaticProfile?: CreateToolsResult["programmaticProfile"];
  private setupInspection?: ProgrammaticSetupInspection;
  private debugManager?: DebugManager;
  private subAgentManager?: SubAgentManager;
  /**
   * Out-of-band push notifications (finished children, background-process
   * progress). Producers enqueue; `getHookSteeringMessages` drains into the
   * live turn so the agent never has to spend a turn asking.
   */
  private readonly notifications = new AgentNotificationQueue();
  private managerAbortSignal?: AbortSignal;
  private readonly managerAbortHandler = () => {
    // Command proposals and receipts outlive tool calls, but never a real stop.
    this.commandCreation?.cancel();
    this.programmaticProfile?.cancel();
    this.discoveryReview?.close();
    this.discoveryCandidates = null;
    this.setupInspection?.close();
    this.lspManager?.clearPendingDiagnostics();
    void this.subAgentManager?.interruptAll();
  };
  private mcpManager?: MCPClientManager;
  /** Invalidates asynchronous MCP discovery from an earlier provider lifecycle. */
  private mcpConnectionGeneration = 0;
  /** Serializes desktop/config-triggered reloads so one lifecycle cannot dispose another. */
  private mcpReloadTail: Promise<void> = Promise.resolve();
  private sharedMcpLeases = new Map<string, SharedMcpClientLease>();
  /** Deferred MCP tools awaiting discovery via tool_search. */
  private mcpCatalog?: DeferredToolCatalog;
  /** Resolved prompt-injection byte budgets (contextLimits setting). */
  private contextLimits: ContextLimits = CONTEXT_LIMITS;
  /**
   * Built-in tools held in the catalog instead of the live toolset. Their names
   * still render as one-line hints in the prompt's Tools section, so the model
   * can discover and promote them; a promoted name drops out of this list.
   */
  private deferredBuiltinToolNames: string[] = [];
  private deferredBuiltinTools = new Map<string, AgentTool>();
  private capabilityPromotedBuiltinNames = new Set<string>();
  private searchedPromotedBuiltinNames = new Set<string>();
  /** Live (connected) MCP tools by provider alias — the reconcile target for cached stubs. */
  private liveMcpTools = new Map<string, AgentTool>();
  /** Exact MCP source identity claimed by each provider alias, cached or live. */
  private mcpToolIdentities = new Map<string, McpToolIdentity>();
  private readonly mcpCatalogCache = new McpCatalogCache();
  /** Untrusted project-scope MCP skips already warned about, so reconnects don't repeat it. */
  private readonly reportedProjectMcpSkips = new Set<string>();
  /** Servers whose latest connect attempt on the current MCP manager failed. */
  private readonly failedMcpServers = new Map<string, { requiresAuth: boolean }>();
  private provider: Provider;
  private model: string;
  private openAICodexContextProfile: OpenAICodexContextProfile = "stable";
  // Monotonic within a conversation: compaction/rewind can remove all messages.
  // Restore derives this from durable history and lineage, not a new header flag.
  private contextProfileLocked = false;
  private cwd: string;
  private readProgrammaticReadiness: () => Promise<ProgrammaticReadiness>;
  /** accountId from the most recently resolved credentials — cached so sync
   *  callers (e.g. the app-sidecar's context-window footer stat) can reflect
   *  transport-specific windows (e.g. OpenAI Codex OAuth's smaller window)
   *  without re-resolving credentials on every poll. */
  private lastAccountId?: string;
  private baseUrl?: string;
  private maxTokens: number;
  private thinkingLevel?: ThinkingLevel;
  private customSystemPrompt?: string;
  /** Sub-agent definition body composed into the standard prompt scaffolding. */
  private agentPrompt?: string;
  /** Stable prompt prefix retained separately from the volatile uncached tail. */
  private baseSystemPrompt = "";
  /**
   * Project languages whose style packs and verify commands are in the
   * standard prompt. Only ever grows within a session (same policy as the
   * terminal UI): a pack disappearing mid-task would rewrite the cached prefix
   * for no benefit.
   */
  private activeLanguages = new Set<LanguageId>();
  /** Languages the model has already been given guidance for, via the system
   *  prompt or an appended language update. */
  private announcedLanguages = new Set<LanguageId>();
  /** Shared with the tool layer so plan-mode restrictions read live state. */
  private planModeRef = { current: false };
  /** Corpus code retrieved this session; plans and Roadmap drafts must cite it. */
  readonly researchSources = new ResearchSourceLedger();
  /** Path of the approved plan currently being implemented, or undefined. When
   *  set, the system prompt carries the `[DONE:n]` progress contract so the
   *  model emits step-completion markers the UI's plan-progress widget reads. */
  private approvedPlanPath?: string;
  private approvedPlanContent?: string;
  private approvedPlanConsumption?: ApprovedPlanConsumptionRecord;
  private approvedPlanPhaseContext?: ActivePhaseContextV1;
  private approvedPlanHydrationDeferred: boolean;
  /** Extra workspace roots added with `/add-dir` (resolved, de-duplicated). */
  private additionalRoots: string[] = [];
  /** Durable selected Roadmap phase, restored before the next provider turn. */
  private activePhaseContext?: ActivePhaseContextV1;
  private roadmapPhaseLeaseMarker?: RoadmapPhaseLeaseMarkerV1;
  private runJournal: RunJournalEntry[] = [];
  private phaseLeaseRunState: "idle" | "running" = "idle";
  /**
   * Session ids this live session rotated away from through compaction
   * checkpoints. A phase lease recorded under one of these ids still belongs to
   * this conversation and is handed to the current session id, not lost.
   */
  private compactionPredecessorSessions: { sessionId: string; sessionPath: string | null }[] = [];

  private sessionId = "";
  private checkpointGeneration = 0;
  /** Stable identity shared by compaction and approved-plan checkpoint files. */
  private conversationId = "";
  /** Original user-authored prompt, retained when internal messages replace history. */
  private sessionPreview = "";
  /** Runtime conversation identity for provider transport headers. Transient
   *  children need one even though they intentionally have no persisted session. */
  private readonly transportSessionId = crypto.randomUUID();
  private sessionPath = "";
  private lastPersistedIndex = 0;
  /**
   * The array `agentLoop` is currently mutating, while a run is in flight.
   *
   * Normally identical to `this.messages`, but a mid-loop compaction rebinds
   * `this.messages` to the compacted result while the loop keeps appending to
   * its own array. Step-boundary flushes must follow the loop's array or they
   * would silently persist nothing for the rest of the run.
   */
  private activeLoopMessages: Message[] | null = null;

  /**
   * Number of non-system messages guaranteed to be in the session file — the
   * anchor base for transcript markers (Ken turns, autopilot verdicts, app
   * markers). `this.messages` can run ahead of the file: the agent loop
   * appends assistant/tool/steering messages in place but they are only
   * persisted when the run SUCCEEDS, so after a failed run the in-memory list
   * carries an unpersisted tail. Markers anchored against that tail point past
   * their real position on resume — the row (notably an error) renders lower
   * in the transcript than it happened, bunching at the bottom, or gets
   * dropped as out-of-range. Anchoring to the persisted prefix keeps resume
   * placement 1:1 with where the row appeared live.
   */
  private persistedTranscriptCount(): number {
    return this.messages.slice(0, this.lastPersistedIndex).filter((m) => m.role !== "system")
      .length;
  }
  /** Current leaf entry ID in the session DAG — used to chain parentIds for branching. */
  private currentLeafId: string | null = null;

  private opts: AgentSessionOptions;

  private resolveRunCredentials(...args: Parameters<AuthStorage["resolveCredentials"]>) {
    assertProviderExecutionAllowed(args[0], this.opts.unattended);
    return this.authStorage.resolveCredentials(...args);
  }

  constructor(options: AgentSessionOptions) {
    this.opts = options;
    this.provider = options.provider;
    this.model = options.model;
    this.cwd = options.cwd;
    this.readProgrammaticReadiness = createProgrammaticReadinessReader(this.cwd);
    this.baseUrl = options.baseUrl;
    this.maxTokens = this.resolveMaxTokens(options.model);
    this.thinkingLevel = options.thinkingLevel;
    this.customSystemPrompt = options.systemPrompt;
    this.agentPrompt = options.agentPrompt;
    this.approvedPlanHydrationDeferred = options.deferApprovedPlanHydration ?? false;
  }

  /**
   * Derive the output-token cap for a model. Follows the active model's
   * `maxOutputTokens` so a session booted on a large-output model (e.g. Kimi's
   * 256K) doesn't carry that cap to a smaller one (e.g. Opus's 128K) after a
   * model switch — that mismatch surfaces from the provider as
   * `max_tokens: 262144 > 128000, which is the maximum allowed …`. An explicit
   * `maxTokens` override is honored but clamped to the model's ceiling.
   */
  private resolveMaxTokens(modelId: string): number {
    const modelInfo = getModel(modelId);
    if (this.opts.maxTokens) {
      return modelInfo
        ? Math.min(this.opts.maxTokens, modelInfo.maxOutputTokens)
        : this.opts.maxTokens;
    }
    return modelInfo?.maxOutputTokens ?? 16384;
  }

  /** {@link outputCapForRequest} for this session's live model and settings. */
  private requestMaxTokens(accountId?: string): number {
    return outputCapForRequest({
      provider: this.provider,
      model: this.model,
      maxTokens: this.maxTokens,
      threshold: this.settingsManager.get("compactThreshold"),
      accountId,
    });
  }

  async initialize(): Promise<void> {
    // Set model for accurate token estimation
    setEstimatorModel(this.model);

    // The Anthropic transport needs the current Claude Code version for its
    // User-Agent before the first request. Without a fresh on-disk cache that
    // is an npm round-trip (~0.3–3s) on the user's first prompt; start it now
    // so it overlaps session setup and the user's typing instead.
    if (this.provider === "anthropic") void getClaudeCliUserAgent().catch(() => {});

    const paths = await ensureAppDirs();

    // Load settings & auth
    this.settingsManager = new SettingsManager(paths.settingsFile);
    await this.settingsManager.load();
    this.contextLimits = resolveSessionContextLimits(
      this.opts.contextLimits,
      this.settingsManager.get("contextLimits"),
    );

    this.authStorage = new AuthStorage(nativeDevAuthFile(paths.authFile));
    await this.authStorage.load();
    await this.refreshStoredAuthState();

    // Session manager. Agent-specific roots keep chat and coder histories isolated.
    this.sessionManager = new SessionManager(this.opts.sessionRootDir ?? paths.sessionsDir);

    const projectCustomization = this.opts.projectCustomization !== false;
    // A real project folder: not Motion (own skills), not GG Goals (goal notes
    // folder, agentContext "none"), not chat (no project customization).
    this.projectSession =
      projectCustomization &&
      !this.opts.skills &&
      (this.opts.agentContext ?? "project") === "project";
    // A sub-agent worker never creates them: the session that owns the
    // project does. GG Goals' workers work in the user's attached folders,
    // which mustn't gain empty .gg folders as a side effect.
    if (projectCustomization && !this.opts.subagentWorker) {
      // Ensure project-local .gg directories exist.
      const localGGDir = path.join(this.cwd, ".gg");
      await fs.mkdir(path.join(localGGDir, "skills"), { recursive: true });
      await fs.mkdir(path.join(localGGDir, "commands"), { recursive: true });
      await fs.mkdir(path.join(localGGDir, "agents"), { recursive: true });
    }
    if (this.opts.skills) {
      this.skills = [...this.opts.skills];
    } else if (projectCustomization) {
      const discovery = await discoverSkillsWithBlocked({
        globalSkillsDir: paths.skillsDir,
        projectDir: this.cwd,
      });
      this.skills = discovery.skills;
      this.blockedSkills = discovery.blocked;
      this.startInstalledPackageWatch();
    } else {
      this.skills = [];
    }

    // Discover agents and create tools (with sub-agent support). Chat sessions
    // can retain bundled workers without loading project/global customization.
    const agents = this.opts.subAgents
      ? [...this.opts.subAgents]
      : projectCustomization
        ? await discoverAgents({
            globalAgentsDir: paths.agentsDir,
            projectDir: this.cwd,
          })
        : this.opts.globalSubagents
          ? await discoverAgents({ globalAgentsDir: paths.agentsDir })
          : [];
    const {
      tools: createdBuiltInTools,
      processManager,
      rebuildReadTool,
      clearReadTracker,
      recordBashReads,
      lspManager,
      debugManager,
      subAgentManager,
      commandCreation,
      programmaticProfile,
    } = await createTools(this.cwd, {
      commandDiscovery:
        this.opts.coderSlashCommands === false
          ? false
          : {
              reservedCommandIdentities: this.opts.reservedCommandIdentities,
              workspaceActions: this.opts.workspaceCommands,
              workspaceCaseInsensitive: this.opts.workspaceCommandCaseInsensitive,
              readReadiness: this.readProgrammaticReadiness,
              getRegistryActions: () =>
                this.opts.advertiseRegistryCommands === false
                  ? []
                  : registryCommandListings(this.slashCommands.getAll()),
            },
      reviewCommandCreation: this.opts.reviewCommandCreation,
      reviewProgrammaticSetup: this.opts.reviewProgrammaticSetup,
      setupOwner: () => `${this.sessionId}:${this.cwd}`,
      assertSetupAllowed: () => {
        if (
          this.setupInspection ||
          !this.isToolCapabilityAllowed("programmatic_profile") ||
          this.unavailableToolNames.has("programmatic_profile")
        )
          throw new Error("Setup generation is unavailable under the current invocation policy.");
      },
      executeReviewedCommand: this.opts.executeReviewedCommand
        ? async (request) => {
            if (
              this.planModeRef.current ||
              this.advisoryTurn ||
              this.discoveryReview ||
              this.opts.coderSlashCommands === false ||
              this.opts.transient ||
              this.opts.allowedTools ||
              this.opts.subagentWorker ||
              this.opts.agentContext === "none"
            )
              throw new Error(
                "Reviewed execution requires an unrestricted desktop code-mode parent outside plan/advisory mode.",
              );
            return this.opts.executeReviewedCommand!(request);
          }
        : undefined,
      getAvailableToolNames: () =>
        [...new Set([...this.registeredTools.keys(), ...this.deferredBuiltinTools.keys()])].filter(
          (name) =>
            this.isPersistentToolCapabilityAllowed(name) && !this.unavailableToolNames.has(name),
        ),
      agents,
      shareWorkspaceRoots: this.opts.shareRootsWithSubAgents,
      defaultSubAgent: this.opts.defaultSubAgent,
      skills: this.skills,
      blockedSkills: this.blockedSkills,
      contextLimits: this.contextLimits,
      provider: this.provider,
      model: this.model,
      lspDiagnostics: this.settingsManager.get("lspDiagnostics"),
      deferLspDiagnostics: true,
      // Deferred and gated to programmatic advisory turns below.
      includeAdvisoryOnlyTools: true,
      getWriteGuardSettings: () => ({
        allowOutsideWorkspaceWrites: this.settingsManager.get("allowOutsideWorkspaceWrites"),
        additionalRoots: this.additionalRoots,
      }),
      getPackageCooldownDays: () => this.settingsManager.get("packageCooldownDays"),
      getNetworkPolicy: () => ({
        mode: this.settingsManager.get("networkMode"),
        allow: this.settingsManager.get("networkAllow"),
      }),
      getForegroundLimitSettings: () => ({
        yieldSeconds: this.settingsManager.get("bashYieldSeconds"),
        inactivitySeconds: this.settingsManager.get("bashInactivitySeconds"),
        hardLimitMinutes: this.settingsManager.get("bashHardLimitMinutes"),
      }),
      getSandboxPolicy: () => ({
        mode: this.settingsManager.get("sandboxMode"),
        // networkAllow always applies. Choosing "allowlist" is the user taking
        // over network policy, so the built-in developer defaults drop out and
        // only their hosts remain reachable.
        allowedDomains: this.settingsManager.get("networkAllow"),
        strictDomains: this.settingsManager.get("networkMode") === "allowlist",
        // Same source of truth as getWriteGuardSettings, so bash and the write
        // tool agree on which roots are writable.
        additionalRoots: this.additionalRoots,
        allowOutsideWorkspaceWrites: this.settingsManager.get("allowOutsideWorkspaceWrites"),
        allowUnixSockets: this.settingsManager.get("sandboxAllowUnixSockets"),
      }),
      getUseExternalGrep: () => this.settingsManager.get("grepUseRipgrep"),
      researchSources: this.researchSources,
      authStorage: this.authStorage,
      onFileMutated: (filePath) => {
        const relative = path.relative(this.cwd, filePath) || path.basename(filePath);
        this.hookFileEditCounts.set(relative, (this.hookFileEditCounts.get(relative) ?? 0) + 1);
      },
      onTasksChanged: this.opts.onTasksChanged,
      // Lazy — sessionId/model/provider can change after createTools() runs, so
      // sub-agent spawns read the current parent state at execution time.
      getProvider: () => this.provider,
      getModel: () => this.model,
      getThinkingLevel: () => this.thinkingLevel,
      getBaseUrl: () => this.baseUrl,
      getCacheKey: () => this.getPromptCacheKey(),
      getMaxPerModel: () => this.settingsManager.get("subagentMaxPerModel"),
      getChildModel: this.opts.getChildModel,
      // A persistent child is already the single allowed fan-out level. Blocking
      // `subagent` here created a timeout sandwich: the nested call could consume
      // the child's entire 10-minute turn budget, discarding all nested results.
      disableSubagents: this.opts.subagentWorker,
      onSubAgentState: (snapshot) => this.eventBus.emit("subagent_state", snapshot),
      notifications: this.notifications,
      // Plan mode: only wired when the host supplies callbacks. The ref is
      // shared so bash/edit/write enforce read-only restrictions live.
      ...(this.opts.onEnterPlan || this.opts.onExitPlan
        ? {
            planModeRef: this.planModeRef,
            onEnterPlan: this.opts.onEnterPlan,
            onExitPlan: this.opts.onExitPlan,
          }
        : {}),
    });
    // Both delegation tools carry the agent roster; when both survive the
    // allow-list, `subagent` points at `spawn_agent`'s copy instead.
    const rosterBuiltInTools =
      createdBuiltInTools.some((t) => t.name === "spawn_agent") && this.isToolAllowed("spawn_agent")
        ? createdBuiltInTools.map((t) =>
            t.name === "subagent" ? { ...t, description: subAgentDescription(agents, true) } : t,
          )
        : createdBuiltInTools;
    // Built-ins a host never wants (GG Goals never edits or runs anything
    // itself) are dropped before tiering; a host may also wrap built-ins (same
    // names and schemas, so the cached tool block is unchanged).
    const without = new Set(this.opts.withoutTools ?? []);
    const wrap = this.opts.wrapTool;
    const builtInTools = rosterBuiltInTools
      .filter((tool) => !without.has(tool.name))
      .map((tool) => (wrap ? wrap(tool) : tool));
    const additionalTools = [...(this.opts.additionalTools ?? [])];
    // Keep the internal tool eager, but subject to the same live capability guards.
    if (isInternalDiagnosticsEnabled()) {
      additionalTools.push(createSessionStatsTool(() => this.diagnosticsRecorder));
    }
    const additionalToolNames = new Set(additionalTools.map((tool) => tool.name));
    // Advisory-only built-ins never go live at setup, on any path: only an
    // active programmatic advisory turn promotes them from the deferred map.
    // A same-named host tool (isolated specialist sessions) still wins.
    const advisoryOnlyBuiltIns = builtInTools.filter(
      (tool) =>
        ADVISORY_ONLY_TOOL_NAMES.has(tool.name) &&
        !additionalToolNames.has(tool.name) &&
        this.isToolAllowed(tool.name),
    );
    const liveBuiltIns = builtInTools.filter((tool) => !ADVISORY_ONLY_TOOL_NAMES.has(tool.name));
    const tools = [...liveBuiltIns, ...additionalTools];
    // Static allow-lists (Ken) and live capability policies (chat Research) share
    // one guarded registry, so initial, additional, promoted, and late tools obey
    // the same boundary and stale references re-check it at execution time.
    const allowedTools = this.opts.allowedTools
      ? tools.filter((tool) => this.isToolAllowed(tool.name))
      : tools;
    // Tier built-ins only. Host-owned additional tools are live immediately; a
    // same-named host tool also overrides its built-in instead of leaving a stale
    // built-in definition in the deferred catalog.
    if (!this.opts.allowedTools && this.settingsManager.get("deferredBuiltinTools")) {
      const tierableBuiltIns = liveBuiltIns.filter((tool) => !additionalToolNames.has(tool.name));
      // Wrap before partitioning so a deferred trigger (spawn_agent) still
      // promotes its follow-ups once the catalog loads it.
      const partition = partitionToolsByTier(
        tierableBuiltIns.map((tool) => this.withWaitAgentPromotion(tool)),
      );
      // A session can keep chosen built-ins in its core set (GG Goals
      // orchestrates, so its agent tools are always at hand). Fixed for the
      // session, so the cached tool block stays byte-stable.
      const keep = new Set(this.opts.coreTools ?? []);
      const deferred = [
        ...partition.deferred.filter((tool) => !keep.has(tool.name)),
        ...advisoryOnlyBuiltIns,
      ];
      const core = [...partition.core, ...partition.deferred.filter((tool) => keep.has(tool.name))];
      this.registerTools([...core, ...additionalTools]);
      if (deferred.length > 0) {
        this.deferredBuiltinToolNames = deferred.map((tool) => tool.name);
        this.deferredBuiltinTools = new Map(deferred.map((tool) => [tool.name, tool]));
        this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
        this.mcpCatalog.add(deferred);
        this.ensureToolSearchTool();
        this.promoteCapabilityAllowedDeferredBuiltins();
        this.reconcileRegisteredTools();
      }
    } else {
      this.registerTools(allowedTools);
      // No catalog or prompt index here: the advisory turn alone promotes these.
      if (advisoryOnlyBuiltIns.length > 0) {
        this.deferredBuiltinTools = new Map(advisoryOnlyBuiltIns.map((tool) => [tool.name, tool]));
      }
    }
    this.rebuildReadTool = rebuildReadTool;
    this.clearReadTracker = clearReadTracker;
    this.recordBashReads = recordBashReads;
    this.processManager = processManager;
    this.lspManager = lspManager;
    this.commandCreation = commandCreation;
    this.programmaticProfile = programmaticProfile;
    this.debugManager = debugManager;
    this.subAgentManager = subAgentManager;
    this.bindManagerCancellation(this.opts.signal);

    // Connect MCP servers. The connect attempt itself can block for up to the
    // per-server connect timeout (~30s) — a slow stdio server such as a
    // first-run `npx -y @playwright/mcp` download stalls here. When the host
    // gates its own readiness on initialize() (the gg-app sidecar can't emit
    // its listening handshake until this resolves), `backgroundMcpConnect`
    // moves the connect off the critical path so the session becomes usable
    // immediately and tools are appended whenever the servers come up.
    if (this.opts.mcpEnabled !== false) {
      this.mcpManager = this.createMcpManager();
      if (this.opts.backgroundMcpConnect) {
        void this.connectMcpServers();
      } else {
        await this.connectMcpServers();
      }
    }

    // Detect languages before the first render so the opening prompt already
    // carries their packs and only a genuinely new language needs an update.
    this.refreshActiveLanguages();
    const basePrompt = await this.buildBasePrompt(false, undefined);
    this.baseSystemPrompt = basePrompt;
    this.messages = [{ role: "system", content: this.withSystemPromptTail(basePrompt) }];

    // Load or create session. Transient sessions (subagent spawns) never
    // touch the session store — sessionPath stays empty and persistMessage
    // is a no-op so their transcripts can't pollute `ggcoder continue`.
    if (this.opts.transient) {
      this.lastPersistedIndex = this.messages.length;
    } else if (this.opts.sessionId) {
      await this.loadExistingSession(this.opts.sessionId);
    } else if (this.opts.continueRecent) {
      const recentPath = await this.sessionManager.getMostRecent(this.cwd);
      if (recentPath) {
        await this.loadExistingSession(recentPath);
      } else {
        await this.createNewSession();
      }
    } else {
      await this.createNewSession();
    }
    if (this.sessionId) await this.subAgentManager?.hydrate(this.sessionId);

    // Maintenance is deliberately queued after initialization work and never
    // awaited, so retention/compression cannot delay sidecar or CLI readiness.
    if (!this.opts.transient) {
      const retentionDays = this.settingsManager.get("sessionRetentionDays");
      void Promise.resolve()
        .then(() =>
          this.sessionManager.runMaintenance({
            retentionDays,
            keepPaths: this.sessionPath ? [this.sessionPath] : [],
          }),
        )
        .then((metrics) => {
          if (metrics.deletedFiles > 0 || metrics.archivedFiles > 0 || metrics.failures > 0) {
            log("INFO", "session", "Session maintenance complete", {
              deletedFiles: String(metrics.deletedFiles),
              deletedMB: (metrics.deletedBytes / 1024 / 1024).toFixed(1),
              archivedFiles: String(metrics.archivedFiles),
              savedMB: (metrics.bytesSaved / 1024 / 1024).toFixed(1),
              failures: String(metrics.failures),
            });
          }
        })
        .catch((error) => {
          log("WARN", "session", "Session maintenance failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    // GG Coder owns its command registry. Other agents start with an isolated
    // empty registry and can register their own commands in their own file.
    if (this.opts.coderSlashCommands !== false) {
      const builtins = createBuiltinCommands();
      for (const cmd of builtins) this.slashCommands.register(cmd);

      // Internal-only diagnostics: recorder + /diagnose exist exclusively when
      // the internal flag is on. Public sessions never see either, so the
      // command list and prompt stay identical to a build without this code.
      if (isInternalDiagnosticsEnabled()) {
        this.diagnosticsRecorder = new SessionDiagnosticsRecorder({
          // Lazy: the session id is assigned at first prompt, not init.
          sessionId: () => this.sessionId,
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
        });
        this.diagnosticsRecorder.attach(this.eventBus);
        this.slashCommands.register(createDiagnoseCommand());
      }

      // Wire up /help to show all registered + prompt + custom commands.
      const helpCmd = this.slashCommands.get("help");
      if (helpCmd) {
        const registry = this.slashCommands;
        helpCmd.execute = async () => {
          const discovery = await discoverCommands(this.cwd, {
            workspaceActions: this.opts.workspaceCommands,
            workspaceCaseInsensitive: this.opts.workspaceCommandCaseInsensitive,
            registryActions: registryCommandListings(registry.getAll()),
            readReadiness: this.readProgrammaticReadiness,
            additionalRoots: this.additionalRoots,
          });
          const lines = discovery.entries.map(
            ({ listing: c }) =>
              `  /${c.name}${c.aliases.length ? ` (${c.aliases.map((a) => "/" + a).join(", ")})` : ""} — ${c.description}`,
          );
          return "Available commands:\n" + lines.join("\n");
        };
      }
    }

    if (this.opts.loadExtensions !== false) {
      const extContext: ExtensionContext = {
        eventBus: this.eventBus,
        registerTool: (tool) => this.registerTool(tool),
        registerSlashCommand: (cmd) => this.slashCommands.register(cmd),
        cwd: this.cwd,
        settingsManager: this.settingsManager,
      };
      await this.extensionLoader.loadAll(paths.extensionsDir, extContext);
    }

    this.eventBus.emit("session_start", { sessionId: this.sessionId });
  }

  /**
  /**
   * Whether a tool name is permitted for this session. With no `allowedTools`,
   * everything passes (default behavior). Otherwise, the exact provider-facing
   * name is checked against `allowedTools` first. MCP server allow-listing then
   * requires an attached or registered `McpToolIdentity` whose `serverName` is in
   * `allowedMcpServers`; the provider-facing name is never parsed for identity.
   * An ordinary host tool beginning with `mcp__` is therefore not treated as MCP.
   */
  private isToolAllowed(name: string, identity?: McpToolIdentity): boolean {
    const allowed = this.opts.allowedTools;
    if (!allowed) return true;
    if (allowed.includes(name)) return true;
    const mcpIdentity = identity ?? this.mcpToolIdentities.get(name);
    const mcpWhitelist = this.opts.allowedMcpServers;
    return mcpIdentity !== undefined && mcpWhitelist?.includes(mcpIdentity.serverName) === true;
  }

  /**
   * Reload persisted MCP configuration without rebuilding conversation, provider,
   * or unrelated host-tool state. MCP registrations are removed synchronously
   * before teardown awaits, so captured wrappers fail closed during removal.
   */
  reloadMcpServers(): Promise<void> {
    const reload = this.mcpReloadTail.then(
      () => this.reloadMcpServersNow(),
      () => this.reloadMcpServersNow(),
    );
    this.mcpReloadTail = reload.catch(() => {});
    return reload;
  }

  /**
   * Give servers that failed to connect (e.g. a startup timeout) one fresh
   * attempt without touching servers that are connected. Queued on the same
   * tail as `reloadMcpServers`, so it never overlaps an MCP panel reload; a
   * GLM switch replaces the manager, which the generation check catches.
   */
  retryFailedMcpServers(): Promise<void> {
    const retry = this.mcpReloadTail.then(
      () => this.retryFailedMcpServersNow(),
      () => this.retryFailedMcpServersNow(),
    );
    this.mcpReloadTail = retry.catch(() => {});
    return retry;
  }

  private async retryFailedMcpServersNow(): Promise<void> {
    const manager = this.mcpManager;
    if (!manager) return;
    // A login-required server fails again until the user signs in; the login
    // flow reconnects it.
    const failedNames = [...this.failedMcpServers]
      .filter(([, failure]) => !failure.requiresAuth)
      .map(([name]) => name)
      .sort();
    if (failedNames.length === 0) return;
    const generation = this.mcpConnectionGeneration;
    try {
      // Re-resolve so trust, enabled and allow-list rules apply exactly as on a
      // full connect. A failed server that is no longer allowed is forgotten,
      // never started.
      const resolved = await this.resolveMcpServers(generation, manager);
      if (!resolved) return;
      // Only session-owned servers are retried. Daemon-pooled servers (just the
      // deprecated kencode-search) never report outcomes here.
      const pool = this.opts.sharedMcpPool;
      const byName = new Map(
        resolved.filter((server) => !pool?.canShare(server)).map((server) => [server.name, server]),
      );
      const servers: MCPServerConfig[] = [];
      for (const name of failedNames) {
        const server = byName.get(name);
        if (server) servers.push(server);
        else this.failedMcpServers.delete(name);
      }
      if (servers.length === 0) return;

      const results = await manager.connectAllDetailed(servers);
      if (!this.isCurrentMcpConnection(generation, manager)) {
        await manager.dispose();
        return;
      }
      const tools = results.flatMap((result) => (result.ok ? result.tools : []));
      const mcpTools = this.opts.allowedTools
        ? tools.filter((tool) => this.isToolAllowed(tool.name, getMcpToolIdentity(tool)))
        : tools;
      this.addMcpTools(mcpTools);
      for (const result of [...results].sort((a, b) => a.name.localeCompare(b.name))) {
        // Name, tool count and the formatted connect error only: never config,
        // env or headers.
        log(
          "INFO",
          "mcp",
          `Retried MCP server "${result.name}" on new session`,
          result.ok
            ? { result: "connected", tools: String(result.tools.length) }
            : { result: "failed", error: result.error ?? "connection failed" },
        );
      }
      if (mcpTools.length > 0 && this.messages.length > 0) {
        await this.rebuildSystemPromptInPlace();
      }
    } catch (err) {
      if (!this.isCurrentMcpConnection(generation, manager)) {
        await manager.dispose();
        return;
      }
      log("WARN", "mcp", `MCP retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async reloadMcpServersNow(): Promise<void> {
    const staleProviderNames = new Set(this.mcpToolIdentities.keys());
    this.unregisterTools(
      (toolName, tool) =>
        getMcpToolIdentity(tool) !== undefined || staleProviderNames.has(toolName),
    );
    this.mcpCatalog?.removeWhere((name) => staleProviderNames.has(name));
    this.liveMcpTools.clear();
    this.mcpToolIdentities.clear();

    const oldManager = this.mcpManager;
    const oldLeases = [...this.sharedMcpLeases.values()];
    this.sharedMcpLeases.clear();
    const generation = ++this.mcpConnectionGeneration;
    const newManager = this.opts.mcpEnabled !== false ? this.createMcpManager() : undefined;
    this.mcpManager = newManager;

    await this.disposeMcpResources(oldManager, oldLeases);
    if (newManager && this.isCurrentMcpConnection(generation, newManager)) {
      await this.connectMcpServers();
    }
    await this.rebuildSystemPromptInPlace();
  }

  /**
   * Connect all configured MCP servers and append their tools to `this.tools`.
   * Resolves the GLM api key first (Z.AI's bundled servers need it). Never
   * throws — a failed connect is logged and skipped — so it is safe to either
   * `await` (CLI: tools ready before the first turn) or fire-and-forget
   * (sidecar: `backgroundMcpConnect`, so a slow stdio server can't stall
   * startup). Tools are pushed onto the live array the agent loop reads each
   * turn, so background-connected servers become available on the next prompt.
   */
  /**
   * Resolve the servers this session may connect: provider defaults plus
   * configured servers, with the project-trust gate, allow-list and enabled
   * filters applied. Every connect path goes through here, so a retry can never
   * start a server a full connect would skip. Returns undefined when the
   * connection generation went stale while resolving.
   */
  private async resolveMcpServers(
    generation: number,
    manager: MCPClientManager,
  ): Promise<MCPServerConfig[] | undefined> {
    if (this.mcpBlockedByAllowList()) return [];
    const mcpWhitelist = this.opts.allowedMcpServers;
    let apiKey: string | undefined;
    if (this.provider === "glm") {
      try {
        const glmCreds = await this.authStorage.resolveCredentials("glm");
        apiKey = glmCreds.accessToken;
      } catch {
        // GLM not configured — skip Z.AI MCP servers
      }
      if (!this.isCurrentMcpConnection(generation, manager)) return undefined;
    }
    let servers = await getAllMcpServers(this.provider, apiKey, this.cwd, {
      allowProjectScope: this.settingsManager.isProjectTrusted(this.cwd),
      reportedProjectSkips: this.reportedProjectMcpSkips,
    });
    if (!this.isCurrentMcpConnection(generation, manager)) return undefined;
    // Whitelisted allow-listed session: connect ONLY the named servers, never
    // the user's full configured set (which could include mutating tools). The
    // whitelist only restricts in allow-list mode (the documented contract) so
    // a normal session is never affected by a stray allowedMcpServers.
    if (this.opts.allowedTools && mcpWhitelist) {
      servers = servers.filter((s) => mcpWhitelist.includes(s.name));
    }
    // Disabled servers must neither acquire shared leases nor publish cached
    // tools. Keep their cache metadata intact so re-enabling can reuse it.
    return servers.filter((server) => server.enabled !== false);
  }

  /**
   * Allow-listed (read-only advisory) sessions enforce a fixed tool set by
   * name. An MCP server is only connected when its name is explicitly
   * whitelisted via `allowedMcpServers`. With no whitelist, skip MCP entirely —
   * dynamic `mcp__server__tool` names could never match a fixed allow-list, and
   * connecting would waste resources spawning stdio servers.
   */
  private mcpBlockedByAllowList(): boolean {
    const mcpWhitelist = this.opts.allowedMcpServers;
    return this.opts.allowedTools !== undefined && (!mcpWhitelist || mcpWhitelist.length === 0);
  }

  private recordMcpConnectOutcome(outcome: {
    name: string;
    ok: boolean;
    requiresAuth?: boolean;
  }): void {
    if (outcome.ok) this.failedMcpServers.delete(outcome.name);
    else this.failedMcpServers.set(outcome.name, { requiresAuth: outcome.requiresAuth === true });
  }

  private async connectMcpServers(): Promise<void> {
    const manager = this.mcpManager;
    if (!manager) return;
    const generation = this.mcpConnectionGeneration;
    // Outcomes belong to one manager; a fresh connect starts a fresh record.
    this.failedMcpServers.clear();
    if (this.mcpBlockedByAllowList()) return;
    const acquiredLeases = new Set<SharedMcpClientLease>();
    try {
      const servers = await this.resolveMcpServers(generation, manager);
      if (!servers) return;
      const pool = this.opts.sharedMcpPool;
      const sharedServers = pool ? servers.filter((server) => pool.canShare(server)) : [];
      const privateServers = pool ? servers.filter((server) => !pool.canShare(server)) : servers;

      // Claim shared leases before cached definitions become visible through
      // tool_search. A background session can promote a cached tool as soon as
      // seedMcpCatalogFromCache yields; without the lease already registered,
      // that activation resolves against the session-local manager and bypasses
      // the daemon pool.
      const sharedConnections: Promise<AgentTool[]>[] = [];
      for (const server of sharedServers) {
        let lease = this.sharedMcpLeases.get(server.name);
        if (!lease) {
          const acquiredLease = pool!.acquire(
            server,
            {
              catalogCache: this.mcpCatalogCache,
              modernProtocol: this.settingsManager.get("mcpModernProtocol"),
            },
            (change) => {
              if (this.sharedMcpLeases.get(server.name) !== acquiredLease) return;
              this.applyMcpServerState(change);
            },
          );
          lease = acquiredLease;
          this.sharedMcpLeases.set(server.name, lease);
        }
        acquiredLeases.add(lease);
        sharedConnections.push(lease.tools);
      }

      const privateConnection = manager.connectAll(privateServers);
      // Seed the catalog only after every shared manager is routable. With
      // `backgroundMcpConnect`, this still exposes cached capabilities before
      // the live connection finishes, but never through the wrong manager.
      await this.seedMcpCatalogFromCache(servers, generation, manager);

      const connected = (await Promise.all([privateConnection, ...sharedConnections])).flat();
      if (!this.isCurrentMcpConnection(generation, manager)) {
        // The old manager may have completed after its first dispose. Dispose it
        // again now that its connect settled, and release every lease this attempt
        // acquired; both operations are idempotent.
        await Promise.all([
          manager.dispose(),
          ...[...acquiredLeases].map((lease) => lease.release()),
        ]);
        return;
      }
      // Defense-in-depth: even from a whitelisted server, only push tools that
      // pass the allow-list (no-op when there's no allow-list).
      const mcpTools = this.opts.allowedTools
        ? connected.filter((tool) => this.isToolAllowed(tool.name, getMcpToolIdentity(tool)))
        : connected;
      this.addMcpTools(mcpTools);
      // Background connect resolves AFTER initialize() has already built the
      // system prompt (the default path awaits this before buildSystemPrompt,
      // so its prompt already lists the tools). Refresh messages[0] so the
      // model is also told about the MCP tools by name on its next turn —
      // mirrors the TUI's replaceSystemPrompt after connectInitialMcpTools.
      // Safe ordering: this method's first await yields before initialize()
      // sets `messages`, and connectAll (process spawn / network) always
      // resolves long after the local-only remainder of init has finished.
      if (
        this.opts.backgroundMcpConnect &&
        mcpTools.length > 0 &&
        this.isCurrentMcpConnection(generation, manager)
      ) {
        await this.rebuildSystemPromptInPlace();
      }
      // Detect project-scope servers excluded because the repo isn't trusted,
      // so the host can offer a per-repo "Trust" button. Computed after the
      // connect so the blocked list reflects the same connect attempt.
    } catch (err) {
      if (!this.isCurrentMcpConnection(generation, manager)) {
        await Promise.all([
          manager.dispose(),
          ...[...acquiredLeases].map((lease) => lease.release()),
        ]);
        return;
      }
      log(
        "WARN",
        "mcp",
        `MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private isCurrentMcpConnection(generation: number, manager: MCPClientManager): boolean {
    return generation === this.mcpConnectionGeneration && manager === this.mcpManager;
  }

  /** Persist explicit per-project trust for project-scope MCP servers. */
  async trustProject(cwd: string): Promise<void> {
    await this.settingsManager.trustProject(cwd);
  }

  /**
   * Route freshly connected MCP tools: deferred into the tool_search catalog
   * (default — keeps ~8k tokens of schema out of every cache-miss turn) or
   * pushed eagerly when the user opted out.
   * Allow-listed sessions (Ken) always get the eager path — their fixed tool
   * expectations predate the catalog, and tool_search isn't allow-listed.
   * Promotion pushes onto the live `this.tools` array the running agent loop
   * re-reads every turn, so promoted tools are callable on the next step.
   */
  private claimMcpToolIdentity(tool: AgentTool): McpToolIdentity | undefined {
    const identity = getMcpToolIdentity(tool);
    if (!identity) {
      log("WARN", "mcp", "MCP tool is missing exact identity metadata; omitting tool", {
        providerName: tool.name,
      });
      return undefined;
    }

    const claimed = this.mcpToolIdentities.get(identity.providerName);
    if (claimed && !sameMcpToolIdentity(claimed, identity)) {
      log("WARN", "mcp", "MCP provider alias collision; omitting conflicting tool", {
        providerName: identity.providerName,
        existingIdentity: [claimed.serverName, claimed.toolName],
        conflictingIdentity: [identity.serverName, identity.toolName],
      });
      return undefined;
    }

    const collidesWithHostTool =
      claimed === undefined &&
      (this.registeredTools.has(identity.providerName) ||
        this.deferredBuiltinTools.has(identity.providerName));
    if (collidesWithHostTool) {
      log("WARN", "mcp", "MCP provider alias collides with a host tool; omitting MCP tool", {
        providerName: identity.providerName,
        mcpIdentity: [identity.serverName, identity.toolName],
      });
      return undefined;
    }

    this.mcpToolIdentities.set(identity.providerName, identity);
    return identity;
  }

  private addMcpTools(mcpTools: AgentTool[]): void {
    if (mcpTools.length === 0) return;
    const acceptedTools = mcpTools.filter((tool) => this.claimMcpToolIdentity(tool) !== undefined);
    if (acceptedTools.length === 0) return;
    for (const tool of acceptedTools) this.liveMcpTools.set(tool.name, tool);

    const defer = !this.opts.allowedTools && this.settingsManager.get("deferredMcpTools");
    if (!defer) {
      // Eager registration retains identity filtering and enforces description budgets.
      this.replaceOrPushTools(
        acceptedTools.map((tool) => clampMcpToolDescription(tool, this.contextLimits)),
      );
      return;
    }
    this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
    // `add` is name-keyed, so live definitions replace cached stubs in place.
    this.mcpCatalog.add(acceptedTools);
    // A stub the model already promoted lives in `this.tools`; swap it for the
    // live tool so later calls dispatch directly instead of through the stub.
    this.replaceLivePromotedTools(acceptedTools);
    this.ensureToolSearchTool();
  }

  /**
   * Register `tool_search` once. Promotion of a cached-only entry waits for its
   * server so the model is told immediately when that capability turns out to
   * be unreachable, instead of promoting a tool that fails on first call.
   *
   * The catalog is created on demand rather than required up front: deferred
   * built-in tools populate it with zero MCP servers connected, so gating
   * registration on an existing catalog would leave those tools unreachable.
   */
  private ensureToolSearchTool(): void {
    this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
    if (this.tools.some((t) => t.name === "tool_search")) return;
    this.registerTool(
      createToolSearchTool(
        this.mcpCatalog,
        async (promoted) => {
          for (const tool of promoted) {
            if (this.deferredBuiltinTools.has(tool.name)) {
              this.searchedPromotedBuiltinNames.add(tool.name);
            }
          }
          this.registerTools(promoted);
          await this.rebuildSystemPromptInPlace();
        },
        async (toolName) => {
          if (this.liveMcpTools.has(toolName)) return undefined;
          const identity = this.mcpToolIdentities.get(toolName);
          if (!identity) return undefined;
          const serverName = identity.serverName;
          const outcome = (await this.mcpManagerForServer(serverName)?.whenConnected(
            serverName,
          )) ?? {
            ok: false as const,
            error: "MCP is disabled for this session",
          };
          return outcome.ok
            ? { serverName, ok: true }
            : { serverName, ok: false, error: outcome.error };
        },
        (toolName) =>
          (!ADVISORY_ONLY_TOOL_NAMES.has(toolName) || this.advisoryTurn?.active === true) &&
          !this.unavailableToolNames.has(toolName) &&
          this.isToolCapabilityAllowed(toolName),
        this.contextLimits,
      ),
    );
  }

  private mcpManagerForServer(serverName: string): MCPClientManager | undefined {
    return this.sharedMcpLeases.get(serverName)?.manager ?? this.mcpManager;
  }

  /**
   * Whether provider-native web search rides along with this request.
   *
   * Anthropic's `web_search_20250305` server tool costs ~2.5k prefix tokens on
   * every request (count_tokens: 6,628 vs 4,098 for the GG prefix without it),
   * yet web search is reached in ~6% of sessions — the reason the client tool
   * is deferred everywhere else. So on a tiered Anthropic session it is only
   * attached once the model has promoted `web_search` (tool_search or a direct
   * call). The server tool is appended last, so the tool block stays
   * append-only. Untiered sessions and other providers keep it always on.
   */
  private nativeWebSearchOn(): boolean {
    if (this.provider !== "anthropic") return true;
    if (!this.deferredBuiltinToolNames.includes("web_search")) return true;
    return this.registeredTools.has("web_search");
  }

  /**
   * A human prompt that plainly asks for the web gets native web search from
   * its first request. Without this, an on-demand web_search costs an extra
   * round trip (tool_search or a client search) before the native tool is
   * attached — slower than the always-on tool it replaced for exactly the
   * sessions that need it. Conservative on purpose: a miss only costs that
   * one discovery turn, a false hit only the ~2.5k-token schema.
   */
  private attachWebSearchIfAsked(content: unknown): void {
    if (this.provider !== "anthropic" || this.nativeWebSearchOn()) return;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                part && typeof part === "object" && "text" in part ? String(part.text) : "",
              )
              .join(" ")
          : "";
    if (WEB_INTENT.test(text)) this.promoteDeferredBuiltin("web_search");
  }

  /**
   * `wait_agent` is deferred, yet nearly every `spawn_agent` is followed by it,
   * so the model spent a whole turn on `tool_search` just to load it (bench 41:
   * ~6 s per fan-out). Promote it as soon as a spawn succeeds instead: the tool
   * list grows exactly as it would after that `tool_search`, one turn earlier,
   * and sessions that never spawn keep the smaller prefix. Promotion goes
   * through the guarded registry, so capability policies still apply.
   */
  private withWaitAgentPromotion(tool: AgentTool): AgentTool {
    // Likewise a background `bash` is always followed by `task_output` (and
    // sometimes `task_send`/`task_stop`) — upstream 987257de.
    const followUps =
      tool.name === "spawn_agent"
        ? { names: ["wait_agent"], when: () => true }
        : tool.name === "bash"
          ? {
              names: ["task_output", "task_send", "task_stop"],
              when: (args: unknown) =>
                (args as { run_in_background?: unknown } | undefined)?.run_in_background === true,
            }
          : undefined;
    if (!followUps) return tool;
    return {
      ...tool,
      execute: async (args, context) => {
        const result = await tool.execute(args, context);
        if (followUps.when(args)) {
          const missing = followUps.names.filter((name) => !this.registeredTools.has(name));
          if (missing.length > 0) this.promoteDeferredBuiltins(missing);
        }
        return result;
      },
    };
  }

  /** Promote deferred built-ins through the guarded registry. */
  private promoteDeferredBuiltins(names: string[]): AgentTool[] {
    const promoted = this.mcpCatalog?.promote(names) ?? [];
    for (const promotedTool of promoted) {
      if (this.deferredBuiltinTools.has(promotedTool.name)) {
        this.searchedPromotedBuiltinNames.add(promotedTool.name);
      }
    }
    if (promoted.length > 0) this.registerTools(promoted);
    return promoted;
  }

  /** Resolve a deferred built-in called by name (append-only promotion). */
  private promoteDeferredBuiltin(name: string): AgentTool | undefined {
    if (!this.deferredBuiltinTools.has(name)) return undefined;
    // Local Fork: by-name and intent promotion (upstream's attachWebSearchIfAsked)
    // honour the same capability boundary as tool_search, e.g. read-only Research.
    if (this.unavailableToolNames.has(name) || !this.isToolCapabilityAllowed(name)) {
      return undefined;
    }
    // Advisory-only tools load solely through the advisory turn, never by name.
    if (ADVISORY_ONLY_TOOL_NAMES.has(name)) return this.tools.find((t) => t.name === name);
    if (!this.registeredTools.has(name)) this.promoteDeferredBuiltins([name]);
    return this.tools.find((t) => t.name === name);
  }

  /** Append tools, replacing any same-named entry (cached stub → live tool). */
  private replaceOrPushTools(tools: AgentTool[]): void {
    this.registerTools(tools);
  }

  /** Swap already-promoted cached stubs for their live equivalents, in place. */
  private replaceLivePromotedTools(tools: AgentTool[]): void {
    for (const tool of tools) {
      if (this.registeredTools.has(tool.name)) this.registerTool(tool);
    }
  }

  /**
   * Publish cached tool definitions into the deferred catalog so `tool_search`
   * answers correctly on turn 1. A cached stub carries the real name, one-line
   * description and input schema; calling it waits for the live connection and
   * then dispatches against the real client, or returns a clear error when that
   * server ultimately failed. Live tools replace stubs on connect.
   */
  private async seedMcpCatalogFromCache(
    servers: MCPServerConfig[],
    generation: number,
    manager: MCPClientManager,
  ): Promise<void> {
    if (!this.opts.backgroundMcpConnect) return;
    if (this.opts.allowedTools || !this.settingsManager.get("deferredMcpTools")) return;
    let entries: Awaited<ReturnType<McpCatalogCache["entriesFor"]>>;
    try {
      entries = await this.mcpCatalogCache.entriesFor(servers);
    } catch {
      return;
    }
    if (!this.isCurrentMcpConnection(generation, manager)) return;
    const stubs: AgentTool[] = [];
    for (const [serverName, entry] of entries) {
      for (const cached of entry.tools) {
        let identity: McpToolIdentity;
        try {
          identity = createMcpToolIdentity(serverName, cached.toolName);
        } catch {
          continue;
        }
        const live = this.liveMcpTools.get(identity.providerName);
        if (live && sameMcpToolIdentity(live, identity)) continue;
        const stub = this.buildCachedMcpTool(identity, cached);
        if (this.claimMcpToolIdentity(stub)) stubs.push(stub);
      }
    }
    if (stubs.length === 0) return;
    log("INFO", "mcp", "Seeded deferred tool catalog from cache", {
      tools: String(stubs.length),
      servers: String(entries.size),
    });
    this.addCachedMcpTools(stubs);
  }

  /** Catalog-only registration for cached stubs — never marks them live. */
  private addCachedMcpTools(stubs: AgentTool[]): void {
    this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
    this.mcpCatalog.add(stubs);
    this.ensureToolSearchTool();
  }

  private buildCachedMcpTool(identity: McpToolIdentity, cached: CachedTool): AgentTool {
    const stub: AgentTool = {
      name: identity.providerName,
      description: cached.description,
      parameters: z.record(z.string(), z.unknown()),
      rawInputSchema: cached.rawInputSchema as Record<string, unknown> | undefined,
      execute: async (args, context) => {
        const live = this.liveMcpTools.get(identity.providerName);
        if (live && sameMcpToolIdentity(live, identity)) return live.execute(args, context);
        const outcome = (await this.mcpManagerForServer(identity.serverName)?.whenConnected(
          identity.serverName,
        )) ?? {
          ok: false as const,
          error: "MCP is disabled for this session",
        };
        if (!outcome.ok) {
          return (
            `MCP tool ${identity.providerName} is unavailable: server "${identity.serverName}" ` +
            `did not connect (${outcome.error}). This tool was offered from a cached catalog. ` +
            `Use a different approach or ask the user to check their MCP configuration.`
          );
        }
        const connected = this.liveMcpTools.get(identity.providerName);
        if (!connected || !sameMcpToolIdentity(connected, identity)) {
          return (
            `MCP tool ${identity.providerName} no longer exists: server ` +
            `"${identity.serverName}" connected but does not expose it. ` +
            `The cached catalog entry was stale.`
          );
        }
        return connected.execute(args, context);
      },
    };
    return withMcpToolIdentity(stub, identity);
  }

  /** Return an actionable error when a built-in command rejects this input. */
  promptInputPolicyError(content: string, attachmentCount = 0): string | null {
    if (this.opts.coderSlashCommands === false) return null;
    const parsed = this.slashCommands.parse(content);
    if (!parsed) return null;
    const command = getPromptCommand(parsed.name);
    if (!command?.input) return null;
    if (
      (parsed.args && command.input.text === "none") ||
      (attachmentCount > 0 && command.input.attachments === "none") ||
      (command.input.references === "none" && parseReferencedFiles(content).files.length > 0)
    ) {
      return command.input.text === "none"
        ? `/${command.name} accepts no arguments, file references, or attachments.`
        : `/${command.name} accepts optional text only, not file references or attachments.`;
    }
    if (command.name === "programmatic" && !parseProgrammaticAssessmentInput(parsed.args).success)
      return "Use an optional focus of at most 4,000 characters without control characters (newlines and tabs are allowed).";
    return null;
  }

  /**
   * Resolve a `/name [args]` input to the prompt template it expands into, or
   * null when it isn't a prompt-template command for THIS session (an ordinary
   * message, a registry/action command, or any slash input on a non-coder
   * agent). Shared by {@link prompt} and {@link willExpandPromptTemplate} so
   * callers can't drift from the expansion that actually happens.
   */
  private async resolveSlashInput(
    content: string,
    includeAdvisory = true,
  ): Promise<
    | {
        kind: "template";
        fullPrompt: string;
        setupInspection?: boolean;
        advisory?: ReturnType<typeof buildProgrammaticAdvisoryContext>;
      }
    | { kind: "command"; result?: string }
    | null
  > {
    const parsedInput = this.slashCommands.parse(content);
    const coderCommands = this.opts.coderSlashCommands !== false;
    // Non-coder agents only intercept commands registered in their own registry.
    // Unknown `/text` stays a normal conversational prompt.
    const parsed =
      parsedInput && (coderCommands || this.slashCommands.get(parsedInput.name))
        ? parsedInput
        : null;
    if (!parsed) return null;
    if (coderCommands && parsed.name === "programmatic-run") {
      return {
        kind: "command",
        result:
          "Review and select an opportunity in Opportunities, then use its separate task approval. Direct /programmatic-run does not authorize execution.",
      };
    }
    if (coderCommands && getPromptCommand(parsed.name)?.name === "programmatic") {
      const guidance = programmaticReadinessGuidance(await this.readProgrammaticReadiness());
      if (guidance) return { kind: "command", result: guidance };
    }
    // GG Coder alone can resolve its prompt-template and project commands.
    const builtinPromptCmd = coderCommands
      ? getPromptCommand(parsed.name, (toolName) =>
          this.tools.some((tool) => tool.name === toolName),
        )
      : undefined;
    // Custom commands fill names no built-in claims, and replace the few
    // built-ins a user's own recipe may override (e.g. their own /commit).
    const customCanReplace =
      !builtinPromptCmd || CUSTOM_OVERRIDABLE_PROMPT_COMMANDS.has(builtinPromptCmd.name);
    const customCmds = coderCommands && customCanReplace ? await this.loadCustomCommands() : [];
    const customPromptCmd = customCmds.find((c) => c.name === parsed.name);
    const promptText = customPromptCmd?.prompt ?? builtinPromptCmd?.prompt;
    const inputPolicyError = this.promptInputPolicyError(content);
    if (inputPolicyError) return { kind: "command", result: inputPolicyError };
    // No template body — a registry/action command that runs and returns text
    // instead of becoming a user message.
    if (!promptText) return { kind: "command" };
    if (builtinPromptCmd?.name === "programmatic") {
      const input = parseProgrammaticAssessmentInput(parsed.args);
      if (!input.success)
        return {
          kind: "command",
          result:
            "Use an optional focus of at most 4,000 characters without control characters (newlines and tabs are allowed).",
        };
      if (!includeAdvisory)
        return {
          kind: "template",
          fullPrompt: this.expandResolvedPromptCommand(promptText, input.data.focus ?? ""),
        };
      const discovery = await discoverCommands(this.cwd, {
        workspaceActions: this.opts.workspaceCommands,
        workspaceCaseInsensitive: this.opts.workspaceCommandCaseInsensitive,
        registryActions:
          this.opts.advertiseRegistryCommands === false
            ? []
            : registryCommandListings(this.slashCommands.getAll()),
        readReadiness: async () => "current",
      });
      const advisory = buildProgrammaticAdvisoryContext(input.data, discovery);
      return {
        kind: "template",
        advisory,
        fullPrompt:
          this.expandResolvedPromptCommand(promptText, input.data.focus ?? "") +
          renderProgrammaticAdvisoryContext(advisory),
      };
    }
    return {
      kind: "template",
      fullPrompt: expandPromptCommand(promptText, parsed.args),
      setupInspection: builtinPromptCmd?.name === "setup-programmatic",
    };
  }

  private assessmentSequence = 0;
  private assessmentActive = false;
  private discoveryReview?: DiscoveryReviewBoundary;
  private discoveryCandidates: {
    owner: string | null;
    sequence: number;
    records: NonNullable<ProgrammaticAssessmentOutcome["discoveryRecords"]>;
  } | null = null;

  reviewDiscoveryCandidate(request: DiscoveryReviewRequest): Promise<DiscoveryReview> {
    return reviewDiscoveryCandidate(this.programmaticHost(), request);
  }

  /** Shared host entry for slash commands and desktop callbacks under their existing run claim.
   * Publishes display-only status, independently of transcript and exact setup ownership. */
  assessProgrammatic(
    mode: "setup" | "configured",
    focus?: string,
    provenance: MessageProvenance = { source: "human", kind: "prompt", visibility: "transcript" },
    options: {
      disableTools?: boolean;
      onAccepted?: () => void | Promise<void>;
      meta?: PromptMeta;
      assessmentRequestId?: string;
    } = {},
  ): Promise<ProgrammaticAssessmentOutcome & { setupFacts?: unknown; scanFacts?: unknown }> {
    return assessProgrammatic(this.programmaticHost(), mode, focus, provenance, options);
  }

  private programmaticHost(): SessionProgrammaticHost {
    return {
      tools: {
        registered: () => this.registeredTools,
        deferred: () => this.deferredBuiltinTools,
        list: () => this.tools,
        guard: (tool) => this.guardRegisteredTool(tool),
        reconcile: () => this.reconcileRegisteredTools(),
        isCapabilityAllowed: (name) => this.isToolCapabilityAllowed(name),
        unavailable: () => this.unavailableToolNames,
        supports: (name, args) => this.supportsToolCall(name, args),
        register: (tool) => this.registerTool(tool),
        searchedPromoted: () => this.searchedPromotedBuiltinNames,
        capabilityPromoted: () => this.capabilityPromotedBuiltinNames,
      },
      boundaries: {
        advisoryTurn: () => this.advisoryTurn,
        setAdvisoryTurn: (turn) => {
          this.advisoryTurn = turn;
        },
        setupInspection: () => this.setupInspection,
        setSetupInspection: (inspection) => {
          this.setupInspection = inspection;
        },
        discoveryReview: () => this.discoveryReview,
        setDiscoveryReview: (review) => {
          this.discoveryReview = review;
        },
        advisoryEvidence: () => this.advisoryEvidence,
        setAdvisoryEvidence: (evidence) => {
          this.advisoryEvidence = evidence;
        },
        setPendingAdvisoryPresentation: (presentation) => {
          this.pendingAdvisoryPresentation = presentation;
        },
        programmaticProfile: () => this.programmaticProfile,
        commandCreation: () => this.commandCreation,
      },
      assessment: {
        active: () => this.assessmentActive,
        setActive: (active) => {
          this.assessmentActive = active;
        },
        sequence: () => this.assessmentSequence,
        nextSequence: () => ++this.assessmentSequence,
        candidates: () => this.discoveryCandidates,
        setCandidates: (candidates) => {
          this.discoveryCandidates = candidates;
        },
      },
      session: {
        sessionId: () => this.sessionId,
        cwd: () => this.cwd,
        options: () => this.opts,
        planMode: () => this.planModeRef.current,
        conversationIdentity: () => this.getConversationIdentity(),
        eventBus: () => this.eventBus,
        readReadiness: () => this.readProgrammaticReadiness(),
        slashCommands: () => this.slashCommands,
        hookText: () => this.hookText,
        hookToolCallCount: () => this.hookToolCalls.size,
        hookFileEditCounts: () => this.hookFileEditCounts,
      },
      transcript: {
        acceptPromptTemplate: (content, provenance, options) =>
          this.acceptPromptTemplate(content, provenance, options),
        expandResolvedPromptCommand: (prompt, args) =>
          this.expandResolvedPromptCommand(prompt, args),
        messages: () => this.messages,
        persistMessage: (message) => this.persistMessage(message),
        setLastPersistedIndex: (index) => {
          this.lastPersistedIndex = index;
        },
      },
    };
  }

  private expandResolvedPromptCommand(prompt: string, args: string): string {
    return appendCommandArguments(prompt, args);
  }

  /** Host-only pinned command entry: no slash lookup or project override. */
  async promptResolvedCommand(command: Readonly<{ prompt: string }>, args: string): Promise<void> {
    if (!this.opts.transient) throw new Error("Resolved commands require a transient session.");
    if (!command.prompt.trim()) throw new Error("Resolved command body is empty.");
    await this.adoptDeferredCheckpointBeforePrompt();
    await this.acceptPromptTemplate(this.expandResolvedPromptCommand(command.prompt, args), {
      source: "human",
      kind: "prompt",
      visibility: "transcript",
    });
  }

  private async acceptPromptTemplate(
    content: string,
    provenance: MessageProvenance,
    options: {
      disableTools?: boolean;
      onAccepted?: () => void | Promise<void>;
      meta?: PromptMeta;
    } = {},
  ): Promise<void> {
    await this.ensureActivePhaseSessionMetadata();
    const userMessage: Message = { role: "user", content, provenance };
    this.contextProfileLocked = true;
    await this.announceNewLanguages();
    this.messages.push(userMessage);
    const meta = normalizePromptMeta(options.meta);
    if (meta) this.promptHints.set(userMessage, meta);
    await this.persistMessage(userMessage, !!options.onAccepted);
    this.lastPersistedIndex = this.messages.length;
    await options.onAccepted?.();
    await this.runLoop(options);
  }

  /**
   * Whether {@link prompt} would expand this input into a template body and
   * persist it as a user message. Hosts use it to record the typed `/name` for
   * transcript restore — gating on anything looser risks tagging an unrelated
   * message when the command turns out NOT to expand.
   */
  async willExpandPromptTemplate(content: string): Promise<boolean> {
    return (await this.resolveSlashInput(content, false))?.kind === "template";
  }

  /** True when this input will enter the provider-backed agent loop. */
  async willStartAgentRun(content: string): Promise<boolean> {
    return (await this.resolveSlashInput(content, false))?.kind !== "command";
  }

  /**
   * Process user input. Handles slash commands or runs agent loop.
   * `capThinking` holds reasoning effort at the plan-mode ceiling for this
   * prompt — for turns that must answer quickly from what is already known.
   */
  async prompt(
    content: string,
    provenance: MessageProvenance = {
      source: "human",
      kind: "prompt",
      visibility: "transcript",
    },
    options: PromptRunOptions & {
      onAccepted?: () => void | Promise<void>;
      meta?: PromptMeta;
    } = {},
  ): Promise<void> {
    if (!content.trim()) return;
    this.prewarmController?.abort();
    if (provenance.source === "human") this.humanPromptSeq += 1;
    await this.settlePostTurnCompaction();
    await this.adoptDeferredCheckpointBeforePrompt();
    const slash = await this.resolveSlashInput(content);
    if (slash?.kind === "template") {
      if (slash.setupInspection || slash.advisory) {
        await this.assessProgrammatic(
          slash.setupInspection ? "setup" : "configured",
          slash.advisory?.assessment.focus,
          provenance,
          options,
        );
      } else await this.acceptPromptTemplate(slash.fullPrompt, provenance, options);
      return;
    }
    if (slash?.kind === "command") {
      const result =
        slash.result ??
        (await this.slashCommands.execute(content, this.createSlashCommandContext()));
      if (result) {
        this.eventBus.emit("text_delta", { text: result + "\n" });
      }
      return;
    }

    await this.ensureActivePhaseSessionMetadata();
    // Push user message
    const userMessage: Message = { role: "user", content, provenance };
    this.contextProfileLocked = true;
    await this.announceNewLanguages();
    this.messages.push(userMessage);
    // Daemon startup must not release its lease on a best-effort append failure.
    const meta = normalizePromptMeta(options.meta);
    if (meta) this.promptHints.set(userMessage, meta);
    await this.persistMessage(userMessage, !!options.onAccepted);
    this.lastPersistedIndex = this.messages.length;
    await options.onAccepted?.();
    if (provenance.source === "human") this.attachWebSearchIfAsked(content);

    await this.runLoop(options);
  }

  /**
   * Prompt with multimodal attachments (images / videos) alongside optional
   * text. Images and videos become native content blocks the model can see;
   * non-media files are surfaced as a text note with their saved path so the
   * agent can open them with its tools. Attachment turns skip normal slash
   * expansion, but fixed-input prompt commands still fail closed here.
   */
  async promptWithAttachments(
    text: string,
    attachments: SessionAttachment[],
    options: { onAccepted?: () => void | Promise<void>; meta?: PromptMeta } = {},
  ): Promise<void> {
    if (attachments.length === 0) {
      await this.prompt(text, undefined, options);
      return;
    }
    const inputPolicyError = this.promptInputPolicyError(text, attachments.length);
    if (inputPolicyError) {
      this.eventBus.emit("text_delta", { text: inputPolicyError + "\n" });
      return;
    }
    this.prewarmController?.abort();
    this.humanPromptSeq += 1;
    await this.settlePostTurnCompaction();
    const parts = this.buildAttachmentParts(text, attachments);
    if (parts.length === 0)
      throw new Error("Attachments produced no usable content. Nothing was sent.");
    await this.adoptDeferredCheckpointBeforePrompt();
    await this.ensureActivePhaseSessionMetadata();
    this.attachWebSearchIfAsked(text);
    const userMessage: Message = {
      role: "user",
      content: parts,
      provenance: { source: "human", kind: "prompt", visibility: "transcript" },
    };
    this.contextProfileLocked = true;
    await this.announceNewLanguages();
    this.messages.push(userMessage);
    const meta = normalizePromptMeta(options.meta);
    if (meta) this.promptHints.set(userMessage, meta);
    await this.persistMessage(userMessage, !!options.onAccepted);
    this.lastPersistedIndex = this.messages.length;
    await options.onAccepted?.();
    await this.runLoop();
  }

  /**
   * Build the native content blocks (text + image/video notes + file notes) for
   * a user message with attachments. Shared by {@link promptWithAttachments} and
   * the mid-run steering drain so queued media is delivered identically.
   */
  private buildAttachmentParts(
    text: string,
    attachments: SessionAttachment[],
  ): Array<TextContent | ImageContent | VideoContent> {
    const parts: Array<TextContent | ImageContent | VideoContent> = [];
    const fileNotes: string[] = [];
    const modelInfo = getModel(this.model);
    const modelSupportsVideo = modelInfo?.supportsVideo ?? false;
    // GLM only: GLM models have no native image input, but the GLM session is
    // the only one with the zai_vision MCP server connected (core/mcp/defaults.ts).
    // Point at the real tool instead of an inline image the provider layer would
    // blank into a placeholder. Every other provider keeps inline images.
    const glmImageHint = this.provider === "glm" && modelInfo?.supportsImages === false;
    for (const a of attachments) {
      if (!a.path && (a.kind !== "image" || glmImageHint || !a.data)) {
        throw new Error(
          `Attachment "${a.name}" is unavailable for analysis. Nothing was sent; retry the attachment.`,
        );
      }
      if (a.kind === "image") {
        if (glmImageHint && a.path) {
          parts.push({
            type: "text",
            text:
              `[User attached an image saved at: ${a.path} — analyze it with the ` +
              `mcp__zai_vision__analyze_image tool (if that tool is not available yet, ` +
              `call tool_search with "analyze image" to unlock it first, then call it with image_source=${a.path})]`,
          });
        } else {
          parts.push({ type: "image", mediaType: a.mediaType, data: a.data });
          if (a.path) {
            parts.push({ type: "text", text: `[Image saved at ${a.path}]` });
          }
        }
      } else if (a.kind === "video") {
        // Mirror the CLI's buildUserContentWithAttachments: never send inline
        // VideoContent in the user message. Video-capable models (Kimi/Gemini/
        // MiniMax) watch video via the read tool, which auto-compresses to the
        // model's byte cap and delivers it in the provider's required shape.
        // Non-video models get a plain note so they know to use ffmpeg. The file
        // was already saved to disk by prepareAttachments in the sidecar.
        if (modelSupportsVideo && a.path) {
          parts.push({
            type: "text",
            text:
              `The user attached a video at ${a.path}. You CAN watch it: call the read tool ` +
              `on this exact path now, then answer based on what you see. Do not say you ` +
              `cannot watch video — reading the file lets you analyze it.`,
          });
        } else if (a.path) {
          parts.push({
            type: "text",
            text:
              `[User attached a video file at ${a.path}. You cannot watch video directly; ` +
              `if needed, use ffmpeg to extract frames or audio.]`,
          });
        } else {
          parts.push({
            type: "text",
            text: `[User attached a video file but it could not be saved for analysis.]`,
          });
        }
      } else if (a.path) {
        fileNotes.push(`- ${a.name} (saved at ${a.path})`);
      }
    }
    const textParts: string[] = [];
    if (text.trim()) textParts.push(text.trim());
    if (fileNotes.length > 0) {
      textParts.push(`Attached files (inspect with your tools):\n${fileNotes.join("\n")}`);
    }
    if (textParts.length > 0) parts.unshift({ type: "text", text: textParts.join("\n\n") });
    return parts;
  }

  /**
   * Reset per-run self-correction hook state. Mirrors the TUI's run_start
   * resets so each run evaluates the hooks from a clean slate. `originalRequest`
   * is the verbatim user ask, pinned for post-compaction re-grounding.
   */
  private resetHookState(originalRequest: string): void {
    this.verificationEvidenceLedger.beginRun();
    this.semanticLoop.controller?.abort();
    this.opts.completionReview?.begin(originalRequest);
    this.lspManager?.clearPendingDiagnostics();
    this.hookStats = { toolCalls: 0, toolFailures: 0, turns: 0 };
    this.hookText = "";
    this.hookConsecutiveFailures = 0;
    this.hookRepeatedNoProgressCalls = 0;
    this.hookProgressTracker.reset();
    this.hookCycleDetector.reset();
    this.hookCyclicPattern = null;
    this.hookFileEditCounts.clear();
    this.hookToolCalls.clear();
    this.loopBreakInjected = 0;
    this.securityRowsThisRun.clear();
    this.regroundingInjected = false;
    this.hookRecentCalls = [];
    this.semanticLoop = {
      checksUsed: 0,
      lastCheckTurn: 0,
      pending: false,
      verdict: null,
      injected: false,
    };
    this.runStartedAt = Date.now();
    this.processGateInjected = 0;
    this.planSubmissionNudges = 0;
    this.compactionOccurred = false;
    // Post-turn compaction may have landed between runs — adopt its armed
    // signal so the re-grounding hook fires for this run exactly as it would
    // after a pre-run compaction.
    if (this.compactionArmedForNextRun) {
      this.compactionArmedForNextRun = false;
      this.compactionOccurred = true;
    }
    this.originalRequest = originalRequest;
  }

  /**
   * Enrich presentation events from the session-owned tool registry. The agent
   * event and provider declaration keep only the provider-facing alias.
   */
  private forwardAgentEvent(event: AgentEvent): void {
    let mcpIdentity: McpToolEventIdentity | undefined;
    if (event.type === "tool_call_start") {
      const identity = getMcpToolIdentity(this.registeredTools.get(event.name));
      if (identity) {
        mcpIdentity = {
          displayName: `${identity.serverName} / ${identity.toolName}`,
          mcpServerName: identity.serverName,
          mcpToolName: identity.toolName,
        };
      }
    }
    this.eventBus.forwardAgentEvent(event, mcpIdentity);
  }

  /**
   * Fold one agent event into the hook stat accumulators. Pure bookkeeping —
   * the same signals the TUI's useAgentLoop collects, so loop-break decisions
   * match across the CLI and the app.
   */
  private async trackHookEvent(event: AgentEvent): Promise<void> {
    if (this.opts.completionReview) {
      await this.opts.completionReview.track(event);
      if (event.type === "checkpoint") await this.persistCompletionReviewState();
    }
    switch (event.type) {
      case "text_delta":
        this.hookText += event.text;
        break;
      case "tool_call_start":
        this.hookToolCalls.set(event.toolCallId, {
          name: event.name,
          args: event.args ?? {},
          revision: this.verificationEvidenceLedger.revision,
          evidenceRevision: this.verificationEvidenceLedger.revision,
          evidenceRun: this.verificationEvidenceLedger.runId,
        });
        break;
      case "tool_call_end": {
        const call = this.hookToolCalls.get(event.toolCallId);
        // A reset/restore retires calls owned by the source checkpoint.
        if (!call) break;
        const name = call.name;
        const args = call?.args;
        const safetyRule = parseSafetyBlock(event.result);
        if (safetyRule) this.recordSafetyBlock(safetyRule, name, args, event.details);
        if (call) {
          const command = typeof call.args.command === "string" ? call.args.command : "";
          // A review the bash tool rejected before spawning ran nothing: it is
          // neither a pass nor a failure, so it must not count as a check.
          const rejectedBeforeStart =
            call.name === "bash" &&
            call.args.review === true &&
            event.result === REVIEW_REJECTED_BEFORE_START;
          const verificationCandidate =
            call.name === "bash" &&
            !rejectedBeforeStart &&
            classifyVerificationCommand(command).candidate;
          const workspace =
            verificationCandidate && this.opts.captureVerificationWorkspace
              ? await this.opts.captureVerificationWorkspace().catch(() => undefined)
              : undefined;
          if (this.hookToolCalls.get(event.toolCallId) !== call) break;
          if (!rejectedBeforeStart)
            this.verificationEvidenceLedger.recordToolResult({
              ...call,
              isError: event.isError,
              details: event.details,
              workspace,
              planMode: this.getPlanMode(),
            });
          // Upstream saves completion-review state whenever verification state
          // changes; the evidence ledger replaced that save point here.
          if (verificationCandidate) await this.persistCompletionReviewState();
        }
        this.hookStats.toolCalls += 1;
        if (event.isError) this.hookStats.toolFailures += 1;
        this.hookConsecutiveFailures = event.isError ? this.hookConsecutiveFailures + 1 : 0;
        this.hookRepeatedNoProgressCalls = this.hookProgressTracker.record(
          name,
          args,
          event.result,
          event.isError,
        );
        this.hookCyclicPattern = this.hookCycleDetector.record(
          name,
          args,
          event.result,
          event.isError,
        );
        // Semantic-loop judge input: a bounded digest of WHAT was attempted and
        // HOW it came out. Args/results are sliced AT RECORD TIME — a write with
        // a 50 KiB payload or a bash dump must never inflate the ring, and the
        // judge needs shapes, not payloads.
        this.hookRecentCalls.push({
          tool: name,
          args: args === undefined ? "" : JSON.stringify(args).slice(0, 300),
          ok: !event.isError,
          result: event.result.slice(0, 400),
        });
        if (this.hookRecentCalls.length > MAX_SEMANTIC_LOOP_CALLS) {
          this.hookRecentCalls.splice(0, this.hookRecentCalls.length - MAX_SEMANTIC_LOOP_CALLS);
        }
        if (this.hookToolCalls.get(event.toolCallId) !== call) break;
        this.hookToolCalls.delete(event.toolCallId);
        // Tool results are what push the run over the review gate, and they all
        // land before the model writes its candidate final answer — so this is
        // the point where arming still beats the draft's first token.
        this.refreshHookArming();
        break;
      }
      case "turn_end":
        this.hookStats.turns = event.turn;
        this.refreshHookArming();
        for (let index = this.messages.length - 1; index >= 0; index--) {
          const anchor = this.messages[index];
          if (anchor?.role === "assistant") {
            this.providerContext = { usage: { ...event.usage }, anchor };
            break;
          }
        }
        await this.persistTurnMetric(event);
        // The assistant message for this turn is now in the array.
        await this.flushPendingMessages();
        break;
      case "checkpoint":
        // Tool results for this step are in the array and their side effects
        // already hit the filesystem. Flushing here is what makes a crash lose
        // at most the in-flight step instead of the entire turn.
        await this.creditBashReads();
        await this.flushPendingMessages();
        await this.publishAdvisoryPresentation();
        break;
    }
  }

  private async publishAdvisoryPresentation(): Promise<void> {
    const pending = this.pendingAdvisoryPresentation;
    this.pendingAdvisoryPresentation = undefined;
    if (
      !pending ||
      this.advisoryTurn !== pending.turn ||
      !pending.turn.active ||
      pending.signal.aborted
    )
      return;
    // Tool results must precede this assistant message in provider/history order.
    // Consume before awaiting so later checkpoints cannot publish it twice.
    const messages = this.activeLoopMessages ?? this.messages;
    const message: Message = { role: "assistant", content: pending.text };
    messages.push(message);
    const target = messages.length;
    while (this.lastPersistedIndex < target) {
      await this.persistMessage(messages[this.lastPersistedIndex], true);
      this.lastPersistedIndex++;
    }
    if (this.advisoryTurn !== pending.turn || !pending.turn.active || pending.signal.aborted)
      return;
    this.eventBus.emit("text_delta", { text: pending.text, standalone: true });
  }

  /**
   * Count full-file `cat` output from the step that just finished as reads, so
   * an edit after `cat` does not cost a second read. Uses the step's results as
   * stored in the transcript (after per-turn trimming): only bytes the model
   * actually received count.
   */
  private async creditBashReads(): Promise<void> {
    if (!this.recordBashReads) return;
    const messages = this.activeLoopMessages ?? this.messages;
    const toolMessage = messages.at(-1);
    const assistant = messages.at(-2);
    if (toolMessage?.role !== "tool" || assistant?.role !== "assistant") return;
    if (typeof assistant.content === "string") return;
    const calls = assistant.content.filter((part): part is ToolCall => part.type === "tool_call");
    try {
      await this.recordBashReads(calls, toolMessage.content);
    } catch (err) {
      log("WARN", "agent-session", "Crediting bash reads failed", { error: String(err) });
    }
  }

  /**
   * Append every message added since the last flush to the session file.
   *
   * Safe to call mid-run: `agentLoop` mutates its message array in place, so
   * the slice from `lastPersistedIndex` is always exactly the new tail.
   * Transient sessions (subagent spawns) have no session file and
   * `persistMessage` no-ops for them.
   *
   * Persistence failures must never take down a live run — the post-loop flush
   * retries the same range.
   */
  private async flushPendingMessages(): Promise<void> {
    const messages = this.activeLoopMessages ?? this.messages;
    if (this.lastPersistedIndex >= messages.length) return;
    const target = messages.length;
    try {
      for (let i = this.lastPersistedIndex; i < target; i++) {
        await this.persistMessage(messages[i]);
        this.lastPersistedIndex = i + 1;
      }
    } catch (err) {
      log("WARN", "session", "Failed to flush messages at a step boundary", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Mid-loop steering hook: delivers pushed notifications and queued user
   * steering, fires the loop-breaker when the agent looks stuck, then
   * post-compaction re-grounding. At most one loop-break/re-grounding per run.
   * Mirrors the TUI's getSteeringMessages ordering.
   */
  private drainQueuedDiagnostics(): string | undefined {
    const evidence = this.verificationEvidenceLedger.snapshot().currentEvidence;
    // Suppress silence notices only after current, successful command evidence.
    // Real diagnostics remain visible; failed/stale/skipped checks never qualify.
    // Unavailable results are held for the completion boundary, which drops them.
    const verified = evidence.length > 0 && evidence.every((entry) => entry.status === "passed");
    return this.lspManager?.drainDiagnostics(!verified, { deferUnverified: true });
  }

  private getHookSteeringMessages(): Message[] | null {
    // Environment drift: settings can move the network allowlist mid-session,
    // and `/add-dir` can widen the workspace, with no prompt rebuild — leaving
    // the cached Environment section describing facts that are no longer real.
    // Correcting it by appending is ~30 tokens; re-rendering the prompt would
    // invalidate every cached byte from that section onward. Unconditional and
    // cheap: identical facts produce no message at all.
    //
    // This runs for a verbatim custom prompt TOO. Those sessions (Ken's) never
    // rebuild their prompt, so this note is the only channel that can tell them
    // a root was added — skipping it meant Ken could write into a folder it had
    // never been told about. The note states the facts outright rather than
    // referring to a section such a prompt does not have.
    const environmentDelta = buildEnvDeltaMessage(
      this.renderedEnvironment,
      this.promptEnvironment(),
    );
    if (environmentDelta) {
      // The model has now been told; only a further change re-triggers this.
      this.renderedEnvironment = this.promptEnvironment();
      log("INFO", "session", "Injecting an environment update the prompt is too stale to show");
    }

    // Push notifications: a child that finished or a background build that
    // exited is new *fact*, not a correction, and it is cheap (bounded to 1 KiB
    // per drain). Drained above the loop-break checks so the agent can act on
    // it in the very next turn instead of discovering it at the pre-stop
    // completion gate — but it never displaces user steering, which rides out
    // in the same batch when both are pending.
    const diagnosticText = this.drainQueuedDiagnostics();
    if (diagnosticText) this.eventBus.emit("diagnostics", { text: diagnosticText });
    this.refreshHookArming();
    const notified = this.notifications.drain();
    const notificationMessage: Message | null =
      notified.length > 0 || diagnosticText
        ? {
            role: "user",
            content: buildNotificationSteeringText([
              ...notified.map((entry) => entry.text),
              ...(diagnosticText ? [diagnosticText] : []),
            ]),
            provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
          }
        : null;
    if (notificationMessage) {
      log("INFO", "notifications", "Injecting pushed notifications", {
        count: String(notified.length),
        chars: String(notificationMessage.content.length),
      });
    }

    // User steering wins: drain any messages queued during this run first so the
    // agent sees them mid-loop instead of after it stops.
    if (this.userQueue.some((m) => !m.deferred)) {
      const queued = this.userQueue.filter((m) => !m.deferred);
      this.userQueue = this.userQueue.filter((m) => m.deferred);
      // The agent has now consumed these. Announce the new depth immediately so
      // clients can drop the "queued" affordance at the turn boundary rather
      // than holding it until the whole run ends — the message is already in
      // the loop, and showing it as still-pending for minutes is a lie.
      this.eventBus.emit("queue_drained", { count: this.userQueue.length });
      // Frame each queued item as concurrent steering — without this wrapper
      // the model treats a mid-run message as a fresh request that supersedes
      // the original task and silently drops it. ONE message per queued item
      // (not merged): each persists as its own user message, so a resumed
      // session shows the same number of bubbles the live run did.
      const steeringMessages = queued.map((m): Message => {
        const provenance: MessageProvenance = {
          source: "human",
          kind: "steering",
          visibility: "transcript",
        };
        if (m.attachments.length === 0) {
          const message: Message = {
            role: "user",
            content: wrapSteeringText(m.modelText ?? m.text),
            provenance,
          };
          // An expanded command records its typed `/name` so a reopened session
          // shows the chip instead of the template body, as idle sends do.
          const hint: PromptHint | undefined =
            m.modelText !== undefined ? { ...m.meta, command: m.text.trim() } : m.meta;
          if (hint) this.promptHints.set(message, hint);
          return message;
        }
        // Queued attachments ride the same native-block path as a non-queued
        // attachment prompt, prefixed with the steering framing.
        const parts: Array<TextContent | ImageContent | VideoContent> = [
          { type: "text", text: STEERING_PREFIX },
          ...this.buildAttachmentParts(m.text, m.attachments),
        ];
        const message: Message = { role: "user", content: parts, provenance };
        if (m.meta) this.promptHints.set(message, m.meta);
        return message;
      });
      return [
        ...(environmentDelta ? [environmentDelta] : []),
        ...steeringMessages,
        ...(notificationMessage ? [notificationMessage] : []),
      ];
    }
    if (environmentDelta || notificationMessage) {
      return [
        ...(environmentDelta ? [environmentDelta] : []),
        ...(notificationMessage ? [notificationMessage] : []),
      ];
    }
    if (this.opts.selfCorrectionHooks === false) return null;
    // Legacy key: the user-facing switch for loop-break and re-grounding nudges.
    if (!this.settingsManager.get("idealReviewEnabled")) return null;
    // Deterministic stuck verdict, computed once and shared: the semantic
    // judge must not spend tokens on a burst the deterministic breaker is
    // about to correct itself.
    const deterministicDecision = evaluateLoopBreak({
      consecutiveFailures: this.hookConsecutiveFailures,
      repeatedNoProgressCalls: this.hookRepeatedNoProgressCalls,
      textRepetitionDetected: detectTextRepetition(this.hookText),
      ...(this.hookCyclicPattern ? { cyclicPattern: this.hookCyclicPattern } : {}),
    });
    // Advisory assessments and discovery reviews are bounded, read-only turns
    // with their own validation and rejection feedback. Loop-break steering and
    // a hidden judge request would escape their request accounting.
    const boundedReview =
      this.advisoryTurn?.active === true || this.discoveryReview?.active === true;
    this.maybeStartSemanticLoopCheck(deterministicDecision.shouldBreak, boundedReview);
    // Two-stage loop-breaker: stage 1 nudges; a FRESH detection after that
    // injects the harsher final stop-and-report prompt. Signals reset after
    // each injection so stage 2 only fires on new evidence.
    if (this.loopBreakInjected < 2 && !boundedReview) {
      const decision = deterministicDecision;
      if (decision.shouldBreak) {
        const stage = this.loopBreakInjected === 0 ? (1 as const) : (2 as const);
        this.loopBreakInjected = stage;
        this.hookProgressTracker.reset();
        this.hookCycleDetector.reset();
        this.hookCyclicPattern = null;
        this.hookConsecutiveFailures = 0;
        this.hookRepeatedNoProgressCalls = 0;
        // The deterministic breaker owns this burst — a semantic verdict from
        // the same burst must not double-correct on the next poll.
        this.semanticLoop.verdict = null;
        // Clear the text buffer too — otherwise a stage-1 text-repetition
        // trigger still sees the same repeated tail on the next check and
        // escalates to stage 2 on stale evidence.
        this.hookText = "";
        log("INFO", "loop-break", "Injecting loop-break nudge", {
          stage: String(stage),
          reasons: decision.reasons.join(", "),
        });
        this.eventBus.emit("hook", { kind: "loop_break" });
        return [buildLoopBreakMessage(decision.reasons, stage === 2)];
      }
    }
    // Semantic loop-break: an LLM verdict (started by maybeStartSemanticLoopCheck
    // on a suspicious-but-syntactically-quiet burst) is consumed here, exactly
    // once, with the deterministic breaker getting priority above. Fail-open:
    // no verdict or no-loop verdict injects nothing.
    if (!boundedReview && this.semanticLoop.verdict && !this.semanticLoop.injected) {
      const verdict = this.semanticLoop.verdict;
      this.semanticLoop.injected = true;
      this.semanticLoop.verdict = null;
      // The judged burst has been addressed; a fresh burst must re-accumulate.
      this.hookConsecutiveFailures = 0;
      log("INFO", "loop-break", "Injecting semantic loop-break steering", {
        reason: verdict.reason,
      });
      this.eventBus.emit("hook", { kind: "loop_break" });
      return [buildSemanticLoopMessage(verdict)];
    }
    if (!this.regroundingInjected && this.compactionOccurred) {
      this.regroundingInjected = true;
      this.eventBus.emit("hook", { kind: "regrounding" });
      return [buildRegroundingMessage(this.originalRequest)];
    }
    return null;
  }

  /** Fire the semantic loop judge when deterministic evidence is suspicious but
   *  the deterministic breaker stayed quiet — the syntactic blind spot where
   *  every retry differs slightly and the run still makes no progress.
   *  Fire-and-forget: the call runs while the next turn streams, and a finished
   *  verdict is consumed by the NEXT steering poll — never blocking a turn. */
  private maybeStartSemanticLoopCheck(deterministicBreak: boolean, boundedReview: boolean): void {
    if (
      !shouldRunSemanticLoopCheck({
        boundedReview,
        consecutiveFailures: this.hookConsecutiveFailures,
        totalFailures: this.hookStats.toolFailures,
        turns: this.hookStats.turns,
        lastCheckTurn: this.semanticLoop.lastCheckTurn,
        checksUsed: this.semanticLoop.checksUsed,
        checkPending: this.semanticLoop.pending,
        deterministicBreak,
      })
    ) {
      return;
    }
    // resetHookState replaces this object on every prompt. A late judge must
    // not publish a verdict or consume the next run's budget/cooldown.
    const runState = this.semanticLoop;
    runState.pending = true;
    const controller = new AbortController();
    runState.controller = controller;
    log("INFO", "loop-break", "Starting semantic loop judge", {
      turn: String(this.hookStats.turns),
      consecutiveFailures: String(this.hookConsecutiveFailures),
      recentCalls: String(this.hookRecentCalls.length),
    });
    void (async () => {
      try {
        const prompt = buildSemanticLoopJudgePrompt(this.hookRecentCalls, this.originalRequest);
        const raw = await withJudgeTimeout(
          (signal) =>
            this.opts.semanticLoopJudge?.(prompt, signal) ??
            this.callSemanticLoopJudge(prompt, signal),
          controller,
          this.opts.signal,
        );
        const verdict = parseSemanticLoopVerdict(raw);
        if (this.semanticLoop === runState && !controller.signal.aborted && verdict?.loop) {
          runState.verdict = verdict;
        }
      } catch (error) {
        // Fail open: judge errors never stop a run. Budget and cooldown are
        // still consumed in `finally` so a flaky judge cannot retry-loop.
        log("WARN", "loop-break", "Semantic loop judge failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (this.semanticLoop === runState) {
          runState.pending = false;
          runState.controller = undefined;
          runState.checksUsed += 1;
          runState.lastCheckTurn = this.hookStats.turns;
        }
      }
    })();
  }

  /** Fresh image-only critique context, using the active transport and auth routing. */
  private async callCompletionReviewer(
    request: CompletionReviewRequest,
    signal: AbortSignal,
  ): Promise<CompletionReviewResponse> {
    const model = this.model;
    const provider = this.provider;
    const thinking = this.thinkingLevel;
    const configuredBaseUrl = this.baseUrl;
    if (getModel(model)?.supportsImages !== true)
      throw new Error("Active model has no confirmed image support");
    signal.throwIfAborted();
    try {
      const creds = await this.authStorage.resolveCredentials(provider, {
        storageKeys: this.currentAuthStorageKeys(),
      });
      const baseUrl = configuredBaseUrl ?? creds.baseUrl;
      const result = stream({
        provider,
        model,
        messages: [
          { role: "system", content: request.instruction },
          { role: "user", content: [{ type: "text", text: request.context }, ...request.images] },
        ],
        maxTokens: 4000,
        thinking,
        apiKey: creds.accessToken,
        accountId: creds.accountId,
        projectId: creds.projectId,
        baseUrl,
        signal,
        transportSessionId: this.sessionId || this.transportSessionId,
        defaultHeaders:
          provider === "moonshot" && isKimiCodingEndpoint(baseUrl)
            ? kimiCodingHeaders()
            : undefined,
        userAgent: provider === "anthropic" ? await getClaudeCliUserAgent() : undefined,
        supportsImages: true,
      });
      const response = await result.response;
      const content = response.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      if (text.length > 32_768) throw new Error("Review response exceeded its limit");
      return { text, model, provider, thinking };
    } catch {
      // Provider errors may contain transport details; never copy them to tools/artifacts.
      signal.throwIfAborted();
      throw new Error("Active model review unavailable or invalid; no verdict recorded");
    }
  }

  /** One-shot judge call on the session's ACTIVE model — deliberately not a
   *  cheaper routing: judging a model's own failure patterns with a weaker
   *  model swaps false negatives for false positives. */
  private async callSemanticLoopJudge(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const creds = await this.resolveRunCredentials(this.provider, {
      storageKeys: this.currentAuthStorageKeys(),
    });
    signal.throwIfAborted();
    const result = stream({
      provider: this.provider,
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 500,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      projectId: creds.projectId,
      baseUrl: this.baseUrl ?? creds.baseUrl,
      signal,
    });
    const response = await result.response;
    // Providers differ in reply shape: some return a bare string, others an
    // array of parts (glm-5.3 among them) — joining text parts covers both,
    // where the string-only branch silently dropped the whole verdict.
    const content = response.message.content;
    if (typeof content === "string") return content;
    return Array.isArray(content)
      ? content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : "";
  }

  /**
   * Turn-budget extension gate. The loop consults this instead of stopping
   * mid-task when it exhausts `maxTurns`. Grant ONLY on evidence of progress —
   * handing more turns to a spinning agent just buys it more tokens to spin
   * with — so reuse the same stuck signals that drive the loop-breaker.
   */
  private shouldExtendTurnBudget(ctx: {
    turn: number;
    maxTurns: number;
    extension: number;
  }): boolean {
    const refusals: string[] = [];

    const stuck = evaluateLoopBreak({
      consecutiveFailures: this.hookConsecutiveFailures,
      repeatedNoProgressCalls: this.hookRepeatedNoProgressCalls,
      textRepetitionDetected: detectTextRepetition(this.hookText),
      ...(this.hookCyclicPattern ? { cyclicPattern: this.hookCyclicPattern } : {}),
    });
    if (stuck.shouldBreak) refusals.push(...stuck.reasons);

    // Stage 2 means the loop-breaker already detected spinning twice and told
    // the agent to stop and report. Do not overrule that with more turns.
    if (this.loopBreakInjected >= 2) refusals.push("loop-breaker already escalated");

    const { toolCalls, toolFailures } = this.hookStats;
    if (toolCalls > 0 && toolFailures / toolCalls > TURN_EXTENSION_MAX_FAILURE_RATIO) {
      refusals.push(`${toolFailures}/${toolCalls} tool calls failed`);
    }

    const granted = refusals.length === 0;
    log(
      "INFO",
      "turn-budget",
      granted ? "Extending turn budget" : "Refusing turn-budget extension",
      {
        turn: String(ctx.turn),
        maxTurns: String(ctx.maxTurns),
        extension: String(ctx.extension),
        ...(granted ? {} : { reasons: refusals.join(", ") }),
      },
    );
    return granted;
  }

  /** Would a stop right now inject a pre-final follow-up that replaces the
   *  candidate answer? Only a mode-owned completion review does, so clients hold
   *  the candidate answer only then. Queued LSP diagnostics are delivered to the
   *  model as passive observations: the Local Fork has no automatic verification
   *  gate, so they never arm a hold. */
  private wouldInjectBeforeFinal(): boolean {
    return this.opts.completionReview?.armed ?? false;
  }

  /** Broadcast pre-final hook arming on change. Both edges matter: armed=false
   *  after the hook fires is what lets a client stream the final answer live
   *  again. Callable before `initialize()`. The kind matches the completion
   *  review's `hook` event (`ideal`); `verification` is never armed. */
  private refreshHookArming(): void {
    const armed = this.wouldInjectBeforeFinal();
    if (armed === this.preFinalArmed) return;
    this.preFinalArmed = armed;
    this.eventBus.emit("hook_armed", { kind: "ideal", armed });
  }

  /**
   * Pre-stop follow-ups: LSP errors, unread child agents and background
   * processes, and a mode-owned completion review. Verification evidence is
   * tracked passively for run status; it never forces another turn.
   */
  private async getHookFollowUpMessages(): Promise<Message[] | null> {
    // Exit notifications and task_output refer to the same host process record.
    // Do not force an extra polling tool/turn merely to acknowledge a known exit.

    // Edits return immediately; only the completion boundary waits for remaining
    // checks. Only real errors cost another turn: a timed-out or unavailable
    // server proves nothing either way, and run status already reports
    // unverified changes without making the model answer twice.
    await this.lspManager?.flushDiagnostics(this.opts.signal);
    if (this.opts.signal?.aborted) return null;
    const diagnosticText = this.lspManager?.drainDiagnostics(false);
    if (diagnosticText) this.eventBus.emit("diagnostics", { text: diagnosticText });
    this.refreshHookArming();
    const diagnosticMessages: Message[] = diagnosticText
      ? [
          {
            role: "user",
            content: buildNotificationSteeringText([diagnosticText]),
            provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
          },
        ]
      : [];
    const childCompletionFollowUp = buildSubAgentCompletionFollowUp(this.subAgentManager);
    if (childCompletionFollowUp) return [...diagnosticMessages, ...childCompletionFollowUp];

    // Background processes started this run and never read block completion:
    // their progress/exit checkpoints only land on the steering path, which an
    // agent about to stop never reaches.
    const processFollowUp = buildProcessCompletionFollowUp(
      this.processManager?.list() ?? [],
      this.runStartedAt,
      this.processGateInjected,
    );
    if (processFollowUp) {
      this.processGateInjected += 1;
      log("INFO", "process-gate", "Injecting background-process completion gate", {
        injected: String(this.processGateInjected),
      });
      return [...diagnosticMessages, ...processFollowUp];
    }

    if (diagnosticMessages.length > 0) return diagnosticMessages;

    await this.rerunRefusedCheck();

    if (
      shouldNudgePlanSubmission({
        enabled: this.opts.planSubmissionGate === true,
        planMode: this.planModeRef.current,
        aborted: this.opts.signal?.aborted === true,
        nudgesThisRun: this.planSubmissionNudges,
      })
    ) {
      this.planSubmissionNudges += 1;
      log("INFO", "plan-gate", "Run stopping in plan mode without a submitted plan; reminding");
      return [
        {
          role: "user",
          content: buildNotificationSteeringText([PLAN_SUBMISSION_NUDGE]),
          provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
        },
      ];
    }

    if (this.opts.completionReview) {
      const followUp = await this.opts.completionReview.followUp(
        (request, signal) => this.callCompletionReviewer(request, signal),
        this.opts.signal,
      );
      await this.persistCompletionReviewState();
      if (followUp) {
        this.eventBus.emit("hook", { kind: "ideal" });
        this.refreshHookArming();
        return [
          {
            role: "user",
            content: followUp,
            provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
          },
        ];
      }
      this.refreshHookArming();
    }
    return null;
  }

  /**
   * The model often runs its tests inside a longer command (`npm test 2>&1 |
   * tail; node -e '…'`) whose exit status belongs to a later part, so the
   * tests can pass without counting. When the turn would end unverified that
   * way, run that check once more on its own, through the same bash tool, and
   * record its real exit status. No model turn and nothing in the transcript:
   * only the run's verification status changes.
   */
  private async rerunRefusedCheck(): Promise<void> {
    if (this.planModeRef.current || this.opts.signal?.aborted) return;
    const check = this.verificationEvidenceLedger.takeRefusedCheck();
    if (!check) return;
    const bash = this.tools.find((tool) => tool.name === "bash");
    // An explicit timeout stops a stuck run instead of moving it to the
    // background, which would leave a process for the next turn to collect.
    const args = { command: check.command, timeout: 120_000 };
    const params = bash?.parameters.safeParse(args);
    if (!bash || !params?.success) return;
    const startedAt = Date.now();
    let passed = false;
    let details: unknown;
    try {
      const result = await bash.execute(params.data, {
        signal: this.opts.signal ?? new AbortController().signal,
        toolCallId: `gg-recheck-${startedAt}`,
      });
      details = typeof result === "string" ? undefined : result.details;
      const diagnostics = (
        details as { bashDiagnostics?: { reason?: unknown; exitCode?: unknown } } | undefined
      )?.bashDiagnostics;
      passed = diagnostics?.reason === "completed" && diagnostics.exitCode === 0;
    } catch (error) {
      if (isAbortError(error) || this.opts.signal?.aborted) return;
      log("WARN", "verification", `Re-running a refused check failed: ${String(error)}`);
    }
    if (this.opts.signal?.aborted) return;
    log("INFO", "verification", "Re-ran a check whose original exit status could not count", {
      passed: String(passed),
      durationMs: String(Date.now() - startedAt),
    });
    // A pass counts like the model's own standalone check at that revision. A
    // failure only stays unverified: the re-run lacks the original command's
    // context (variables, files it wrote first), so it proves nothing failed.
    if (!passed) return;
    const workspace = this.opts.captureVerificationWorkspace
      ? await this.opts.captureVerificationWorkspace().catch(() => undefined)
      : undefined;
    this.verificationEvidenceLedger.recordToolResult({
      name: "bash",
      args,
      isError: false,
      details,
      workspace,
      evidenceRevision: check.generation,
      evidenceRun: check.run,
      planMode: this.getPlanMode(),
    });
    await this.persistCompletionReviewState();
  }

  /** Wraps the real run: cancels an in-flight cache prewarm and tracks run
   *  activity / last real request time for {@link prewarm}. */
  private async runLoop(options: PromptRunOptions = {}): Promise<void> {
    this.prewarmController?.abort();
    this.runLoopDepth++;
    if (this.runLoopDepth === 1) this.notifyRunActive(true);
    try {
      await this.runLoopInner(options);
    } finally {
      this.runLoopDepth--;
      this.lastRealRequestAt = Date.now();
      if (this.runLoopDepth === 0) this.notifyRunActive(false);
    }
  }

  /** `opts.onRunActive`, never allowed to throw into the run. */
  private notifyRunActive(active: boolean): void {
    try {
      this.opts.onRunActive?.(active);
    } catch (err) {
      log("WARN", "session", "onRunActive listener threw", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Auto-compact if needed, run agent loop with auth retry, and persist messages. */
  private async runLoopInner(options: PromptRunOptions = {}): Promise<void> {
    return this.opts.unattended
      ? runUnattended(() => this.runLoopInternal(options))
      : this.runLoopInternal(options);
  }

  private async runLoopInternal(options: PromptRunOptions): Promise<void> {
    assertProviderExecutionAllowed(this.provider, this.opts.unattended);
    await this.prepareSystemPromptForRequest();
    // One-shot cache-key marker per session so turn_end cacheRead numbers
    // in the log can be traced back to a specific routing namespace —
    // particularly useful when sub-agents inherit `parentKey:subagent`.
    if (!this.cacheKeyLogged) {
      this.cacheKeyLogged = true;
      log("INFO", "cache", "Session cache key", {
        provider: this.provider,
        model: this.model,
        key: this.getPromptCacheKey() ?? "(none)",
        transient: String(!!this.opts.transient),
      });
    }

    // Reset self-correction hook state for this run; pin the latest user message
    // as the verbatim original request for post-compaction re-grounding.
    // A status update that started an idle-wake run is not the user's request.
    const lastUser = [...this.messages]
      .reverse()
      .find((m) => m.role === "user" && m.provenance?.kind !== "notification");
    this.resetHookState(requestTextForRegrounding(lastUser));

    // Resolve OAuth credentials and run agent loop.
    // On 401, force-refresh the token and retry once — the provider may have
    // revoked the token server-side before the stored expiry (e.g. after a restart).
    let creds = await this.resolveRunCredentials(this.provider, {
      storageKeys: this.currentAuthStorageKeys(),
    });
    // Cache for sync callers (see field doc) — kept in step with `creds`
    // through the 401 force-refresh retry below.
    this.lastAccountId = creds.accountId;
    // The access token most recently handed to the provider. Tracked separately
    // from `creds` because the per-turn resolver can rotate it mid-run, and the
    // 401 handler must name the token that was actually rejected.
    let lastResolvedAccessToken = creds.accessToken;

    // Auto-compact if needed. This must happen after credential resolution so
    // OpenAI OAuth/Codex sessions use the Codex product context window instead
    // of the public API model window. Failed/no-op attempts cool down across
    // prompts; provider overflow recovery still bypasses this path entirely.
    if (this.settingsManager.get("autoCompact") && Date.now() >= this.compactionRetryAfter) {
      // A post-turn compaction may still be running in the background. Let it
      // settle first: it usually already compacted this history, so the
      // decision below turns into a no-op instead of duplicate work.
      if (this.postTurnCompaction) await this.postTurnCompaction;
      const contextWindow = getContextWindow(this.model, {
        provider: this.provider,
        accountId: creds.accountId,
        openAICodexContextProfile: this.openAICodexContextProfile,
      });
      const policy = resolveCompactionPolicy({
        provider: this.provider,
        model: this.model,
        contextWindow,
        threshold: this.settingsManager.get("compactThreshold"),
        accountId: creds.accountId,
        approvedPlanPath: this.approvedPlanPath,
      });
      let activeTokens: number | undefined;
      if (this.providerContext) {
        const anchorIndex = this.messages.lastIndexOf(this.providerContext.anchor);
        if (anchorIndex >= 0) {
          activeTokens = calculateActiveContextTokens(this.messages, {
            usage: this.providerContext.usage,
            pendingMessages: this.messages.slice(anchorIndex + 1),
          });
        } else {
          this.providerContext = null;
        }
      }
      log("INFO", "compaction", "Pre-run compaction decision", {
        provider: this.provider,
        model: this.model,
        transport: this.provider === "openai" && creds.accountId ? "codex_oauth" : "public_api",
        contextWindow: String(contextWindow),
        activeTokens: activeTokens === undefined ? "estimated" : String(activeTokens),
        triggerLimit: String(policy.targetTokens),
      });
      if (
        shouldCompact(
          this.messages,
          contextWindow,
          policy.threshold,
          activeTokens,
          policy.targetTokens,
        )
      ) {
        try {
          await this.compact(creds, "automatic");
          if (this.lastCompactionCompacted) {
            // Re-grounding hook keys off this — the context was just summarized.
            this.compactionOccurred = true;
            this.compactionRetryAfter = 0;
          } else {
            this.compactionRetryAfter = Date.now() + 30_000;
          }
        } catch (error) {
          if (error instanceof RequiredSessionPersistenceError) throw error;
          this.compactionRetryAfter = Date.now() + 30_000;
          if (isAbortError(error) || this.opts.signal?.aborted) throw error;
          log(
            "WARN",
            "compaction",
            `Pre-run compaction failed; cooling down for 30s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    // Reassignable: Anthropic can reject the spoofed claude-cli version as too
    // old for a newly released model, and the retry below rebuilds it.
    let userAgent = this.provider === "anthropic" ? await getClaudeCliUserAgent() : undefined;

    const loopMessages = await this.prepareDynamicContext();
    // Re-read every run so rule-file edits apply on the next turn; a few small files.
    const streamRules = await loadStreamRules(this.cwd);

    const runAgentLoop = async (apiKey: string, accountId?: string, projectId?: string) => {
      lastResolvedAccessToken = apiKey;
      const modelInfo = getModel(this.model);
      const effectiveBaseUrl = this.baseUrl ?? creds.baseUrl;
      const generator = agentLoop(loopMessages, {
        ...(streamRules.length > 0 ? { streamRules: { rules: streamRules } } : {}),
        provider: this.provider,
        model: resolveTransportModel(this.provider, this.model),
        tools: options.disableTools ? [] : this.tools,
        webSearch: options.disableTools ? false : () => this.nativeWebSearchOn(),
        maxTokens: this.requestMaxTokens(accountId),
        maxTurns: this.opts.maxTurns,
        maxTurnExtensions: this.opts.maxTurnExtensions,
        // Plan mode caps effort at medium (Codex `plan_mode_reasoning_effort`
        // preset): read-only exploration doesn't need xhigh/max reasoning, and
        // deep-reasoning models left at the ceiling burn enormous thinking
        // budgets re-deriving context they cannot act on. A capped prompt
        // (a sub-agent's timed answer) gets the same ceiling for the same reason.
        thinking:
          this.planModeRef.current || options.capThinking
            ? clampThinkingForPlanMode(this.thinkingLevel)
            : this.thinkingLevel,
        apiKey,
        // Per-turn credential resolution. A run can span many minutes; if any
        // process sharing auth.json refreshes this grant meanwhile, the token
        // captured above is invalidated server-side and every remaining turn
        // would fail with an authentication error until the user restarted.
        // Static API keys resolve to the same value, so this is a no-op for them.
        resolveCredentials: async () => {
          const live = await this.resolveRunCredentials(this.provider, {
            storageKeys: this.currentAuthStorageKeys(),
          });
          this.lastAccountId = live.accountId;
          lastResolvedAccessToken = live.accessToken;
          return {
            apiKey: live.accessToken,
            accountId: live.accountId,
            ...(live.projectId !== undefined ? { projectId: live.projectId } : {}),
          };
        },
        baseUrl: effectiveBaseUrl,
        signal: this.opts.signal,
        accountId,
        transportSessionId: this.sessionId || this.transportSessionId,
        projectId,
        // Kimi For Coding gates the managed endpoint on coding-agent identity
        // headers; attach them only when the Kimi OAuth token is in use.
        defaultHeaders:
          this.provider === "moonshot" && isKimiCodingEndpoint(effectiveBaseUrl)
            ? kimiCodingHeaders()
            : undefined,
        // speedProfile "optimized": 1-h cache TTL (survives turns >5 min apart)
        // + pre-warm before the first turn. "baseline": current 5-min default.
        cacheRetention: this.isSpeedOptimized() ? "long" : "short",
        promptCacheKey: this.getPromptCacheKey(),
        responsesLite: resolveResponsesLite(
          this.codexShapeSetting("codexResponsesLite"),
          this.provider,
          this.model,
        ),
        strictTools: resolveStrictTools(this.codexShapeSetting("codexStrictTools"), this.provider),
        onContextPrepared: (context) => {
          const report = this.cacheDiagnostics.prepare(context, {
            provider: this.provider,
            model: this.model,
            at: Date.now(),
            cacheRetention: this.isSpeedOptimized() ? "long" : "short",
            route: { baseUrl: effectiveBaseUrl, accountId: this.lastAccountId ?? accountId },
            settings: {
              thinking:
                this.planModeRef.current || options.capThinking
                  ? clampThinkingForPlanMode(this.thinkingLevel)
                  : this.thinkingLevel,
              webSearch: !options.disableTools && this.nativeWebSearchOn(),
              supportsImages: modelInfo?.supportsImages,
              promptCacheKey: this.getPromptCacheKey(),
            },
          });
          log("INFO", "cache", "Prepared context", {
            sessionId: this.sessionId || this.transportSessionId,
            data: JSON.stringify(report),
          });
          if (report.thinkingPrefixRiskBlocks > 0) {
            log("WARN", "cache", "Possible signed-thinking prefix mismatch; not server verified", {
              sessionId: this.sessionId || this.transportSessionId,
              blocks: String(report.thinkingPrefixRiskBlocks),
            });
          }
        },
        supportsImages: modelInfo?.supportsImages,
        supportsVideo: modelInfo?.supportsVideo,
        userAgent,
        // Codex caps each tool output at 10K tokens. Other transports retain the
        // generic 30%-of-context allowance used before this provider policy.
        maxToolResultChars: resolveSessionToolResultCharLimit(
          this.model,
          this.provider,
          accountId,
          this.openAICodexContextProfile,
        ),
        // Aggregate per-turn budget across parallel tool results (fan-out guard).
        maxTurnToolResultChars: resolveSessionTurnToolResultCharLimit(
          this.model,
          this.provider,
          accountId,
          this.openAICodexContextProfile,
        ),
        // Warn when web/MCP output contains instruction-like text (see injection-detect.ts).
        transformToolResult: flagUntrustedToolResult,
        // A deferred built-in called by its advertised name runs directly
        // instead of costing a turn on "Unknown tool" then tool_search.
        ...(options.disableTools
          ? {}
          : { resolveTool: (name: string) => this.promoteDeferredBuiltin(name) }),
        // Self-correction hooks (same as the TUI): loop-break + re-grounding are
        // polled mid-loop; the ideal review is polled when the agent would stop.
        getSteeringMessages: () => this.getHookSteeringMessages(),
        onSteeringAvailable: (listener) => {
          this.steeringListeners.add(listener);
          return () => this.steeringListeners.delete(listener);
        },
        getFollowUpMessages: () => this.getHookFollowUpMessages(),
        onTurnBudgetExhausted: (ctx) => this.shouldExtendTurnBudget(ctx),
        // Check authoritative provider usage before every model/tool step.
        // Forced overflow recovery bypasses settings and cooldown; proactive
        // checks honor both and estimate only messages unseen by the provider.
        transformContext: async (messages, transformOpts) => {
          if (transformOpts.usage) {
            const anchorIndex = messages.length - transformOpts.pendingMessages.length - 1;
            const anchor = messages[anchorIndex];
            if (anchor?.role === "assistant") {
              this.providerContext = { usage: { ...transformOpts.usage }, anchor };
              // Feed the authoritative usage back into the token estimator so
              // char-based estimates track this session's real tokenizer. The
              // provider's count includes the tool definitions sent with the
              // request, so their characters must be counted too — without
              // them a short history reads as ~2 chars/token and drags the
              // shared ratio down for every session in the process.
              calibrateEstimatorFromUsage(
                messages.slice(0, anchorIndex),
                transformOpts.usage,
                options.disableTools ? 0 : this.toolDefinitionChars(),
              );
            }
          }

          const force = transformOpts.force === true;
          if (!force) {
            if (!this.settingsManager.get("autoCompact")) return messages;

            const contextWindow = getContextWindow(this.model, {
              provider: this.provider,
              accountId,
              openAICodexContextProfile: this.openAICodexContextProfile,
            });
            const policy = resolveCompactionPolicy({
              provider: this.provider,
              model: this.model,
              contextWindow,
              threshold: this.settingsManager.get("compactThreshold"),
              accountId,
              approvedPlanPath: this.approvedPlanPath,
            });
            // Provider usage when there is some, else an estimate of the history.
            const measureActiveTokens = (): number => {
              let usage = transformOpts.usage;
              let pendingMessages = transformOpts.pendingMessages;
              if (!usage && this.providerContext) {
                const anchorIndex = messages.lastIndexOf(this.providerContext.anchor);
                if (anchorIndex >= 0) {
                  usage = this.providerContext.usage;
                  pendingMessages = messages.slice(anchorIndex + 1);
                } else {
                  this.providerContext = null;
                }
              }
              return calculateActiveContextTokens(messages, { usage, pendingMessages });
            };
            let activeTokens = measureActiveTokens();

            // Cheap stale-tool-output pruning before the expensive LLM
            // compaction check, once the context is big enough for the freed
            // tokens to be worth a cache rewrite. In-place mutation preserves
            // anchors; drop the retained usage afterwards since it counted the
            // pruned content.
            if (shouldPruneToolResults(activeTokens, policy.targetTokens)) {
              const pruneResult = pruneStaleToolResults(messages);
              if (pruneResult.pruned) {
                this.cacheDiagnostics.noteEdit("tool_prune", pruneResult.freedTokens);
                this.providerContext = null;
                log("INFO", "compaction", "Pruned stale tool outputs", {
                  prunedResults: String(pruneResult.prunedResults),
                  compactedToolCalls: String(pruneResult.compactedToolCalls),
                  freedTokens: String(pruneResult.freedTokens),
                });
                // The measured size counted the pruned content, so take the
                // freed tokens off it. Never swap the provider's count for a
                // whole-history estimate here: that estimate rides a shared
                // chars-per-token ratio, and it once read a 234K-token MiMo
                // context (23% of 1M) as ~400K and compacted it against a 340K
                // trigger.
                activeTokens = Math.max(0, activeTokens - pruneResult.freedTokens);
              }
            }

            if (Date.now() < this.compactionRetryAfter) return messages;
            // An approved plan runs as ONE run, so step boundaries are only
            // visible here, between model steps — not after the run ends.
            const planStep = this.observePlanStepProgress(messages, contextWindow, activeTokens);
            log("INFO", "compaction", "In-flight compaction decision", {
              provider: this.provider,
              model: this.model,
              transport: this.provider === "openai" && accountId ? "codex_oauth" : "public_api",
              contextWindow: String(contextWindow),
              activeTokens: String(activeTokens),
              triggerLimit: String(policy.targetTokens),
              ...(planStep ? { planStep: `${planStep.compact} (${planStep.reason})` } : {}),
            });
            if (
              !shouldCompact(
                messages,
                contextWindow,
                policy.threshold,
                activeTokens,
                policy.targetTokens,
              ) &&
              !planStep?.compact
            )
              return messages;
          }

          // compact() operates on this.messages, while an earlier transform may
          // have replaced the loop's in-flight array. Rebind before every attempt
          // so the current tool results are included in the summary.
          this.messages = messages;
          try {
            await this.compact(
              {
                accessToken: apiKey,
                accountId,
                projectId,
                baseUrl: effectiveBaseUrl,
              },
              force ? "forced" : "automatic",
            );
          } catch (error) {
            this.messages = messages;
            if (error instanceof RequiredSessionPersistenceError) throw error;
            this.compactionRetryAfter = Date.now() + 30_000;
            if (force || isAbortError(error) || this.opts.signal?.aborted) throw error;
            log(
              "WARN",
              "compaction",
              `In-flight compaction failed; cooling down for 30s: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return messages;
          }

          if (!this.lastCompactionCompacted) {
            this.messages = messages;
            this.compactionRetryAfter = Date.now() + 30_000;
            return messages;
          }

          this.compactionRetryAfter = 0;
          this.compactionOccurred = true;
          return this.messages;
        },
      });

      this.activeLoopMessages = loopMessages;
      try {
        for await (const event of generator as AsyncIterable<AgentEvent>) {
          await this.trackHookEvent(event);
          this.forwardAgentEvent(event);
        }
      } finally {
        this.activeLoopMessages = null;
        // An in-flight compaction rebinds `this.messages` to the compacted array
        // while the loop keeps appending to `loopMessages`. Resync on every exit
        // — a failed or aborted run included — or the session silently drops
        // this run's post-compaction messages (they are still on disk) and the
        // next prompt replays a history the provider may reject.
        this.messages = loopMessages;
      }
    };

    const clearInvalidStaticApiKey = async (error: unknown): Promise<boolean> => {
      if (!(error instanceof ProviderError) || error.statusCode !== 401) return false;
      if (!(await this.authStorage.isStaticApiKey(this.provider))) return false;

      // Clear whichever key actually resolved (the request may have used a
      // fallback key, not the model's first preference).
      const badKey =
        (await this.authStorage.pickStorageKey(this.currentAuthStorageKeys())) ??
        this.currentAuthStorageKeys()[0]!;
      log(
        "WARN",
        "auth",
        `Got 401 for ${this.provider} (${badKey}) — API key is invalid or revoked`,
      );
      await this.authStorage.clearCredentials(badKey);
      return true;
    };

    try {
      await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
    } catch (err) {
      // Abort errors are expected (user cancellation) — don't retry or re-throw
      if (isAbortError(err) || this.opts.signal?.aborted) {
        return;
      }
      // A subscription OAuth plan ran out of usage (hard usage-limit stop, or an
      // HTTP 402 billing stop). If the user ALSO configured that provider's API
      // key, mark the OAuth credential usage-exhausted (honoring the
      // provider-stated reset time when present) and retry this turn on the API
      // key — OAuth stays the preferred credential and resumes automatically once
      // the mark lapses. A generic 429 is deliberately excluded: it may be a
      // transient rate limit and must not silently switch the user to a billed
      // API key.
      //
      // Grok adds one case Kimi doesn't have: xAI gates its CLI chat proxy by
      // subscription tier, so an entitled-looking account can be refused outright
      // with a 403. That means "OAuth cannot serve this", not a transient error,
      // so it counts as exhausted too — otherwise a dual-configured user would
      // hard-fail while holding a perfectly good API key.
      //
      // Guarded on the subscription endpoint actually being in use: if the API key
      // was already active, the same error means BOTH are out and must surface.
      const dualAuth = dualAuthProvider(this.provider);
      const onSubscriptionEndpoint =
        (this.provider === "moonshot" && isKimiCodingEndpoint(creds.baseUrl)) ||
        (this.provider === "xai" && isGrokCliEndpoint(creds.baseUrl));
      const tierRefusal =
        this.provider === "xai" && err instanceof ProviderError && err.statusCode === 403;
      const oauthIsOut =
        isUsageLimitError(err) ||
        (err instanceof ProviderError && err.statusCode === 402) ||
        tierRefusal;
      if (
        dualAuth &&
        !this.baseUrl &&
        onSubscriptionEndpoint &&
        oauthIsOut &&
        (await this.authStorage.hasCredentials(dualAuth.provider))
      ) {
        const resetsAt = err instanceof ProviderError ? err.resetsAt : undefined;
        await this.authStorage.markUsageExhausted(dualAuth.oauthKey, resetsAt);
        log(
          "WARN",
          "auth",
          `${dualAuth.oauthLabel} usage limit reached — retrying this turn on the ${dualAuth.apiKeyLabel}`,
          { resetsAt: resetsAt !== undefined ? String(resetsAt) : "unknown" },
        );
        creds = await this.resolveRunCredentials(this.provider, {
          storageKeys: this.currentAuthStorageKeys(),
        });
        this.lastAccountId = creds.accountId;
        // The runAgentLoop closure re-reads `creds`, so the retry picks up the
        // API key's public baseUrl (api.moonshot.ai / api.x.ai) and drops the
        // subscription endpoint's client-identity headers.
        try {
          await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
        } catch (fallbackErr) {
          // The fallback is inside this catch branch, so its errors do not pass
          // through the outer 401 handler. Clear a rejected API key explicitly
          // before surfacing the error and prompting the user to log in again.
          await clearInvalidStaticApiKey(fallbackErr);
          throw fallbackErr;
        }
      } else if (
        this.provider === "anthropic" &&
        (await noteRequiredClaudeCodeVersion(err instanceof Error ? err.message : String(err)))
      ) {
        // A just-released model requires a newer Claude Code client than our
        // cached version spoofs. The floor has been raised on disk — rebuild the
        // User-Agent and retry this turn once instead of failing the user.
        userAgent = await getClaudeCliUserAgent();
        log("INFO", "anthropic", `Retrying with refreshed client version: ${userAgent}`);
        await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
      } else if (err instanceof ProviderError && err.statusCode === 401) {
        // Static API-key providers (GLM, Moonshot API key, etc.) have no refresh
        // mechanism — retrying with the same key is pointless. Clear the
        // credential and surface the error so the user re-logins. Subscription
        // OAuth (active for `moonshot`/`xai` when present) is refreshable, so it
        // falls through to the force-refresh path below.
        if (await clearInvalidStaticApiKey(err)) throw err;

        log("INFO", "auth", "Got 401, force-refreshing token and retrying");
        creds = await this.resolveRunCredentials(this.provider, {
          forceRefresh: true,
          storageKeys: this.currentAuthStorageKeys(),
          // Name the token the provider actually rejected (which the per-turn
          // resolver may have rotated since the run started). If disk already
          // holds a newer one, adopt it instead of minting another — a fresh
          // refresh would invalidate the token every sibling process is using
          // and turn one 401 into a cascade of them.
          rejectedToken: lastResolvedAccessToken,
        });
        this.lastAccountId = creds.accountId;
        await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
      } else {
        throw err;
      }
    }

    this.messages = loopMessages;

    // Backstop. Step-boundary flushes (checkpoint / turn_end) normally leave
    // nothing here, but this still catches messages appended after the last
    // checkpoint — an aborted final step, or a flush that failed mid-run.
    for (let i = this.lastPersistedIndex; i < this.messages.length; i++) {
      await this.persistMessage(this.messages[i]);
    }
    this.lastPersistedIndex = this.messages.length;

    // Final response is delivered — compact in the background while the user
    // reads it, instead of charging the summarizer latency to their next
    // prompt. Detached by design; the pre-run path above remains the backstop.
    this.maybeCompactPostTurn(creds);
  }

  getOpenAICodexContextProfileEligibility(): OpenAICodexContextProfileEligibility {
    if (
      this.contextProfileLocked ||
      this.messages.some((message) => message.role !== "system") ||
      this.kenTurns.length > 0
    ) {
      return {
        canChange: false,
        reason:
          "Context mode is fixed after this session starts. Start a new session to change it.",
      };
    }
    return { canChange: true };
  }

  async switchOpenAICodexContextProfile(profile: OpenAICodexContextProfile): Promise<void> {
    if (profile === this.openAICodexContextProfile) return;
    const eligibility = this.getOpenAICodexContextProfileEligibility();
    if (!eligibility.canChange) throw new Error(eligibility.reason);
    assertOpenAICodexContextProfileFitsUsage(this.model, profile, this.getContextUsage().used);
    if (!this.opts.transient && this.sessionPath) {
      await this.sessionManager.updateOpenAICodexContextProfile(this.sessionPath, profile);
    }
    this.openAICodexContextProfile = profile;
  }

  /**
   * Rename this conversation. The title is saved to the current session file
   * when `persist` is set (another pane on the same file may already have
   * saved it) and always becomes the preview carried into later checkpoints,
   * so compaction does not revert the name to the first prompt.
   *
   * The preview is set before the label is written, so a checkpoint created
   * from here on carries the new name. A checkpoint already in flight captured
   * the old preview, so if the session moves to a new file while the label is
   * being written, the label is written to that file too.
   */
  async renameSession(title: string, persist: boolean): Promise<void> {
    const previousPreview = this.sessionPreview;
    this.sessionPreview = title;
    if (!persist || this.opts.transient || !this.sessionPath) return;
    try {
      let labelledPath = this.sessionPath;
      await this.sessionManager.appendLabel(labelledPath, title);
      while (this.sessionPath && !sameSessionFile(this.sessionPath, labelledPath)) {
        labelledPath = this.sessionPath;
        await this.sessionManager.appendLabel(labelledPath, title);
      }
    } catch (error) {
      // The rename failed: keep the old name unless a later rename replaced it.
      if (this.sessionPreview === title) this.sessionPreview = previousPreview;
      throw error;
    }
  }

  /**
   * One-time move off the retired per-session Astra Fast flag. A session saved
   * with it on resumes on `gpt-6-astra-fast`, but only where the flag used to
   * apply: standard Astra through Codex OAuth, so no other pane is moved onto
   * premium billing. The flag is then cleared so a later choice of standard
   * Astra sticks. Clearing is best effort: a failed header write never blocks
   * the resume.
   */
  private async migrateLegacyOpenAICodexFast(
    header: SessionHeader,
    sessionPath: string,
  ): Promise<void> {
    if (header.openAICodexFast !== true) return;
    if (this.provider === "openai" && this.model === "gpt-6-astra" && this.lastAccountId) {
      await this.switchModel("openai", "gpt-6-astra-fast");
    }
    if (this.opts.transient) return;
    await this.sessionManager.clearLegacyOpenAICodexFast(sessionPath).catch((error: unknown) => {
      log("WARN", "session", "Failed to clear the retired Fast flag", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Switch the session's model. A model that spends real money (Claude fast
   * mode bills usage credits) is refused unless `confirmPaid` carries the
   * user's explicit yes, so no caller can switch onto one by accident: every
   * path (app, CLI, editors, chat bridges, RPC) fails closed by default.
   */
  async switchModel(
    provider: string,
    model: string,
    options: { confirmPaid?: boolean } = {},
  ): Promise<void> {
    const target = getModel(model);
    if (target?.billing?.paid && options.confirmPaid !== true && model !== this.model) {
      throw new PaidModelConfirmationError(target.name, target.billing.detail);
    }
    // The model-switch note is appended to `this.messages`; settle any
    // background compaction first so the note cannot be swapped out.
    await this.settlePostTurnCompaction();
    const prevProvider = this.provider;
    const prevModel = this.model;
    // Diff gate: a "switch" to the model already in use is not state change.
    // Recording it anyway would write a redundant marker and a redundant
    // history note on every no-op re-selection from the UI.
    const changed = model !== prevModel || (Boolean(provider) && provider !== prevProvider);
    if (provider) this.provider = provider as Provider;
    this.model = model;
    this.providerContext = null;
    // Keep host-provided option closures (notably chat delegation) aligned with
    // the live selection after an in-session model switch.
    this.opts.provider = this.provider;
    this.opts.model = this.model;
    await this.refreshStoredAuthState();
    setEstimatorModel(model);
    // maxTokens must follow the active model — it was frozen at the boot
    // model's `maxOutputTokens` in the constructor, so without this a session
    // booted on e.g. Kimi (256K) keeps sending that cap after switching to a
    // smaller model (Opus 128K), which the provider rejects.
    this.maxTokens = this.resolveMaxTokens(model);
    this.eventBus.emit("model_change", {
      provider: this.provider,
      model: this.model,
      supportsVideo: getModel(this.model)?.supportsVideo ?? false,
    });

    // Rebuild the read tool for the new model's video byte cap. The tool's
    // video capability (description + native-video execute path) is baked in
    // at creation from the model's maxVideoBytes, so switching to/from a
    // video-capable model mid-session needs a fresh tool object — mirrors
    // the TUI's rebuildReadTool call on model switch.
    if (this.rebuildReadTool) {
      this.registerTool(this.rebuildReadTool(model));
    }

    // Model-dependent guidance lives in the uncached tail, so this rewrites
    // only the bytes after the cache marker — the cached prefix survives the
    // switch intact and the next turn still reads from cache.
    this.refreshSystemPromptTail();

    if (changed) {
      // Durable, replayable record of which model produced which segment. Rides
      // the existing app-marker path (parentId null, anchored by message count)
      // so a resumed session reconstructs the switch without the LLM seeing an
      // extra transcript row.
      await this.persistAppMarker("model_switch", {
        from: prevModel,
        to: this.model,
        provider: this.provider,
        fromProvider: prevProvider,
      }).catch((error) => {
        log("WARN", "session", "Failed to persist model-switch marker", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.appendModelSwitchNote(prevModel, prevProvider);
    }

    // Update provider-specific tools when provider changes
    if (provider && provider !== prevProvider) {
      // Add/remove client-side web_search tool based on provider.
      // Anthropic has native server-side web search; all other providers need the client tool.
      const hasWebSearch = this.registeredTools.has("web_search");
      if (this.deferredBuiltinToolNames.includes("web_search")) {
        // Tiered: the client tool lives in the catalog for every provider and,
        // once promoted, is swapped for the native server tool by the Anthropic
        // transport. Nothing to add or remove — doing so would either load the
        // schema eagerly or take away a capability the model already has.
      } else if (this.provider === "anthropic" && hasWebSearch) {
        // Switching TO anthropic — remove client-side web_search (server-side handles it)
        this.unregisterTools((toolName) => toolName === "web_search");
      } else if (this.provider !== "anthropic" && !hasWebSearch) {
        // Switching FROM anthropic — add client-side web_search
        this.registerTool(
          createWebSearchTool(() => ({
            mode: this.settingsManager.get("networkMode"),
            allow: this.settingsManager.get("networkAllow"),
          })),
        );
      }

      // Reconnect MCP servers ONLY when GLM is involved on either side — GLM
      // is the only provider with a different server set (Z.AI tools), so a
      // non-GLM switch keeps the identical set. Skipping the dispose/reconnect
      // there avoids tearing down a live stdio child and
      // gambling on a `npx` re-spawn that could fail and drop the tools.
      const glmInvolved = this.provider === "glm" || prevProvider === "glm";
      if (this.mcpManager && glmInvolved) {
        // Remove only identity-bearing MCP tools. Ordinary tools whose valid
        // host-owned names happen to begin with `mcp__` must survive.
        this.unregisterTools(
          (toolName, tool) =>
            getMcpToolIdentity(tool) !== undefined || this.mcpToolIdentities.has(toolName),
        );

        // A disposed manager is terminal: detach it and invalidate its async
        // discovery before any teardown await can yield, then give the new
        // provider a fresh close-reporting lifecycle.
        const oldManager = this.mcpManager;
        const oldLeases = [...this.sharedMcpLeases.values()];
        this.sharedMcpLeases.clear();
        const generation = ++this.mcpConnectionGeneration;
        const newManager = this.createMcpManager();
        this.mcpManager = newManager;
        await this.disposeMcpResources(oldManager, oldLeases);
        if (!this.isCurrentMcpConnection(generation, newManager)) return;

        // Drop stale identity-bearing MCP tools, then reconnect through the same
        // trust-gated shared/private ownership path used during initialization.
        this.unregisterTools(
          (toolName, tool) =>
            getMcpToolIdentity(tool) !== undefined || this.mcpToolIdentities.has(toolName),
        );
        this.mcpCatalog?.removeWhere((name) => this.mcpToolIdentities.has(name));
        this.liveMcpTools.clear();
        this.mcpToolIdentities.clear();
        await this.connectMcpServers();
      }
    }
  }

  /**
   * Record the switch as its own trailing message at the point it happened,
   * rather than by rewriting the system prompt. Two reasons: the system prompt
   * is the cached prefix and rewriting it costs a full cache write, and a
   * resumed transcript can only attribute output to the right model if the
   * switch sits in message order.
   *
   * Skipped before the conversation starts (nothing to disambiguate) and while
   * an assistant turn has unresolved tool calls, where inserting a user message
   * would break tool_use/tool_result pairing.
   */
  private appendModelSwitchNote(prevModel: string, prevProvider: Provider): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role === "system") return;
    if (last.role === "assistant" && hasUnresolvedToolCalls(last)) return;
    const from = prevProvider === this.provider ? prevModel : `${prevProvider}/${prevModel}`;
    const to = prevProvider === this.provider ? this.model : `${this.provider}/${this.model}`;
    this.messages.push({
      role: "user",
      content: `[Model switched from ${from} to ${to}. Everything above was produced under the previous model; continue the current task from here.]`,
      provenance: { source: "runtime", kind: "model_switch", visibility: "hidden" },
    });
  }

  private async adoptCompactionCheckpoint(
    loaded: Awaited<ReturnType<SessionManager["load"]>>,
  ): Promise<void> {
    // Adoption always continues a conversation, even an empty historical checkpoint.
    this.contextProfileLocked = true;
    const systemMessage = this.messages[0];
    const loadedMessages = this.sessionManager.getMessages(loaded.entries, loaded.header.leafId);
    this.messages = [systemMessage, ...loadedMessages];
    this.recordCompactionPredecessor();
    this.sessionId = loaded.header.id;
    this.conversationId = loaded.header.conversationId ?? loaded.header.id;
    this.checkpointGeneration = loaded.header.generation ?? 0;
    this.openAICodexContextProfile = loaded.header.openAICodexContextProfile ?? "stable";
    this.currentLeafId = loaded.header.leafId;
    this.setSessionPath(loaded.path);
    this.kenTurns = this.sessionManager.getKenTurns(loaded.entries, loaded.header.leafId);
    this.autopilotMarkers = this.sessionManager.getAutopilotMarkers(
      loaded.entries,
      loaded.header.leafId,
    );
    this.appMarkers = this.sessionManager.getAppMarkers(loaded.entries, loaded.header.leafId);
    this.turnMetrics = this.sessionManager.getTurnMetrics(loaded.entries);
    this.lastPersistedIndex = this.messages.length;
    this.providerContext = null;
    await this.subAgentManager?.rebindParentSession(this.sessionId);
    // The adopted checkpoint continues this conversation, so the selected phase
    // and its lease marker continue with it.
    await this.rePersistActivePhaseContext();
    await this.rePersistRoadmapPhaseLeaseMarker();
  }

  /** Canonicalize a deferred restore before a new prompt can fork stale history. */
  private async adoptDeferredCheckpointBeforePrompt(): Promise<void> {
    if (!this.deferredCompactionPending || !this.conversationId) return;
    this.deferredCompactionPending = false;
    const canonicalPath = await this.sessionManager.resolveCanonicalSession(
      this.conversationId,
      this.cwd,
    );
    if (!canonicalPath || canonicalPath === this.sessionPath) return;
    await this.adoptCompactionCheckpoint(
      await this.sessionManager.load(canonicalPath, { canonical: true }),
    );
  }

  private async persistCompactionCheckpoint(
    sourceFingerprint: string,
    result: CompactionResult,
  ): Promise<void> {
    this.contextProfileLocked = true;
    const parentSessionId = this.sessionId || undefined;
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model, {
      conversationId: this.conversationId || undefined,
      generation: this.checkpointGeneration + 1,
      parentSessionId,
      sourceFingerprint,
      retainedMessageCount:
        result.retainedCount === 0
          ? 0
          : this.messages
              .slice(-result.retainedCount)
              .filter((message) => getHistoryMessageVisibility(message) !== "hidden").length,
      preview: this.sessionPreview || undefined,
      openAICodexContextProfile: this.openAICodexContextProfile,
    });
    this.recordCompactionPredecessor();
    this.sessionId = session.id;
    this.checkpointGeneration = session.header.generation ?? 0;
    this.conversationId = session.header.conversationId ?? session.id;
    this.currentLeafId = null;
    this.setSessionPath(session.path);
    await this.subAgentManager?.rebindParentSession(this.sessionId);

    for (const message of this.messages) {
      if (message.role !== "system") await this.persistMessage(message);
    }
    this.lastPersistedIndex = this.messages.length;
    await this.rePersistTurnMetrics();
    await this.rePersistKenTurns();
    await this.rePersistAutopilotMarkers();
    await this.rePersistApprovedPlanConsumption();
    await this.rePersistAppMarkers();
    await this.persistCompletionReviewState();
    // A compaction checkpoint continues the same conversation: carry the
    // selected phase and its lease marker into the new session file, exactly as
    // a preserved fresh session does. Dropping them orphaned the phase lease.
    await this.rePersistActivePhaseContext();
    await this.rePersistRoadmapPhaseLeaseMarker();
    await this.persistAppMarker("compaction", {
      originalCount: result.originalCount,
      newCount: result.newCount,
    });
  }

  /** Call before the session identity rotates to a compaction checkpoint. */
  private recordCompactionPredecessor(): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const retained = this.compactionPredecessorSessions.filter(
      (link) => link.sessionId !== sessionId,
    );
    retained.push({ sessionId, sessionPath: this.sessionPath || null });
    this.compactionPredecessorSessions = retained.slice(-COMPACTION_PREDECESSOR_LIMIT);
  }

  /** Sessions this live session continued from through compaction checkpoints, oldest first. */
  getCompactionPredecessorSessions(): { sessionId: string; sessionPath: string | null }[] {
    return this.compactionPredecessorSessions.map((link) => ({ ...link }));
  }

  /**
   * Wait out any in-flight post-turn background compaction before a new
   * entry point mutates `this.messages` (prompt, attachments, model switch).
   * The background compact() snapshots and then REPLACES the array, so a
   * message pushed while it runs would be silently dropped from the live
   * history — the pre-run await in runLoop() sits after the push and cannot
   * protect it.
   */
  private async settlePostTurnCompaction(): Promise<void> {
    if (this.postTurnCompaction) await this.postTurnCompaction;
  }

  /**
   * Advance plan-step bookkeeping over the messages added since the last
   * observation and, when a plan step was newly completed (`[DONE:n]`), run
   * the SoL-Pi cost rule. Called between model steps (in-flight) and once
   * after the run; `scanIndex` and `doneSteps` make each message and each
   * step count once across both paths. Returns undefined when no step
   * completed since the last observation.
   */
  private observePlanStepProgress(
    messages: Message[],
    contextWindow: number,
    activeTokens: number | undefined,
  ): PlanStepCompactionDecision | undefined {
    const st = this.planStepState;
    const planPath = this.approvedPlanPath;
    if (st.planPath !== planPath) {
      st.planPath = planPath;
      st.doneSteps = new Set<number>();
      st.requestsInCompletedSteps = 0;
      st.requestsThisStep = 0;
    }
    if (st.scanIndex > messages.length) st.scanIndex = 0;
    let requests = 0;
    const newlyDone: number[] = [];
    for (let i = st.scanIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      requests++;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      for (const step of findCompletedMarkers(text)) {
        if (!st.doneSteps.has(step)) newlyDone.push(step);
      }
    }
    st.scanIndex = messages.length;
    const contextTokens = activeTokens ?? estimateConversationTokens(messages);
    if (st.lastContextTokens > 0)
      st.grownTokens += Math.max(0, contextTokens - st.lastContextTokens);
    st.lastContextTokens = contextTokens;
    st.requests += requests;
    st.requestsThisStep += requests;
    st.requestsSinceLastCompaction += requests;
    if (st.writeCostBalance > 0) st.writeCostBalance -= st.savingPerRequest * requests;
    if (!planPath || newlyDone.length === 0) return undefined;
    for (const step of newlyDone) st.doneSteps.add(step);
    st.requestsInCompletedSteps += st.requestsThisStep;
    st.requestsThisStep = 0;
    let planText: string;
    try {
      planText = readFileSync(planPath, "utf8");
    } catch {
      return undefined;
    }
    const totalSteps = extractPlanSteps(planText).length;
    const decision = decidePlanStepCompaction({
      contextTokens,
      keptTailTokens: PLAN_STEP_KEEP_TOKENS,
      contextWindow,
      // The model registry carries no cache price fields; use the SoL-Pi default.
      cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
      stepsCompleted: st.doneSteps.size,
      stepsRemaining: Math.max(0, totalSteps - st.doneSteps.size),
      requestsInCompletedSteps: st.requestsInCompletedSteps,
      requests: st.requests,
      grownTokens: st.grownTokens,
      priorCompactions: st.compactions,
      writeCostBalance: st.writeCostBalance,
      requestsSinceLastCompaction: st.compactions > 0 ? st.requestsSinceLastCompaction : undefined,
    });
    log("INFO", "compaction", "Plan-step compaction decision", {
      compact: String(decision.compact),
      reason: decision.reason,
    });
    return decision;
  }

  /**
   * Plan-step bookkeeping after ANY successful compaction (as in the bench:
   * every compaction leaves a cache-write cost to be repaid by later savings).
   */
  private recordPlanStepCompaction(contextBefore: number): void {
    const st = this.planStepState;
    const after = estimateConversationTokens(this.messages);
    st.scanIndex = this.messages.length;
    st.lastContextTokens = after;
    st.requestsSinceLastCompaction = 0;
    st.compactions++;
    st.writeCostBalance += after * (DEFAULT_CACHE_WRITE_READ_RATIO - 1);
    st.savingPerRequest = Math.max(0, contextBefore - after);
  }

  /**
   * Post-turn compaction: once the final response has been delivered, compact
   * in the background while the user reads the answer, instead of making the
   * next prompt pay the summarizer latency up front (the pre-run path stays as
   * the backstop, so a skipped or failed attempt costs nothing). Mirrors the
   * Codex `model_post_turn_compact_threshold_percent` guards: skip when user
   * input is already queued (it would race the next turn), when the run was
   * aborted, or during the failure cooldown — and never let a compaction
   * error surface in the completed turn. Besides the size trigger, a newly
   * completed approved-plan step may compact when the cache-cost rule in
   * compaction/plan-step-policy.ts says the shrink pays for itself.
   */
  private maybeCompactPostTurn(creds: {
    accessToken: string;
    accountId?: string;
    projectId?: string;
    baseUrl?: string;
  }): void {
    if (!this.settingsManager.get("autoCompact")) return;
    if (this.opts.signal?.aborted) return;
    if (this.userQueue.some((m) => !m.deferred)) return;
    if (this.postTurnCompaction) return;
    if (Date.now() < this.compactionRetryAfter) return;
    const contextWindow = getContextWindow(this.model, {
      provider: this.provider,
      accountId: creds.accountId,
    });
    // One compaction per turn boundary: a pre-run, in-flight or overflow
    // compaction already shrank this run's history — re-probing right after
    // the final response would only re-derive that decision. Still record the
    // final response's `[DONE:n]` steps so plan bookkeeping stays current.
    if (this.compactionOccurred) {
      this.observePlanStepProgress(this.messages, contextWindow, undefined);
      return;
    }
    const policy = resolveCompactionPolicy({
      provider: this.provider,
      model: this.model,
      contextWindow,
      threshold: this.settingsManager.get("compactThreshold"),
      accountId: creds.accountId,
      approvedPlanPath: this.approvedPlanPath,
    });
    let activeTokens: number | undefined;
    if (this.providerContext) {
      const anchorIndex = this.messages.lastIndexOf(this.providerContext.anchor);
      if (anchorIndex >= 0) {
        activeTokens = calculateActiveContextTokens(this.messages, {
          usage: this.providerContext.usage,
          pendingMessages: this.messages.slice(anchorIndex + 1),
        });
      }
    }
    const planStep = this.observePlanStepProgress(this.messages, contextWindow, activeTokens);
    if (
      !shouldCompact(
        this.messages,
        contextWindow,
        policy.threshold,
        activeTokens,
        policy.targetTokens,
      ) &&
      !planStep?.compact
    )
      return;
    log("INFO", "compaction", "Post-turn compaction decision — compacting in background", {
      trigger: planStep?.compact ? `plan-step (${planStep.reason})` : "size",
      provider: this.provider,
      model: this.model,
      transport: this.provider === "openai" && creds.accountId ? "codex_oauth" : "public_api",
      contextWindow: String(contextWindow),
      activeTokens: activeTokens === undefined ? "estimated" : String(activeTokens),
      triggerLimit: String(policy.targetTokens),
    });
    this.postTurnCompaction = (async () => {
      try {
        await this.compact(creds, "automatic");
        if (this.lastCompactionCompacted) {
          // Arm re-grounding for the next turn. resetHookState clears
          // compactionOccurred at run start, before the injection point, so
          // park the signal for pickup there.
          this.compactionArmedForNextRun = true;
          this.compactionRetryAfter = 0;
        } else {
          this.compactionRetryAfter = Date.now() + 30_000;
        }
      } catch (error) {
        this.compactionRetryAfter = Date.now() + 30_000;
        if (isAbortError(error) || this.opts.signal?.aborted) return;
        log(
          "WARN",
          "compaction",
          `Post-turn compaction failed; cooling down for 30s: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        this.postTurnCompaction = undefined;
      }
    })();
  }

  async compact(
    existingCredentials?: {
      accessToken: string;
      accountId?: string;
      projectId?: string;
      baseUrl?: string;
    },
    mode: "manual" | "automatic" | "forced" = "manual",
    /** User-stated focus (`/compact <focus>`): what must survive verbatim. */
    focus?: string,
  ): Promise<void> {
    this.contextProfileLocked = !this.getOpenAICodexContextProfileEligibility().canChange;
    this.lastCompactionCompacted = false;
    const creds =
      existingCredentials ??
      (await this.resolveRunCredentials(this.provider, {
        storageKeys: this.currentAuthStorageKeys(),
      }));
    const contextWindow = getContextWindow(this.model, {
      provider: this.provider,
      accountId: creds.accountId,
      openAICodexContextProfile: this.openAICodexContextProfile,
    });
    const policy = resolveCompactionPolicy({
      provider: this.provider,
      model: this.model,
      contextWindow,
      threshold: this.settingsManager.get("compactThreshold"),
      accountId: creds.accountId,
      approvedPlanPath: this.approvedPlanPath,
    });
    const originalCount = this.messages.length;
    const contextTokensBefore = estimateConversationTokens(this.messages);
    this.eventBus.emit("compaction_start", { messageCount: originalCount });

    let contextSelection: CompactionContextSelection | undefined;
    const runCompactor = async () => {
      const output = await compact(this.messages, {
        provider: this.provider,
        model: this.model,
        transportModel: resolveTransportModel(this.provider, this.model),
        apiKey: creds.accessToken,
        accountId: creds.accountId,
        projectId: creds.projectId,
        baseUrl: this.baseUrl ?? creds.baseUrl,
        contextWindow,
        targetTokens: policy.targetTokens,
        signal: this.opts.signal,
        approvedPlanPath: this.approvedPlanPath,
        focus,
      });
      contextSelection = output.result.contextSelection;
      return output;
    };

    let finalCount = originalCount;
    if (this.opts.transient || !this.conversationId) {
      const result = await runCompactor();
      finalCount = result.result.newCount;
      this.messages = result.messages;
      this.lastCompactionCompacted = result.result.compacted;
      if (result.result.compacted) {
        this.providerContext = null;
        this.remapMarkerAnchors(result.result.anchorRemap);
        this.lastPersistedIndex = this.messages.length;
      }
    } else {
      const conversationId = this.conversationId;
      await this.sessionManager.withCompactionLease(conversationId, this.opts.signal, async () => {
        let sourceFingerprint = computeSourceFingerprint(this.messages);
        const canonicalPath = await this.sessionManager.resolveCanonicalSession(
          conversationId,
          this.cwd,
        );
        if (canonicalPath && canonicalPath !== this.sessionPath) {
          const newest = await this.sessionManager.load(canonicalPath, { canonical: true });
          if (newest.header.sourceFingerprint === sourceFingerprint) {
            await this.adoptCompactionCheckpoint(newest);
            this.lastCompactionCompacted = true;
            finalCount = this.messages.length;
            return;
          }
          // The canonical branch contains different progress. Rebase onto it before
          // compacting so a stale caller cannot supersede newer history by generation.
          await this.adoptCompactionCheckpoint(newest);
          sourceFingerprint = computeSourceFingerprint(this.messages);
        }

        const attempt = await this.sessionManager.readCompactionAttemptState(conversationId);
        const attemptActive = !attempt?.expiresAt || Date.parse(attempt.expiresAt) > Date.now();
        if (
          mode === "automatic" &&
          attempt?.fingerprint === sourceFingerprint &&
          attempt.policyKey === policy.policyKey &&
          attemptActive
        ) {
          if (attempt.outcome === "success" && attempt.checkpointId) {
            const checkpointPath = await this.sessionManager.findById(
              this.cwd,
              attempt.checkpointId,
            );
            if (checkpointPath) {
              const checkpoint = await this.sessionManager.load(checkpointPath);
              if (checkpoint.header.sourceFingerprint === sourceFingerprint) {
                await this.adoptCompactionCheckpoint(checkpoint);
                this.lastCompactionCompacted = true;
                finalCount = this.messages.length;
                return;
              }
            }
          } else if (attempt.outcome === "failed" || attempt.outcome === "noop") {
            return;
          }
        }

        try {
          const result = await runCompactor();
          finalCount = result.result.newCount;
          this.messages = result.messages;
          this.lastCompactionCompacted = result.result.compacted;
          if (!result.result.compacted) {
            await this.sessionManager.writeCompactionAttemptState(conversationId, {
              fingerprint: sourceFingerprint,
              policyKey: policy.policyKey,
              outcome: "noop",
              updatedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            });
            return;
          }

          this.providerContext = null;
          this.remapMarkerAnchors(result.result.anchorRemap);
          await this.persistCompactionCheckpoint(sourceFingerprint, result.result);
          await this.sessionManager.writeCompactionAttemptState(conversationId, {
            fingerprint: sourceFingerprint,
            policyKey: policy.policyKey,
            outcome: "success",
            checkpointId: this.sessionId,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          await this.sessionManager
            .writeCompactionAttemptState(conversationId, {
              fingerprint: sourceFingerprint,
              policyKey: policy.policyKey,
              outcome: "failed",
              updatedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            })
            .catch(() => {});
          throw error;
        }
      });
    }

    if (this.lastCompactionCompacted) {
      this.cacheDiagnostics.noteEdit("compaction");
      this.recordPlanStepCompaction(contextTokensBefore);
    }
    this.eventBus.emit("compaction_end", {
      compacted: this.lastCompactionCompacted,
      originalCount,
      newCount: finalCount,
      ...(contextSelection
        ? {
            selectionStrategy: contextSelection.strategy,
            selectedMessages: contextSelection.selectedMessages,
            selectedTokens: contextSelection.selectedTokens,
            droppedMessages: contextSelection.droppedMessages,
            queryTerms: contextSelection.queryTerms,
            ...(contextSelection.fallbackReason
              ? { selectionFallback: contextSelection.fallbackReason }
              : {}),
          }
        : {}),
    });
  }

  private beforeConversationTransition?: (
    kind: "reset" | "restore" | "history" | "checkpoint",
  ) => () => void;

  /** Host-owned synchronous fence, entered before any transition await. The
   * returned finalizer also runs on failure so the host can rebind authority. */
  setBeforeConversationTransition(
    hook: NonNullable<AgentSession["beforeConversationTransition"]>,
  ): void {
    this.beforeConversationTransition = hook;
  }

  async newSession(preserveConversation = false): Promise<void> {
    // A background post-turn compaction replaces `this.messages` when it
    // lands; finishing after the reset would swap the old history back into
    // the fresh session (e.g. an accepted plan's build would inherit the
    // planning conversation and lose the approved-plan prompt). Await only when
    // one is pending so an idle reset still invalidates in-flight work
    // synchronously, before the caller's next tick.
    if (this.postTurnCompaction) await this.postTurnCompaction;
    this.commandCreation?.cancel();
    this.programmaticProfile?.cancel();
    this.discoveryReview?.close();
    this.discoveryCandidates = null;
    this.setupInspection?.close();
    const finish = this.beforeConversationTransition?.(
      preserveConversation ? "checkpoint" : "reset",
    );
    // Reset replaces these values rather than mutating their source containers.
    // Keep authority until every required destination write has succeeded. This
    // snapshot deliberately excludes provider signals, workers and run ownership.
    const sourcePath = this.sessionPath;
    const sourcePlanMode = this.planModeRef.current;
    const source = {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      checkpointGeneration: this.checkpointGeneration,
      sessionPreview: this.sessionPreview,
      activePhaseContext: this.activePhaseContext,
      approvedPlanPath: this.approvedPlanPath,
      approvedPlanConsumption: this.approvedPlanConsumption,
      contextProfileLocked: this.contextProfileLocked,
      kenTurns: this.kenTurns,
      autopilotMarkers: this.autopilotMarkers,
      appMarkers: this.appMarkers,
      turnMetrics: this.turnMetrics,
      messages: this.messages,
      currentLeafId: this.currentLeafId,
      baseSystemPrompt: this.baseSystemPrompt,
      renderedEnvironment: this.renderedEnvironment,
      lastPersistedIndex: this.lastPersistedIndex,
      compactionPredecessorSessions: this.compactionPredecessorSessions,
    };
    let parentResetAttempted = false;
    try {
      try {
        await this.resetSession(preserveConversation);
        if (!this.opts.transient && this.subAgentManager) {
          parentResetAttempted = true;
          await this.subAgentManager.resetParentSession(this.sessionId);
        }
      } catch (error) {
        const failedDestination = this.sessionPath !== sourcePath ? this.sessionPath : undefined;
        Object.assign(this, source);
        this.planModeRef.current = sourcePlanMode;
        this.setSessionPath(sourcePath);
        const rollbackErrors: unknown[] = [];
        if (failedDestination) {
          // create() only returns after its header append; active-path ownership
          // is changed by AgentSession, not SessionManager. Remove a failed newer
          // checkpoint so a subsequent canonical resume cannot select it.
          try {
            await fs.rm(failedDestination, { force: true });
          } catch (cleanupError) {
            rollbackErrors.push(cleanupError);
          }
        }
        if (parentResetAttempted) {
          // Rebind the resource manager, but never restore its retired workers.
          try {
            await this.subAgentManager?.resetParentSession(source.sessionId);
          } catch (rebindError) {
            rollbackErrors.push(rebindError);
          }
        }
        if (rollbackErrors.length)
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Session reset failed; source restored but destination cleanup failed.",
            { cause: error },
          );
        throw error;
      }
      // Commit: advisory receipts belong to the live conversation, not the
      // AgentSession object or physical checkpoint. A preserving checkpoint
      // continues that conversation; failed resets must retain its receipts.
      if (!preserveConversation) {
        this.advisoryTurn?.close();
        this.advisoryEvidence.clear();
      }
      // Only successful reset retires source-checkpoint verification evidence.
      // Preserve conversation/phase identity when requested, never its approval.
      this.verificationEvidenceLedger.clear();
      // Corpus research is in-memory only and belongs to the source context.
      // Clear it even for a preserving checkpoint: exit_plan already cleared it
      // after the approved plan cited it, and anything retrieved afterwards did
      // not shape that plan. Keeping it would demand citations for repos the
      // next plan or Roadmap draft never saw.
      this.researchSources.clear();
      this.hookToolCalls.clear();
      this.eventBus.emit("session_start", { sessionId: this.sessionId });
    } finally {
      finish?.();
    }
    // A fresh session is the natural moment to recover servers that failed at
    // startup. Background-connect hosts (the desktop daemon) never block the
    // reset on a slow server; the CLI waits so the first prompt sees the tools.
    // The retry logs its own failures; it must never fail a completed reset.
    const retry = this.retryFailedMcpServers().catch(() => {});
    if (!this.opts.backgroundMcpConnect) await retry;
  }

  private async resetSession(preserveConversation: boolean): Promise<void> {
    this.assessmentSequence++;
    const continuationReview = preserveConversation
      ? this.getContinuationReviewRecord()
      : undefined;
    // Stay fail-closed while preparing. The caller restores source eligibility
    // on failure; a successful checkpoint never establishes fresh eligibility.
    this.contextProfileLocked = true;
    this.cacheDiagnostics.reset();
    // Approved-plan execution is a clean checkpoint of the same conversation;
    // explicit new sessions reset the conversation identity and phase binding.
    if (!preserveConversation) {
      this.conversationId = "";
      this.checkpointGeneration = 0;
      this.sessionPreview = "";
      this.activePhaseContext = undefined;
      // Compaction lineage belongs to the abandoned conversation; keeping it
      // would mark that conversation's sessions live and block lease reclaim.
      this.compactionPredecessorSessions = [];
    }
    // A fresh explicit session drops plan state. A preserved phase checkpoint
    // reconstructs it from durable execution metadata below.
    this.planModeRef.current = false;
    this.approvedPlanPath = undefined;
    this.approvedPlanConsumption = undefined;
    if (preserveConversation && this.activePhaseContext) {
      this.restorePlanStateFromActivePhase(this.activePhaseContext);
    }
    // Display-only history belongs to the OLD session. Without this, stale Ken
    // turns / autopilot verdicts / app markers linger in memory, show up in the
    // new session's /history, and get re-persisted into the new file by the
    // next compaction — the cross-session duplicate-marker propagation bug.
    this.kenTurns = [];
    this.autopilotMarkers = [];
    this.appMarkers = [];
    this.turnMetrics = [];
    // Detect languages before the first render so the opening prompt already
    // carries their packs and only a genuinely new language needs an update.
    this.refreshActiveLanguages();
    const basePrompt = await this.buildBasePrompt(false, undefined);
    this.baseSystemPrompt = basePrompt;
    this.messages = [{ role: "system", content: this.withSystemPromptTail(basePrompt) }];
    this.clearReadTracker?.();
    // Fresh conversation — new entries must not chain onto the old DAG's leaf.
    this.currentLeafId = null;
    // Transient sessions (Ken chat/autopilot, subagent spawns) never touch the
    // session store. Without this guard, autopilot's per-cycle resetReviewer
    // (kenAutoSession.newSession()) created a real session file EVERY review
    // cycle — the stream of 3-line "## Who you are … Ken Kai" sessions that
    // polluted the project's session list.
    if (this.opts.transient) {
      this.sessionId = "";
      this.conversationId = "";
      this.checkpointGeneration = 0;
      this.sessionPreview = "";
      this.setSessionPath("");
      this.lastPersistedIndex = this.messages.length;
    } else {
      await this.createNewSession();
      if (continuationReview) {
        await this.persistRequiredAppMarker("user_hint", { kenSent: true, continuationReview });
      }
      await this.rePersistActivePhaseContext();
      await this.rePersistRoadmapPhaseLeaseMarker();
    }
    this.contextProfileLocked = preserveConversation;
  }

  async loadSession(sessionPath: string): Promise<void> {
    this.commandCreation?.cancel();
    this.programmaticProfile?.cancel();
    this.discoveryReview?.close();
    this.discoveryCandidates = null;
    this.setupInspection?.close();
    const finish = this.beforeConversationTransition?.("restore");
    try {
      await this.loadExistingSession(sessionPath);
      this.cacheDiagnostics.reset();
      this.verificationEvidenceLedger.clear();
      // A loaded transcript carries no in-memory corpus record.
      this.researchSources.clear();
      if (this.sessionId) await this.subAgentManager?.hydrate(this.sessionId);
      this.eventBus.emit("session_start", { sessionId: this.sessionId });
    } finally {
      finish?.();
    }
  }

  /** Restore one physical checkpoint without resolving to its conversation tip. */
  async loadSessionCheckpoint(sessionPath: string, expectedConversationId?: string): Promise<void> {
    const retain = Boolean(
      expectedConversationId && expectedConversationId === this.conversationId,
    );
    this.commandCreation?.cancel();
    this.programmaticProfile?.cancel();
    this.discoveryReview?.close();
    this.discoveryCandidates = null;
    this.setupInspection?.close();
    const finish = this.beforeConversationTransition?.(retain ? "checkpoint" : "restore");
    try {
      await this.loadExistingSession(sessionPath, false, expectedConversationId);
      this.cacheDiagnostics.reset();
      this.verificationEvidenceLedger.clear();
      // A loaded transcript carries no in-memory corpus record.
      this.researchSources.clear();
      if (this.sessionId) await this.subAgentManager?.hydrate(this.sessionId);
      this.eventBus.emit("session_start", { sessionId: this.sessionId });
    } finally {
      finish?.();
    }
  }

  /**
   * Create a branch at a specific point in the conversation.
   * Rewinds the message history to the given entry and sets the leaf
   * so new messages fork from that point.
   *
   * @param stepsBack Number of messages to rewind (default: 2 — backs up past last assistant + tool)
   */
  async branch(stepsBack = 2): Promise<{ branchedFrom: number; messagesKept: number }> {
    this.commandCreation?.cancel();
    this.programmaticProfile?.cancel();
    this.discoveryReview?.close();
    this.discoveryCandidates = null;
    this.setupInspection?.close();
    const finish = this.beforeConversationTransition?.("history");
    try {
      return await this.branchSession(stepsBack);
    } finally {
      finish?.();
    }
  }

  private async branchSession(
    stepsBack: number,
  ): Promise<{ branchedFrom: number; messagesKept: number }> {
    // Load the full session to access the DAG
    const loaded = await this.sessionManager.load(this.sessionPath);
    this.setSessionPath(loaded.path);
    const branch = this.sessionManager.getBranch(loaded.entries, this.currentLeafId);

    // Walk back stepsBack message entries
    const messageEntries = branch.filter((e) => e.type === "message");
    const targetIndex = Math.max(0, messageEntries.length - stepsBack);

    if (targetIndex === 0) {
      throw new Error("Cannot branch — already at the start of the conversation.");
    }

    // Set leaf to the entry just before the branch point
    const newLeafEntry = messageEntries[targetIndex - 1]!;
    this.currentLeafId = newLeafEntry.id;
    await this.sessionManager.updateLeaf(this.sessionPath, newLeafEntry.id);

    // Rewinding does not undo accepted conversation history.
    this.contextProfileLocked = !this.getOpenAICodexContextProfileEligibility().canChange;
    // Rebuild messages from the new branch
    const branchMessages = this.sessionManager.getMessages(loaded.entries, this.currentLeafId);
    const systemMsg = this.messages[0];
    this.messages = [systemMsg, ...branchMessages];
    this.cacheDiagnostics.reset();
    this.lastPersistedIndex = this.messages.length;
    this.verificationEvidenceLedger.clear();
    // Reads made in the dropped messages are no longer in the model's context.
    this.clearReadTracker?.();

    this.eventBus.emit("branch_created", {
      leafId: this.currentLeafId,
      messagesKept: branchMessages.length,
    });

    return {
      branchedFrom: messageEntries.length,
      messagesKept: branchMessages.length,
    };
  }

  /**
   * List all branches in the current session.
   */
  async listBranches(): Promise<BranchInfo[]> {
    const loaded = await this.sessionManager.load(this.sessionPath);
    this.setSessionPath(loaded.path);
    return this.sessionManager.listBranches(loaded.entries);
  }

  /** Cheap server identity; never derive conversation identity from a path. */
  getConversationIdentity(): { conversationId: string; sessionId: string; leafId: string | null } {
    return {
      conversationId: this.conversationId,
      sessionId: this.sessionId,
      leafId: this.currentLeafId,
    };
  }

  /** Only preparation/commit need the full revision, not state/extras polling. */
  getContinuationSourceRevision(): ContinuationSourceRevision {
    const identity = this.getConversationIdentity();
    const fingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          ...identity,
          messages: computeSourceFingerprint(this.messages),
          mentor: this.kenTurns,
          provider: this.provider,
          model: this.model,
          accountId: this.lastAccountId,
          profile: this.openAICodexContextProfile,
        }),
      )
      .digest("hex");
    return { ...identity, fingerprint };
  }

  /** Skills the safety scan kept out of this session, for the app/CLI to show. */
  getBlockedSkills(): readonly BlockedSkill[] {
    return this.blockedSkills;
  }

  /** Installed packages (project lockfiles) now known to be malware. */
  getInstalledThreats(): readonly InstalledThreat[] {
    return this.installedThreats;
  }

  /**
   * Background check of the project's lockfiles for packages flagged as
   * malware after they were installed: shortly after start, after each daily
   * threat-feed update, and after a run that changed a lockfile. Never awaited
   * by anything; a new hit is shown to the user once (security_notice) and told
   * to the agent at its next turn. Off under vitest unless a test opts in.
   */
  private startInstalledPackageWatch(): void {
    const enabled = this.opts.installedPackageWatch ?? !process.env.VITEST;
    // Workers share their parent's project: the parent session watches it.
    if (!enabled || !this.projectSession || this.opts.subagentWorker || this.installedWatchStop) {
      return;
    }
    // The home folder or a filesystem root is not a project: never scan it.
    if (!isScannableProjectDir(this.cwd)) return;
    const delay = this.opts.installedPackageWatchDelayMs ?? 5_000;
    const timer = setTimeout(() => void this.scanInstalledPackages(), delay);
    timer.unref?.();
    const offFeed = onThreatFeedUpdated(() => void this.scanInstalledPackages());
    const offDone = this.eventBus.on("agent_done", () => void this.rescanIfLockfilesChanged());
    this.installedWatchStop = () => {
      this.installedWatchStopped = true;
      clearTimeout(timer);
      offFeed();
      offDone();
    };
  }

  private async rescanIfLockfilesChanged(): Promise<void> {
    if (!this.installedStamp || this.installedWatchStopped) return;
    const stamp = await stampProjectLockfiles(this.cwd);
    if (!sameStamp(stamp, this.installedStamp)) await this.scanInstalledPackages();
  }

  /**
   * A guard refused a tool call: a lasting chat row (live event + persisted
   * marker, so a reopened session shows it too) and, for packages, an entry in
   * the project's "don't install" list. All fire-and-forget; never blocks.
   */
  private recordSafetyBlock(rule: string, toolName: string, args: unknown, details: unknown): void {
    const a = (args ?? {}) as Record<string, unknown>;
    const raw = String(a.command ?? a.input ?? a.file_path ?? a.path ?? a.url ?? toolName);
    this.emitSecurityRow(rule, securityRowTarget(raw));
    const packages = (details as { safetyBlock?: { packages?: BlockedPackage[] } } | undefined)
      ?.safetyBlock?.packages;
    if (packages?.length) this.recordBlockedList(packages);
  }

  /**
   * One row per distinct block per run: an agent retrying the same blocked
   * install 30 times leaves one row, and a run hitting 100 blocks leaves at
   * most MAX_SECURITY_ROWS_PER_RUN (the session file stays small).
   */
  private emitSecurityRow(rule: string, target: string): void {
    const key = `${rule}\0${target}`;
    if (this.securityRowsThisRun.has(key)) return;
    if (this.securityRowsThisRun.size >= MAX_SECURITY_ROWS_PER_RUN) return;
    this.securityRowsThisRun.add(key);
    this.eventBus.emit("security_block", { rule, target });
    void this.persistAppMarker("security", { rule, target }).catch(() => {});
  }

  private recordBlockedList(packages: readonly BlockedPackage[]): void {
    const enabled = this.opts.blockedPackagesFile ?? !process.env.VITEST;
    if (!enabled || !this.projectSession) return;
    void recordBlockedPackages(this.cwd, packages).then(
      (file) => {
        if (file) log("INFO", "blocked-packages", `recorded blocked packages in ${file}`);
      },
      (err: unknown) =>
        log("WARN", "blocked-packages", `could not record blocked packages: ${String(err)}`),
    );
  }

  /** Exposed for tests; safe to call any time (one scan at a time, never throws). */
  async scanInstalledPackages(): Promise<void> {
    if (this.installedScanRunning || this.installedWatchStopped) return;
    this.installedScanRunning = true;
    try {
      const { stamp, found } = await sharedLockfileScan(this.cwd, this.opts.installedPackageCheck);
      // Disposed mid-scan: no late events.
      if (this.installedWatchStopped) return;
      this.installedStamp = stamp;
      const known = new Set(this.installedThreats.map((t) => t.key));
      this.installedThreats = found;
      for (const threat of found) {
        if (known.has(threat.key)) continue;
        log("WARN", "installed-threats", threat.message);
        this.notify(`installed-threat:${threat.file}`, threat.agentText);
        this.eventBus.emit("security_notice", { key: threat.key, message: threat.message });
        this.emitSecurityRow(
          "installed-malware",
          securityRowTarget(
            `${threat.packages.join(", ")} in ${path.relative(this.cwd, threat.file) || threat.file}`,
          ),
        );
        this.recordBlockedList(threat.blocked);
      }
    } catch (err) {
      log("WARN", "installed-threats", `installed-package check failed: ${String(err)}`);
    } finally {
      this.installedScanRunning = false;
    }
  }

  getState(): AgentSessionState {
    return {
      provider: this.provider,
      model: this.model,
      cwd: this.cwd,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      sessionPath: this.sessionPath,
      messageCount: this.messages.length,
      planMode: this.planModeRef.current,
      accountId: this.lastAccountId,
      openAICodexContextProfile: this.openAICodexContextProfile,
      openAICodexContextProfileEligibility: this.getOpenAICodexContextProfileEligibility(),
    };
  }

  /**
   * Tokens currently in context and the window they are measured against.
   *
   * Uses the same accounting as the compaction decision: authoritative provider
   * usage when we have it (it includes the system prompt and tool schemas),
   * plus a local estimate of anything appended after that sample. A client
   * reading this right after a compaction sees the drop, because compaction
   * clears the retained provider sample along with the messages it measured.
   *
   * `costUsd` is present only when EVERY recorded turn has an authoritative
   * price; a partial sum would read as a full session cost and understate it.
   */
  getContextUsage(): {
    used: number;
    size: number;
    openAICodexContextProfile: OpenAICodexContextProfile;
    costUsd?: number;
  } {
    const size = getContextWindow(this.model, {
      provider: this.provider,
      accountId: this.lastAccountId,
      openAICodexContextProfile: this.openAICodexContextProfile,
    });

    let used: number;
    const anchorIndex = this.providerContext
      ? this.messages.lastIndexOf(this.providerContext.anchor)
      : -1;
    if (this.providerContext && anchorIndex >= 0) {
      used = calculateActiveContextTokens(this.messages, {
        usage: this.providerContext.usage,
        pendingMessages: this.messages.slice(anchorIndex + 1),
      });
    } else {
      used = calculateActiveContextTokens(this.messages);
    }

    const costUsd =
      this.turnMetrics.length > 0 && this.turnMetrics.every((m) => m.cost.status === "known")
        ? this.turnMetrics.reduce((sum, m) => sum + (m.cost.status === "known" ? m.cost.usd : 0), 0)
        : undefined;

    const usage = { used, size, openAICodexContextProfile: this.openAICodexContextProfile };
    return costUsd === undefined ? usage : { ...usage, costUsd };
  }

  /**
   * Whether the provider's prompt cache has likely lapsed since the last
   * successful request, and how many tokens the next message would re-read at
   * full price. Null when the route has no known TTL or the chat is empty.
   */
  getCacheExpiryStatus(now = Date.now()): CacheExpiryStatus | null {
    const status = assessCacheExpiry({
      current: {
        provider: this.provider,
        model: this.model,
        policy: resolveCacheTtl({
          provider: this.provider,
          model: this.model,
          cacheRetention: this.isSpeedOptimized() ? "long" : "short",
          baseUrl: this.baseUrl,
          accountId: this.lastAccountId,
        }),
      },
      lastTouch: this.cacheDiagnostics.lastCacheTouch(),
      now,
      prefixTokens: this.getContextUsage().used,
      hasHistory: this.messages.some((m) => m.role === "user"),
    });
    return status && { ...status, sessionId: this.sessionId || this.transportSessionId };
  }

  getPlanMode(): boolean {
    return this.planModeRef.current;
  }

  /** Queue admission must not bypass setup/readiness/approval dispatch. */
  queueInputPolicyError(text: string): string | null {
    return this.opts.coderSlashCommands === false ? null : workflowQueuePolicyError(text);
  }

  /** Queue a user message (optionally with attachments) to be injected mid-run
   *  as steering. Returns the new queue length. No-op semantics are the caller's
   *  concern. */
  queueMessage(text: string, attachments: SessionAttachment[] = [], meta?: PromptMeta): number {
    this.assertQueueable(text, attachments);
    return this.enqueue(text, attachments, meta);
  }

  /**
   * Queue a prompt in one of two modes. The queue always shows and restores what
   * was typed.
   *
   * - Steering (default): like {@link queueMessage}, drained into the run in
   *   flight. A prompt-template command (`/name args`) is expanded now, so the
   *   model receives its instructions as steering rather than the bare name.
   *   Action commands and plain text queue unchanged.
   * - Deferred (`options.deferred`): waits for the current run to end and stays
   *   cancellable until the host takes it with {@link takeNextQueuedMessage}.
   *   The host then runs the raw text as its own normal send, which expands any
   *   command at that point, so nothing is expanded here.
   *
   * Calls are serialized: each entry is pushed in arrival order, and only once
   * fully prepared, so a mid-run drain never sees a half-prepared item and a
   * slow command expansion cannot be overtaken by a later plain message.
   * Returns the queue length after the push and the pushed entry's own id.
   */
  queuePrompt(
    text: string,
    attachments: SessionAttachment[] = [],
    meta?: PromptMeta,
    options: { deferred?: boolean } = {},
  ): Promise<{ count: number; id: string }> {
    // Policy errors reject this call immediately (as a rejection, not a
    // synchronous throw) and never hold up the chain.
    try {
      this.assertQueueable(text, attachments);
    } catch (error) {
      return Promise.reject(error);
    }
    const queued = this.queuePromptChain.then(async () => {
      // Attachment prompts skip slash expansion when idle too. Deferred entries
      // are expanded by the later send that runs them, so skip it here.
      const resolved =
        attachments.length === 0 && options.deferred !== true
          ? await this.resolveSlashInput(text, false)
          : null;
      const modelText =
        resolved?.kind === "template" && !resolved.setupInspection
          ? resolved.fullPrompt
          : undefined;
      const count = this.enqueue(text, attachments, meta, modelText, options.deferred === true);
      return { count, id: `q${this.queueSeq}` };
    });
    // A failed expansion rejects only its own call; later calls still run.
    this.queuePromptChain = queued.catch(() => undefined);
    return queued;
  }

  private assertQueueable(text: string, attachments: SessionAttachment[]): void {
    const inputPolicyError = this.promptInputPolicyError(text, attachments.length);
    if (inputPolicyError) throw new Error(inputPolicyError);
    const queuePolicyError = this.queueInputPolicyError(text);
    if (queuePolicyError) throw new Error(queuePolicyError);
    if (attachments.length > 0) this.buildAttachmentParts(text, attachments);
  }

  private enqueue(
    text: string,
    attachments: SessionAttachment[],
    meta: PromptMeta | undefined,
    modelText?: string,
    deferred = false,
  ): number {
    if (text.trim() || attachments.length > 0) this.contextProfileLocked = true;
    this.queueSeq += 1;
    const displayMeta = normalizePromptMeta(meta);
    this.userQueue.push({
      id: `q${this.queueSeq}`,
      text,
      attachments,
      ...(displayMeta ? { meta: displayMeta } : {}),
      ...(modelText !== undefined ? { modelText } : {}),
      ...(deferred ? { deferred } : {}),
    });
    // Instant interrupt: preempt running tools so the steer lands right away.
    // A deferred entry waits for the run to end, so it must not cut tools short.
    if (!deferred) for (const listener of [...this.steeringListeners]) listener();
    return this.userQueue.length;
  }

  /** Pending queued messages (id + text), oldest first, for client display. */
  listQueuedMessages(): Array<{ id: string; text: string }> {
    return this.userQueue.map((m) => ({ id: m.id, text: m.text }));
  }

  /** Cancel one pending message by id. Returns true if it was still queued.
   *  Deferred entries stay cancellable until their own run starts; steering
   *  entries until they drain into the run in flight. A false return is the
   *  normal race rather than an error: the message was taken (its run started,
   *  or it drained as steering) between the client rendering the cancel
   *  affordance and the click arriving. */
  cancelQueuedMessage(id: string): boolean {
    const index = this.userQueue.findIndex((m) => m.id === id);
    if (index === -1) return false;
    this.userQueue.splice(index, 1);
    return true;
  }

  /** Number of messages currently queued. */
  getQueuedCount(): number {
    return this.userQueue.length;
  }

  /** Number of queued messages meant to steer the current run. Deferred entries
   *  wait for the run to end and run as their own turns, so they are excluded. */
  getSteeringQueuedCount(): number {
    return this.userQueue.filter((m) => !m.deferred).length;
  }

  /** Remove and return the oldest queued message (text + attachments), or null.
   *  The sidecar's queue drain uses this to run queued prompts one at a time as
   *  their own turns once the session is idle (deferred user prompts, plus any
   *  leftovers queued while autopilot was reviewing) — unlike {@link drainQueue},
   *  attachments survive so queued media isn't silently dropped. */
  takeNextQueuedMessage(): QueuedPrompt | null {
    return this.userQueue.shift() ?? null;
  }

  /** Clear the queue, returning the combined text (to restore to the composer).
   *  Queued attachments are dropped on cancel — the composer only restores text. */
  drainQueue(): string {
    return this.userQueue
      .splice(0)
      .map((m) => m.text)
      .join("\n\n");
  }

  /**
   * Tell the agent a new fact at its next turn, as a short hidden message
   * appended after the cached prompt (the same channel as a finished worker),
   * so a mid-session change reaches it without re-rendering the prompt. A
   * later note with the same id replaces one not yet delivered.
   */
  notify(id: string, text: string): void {
    this.notifications.enqueue("goal", id, text, { terminal: true });
  }

  /**
   * Observe urgent background alerts — a background task failed or exited
   * non-zero, or a child agent finished — as they are queued. Hosts use this to
   * wake an idle session (see {@link continueFromNotifications}); a live run
   * already receives them at its next steering boundary. Returns unsubscribe.
   */
  onBackgroundAlert(listener: () => void): () => void {
    return this.notifications.onUrgent(() => listener());
  }

  /**
   * Characters of the tool definitions sent with every request (name,
   * description, JSON schema), for estimator calibration. Cached by tool count:
   * the tool array is append-only.
   */
  private toolDefinitionChars(): number {
    if (this.toolCharsCache?.count === this.tools.length) return this.toolCharsCache.chars;
    let chars = 0;
    for (const tool of this.tools) {
      chars += tool.name.length + tool.description.length;
      try {
        chars += JSON.stringify(resolveToolSchema(tool)).length;
      } catch {
        // A schema that cannot be serialized is not sent either.
      }
    }
    this.toolCharsCache = { count: this.tools.length, chars };
    return chars;
  }

  /** True while an urgent background alert is waiting to be delivered. */
  hasPendingBackgroundAlert(): boolean {
    return this.notifications.hasUrgent();
  }

  /** Monotonic count of human-originated prompts this session has run. */
  getHumanPromptSeq(): number {
    return this.humanPromptSeq;
  }

  /**
   * Start a run from pending background notifications, for a session that had
   * already finished its turn. The notifications become one hidden runtime
   * message (never shown as something the user typed), and the agent decides
   * whether they need action. Returns false, starting nothing, when no urgent
   * alert is pending — a live run may have delivered it in the meantime.
   */
  async continueFromNotifications(): Promise<boolean> {
    if (!this.notifications.hasUrgent()) return false;
    this.prewarmController?.abort();
    await this.settlePostTurnCompaction();
    await this.adoptDeferredCheckpointBeforePrompt();
    const notified = this.notifications.drain();
    if (notified.length === 0) return false;
    const message: Message = {
      role: "user",
      content: buildIdleWakeNotificationText(notified.map((entry) => entry.text)),
      provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    };
    log("INFO", "notifications", "Starting a run from background alerts", {
      count: String(notified.length),
    });
    this.messages.push(message);
    await this.persistMessage(message);
    this.lastPersistedIndex = this.messages.length;
    await this.runLoop();
    return true;
  }

  /** This session's sub-agents (workers), newest-state, including ones restored after a restart. */
  listSubAgents(): SubAgentSnapshot[] {
    return this.subAgentManager?.list() ?? [];
  }

  /** Snapshot of background processes (bash run_in_background), newest-state. */
  listBackgroundProcesses(): BackgroundProcess[] {
    return this.processManager?.list() ?? [];
  }

  /** Stop a background process by id. Returns a human-readable status string. */
  async killBackgroundProcess(id: string): Promise<string> {
    if (!this.processManager) return `No background process with id "${id}"`;
    return this.processManager.stop(id);
  }

  /**
   * Change whether named tools are registered with the live agent loop.
   * Calls made before initialize() also apply to tools registered later.
   */
  setToolAvailability(toolNames: Iterable<string>, available: boolean): void {
    for (const toolName of toolNames) {
      if (available) this.unavailableToolNames.delete(toolName);
      else this.unavailableToolNames.add(toolName);
    }
    this.reconcileRegisteredTools();
  }

  /**
   * Apply a positive runtime capability policy without discarding the original registry.
   * Late tools are guarded on registration; stale references re-check the current policy.
   */
  setToolCapabilityPolicy(
    policy:
      | {
          allowedToolNames: Iterable<string>;
          allowedToolPrefixes?: Iterable<string>;
          unavailableMessage?: (toolName: string) => string;
        }
      | undefined,
  ): void {
    for (const toolName of this.capabilityPromotedBuiltinNames) {
      if (!this.searchedPromotedBuiltinNames.has(toolName)) {
        this.registeredTools.delete(toolName);
      }
    }
    this.capabilityPromotedBuiltinNames.clear();

    this.toolCapabilityPolicy = policy
      ? {
          allowedNames: new Set(policy.allowedToolNames),
          allowedPrefixes: [...(policy.allowedToolPrefixes ?? [])],
          unavailableMessage:
            policy.unavailableMessage ??
            ((toolName) => `${toolName} is unavailable under the active tool capability policy.`),
        }
      : null;

    this.promoteCapabilityAllowedDeferredBuiltins();
    this.reconcileRegisteredTools();
  }

  private promoteCapabilityAllowedDeferredBuiltins(): void {
    if (!this.toolCapabilityPolicy) return;
    for (const [toolName, tool] of this.deferredBuiltinTools) {
      if (ADVISORY_ONLY_TOOL_NAMES.has(toolName)) continue;
      if (!this.isToolCapabilityAllowed(toolName) || this.registeredTools.has(toolName)) continue;
      this.registeredTools.set(toolName, this.guardRegisteredTool(tool));
      this.capabilityPromotedBuiltinNames.add(toolName);
    }
  }

  private prepareToolRegistration(tool: AgentTool): boolean {
    const identity = getMcpToolIdentity(tool);
    if (identity) return this.claimMcpToolIdentity(tool) !== undefined;

    const claimed = this.mcpToolIdentities.get(tool.name);
    if (claimed) {
      // Host tools always keep their declared names. Evict the conflicting MCP
      // identity instead of making registration order choose the implementation.
      log("WARN", "mcp", "Host tool displaced a colliding MCP provider alias", {
        providerName: tool.name,
        mcpIdentity: [claimed.serverName, claimed.toolName],
      });
      this.mcpToolIdentities.delete(tool.name);
      this.liveMcpTools.delete(tool.name);
      this.mcpCatalog?.removeWhere((name) => name === tool.name);
    }
    return true;
  }

  /** Read-only host preflight against the live guarded registry, without executing a tool. */
  supportsToolCall(name: string, args?: unknown): boolean {
    const tool = this.tools.find((candidate) => candidate.name === name);
    return (
      !!tool &&
      this.isToolCapabilityAllowed(name) &&
      !this.unavailableToolNames.has(name) &&
      (args === undefined || tool.parameters.safeParse(args).success)
    );
  }

  /** Register or replace a host-owned runtime tool under the active capability policy. */
  registerTool(tool: AgentTool): void {
    if (!this.prepareToolRegistration(tool)) return;
    const guardedTool = this.guardRegisteredTool(tool);
    this.registeredTools.set(tool.name, guardedTool);
    this.reconcileRegisteredTools();
  }

  private registerTools(tools: Iterable<AgentTool>): void {
    for (const tool of tools) {
      if (!this.prepareToolRegistration(tool)) continue;
      this.registeredTools.set(tool.name, this.guardRegisteredTool(tool));
    }
    this.reconcileRegisteredTools();
  }

  private guardRegisteredTool(tool: AgentTool): AgentTool {
    return guardSessionTool(tool, this.toolGuardHost());
  }

  private toolGuardHost(): SessionToolGuardHost {
    return {
      registeredTool: (name) => this.registeredTools.get(name),
      isUnavailable: (name) => this.unavailableToolNames.has(name),
      isCapabilityAllowed: (name) => this.isToolCapabilityAllowed(name),
      unavailableMessage: (name) => this.toolCapabilityPolicy?.unavailableMessage(name),
      discoveryReview: () => this.discoveryReview,
      setupInspection: () => this.setupInspection,
      advisoryTurn: () => this.advisoryTurn,
      commandCreation: () => this.commandCreation,
      cwd: () => this.cwd,
      options: () => this.opts,
      setPendingAdvisoryPresentation: (presentation) => {
        this.pendingAdvisoryPresentation = presentation;
      },
    };
  }

  private isToolCapabilityAllowed(toolName: string): boolean {
    if (!this.isPersistentToolCapabilityAllowed(toolName)) return false;
    if (this.setupInspection && !this.setupInspection.allows(toolName)) return false;
    if (this.advisoryTurn && !this.advisoryTurn.allows(toolName)) return false;
    if (this.discoveryReview && !this.discoveryReview.allows(toolName)) return false;
    return true;
  }

  /** Prerequisite inventory excludes temporary turn boundaries, never host permissions.
   * Execution must still pass isToolCapabilityAllowed and guardRegisteredTool. */
  private isPersistentToolCapabilityAllowed(toolName: string): boolean {
    if (!this.isToolAllowed(toolName)) return false;
    const policy = this.toolCapabilityPolicy;
    if (!policy) return true;
    if (policy.allowedNames.has(toolName)) return true;
    return policy.allowedPrefixes.some((prefix) => toolName.startsWith(prefix));
  }

  private reconcileRegisteredTools(): void {
    const availableTools = [...this.registeredTools.values()].filter(
      (tool) =>
        !this.unavailableToolNames.has(tool.name) && this.isToolCapabilityAllowed(tool.name),
    );
    this.tools.splice(0, this.tools.length, ...availableTools);
  }

  private unregisterTools(predicate: (toolName: string, tool: AgentTool) => boolean): void {
    for (const [toolName, tool] of this.registeredTools) {
      if (predicate(toolName, tool)) this.registeredTools.delete(toolName);
    }
    this.reconcileRegisteredTools();
  }

  /**
   * Force-stop every background process tree, synchronously. Background
   * commands run in their own process group, so the daemon's group kill on
   * quit never reaches them: this is the only thing that does. Callers on a
   * shutdown deadline run it before awaiting anything that can hang.
   */
  stopBackgroundProcesses(): void {
    this.processManager?.shutdownAll();
  }

  /** Replace a host-owned system prompt in place without resetting conversation history. */
  setCustomSystemPrompt(systemPrompt: string, promptCacheKeyPrefix?: string): void {
    this.customSystemPrompt = systemPrompt;
    this.baseSystemPrompt = systemPrompt;
    this.opts.systemPrompt = systemPrompt;
    if (promptCacheKeyPrefix) this.opts.promptCacheKeyPrefix = promptCacheKeyPrefix;
    const content = this.withSystemPromptTail(systemPrompt);
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  /**
   * Toggle plan mode: flips the shared ref (so tools enforce read-only
   * restrictions) and rebuilds the system prompt in place so the model is told
   * about the mode change on its next turn. No-op when a custom system prompt
   * is in force (the host owns the prompt then).
   */
  async setPlanMode(active: boolean): Promise<void> {
    this.planModeRef.current = active;
    // Plan mode always ends with `exit_plan`; a deferred one must be callable
    // without a tool_search turn.
    if (active) this.promoteDeferredBuiltin("exit_plan");
    // Entering plan mode discards any prior approved-plan contract (a new plan
    // is about to be drafted); exiting keeps it (set explicitly via accept).
    if (active) {
      this.approvedPlanPath = undefined;
      this.approvedPlanConsumption = undefined;
    }
    await this.rebuildSystemPromptInPlace();
  }

  /** Legacy path-based plan activation. Durable app handoffs use the exact-content record below. */
  async setApprovedPlan(approvedPlanPath: string | undefined): Promise<void> {
    this.approvedPlanPath = approvedPlanPath;
    this.approvedPlanConsumption = undefined;
    this.approvedPlanPhaseContext = undefined;
    await this.rebuildSystemPromptInPlace();
  }

  persistApprovedPlanConsumption(
    input: ApprovedPlanConsumptionInput,
  ): Promise<ApprovedPlanConsumptionRecord> {
    return persistApprovedPlanConsumption(this.approvedPlanHost(), input);
  }

  hydrateCanonicalApprovedPlan(
    input: Omit<ApprovedPlanConsumptionRecord, "version">,
  ): Promise<ApprovedPlanConsumptionRecord> {
    return hydrateCanonicalApprovedPlan(this.approvedPlanHost(), input);
  }

  private approvedPlanHost(): SessionApprovedPlanHost {
    return {
      sessionPath: () => this.sessionPath,
      sessionManager: () => this.sessionManager,
      approvedPlanConsumption: () => this.approvedPlanConsumption,
      setApprovedPlanConsumption: (record) => {
        this.approvedPlanConsumption = record;
      },
      setApprovedPlanPath: (planPath) => {
        this.approvedPlanPath = planPath;
      },
      setApprovedPlanPhaseContext: (context) => {
        this.approvedPlanPhaseContext = context;
      },
      setApprovedPlanHydrationDeferred: (deferred) => {
        this.approvedPlanHydrationDeferred = deferred;
      },
      activePhaseContext: () => this.activePhaseContext,
      messages: () => this.messages,
      lockContextProfile: () => {
        this.contextProfileLocked = true;
      },
      persistMessage: (message, required) => this.persistMessage(message, required),
      setLastPersistedIndex: (index) => {
        this.lastPersistedIndex = index;
      },
      persistedTranscriptCount: () => this.persistedTranscriptCount(),
      rebuildSystemPromptInPlace: () => this.rebuildSystemPromptInPlace(),
      refreshSystemPromptTail: () => this.refreshSystemPromptTail(),
    };
  }

  getContinuationReviewRecord(): ContinuationReviewRecord | undefined {
    for (const marker of [...this.appMarkers].reverse()) {
      if (marker.kind !== "user_hint" || !Object.hasOwn(marker.data, "continuationReview"))
        continue;
      // The latest candidate is authoritative: malformed data cannot resurrect
      // an older record. Parsing returns a detached, bounded value.
      return parseContinuationReviewRecord(marker.data.continuationReview, {
        conversationId: this.conversationId,
        profile: this.openAICodexContextProfile,
      });
    }
    return undefined;
  }

  getApprovedPlanConsumption(): ApprovedPlanConsumptionRecord | undefined {
    return this.approvedPlanConsumption ? structuredClone(this.approvedPlanConsumption) : undefined;
  }

  getApprovedPlanPhaseContext(): ActivePhaseContextV1 | undefined {
    return this.approvedPlanPhaseContext
      ? structuredClone(this.approvedPlanPhaseContext)
      : undefined;
  }

  markApprovedPlanImplementationPromptStarted(): Promise<ApprovedPlanConsumptionRecord> {
    return markApprovedPlanImplementationPromptStarted(this.approvedPlanHost());
  }

  completeApprovedPlanConsumption(): Promise<void> {
    return completeApprovedPlanConsumption(this.approvedPlanHost());
  }

  runApprovedPlanImplementation(
    prompt: string,
    generation: number,
    run: () => Promise<void> = () => this.runLoop(),
  ): Promise<void> {
    return runApprovedPlanImplementation(this.approvedPlanHost(), prompt, generation, run);
  }

  resumeApprovedPlanImplementation(
    prompt: string,
    generation: number,
    run?: () => Promise<void>,
  ): Promise<void> {
    return this.runApprovedPlanImplementation(prompt, generation, run);
  }

  /** Extra workspace roots added with `/add-dir`, in the order added. */
  getAdditionalRoots(): string[] {
    return [...this.additionalRoots];
  }

  /**
   * The custom `.gg/commands` slash commands this session can run: the
   * project's, then those of every added root (a goal's attached repos too).
   * Read fresh, so a new command file is picked up without a restart.
   */
  loadCustomCommands(): Promise<CustomCommand[]> {
    return loadWorkspaceCustomCommands([this.cwd, ...this.additionalRoots]);
  }

  /**
   * Add another workspace root. Tools already accept absolute paths, so this
   * only widens the write guard and tells the model the root exists. Rebuilding
   * the system prompt costs one cache-miss turn — the alternative (an uncached
   * suffix) would drift from the tool behaviour it describes.
   *
   * @returns the resolved root, or an error message for the user.
   */
  async addDirectory(
    dir: string,
  ): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
    const resolved = path.resolve(this.cwd, dir.replace(/^~(?=[/\\]|$)/, os.homedir()));
    let stat: Stats;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return { ok: false, error: `Not found: ${resolved}` };
    }
    if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${resolved}` };

    const covered = [this.cwd, ...this.additionalRoots].some((root) => {
      const relative = path.relative(path.resolve(root), resolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (covered) return { ok: false, error: `Already in the workspace: ${resolved}` };

    // Drop roots the new one subsumes so the list stays minimal.
    this.additionalRoots = this.additionalRoots.filter((root) => {
      const relative = path.relative(resolved, path.resolve(root));
      return relative.startsWith("..") || path.isAbsolute(relative);
    });
    this.additionalRoots.push(resolved);
    await this.refreshPromptForRoots();
    return { ok: true, root: resolved };
  }

  /** Remove an exact root previously added with `/add-dir`. */
  async removeDirectory(
    dir: string,
  ): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
    const resolved = path.resolve(this.cwd, dir.replace(/^~(?=[/\\]|$)/, os.homedir()));
    const index = this.additionalRoots.findIndex((root) => path.resolve(root) === resolved);
    if (index === -1) {
      return { ok: false, error: `Not an additional workspace root: ${resolved}` };
    }

    this.additionalRoots.splice(index, 1);
    await this.refreshPromptForRoots();
    return { ok: true, root: resolved };
  }

  /**
   * Name a root change in the prompt only while there is no conversation yet.
   * Mid-conversation the env-delta note tells the model instead: the roots sit
   * in the Environment section, and rewriting it would invalidate every cached
   * message after it (a goal attaching a folder re-sent ~75k tokens).
   */
  private async refreshPromptForRoots(): Promise<void> {
    if (this.messages.some((message) => message.role !== "system")) return;
    await this.rebuildSystemPromptInPlace();
  }

  /**
   * Names to advertise as available-on-demand. A tool the model already
   * promoted lives in `this.tools` and carries its own schema, so it drops out
   * of the index rather than being listed twice.
   */
  private deferredToolNamesForPrompt(liveNames: readonly string[]): string[] {
    if (this.deferredBuiltinToolNames.length === 0) return [];
    const live = new Set(liveNames);
    return this.deferredBuiltinToolNames.filter((name) => !live.has(name));
  }

  /**
   * The environment about to be rendered into a prompt, remembered as the
   * truth the model has been told. Pairs with the env-delta hook: whatever the
   * prompt states, the model is only corrected when reality moves away from it.
   */
  private recordRenderedEnvironment(): SystemPromptEnvironment {
    const environment = this.promptEnvironment();
    this.renderedEnvironment = environment;
    return environment;
  }

  /** Environment facts that vary per session rather than per host. */
  private promptEnvironment(): SystemPromptEnvironment {
    const networkAllow =
      this.settingsManager.get("networkMode") === "allowlist"
        ? this.settingsManager.get("networkAllow")
        : [];
    return { additionalRoots: this.additionalRoots, networkAllow };
  }

  /**
   * Build the stable system-prompt prefix for the current tool set and state.
   *
   * Three modes, in precedence order: a full replacement (`systemPrompt`), a
   * composed sub-agent prompt (`agentPrompt` — agent body plus Tools, project
   * context, return contract and Environment), or the standard prompt.
   */
  private async buildBasePrompt(planMode: boolean, approvedPlanPath?: string): Promise<string> {
    if (this.customSystemPrompt) return this.customSystemPrompt;
    const toolNames = this.tools.map((tool) => tool.name);
    const deferredToolNames = this.deferredToolNamesForPrompt(toolNames);
    // Whatever is rendered now is what the model has been told.
    this.announcedLanguages = new Set(this.activeLanguages);
    if (this.agentPrompt !== undefined) {
      return buildSubAgentSystemPrompt(this.agentPrompt, {
        cwd: this.cwd,
        toolNames,
        deferredToolNames,
        context: this.opts.agentContext,
        role: this.opts.agentRole,
        environment: this.recordRenderedEnvironment(),
        contextLimits: this.contextLimits,
        ...(this.languagesApply() ? { activeLanguages: this.activeLanguages } : {}),
      });
    }
    return buildSystemPrompt(
      this.cwd,
      this.skills,
      planMode,
      this.approvedPlanHydrationDeferred
        ? undefined
        : this.approvedPlanConsumption
          ? {
              content: this.approvedPlanConsumption.content,
              approvedPlanPath: this.approvedPlanConsumption.approvedPlanPath,
            }
          : approvedPlanPath,
      toolNames,
      this.activeLanguages,
      this.provider,
      this.recordRenderedEnvironment(),
      deferredToolNames,
      this.contextLimits,
    );
  }

  /**
   * Bring the system prompt to the exact state the next provider request will
   * send. Shared by real runs and {@link prewarm} so both see one prefix.
   *
   * Languages are re-detected at each task boundary. Before the first reply
   * nothing is cached worth keeping, so a new language simply rebuilds the
   * prompt. After that the prompt is a cached prefix and is left alone: the
   * new language is announced by {@link announceNewLanguages} instead.
   */
  private async prepareSystemPromptForRequest(): Promise<void> {
    if (this.refreshActiveLanguages() && !this.hasReply()) {
      await this.rebuildSystemPromptInPlace();
    }
    this.refreshSystemPromptTail();
  }

  private hasReply(): boolean {
    return this.messages.some((m) => m.role === "assistant");
  }

  /**
   * Give the model style packs for languages that appeared after its prompt
   * was cached (e.g. the previous task scaffolded a TypeScript project), as a
   * hidden message appended to the history rather than a prompt re-render that
   * would throw away the whole cache. Runs just before a new user message is
   * added, so the user's request stays the last thing the model reads and the
   * update is saved in order with the rest of the conversation.
   */
  private async announceNewLanguages(): Promise<void> {
    if (!this.hasReply()) return; // the next request rebuilds the prompt instead
    this.refreshActiveLanguages();
    const fresh = new Set(
      [...this.activeLanguages].filter((id) => !this.announcedLanguages.has(id)),
    );
    if (fresh.size === 0) return;
    for (const id of fresh) this.announcedLanguages.add(id);
    const update = buildLanguageUpdateMessage(fresh, this.cwd);
    if (!update) return;
    this.messages.push(update);
    await this.persistMessage(update);
    this.lastPersistedIndex = this.messages.length;
    log("INFO", "language", "Appended style packs for new languages", {
      added: [...fresh].join(","),
    });
  }

  /**
   * Whether this session renders language packs: the standard prompt, and a
   * code-writing child (a sub-agent prompt with project context). A verbatim
   * custom prompt never does, nor do user-facing specialist agents (Motion,
   * goals) or recon children without project context.
   */
  private languagesApply(): boolean {
    if (this.customSystemPrompt) return false;
    if (this.agentPrompt === undefined) return true;
    return (
      (this.opts.agentRole ?? "subagent") === "subagent" &&
      (this.opts.agentContext ?? "project") === "project"
    );
  }

  /** Add newly detected project languages. Returns true when the set grew. */
  private refreshActiveLanguages(): boolean {
    if (!this.languagesApply()) return false;
    let grew = false;
    try {
      for (const id of detectLanguages(this.cwd)) {
        if (this.activeLanguages.has(id)) continue;
        this.activeLanguages.add(id);
        grew = true;
      }
    } catch (err) {
      log("WARN", "language", `Language detection failed: ${(err as Error).message}`);
      return false;
    }
    if (grew) {
      log("INFO", "language", "Style packs active", {
        active: [...this.activeLanguages].join(","),
      });
    }
    return grew;
  }

  /** Rebuild messages[0] from current plan-mode + approved-plan state. */
  private async rebuildSystemPromptInPlace(): Promise<void> {
    // A full replacement is verbatim by contract — there is nothing to rebuild.
    // A composed agent prompt still must be: its Tools section has to follow
    // late-arriving MCP tools, or a compacted child loses tools it can call.
    if (this.customSystemPrompt) return;
    const rebuilt = await this.buildBasePrompt(this.planModeRef.current, this.approvedPlanPath);
    this.baseSystemPrompt = rebuilt;
    const content = this.withSystemPromptTail(rebuilt);
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  /**
   * Compose the system message: stable prefix, then everything volatile behind
   * the `<!-- uncached -->` marker that providers split on for cache control.
   *
   * Anything that varies with the live model/provider/thinking level belongs in
   * the tail. Putting it in the prefix means every model switch rewrites cached
   * bytes and the next turn pays a full cache write instead of a read.
   */
  private withSystemPromptTail(basePrompt: string): string {
    const tailParts: string[] = [];
    const orchestration = this.orchestrationPolicyTail();
    if (orchestration) tailParts.push(orchestration);
    const hostTail = this.opts.getSystemPromptTail?.();
    if (hostTail) tailParts.push(hostTail);
    if (this.activePhaseContext) {
      tailParts.push(renderActivePhasePackage(this.activePhaseContext).systemPromptSuffix);
    }
    if (tailParts.length === 0) return basePrompt;
    return `${basePrompt}\n\n<!-- uncached -->\n${tailParts.join("\n\n")}`;
  }

  /**
   * Sol/Terra async-orchestration guidance for the CURRENT model and thinking
   * level. Per-switch volatile by definition, so it is rendered as a tail part
   * rather than spliced into the cached prefix.
   */
  private orchestrationPolicyTail(): string {
    if (this.opts.orchestrationPrompt === false) return "";
    return applyAsyncSubagentPolicy(
      "",
      this.provider,
      this.model,
      this.thinkingLevel,
      // Deferred spawn_agent/wait_agent are one call away (resolveTool loads
      // them on first use), so the policy must still see them.
      [...this.tools.map((tool) => tool.name), ...this.deferredBuiltinToolNames],
    ).trim();
  }

  /**
   * Re-render the uncached tail of messages[0] in place. The cached prefix is
   * byte-identical afterwards, so this is safe to call on every model /
   * thinking-level change.
   */
  private refreshSystemPromptTail(): void {
    const content = this.withSystemPromptTail(this.baseSystemPrompt);
    if (this.messages[0]?.role === "system") {
      if (this.messages[0].content === content) return;
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getRunVerificationActivity() {
    return this.verificationEvidenceLedger.runActivity();
  }

  /** Why current code changes are not proven by a passing check, or null. */
  getVerificationProblem(): string | null {
    return this.verificationEvidenceLedger.verificationProblem();
  }

  getVerificationEvidence() {
    return this.verificationEvidenceLedger.workspaceEvidence();
  }

  getVerificationEvidenceLedgerSnapshot(): SessionVerificationEvidenceLedgerSnapshot {
    return this.verificationEvidenceLedger.snapshot();
  }

  getActivePhaseContext(): ActivePhaseContextV1 | undefined {
    return this.activePhaseContext ? structuredClone(this.activePhaseContext) : undefined;
  }

  getPhaseLeaseRunState(): "idle" | "running" {
    return this.phaseLeaseRunState;
  }

  setPhaseLeaseRunState(state: "idle" | "running"): void {
    this.phaseLeaseRunState = state;
  }

  getRoadmapPhaseLeaseMarker(): RoadmapPhaseLeaseMarkerV1 | undefined {
    return this.roadmapPhaseLeaseMarker ? structuredClone(this.roadmapPhaseLeaseMarker) : undefined;
  }

  setRoadmapPhaseLeaseMarker(marker: RoadmapPhaseLeaseMarkerV1): Promise<void> {
    return setRoadmapPhaseLeaseMarker(this.phaseContextHost(), marker);
  }

  private rePersistRoadmapPhaseLeaseMarker(): Promise<void> {
    return rePersistRoadmapPhaseLeaseMarker(this.phaseContextHost());
  }

  setActivePhaseContext(context: ActivePhaseContextV1 | undefined): Promise<void> {
    return setActivePhaseContext(this.phaseContextHost(), context);
  }

  clearActivePhaseContext(reason: ActivePhaseContextClearReason = "cleared"): Promise<void> {
    return clearActivePhaseContext(this.phaseContextHost(), reason);
  }

  updateActivePhaseStage(
    executionStage: ActivePhaseExecutionStage,
    approvedPlanPath?: string,
  ): Promise<ActivePhaseContextV1> {
    return updateActivePhaseStage(this.phaseContextHost(), executionStage, approvedPlanPath);
  }

  private restorePlanStateFromActivePhase(context: ActivePhaseContextV1): void {
    restorePlanStateFromActivePhase(this.phaseContextHost(), context);
  }

  private ensureActivePhaseSessionMetadata(): Promise<void> {
    return ensureActivePhaseSessionMetadata(this.phaseContextHost());
  }

  private rePersistActivePhaseContext(
    context: ActivePhaseContextV1 | undefined = this.activePhaseContext,
  ): Promise<ActivePhaseContextV1 | undefined> {
    return rePersistActivePhaseContext(this.phaseContextHost(), context);
  }

  private phaseContextHost(): SessionPhaseContextHost {
    return {
      cwd: () => this.cwd,
      sessionId: () => this.sessionId,
      sessionPath: () => this.sessionPath,
      sessionManager: () => this.sessionManager,
      activePhaseContext: () => this.activePhaseContext,
      storeActivePhaseContext: (context) => {
        this.activePhaseContext = context;
      },
      leaseMarker: () => this.roadmapPhaseLeaseMarker,
      storeLeaseMarker: (marker) => {
        this.roadmapPhaseLeaseMarker = marker;
      },
      setPlanModeFlag: (planMode) => {
        this.planModeRef.current = planMode;
      },
      setApprovedPlanPath: (planPath) => {
        this.approvedPlanPath = planPath;
      },
      refreshSystemPromptTail: () => this.refreshSystemPromptTail(),
      rebuildSystemPromptInPlace: () => this.rebuildSystemPromptInPlace(),
    };
  }

  getTurnMetrics(): TurnMetricPayload[] {
    return this.turnMetrics.map((metric) => ({
      ...metric,
      usage: { ...metric.usage },
      timing: { ...metric.timing },
      cost: { ...metric.cost },
    }));
  }

  private async persistTurnMetric(event: AgentTurnEndEvent): Promise<void> {
    if (event.stopReason === "error") this.cacheDiagnostics.discardAttempt();
    const cache = this.cacheDiagnostics.complete(event.usage, event.timing);
    if (cache) {
      log("INFO", "cache", "Context cache outcome", {
        sessionId: this.sessionId || this.transportSessionId,
        provider: this.provider,
        model: this.model,
        data: JSON.stringify(cache),
      });
    }
    const payload: TurnMetricPayload = {
      version: 1,
      turn: event.turn,
      provider: this.provider,
      model: this.model,
      stopReason: event.stopReason,
      usage: { ...event.usage },
      timing: { ...event.timing },
      cost: {
        status: "unavailable",
        reason: "No authoritative effective-dated provider pricing is available",
      },
    };
    this.turnMetrics.push(payload);
    // Internal diagnostics piggyback on the authoritative per-turn metric —
    // one source of truth, and the record flushes to disk every turn.
    this.diagnosticsRecorder?.recordTurnMetric(payload);
    if (this.sessionPath) await this.sessionManager.appendTurnMetric(this.sessionPath, payload);
  }

  private async rePersistTurnMetrics(): Promise<void> {
    if (!this.sessionPath) return;
    for (const metric of this.turnMetrics) {
      await this.sessionManager.appendTurnMetric(this.sessionPath, metric);
    }
  }

  /** Ken Kai (mentor) turns recorded against this session, in record order. Used
   *  by the host to interleave Ken's advisory exchanges back into the transcript
   *  on resume. Never part of the LLM message history. */
  getKenTurns(): KenTurnPayload[] {
    return this.kenTurns;
  }

  /** Autopilot verdict markers recorded against this session, in record order.
   *  Used by the host to interleave the auto-review loop's markers back into
   *  the transcript on resume, mirroring `getKenTurns`. */
  getAutopilotMarkers(): AutopilotMarkerPayload[] {
    return this.autopilotMarkers;
  }

  /** Non-system messages that are actually on disk. Transcript markers anchor
   *  against this (not the in-memory list, which can run ahead after a failed
   *  run), so hosts computing marker-derived values must use the same base. */
  getPersistedTranscriptCount(): number {
    return this.persistedTranscriptCount();
  }

  /**
   * Rebase every transcript anchor (Ken turns, autopilot verdicts, app markers)
   * onto a freshly compacted message list. Called right after `this.messages`
   * is replaced and before the markers are re-persisted into the continuation
   * file, so the new file carries positions that match its own transcript.
   */
  private remapMarkerAnchors(remap: CompactionAnchorRemap | undefined): void {
    if (!remap) return;
    const move = <T extends { afterMessageCount: number }>(payload: T): T => ({
      ...payload,
      afterMessageCount: remapAnchorForCompaction(payload.afterMessageCount, remap),
    });
    this.kenTurns = this.kenTurns.map(move);
    this.autopilotMarkers = this.autopilotMarkers.map(move);
    this.appMarkers = this.appMarkers.map(move);
  }

  /**
   * Record one Ken Kai (mentor agent) turn against this build session: the
   * user's question + Ken's reply. Kept in memory for the live transcript and
   * persisted as a `custom` entry (parentId null, so it's never on the message
   * DAG and never seen by the LLM, and can't race the build session's leaf while
   * Ken runs concurrently). `afterMessageCount` anchors it among the messages so
   * the host can interleave it chronologically. No-op persistence for transient
   * sessions (kept in memory only). Best-effort: a write failure is swallowed by
   * appendEntry's own handling.
   */
  async persistKenTurn(question: string, reply: string): Promise<void> {
    const afterMessageCount = this.persistedTranscriptCount();
    const payload: KenTurnPayload = { version: 1, question, reply, afterMessageCount };
    this.contextProfileLocked = true;
    this.kenTurns.push(payload);
    if (!this.sessionPath) return;
    const entry: CustomEntry = {
      type: "custom",
      kind: KEN_TURN_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
  }

  /** Re-append the in-memory Ken turns to the current session file. Called after
   *  a continuation/compaction file is created so Ken's advisory history isn't
   *  lost when the session is rewritten (those rewrites only re-persist
   *  messages). Each turn keeps its original `afterMessageCount` anchor. */
  private async rePersistKenTurns(): Promise<void> {
    if (!this.sessionPath) return;
    for (const payload of this.kenTurns) {
      const entry: CustomEntry = {
        type: "custom",
        kind: KEN_TURN_CUSTOM_KIND,
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        data: stripRecordedPosition(payload),
      };
      await this.sessionManager.appendEntry(this.sessionPath, entry);
    }
  }

  private async persistCompletionReviewState(): Promise<void> {
    if (!this.sessionPath || !this.opts.completionReview) return;
    await this.sessionManager.appendEntry(this.sessionPath, {
      type: "custom",
      kind: COMPLETION_REVIEW_STATE_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: this.opts.completionReview.snapshot(),
    });
  }

  /**
   * Record one autopilot verdict marker (prompted / done / human / capped)
   * against this build session. Kept in memory for the live transcript and
   * persisted as a `custom` entry (parentId null, same as Ken turns) so a
   * resumed session renders the exact same Ken bubble the live run showed
   * instead of dropping the marker or falling back to a raw verdict string.
   * No-op persistence for transient sessions (kept in memory only).
   */
  async persistAutopilotMarker(
    phase: AutopilotMarkerPayload["phase"],
    extra?: { reason?: string; body?: string },
  ): Promise<void> {
    const afterMessageCount = this.persistedTranscriptCount();
    const payload: AutopilotMarkerPayload = {
      version: 1,
      phase,
      afterMessageCount,
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra?.body !== undefined ? { body: extra.body } : {}),
    };
    this.autopilotMarkers.push(payload);
    if (!this.sessionPath) return;
    const entry: CustomEntry = {
      type: "custom",
      kind: AUTOPILOT_MARKER_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
  }

  /** Re-append the in-memory autopilot markers to the current session file.
   *  Mirrors `rePersistKenTurns` — called after a continuation/compaction file
   *  is created so the auto-review history survives the rewrite. */
  private async rePersistAutopilotMarkers(): Promise<void> {
    if (!this.sessionPath) return;
    for (const payload of this.autopilotMarkers) {
      const entry: CustomEntry = {
        type: "custom",
        kind: AUTOPILOT_MARKER_CUSTOM_KIND,
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        data: stripRecordedPosition(payload),
      };
      await this.sessionManager.appendEntry(this.sessionPath, entry);
    }
  }

  /** App transcript markers recorded against this session, in record order.
   *  Used by the host to interleave display-only rows (plan banner, task
   *  header, errors, user-bubble hints) back into the transcript on resume. */
  getAppMarkers(): AppMarkerPayload[] {
    return this.appMarkers;
  }

  /**
   * Record one app transcript marker (display-only row) against this session.
   * Same treatment as autopilot markers: kept in memory for the live
   * transcript, persisted as a `custom` entry (parentId null, never on the
   * message DAG) so a resumed session shows the identical row. `anchorOffset`
   * shifts the recorded `afterMessageCount` — pass +1 for a marker that should
   * attach to the user message about to be pushed by the imminent prompt.
   * No-op persistence for transient sessions.
   */
  async persistAppMarker(
    kind: AppMarkerPayload["kind"],
    data: Record<string, unknown>,
    anchorOffset = 0,
  ): Promise<void> {
    const afterMessageCount = this.persistedTranscriptCount() + anchorOffset;
    const payload: AppMarkerPayload = { version: 1, kind, afterMessageCount, data };
    if (!this.sessionPath) {
      this.appMarkers.push(payload);
      return;
    }
    const entry: CustomEntry = {
      type: "custom",
      kind: APP_MARKER_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
    this.appMarkers.push(payload);
  }

  async persistRequiredAppMarker(
    kind: AppMarkerPayload["kind"],
    data: Record<string, unknown>,
    anchorOffset = 0,
  ): Promise<void> {
    const afterMessageCount = this.persistedTranscriptCount() + anchorOffset;
    const payload: AppMarkerPayload = { version: 1, kind, afterMessageCount, data };
    if (!this.sessionPath) throw new Error("Required app markers need a persistent session.");
    const entry: CustomEntry = {
      type: "custom",
      kind: APP_MARKER_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.sessionManager.appendRequiredEntry(this.sessionPath, entry);
    this.appMarkers.push(payload);
  }

  /**
   * Open the run journal for one `RunLifecycle` generation.
   *
   * Never throws and never blocks the run: a session with no file (transient
   * children) writes nothing, and a write failure just means the run isn't
   * journalled — which is strictly better than failing the run over it.
   */
  async persistRunStarted(generation: number): Promise<void> {
    if (!this.sessionPath) return;
    const startedAt = new Date().toISOString();
    const afterMessageCount = this.persistedTranscriptCount();
    await this.sessionManager.appendRunStarted(this.sessionPath, {
      version: 1,
      generation,
      startedAt,
      afterMessageCount,
    });
    this.runJournal.push({ generation, startedAt, afterMessageCount });
  }

  /** Close the run journal. Its absence is what marks a run as crashed. */
  async persistRunFinished(generation: number, outcome: RunOutcome): Promise<void> {
    if (!this.sessionPath) return;
    await this.sessionManager.appendRunFinished(this.sessionPath, {
      version: 1,
      generation,
      outcome,
    });
    const run = [...this.runJournal].reverse().find((entry) => entry.generation === generation);
    if (run) run.outcome = outcome;
  }

  getRunJournal(): RunJournalEntry[] {
    return structuredClone(this.runJournal);
  }

  async getRunJournalForSession(sessionPath: string): Promise<RunJournalEntry[]> {
    if (sessionPath === this.sessionPath) return this.getRunJournal();
    const loaded = await this.sessionManager.load(sessionPath);
    return this.sessionManager.getRunJournal(loaded.entries);
  }

  private async rePersistApprovedPlanConsumption(): Promise<void> {
    if (!this.sessionPath || !this.approvedPlanConsumption) return;
    const committed: ApprovedPlanConsumptionRecord = {
      ...this.approvedPlanConsumption,
      state: "approval-committed",
    };
    await this.sessionManager.appendApprovedPlanConsumptionRequired(this.sessionPath, committed);
    if (this.approvedPlanConsumption.state === "implementation-prompt-started") {
      await this.sessionManager.appendApprovedPlanConsumptionRequired(
        this.sessionPath,
        this.approvedPlanConsumption,
      );
    }
  }

  /** Re-append the in-memory app markers to the current session file. Mirrors
   *  `rePersistKenTurns` — called after a continuation/compaction file is
   *  created so display-only rows survive the rewrite. */
  private async rePersistAppMarkers(): Promise<void> {
    if (!this.sessionPath) return;
    for (const payload of this.appMarkers) {
      const entry: CustomEntry = {
        type: "custom",
        kind: APP_MARKER_CUSTOM_KIND,
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        data: stripRecordedPosition(payload),
      };
      await this.sessionManager.appendEntry(this.sessionPath, entry);
    }
  }

  /**
   * Rewrite a draft prompt into a tighter, terminology-correct version using
   * the ACTIVE provider/model. A stateless one-off LLM call (no agent loop, no
   * tools, no session mutation) — safe to run even mid-run. Returns the plain
   * enhanced text plus typed segments marking each corrected term. Errors throw
   * so the caller can surface them.
   */
  async enhancePrompt(text: string): Promise<EnhanceResult> {
    if (!text.trim()) return { enhanced: text, segments: [{ kind: "text", text }] };
    // Keep credentials and settings on the model selected at click time, even
    // if the user switches models while credential resolution is pending.
    const { provider, model, thinkingLevel, maxTokens: requestedMaxTokens, baseUrl } = this;
    const threshold = this.settingsManager.get("compactThreshold");
    const creds = await this.resolveRunCredentials(provider, {
      storageKeys: this.currentAuthStorageKeys(),
    });
    const maxTokens = outputCapForRequest({
      provider,
      model,
      maxTokens: requestedMaxTokens,
      threshold,
      accountId: creds.accountId,
    });
    // Cheap, best-effort stack detection from the project root so terminology is
    // idiomatic to the user's stack. Never throws (returns "" on any failure).
    let stack = "";
    try {
      stack = detectProjectStack(this.cwd);
    } catch {
      /* detection is best-effort — fall back to no stack hint */
    }
    return enhancePrompt({
      provider,
      model: resolveTransportModel(provider, model),
      thinking: thinkingLevel,
      maxTokens,
      userAgent: provider === "anthropic" ? await getClaudeCliUserAgent() : undefined,
      projectId: creds.projectId,
      prompt: text,
      stack,
      apiKey: creds.accessToken,
      baseUrl: baseUrl ?? creds.baseUrl,
      accountId: creds.accountId,
      signal: this.opts.signal,
    });
  }

  /** Current reasoning/thinking level, or undefined when thinking is off. */
  getThinkingLevel(): ThinkingLevel | undefined {
    return this.thinkingLevel;
  }

  /** Set the reasoning/thinking level (undefined turns thinking off). Takes
   * effect on the next prompt, since the in-flight loop reads it at start. */
  setThinkingLevel(level: ThinkingLevel | undefined): void {
    this.thinkingLevel = level;
    this.refreshSystemPromptTail();
  }

  /** Replace the abort signal (e.g. after cancellation). */
  setSignal(signal: AbortSignal): void {
    if (signal !== this.opts.signal) this.semanticLoop.controller?.abort();
    this.opts = { ...this.opts, signal };
    this.bindManagerCancellation(signal);
  }

  private bindManagerCancellation(signal: AbortSignal | undefined): void {
    this.managerAbortSignal?.removeEventListener("abort", this.managerAbortHandler);
    this.managerAbortSignal = signal;
    signal?.addEventListener("abort", this.managerAbortHandler, { once: true });
    if (signal?.aborted) this.managerAbortHandler();
  }

  private runLoopDepth = 0;
  private lastRealRequestAt = 0;
  private lastPrewarmAt = 0;
  private prewarmController: AbortController | null = null;

  /**
   * Best-effort Anthropic prompt-cache prewarm before the user's next turn
   * (desktop app calls this on the first keystroke after opening a chat or an
   * idle pause). Sends the exact request prefix the next real turn will use —
   * same system/tools/thinking/cache options — with `max_tokens: 1`, so the
   * first real reply is a cache read instead of a cold write.
   */
  async prewarm(signal?: AbortSignal): Promise<{ ok: boolean; reason: string; usage?: Usage }> {
    if (this.provider !== "anthropic") return { ok: false, reason: "provider" };
    if (this.settingsManager?.get("cachePrewarm") === false) {
      return { ok: false, reason: "disabled" };
    }
    if (this.runLoopDepth > 0) return { ok: false, reason: "run_active" };
    if (this.prewarmController) return { ok: false, reason: "in_flight" };
    const cacheRetention = this.isSpeedOptimized() ? "long" : "short";
    const ttlMs = (cacheRetention === "long" ? 60 : 5) * 60_000;
    const now = Date.now();
    if (now - Math.max(this.lastPrewarmAt, this.lastRealRequestAt) < ttlMs) {
      return { ok: false, reason: "cache_fresh" };
    }
    // Same preparation as the real run, BEFORE copying history: otherwise the
    // warmed system block differs from the next request (language packs are
    // detected at run start) and everything after it misses the cache.
    await this.prepareSystemPromptForRequest();
    // The await above yields: re-check that no run or other prewarm began.
    if (this.runLoopDepth > 0) return { ok: false, reason: "run_active" };
    if (this.prewarmController) return { ok: false, reason: "in_flight" };
    // End at the last user/tool message: the next real turn appends a new user
    // message after the trailing assistant reply, and its cache lookback hits
    // the entry written at this boundary. A request must end on a user turn.
    let end = this.messages.length;
    while (end > 0 && this.messages[end - 1]?.role === "assistant") end--;
    // The loop repairs tool pairing in place before every request; apply the
    // same repair to a copy so the warmed prefix is byte-identical to it.
    const messages = structuredClone(this.messages.slice(0, end));
    repairToolPairingAdjacent(messages);
    if (!messages.some((m) => m.role === "user" || m.role === "tool")) {
      return { ok: false, reason: "no_history" };
    }
    const tokens = estimateConversationTokens(messages);
    if (tokens < 4_000) return { ok: false, reason: "too_small" };

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.prewarmController = controller;
    const started = Date.now();
    try {
      const creds = await this.authStorage.resolveCredentials(this.provider, {
        storageKeys: this.currentAuthStorageKeys(),
      });
      if (controller.signal.aborted || this.runLoopDepth > 0) {
        return { ok: false, reason: "aborted" };
      }
      const modelInfo = getModel(this.model);
      const result = stream({
        provider: this.provider,
        model: this.model,
        messages,
        tools: this.tools,
        webSearch: this.nativeWebSearchOn(),
        maxTokens: this.requestMaxTokens(creds.accountId),
        thinking: this.planModeRef.current
          ? clampThinkingForPlanMode(this.thinkingLevel)
          : this.thinkingLevel,
        apiKey: creds.accessToken,
        baseUrl: this.baseUrl ?? creds.baseUrl,
        accountId: creds.accountId,
        transportSessionId: this.sessionId || this.transportSessionId,
        cacheRetention,
        promptCacheKey: this.getPromptCacheKey(),
        supportsImages: modelInfo?.supportsImages,
        supportsVideo: modelInfo?.supportsVideo,
        userAgent: await getClaudeCliUserAgent(),
        prewarm: true,
        signal: controller.signal,
      });
      const response = await result.response;
      const usage = response.usage;
      if (usage.inputTokens === 0 && usage.outputTokens === 0) {
        // gg-ai sent nothing: budget thinking can't stay identical at max_tokens 1.
        log("INFO", "prewarm", "Cache prewarm skipped: budget thinking", {
          model: this.model,
        });
        return { ok: false, reason: "thinking_budget_incompatible" };
      }
      this.lastPrewarmAt = Date.now();
      const warmedPolicy = resolveCacheTtl({
        provider: this.provider,
        model: this.model,
        cacheRetention,
        baseUrl: this.baseUrl ?? creds.baseUrl,
        accountId: creds.accountId,
      });
      if (warmedPolicy) {
        this.cacheDiagnostics.noteCacheTouch({
          at: started,
          provider: this.provider,
          model: this.model,
          policy: warmedPolicy,
        });
      }
      log("INFO", "prewarm", "Cache prewarm complete", {
        tokens: String(tokens),
        cacheRead: String(usage.cacheRead ?? 0),
        cacheWrite: String(usage.cacheWrite ?? 0),
        ms: String(Date.now() - started),
      });
      return { ok: true, reason: "warmed", usage };
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return { ok: false, reason: "aborted" };
      log(
        "WARN",
        "prewarm",
        `Cache prewarm failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: "error" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.prewarmController === controller) this.prewarmController = null;
    }
  }

  private codexShapeSetting(key: "codexResponsesLite" | "codexStrictTools"): CodexShapeSetting {
    return this.settingsManager?.get(key) ?? "auto";
  }

  /** True when speedProfile is "optimized" (1-h cache TTL + pre-warm), or the
   *  session was constructed with `forceLongCacheRetention` (Ken sessions). */
  private isSpeedOptimized(): boolean {
    return (
      this.opts.forceLongCacheRetention === true ||
      this.settingsManager?.get("speedProfile") === "optimized"
    );
  }

  /**
   * Ordered auth-storage keys the current (provider, model) pair tries, first
   * match wins. Almost always just the provider id; Xiaomi models can prefer
   * one endpoint and fall back to another the user configured instead (e.g.
   * `mimo-v2.6-pro` prefers the Token Plan, falls back to API Credits; the
   * API-only `mimo-v2.6-pro-ultraspeed` has no fallback).
   */
  private currentAuthStorageKeys(): string[] {
    return getAuthStorageKeys(this.provider, this.model);
  }

  /** Re-read shared credentials without refreshing tokens or making network calls. */
  async refreshStoredAuthState(): Promise<void> {
    this.lastAccountId =
      this.provider === "openai"
        ? (await this.authStorage.getCredentials("openai"))?.accountId
        : undefined;
  }

  private getPromptCacheKey(): string | undefined {
    if (this.opts.promptCacheKey) return this.opts.promptCacheKey;
    if (!this.sessionId) return undefined;
    return `${this.opts.promptCacheKeyPrefix ?? "ggcoder"}:${this.sessionId}`;
  }

  /** Stable cache-routing key for downstream sub-agent processes. */
  getCurrentCacheKey(): string | undefined {
    return this.getPromptCacheKey();
  }

  private createMcpManager(): MCPClientManager {
    const manager = new MCPClientManager({
      catalogCache: this.mcpCatalogCache,
      modernProtocol: this.settingsManager.get("mcpModernProtocol"),
      onElicit: this.opts.onMcpElicit,
      onServerStateChange: (change) => {
        if (manager !== this.mcpManager) return;
        this.applyMcpServerState(change);
      },
      onConnectResult: (result) => {
        if (manager !== this.mcpManager) return;
        this.recordMcpConnectOutcome(result);
      },
    });
    return manager;
  }

  /** Remove one server's exact identities synchronously, then publish only the
   * replacement connection's freshly filtered wrappers. */
  private applyMcpServerState(change: {
    name: string;
    status: "connected" | "disconnected" | "recovering";
    tools: AgentTool[];
    error?: string;
  }): void {
    const staleProviderNames = new Set(
      [...this.mcpToolIdentities.entries()]
        .filter(([, identity]) => identity.serverName === change.name)
        .map(([providerName]) => providerName),
    );
    this.unregisterTools((_toolName, tool) => {
      const identity = getMcpToolIdentity(tool);
      return identity?.serverName === change.name;
    });
    this.mcpCatalog?.removeWhere((providerName) => staleProviderNames.has(providerName));
    for (const providerName of staleProviderNames) {
      this.liveMcpTools.delete(providerName);
      this.mcpToolIdentities.delete(providerName);
    }

    let published: AgentTool[] = [];
    if (change.status === "connected") {
      published = this.opts.allowedTools
        ? change.tools.filter((tool) => this.isToolAllowed(tool.name, getMcpToolIdentity(tool)))
        : change.tools;
      this.addMcpTools(published);
    }
    this.eventBus.emit("mcp_server_state", {
      name: change.name,
      status: change.status,
      toolCount: published.length,
      ...(change.error ? { error: change.error } : {}),
    });
    if (change.status === "connected" && this.messages.length > 0) {
      void this.rebuildSystemPromptInPlace();
    }
  }

  private async disposeMcpResources(
    manager: MCPClientManager | undefined,
    leases: SharedMcpClientLease[],
  ): Promise<void> {
    await Promise.all([manager?.dispose(), ...leases.map((lease) => lease.release())]);
  }

  private async disposeMcpConnections(): Promise<void> {
    ++this.mcpConnectionGeneration;
    const manager = this.mcpManager;
    this.mcpManager = undefined;
    const leases = [...this.sharedMcpLeases.values()];
    this.sharedMcpLeases.clear();
    await this.disposeMcpResources(manager, leases);
  }

  async dispose(beforeSessionReset?: () => Promise<void>, awaitProcesses = false): Promise<void> {
    // First and synchronous: nothing below may delay this, or a hung teardown
    // step leaves background commands running after the app has quit.
    if (!awaitProcesses) this.stopBackgroundProcesses();
    this.installedWatchStop?.();
    this.assessmentSequence++;
    this.commandCreation?.dispose();
    this.programmaticProfile?.dispose();
    this.discoveryReview?.close();
    this.discoveryCandidates = null;
    this.setupInspection?.close();
    this.advisoryTurn?.close();
    this.advisoryTurn = undefined;
    this.advisoryEvidence.clear();
    this.semanticLoop.controller?.abort();
    this.semanticLoop.verdict = null;
    await this.settlePostTurnCompaction();
    this.cacheDiagnostics.reset();
    this.diagnosticsRecorder?.finalize();
    this.managerAbortSignal?.removeEventListener("abort", this.managerAbortHandler);
    if (awaitProcesses) this.eventBus.removeAllListeners();
    const processes = awaitProcesses
      ? [this.processManager?.shutdownAllAndWait(), this.lspManager?.shutdownAllAndWait()]
      : [this.processManager?.shutdownAll(), this.lspManager?.shutdownAll()];
    this.debugManager?.shutdown();
    await Promise.all([
      ...processes,
      this.subAgentManager?.shutdownAll(),
      this.disposeMcpConnections(),
    ]);
    await this.extensionLoader.deactivateAll();
    try {
      await beforeSessionReset?.();
    } finally {
      this.setSessionPath("");
      this.eventBus.removeAllListeners();
      this.messages = [];
      this.tools.splice(0, this.tools.length);
      this.registeredTools.clear();
      this.unavailableToolNames.clear();
      this.toolCapabilityPolicy = null;
    }
  }

  // ── Private ────────────────────────────────────────────

  private setSessionPath(nextPath: string): void {
    if (this.sessionPath === nextPath) return;
    if (this.sessionPath) this.sessionManager.unregisterActivePath(this.sessionPath);
    this.sessionPath = nextPath;
    if (nextPath) this.sessionManager.registerActivePath(nextPath);
  }

  private async createNewSession(): Promise<void> {
    const continuingConversation = Boolean(this.conversationId && this.sessionId);
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model, {
      conversationId: this.conversationId || undefined,
      generation: continuingConversation ? this.checkpointGeneration + 1 : 0,
      parentSessionId: continuingConversation ? this.sessionId : undefined,
      preview: this.sessionPreview || undefined,
      openAICodexContextProfile: this.openAICodexContextProfile,
    });
    this.sessionId = session.id;
    this.checkpointGeneration = session.header.generation ?? 0;
    this.conversationId = session.header.conversationId ?? session.id;
    this.setSessionPath(session.path);
    this.lastPersistedIndex = this.messages.length;
  }

  private async loadExistingSession(
    sessionPath: string,
    resolveCanonical = true,
    expectedConversationId?: string,
  ): Promise<void> {
    // A stale physical checkpoint is only an address, not the conversation tip.
    // Resolve every resume—not just over-threshold/deferred compaction resumes—
    // before reading history so the next prompt cannot continue an old branch.
    const canonicalPath = resolveCanonical
      ? ((await this.sessionManager.resolveCanonicalSession(sessionPath, this.cwd)) ?? sessionPath)
      : sessionPath;
    const expectedProjectKey = canonicalProjectKey(this.cwd);
    const loaded = await this.sessionManager.load(canonicalPath, {
      projectKey: expectedProjectKey,
      resolveCanonical: false,
    });
    // A caller retaining mentor context must supply a captured conversation ID,
    // and the durable header must verify it before any in-memory mutation.
    if (
      expectedConversationId &&
      (loaded.header.conversationId ?? loaded.header.id) !== expectedConversationId
    ) {
      throw new Error("Checkpoint conversation does not match the captured destination.");
    }
    // Inspect the whole durable DAG, not just the selected branch. Empty
    // checkpoints with lineage cannot prove no conversation has ever started.
    this.contextProfileLocked = Boolean(
      (this.conversationId === (loaded.header.conversationId ?? loaded.header.id) &&
        !this.getOpenAICodexContextProfileEligibility().canChange) ||
      loaded.header.parentSessionId ||
      (loaded.header.generation ?? 0) > 0 ||
      (loaded.header.conversationId && loaded.header.conversationId !== loaded.header.id) ||
      loaded.entries.some(
        (entry) =>
          (entry.type === "message" && entry.message.role !== "system") ||
          entry.type === "compaction" ||
          (entry.type === "custom" && entry.kind === KEN_TURN_CUSTOM_KIND),
      ),
    );
    // Use the leaf from the header to walk the correct branch
    const loadedMessages = this.sessionManager.getMessages(loaded.entries, loaded.header.leafId);
    const savedCompletionReview = [...loaded.entries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.kind === COMPLETION_REVIEW_STATE_KIND);
    this.opts.completionReview?.restore(
      savedCompletionReview?.type === "custom" ? savedCompletionReview.data : null,
    );
    this.hookToolCalls.clear();
    this.checkpointGeneration = loaded.header.generation ?? 0;
    const restoredConversationId = loaded.header.conversationId ?? loaded.header.id;
    // Retire the old conversation's receipts at the identity transition, after
    // loading and validating the destination. Same-conversation checkpoints and
    // restores rejected before this point keep their evidence.
    if (this.conversationId !== restoredConversationId) {
      this.advisoryTurn?.close();
      this.advisoryEvidence.clear();
      // Compaction lineage is per conversation, not per AgentSession object.
      this.compactionPredecessorSessions = [];
    }
    this.conversationId = restoredConversationId;
    this.openAICodexContextProfile = loaded.header.openAICodexContextProfile ?? "stable";
    const legacyLabel = [...loaded.entries]
      .reverse()
      .find((entry) => entry.type === "label")
      ?.label.replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    this.sessionPreview =
      legacyLabel || loaded.header.preview || findUserSessionPrompt(loadedMessages);
    // Restore Ken's advisory turns (custom entries, not on the message branch) so
    // they reappear in the transcript and survive into the continuation file.
    // The leaf is passed so each marker also carries its FILE-order position,
    // the fallback used when a legacy anchor is out of range (see
    // RecordedPosition).
    this.kenTurns = this.sessionManager.getKenTurns(loaded.entries, loaded.header.leafId);
    // Restore autopilot verdict markers the same way (not on the message DAG).
    this.autopilotMarkers = this.sessionManager.getAutopilotMarkers(
      loaded.entries,
      loaded.header.leafId,
    );
    // Restore app transcript markers (plan banner / task header / errors / hints).
    this.appMarkers = this.sessionManager.getAppMarkers(loaded.entries, loaded.header.leafId);
    this.turnMetrics = this.sessionManager.getTurnMetrics(loaded.entries);
    this.activePhaseContext = this.sessionManager.getActivePhaseContext(loaded.entries, {
      projectKey: expectedProjectKey,
    });
    this.roadmapPhaseLeaseMarker = this.sessionManager.getRoadmapPhaseLeaseMarker(loaded.entries, {
      projectKey: expectedProjectKey,
      phaseId: this.activePhaseContext?.phase.id,
    });
    if (this.activePhaseContext) this.restorePlanStateFromActivePhase(this.activePhaseContext);
    this.approvedPlanConsumption = this.sessionManager.getApprovedPlanConsumption(loaded.entries);
    this.approvedPlanPhaseContext = this.sessionManager.getApprovedPlanPhaseContext(loaded.entries);
    if (this.approvedPlanConsumption) {
      this.approvedPlanPath = this.approvedPlanConsumption.approvedPlanPath;
    }
    if (this.activePhaseContext || this.approvedPlanConsumption) {
      await this.rebuildSystemPromptInPlace();
      this.refreshSystemPromptTail();
    }
    // A run that opened the journal and never closed it died mid-flight. Read
    // it here, before anything rewrites the file, and report it once the
    // transcript is in place.
    this.runJournal = this.sessionManager.getRunJournal(loaded.entries);
    const interruptedRuns = this.runJournal.filter((run) => run.outcome === undefined);

    // Track the current leaf for subsequent entries
    this.currentLeafId = loaded.header.leafId;

    // Rebuild messages: keep system, add loaded. Older gg-app sessions may
    // contain full-resolution attachments; repair them once on load so they do
    // not fail when Anthropic's stricter many-image limit activates later.
    const systemMsg = this.messages[0]; // Already built
    this.messages = [systemMsg, ...loadedMessages];
    // Reads recorded for the previous conversation don't carry over.
    this.clearReadTracker?.();
    const normalizedImageCount = await normalizeMessageImages(this.messages);
    if (normalizedImageCount > 0) {
      log("INFO", "session", `Resized ${normalizedImageCount} restored session image(s)`);
    }
    // Auto-compact on load if the restored session exceeds the context window.
    // Without this, huge sessions (1M+ tokens) get loaded into memory and OOM.
    const creds = await this.resolveRunCredentials(this.provider, {
      storageKeys: this.currentAuthStorageKeys(),
    });
    // Cache for sync callers (see field doc) so the app-sidecar's footer shows
    // the right context window immediately on resume, before any prompt runs
    // runLoop() and would otherwise be the first to set this.
    this.lastAccountId = creds.accountId;
    const contextWindow = getContextWindow(this.model, {
      provider: this.provider,
      accountId: creds.accountId,
      openAICodexContextProfile: this.openAICodexContextProfile,
    });
    this.sessionId = loaded.header.id;
    this.setSessionPath(loaded.path);
    this.lastPersistedIndex = this.messages.length;

    const loadPolicy = resolveCompactionPolicy({
      provider: this.provider,
      model: this.model,
      contextWindow,
      threshold: this.settingsManager.get("compactThreshold"),
      accountId: creds.accountId,
      approvedPlanPath: this.approvedPlanPath,
    });
    log("INFO", "compaction", "Restore compaction decision", {
      provider: this.provider,
      model: this.model,
      transport: this.provider === "openai" && creds.accountId ? "codex_oauth" : "public_api",
      contextWindow: String(contextWindow),
      activeTokens: "estimated",
      triggerLimit: String(loadPolicy.targetTokens),
    });
    const needsLoadCompaction =
      this.settingsManager.get("autoCompact") &&
      shouldCompact(
        this.messages,
        contextWindow,
        loadPolicy.threshold,
        undefined,
        loadPolicy.targetTokens,
      );
    if (needsLoadCompaction && this.opts.deferLoadCompaction) {
      // Canonicalize again immediately before the first prompt is persisted:
      // another process may create the shared checkpoint after this load.
      this.deferredCompactionPending = true;
      log(
        "INFO",
        "session",
        "Restored session exceeds context — deferring compaction to first prompt",
      );
    } else if (needsLoadCompaction) {
      await this.subAgentManager?.hydrate(loaded.header.id);
      log("INFO", "session", `Restored session exceeds context — auto-compacting`);
      await this.compact(creds, "automatic");
      if (this.lastCompactionCompacted) {
        await this.recordInterruptedRuns(interruptedRuns);
        await this.migrateLegacyOpenAICodexFast(loaded.header, loaded.path);
        return;
      }
    }

    // Plain resume (no compaction needed): keep using the original session
    // file/id and append future turns to it in place. Forking a new file here
    // unconditionally used to create a byte-identical duplicate every time a
    // session was merely reopened (e.g. app/window restart) with zero new
    // messages in between — the duplicate entries seen in the session list.
    this.sessionId = loaded.header.id;
    this.setSessionPath(loaded.path);
    this.lastPersistedIndex = this.messages.length;
    await this.recordInterruptedRuns(interruptedRuns);
    await this.migrateLegacyOpenAICodexFast(loaded.header, loaded.path);
  }

  /**
   * Surface runs that died mid-flight, without resuming them.
   *
   * Deliberately NOT auto-resumed: the dead run's tools already wrote files,
   * ran commands and made commits. Replaying it would duplicate those effects.
   * The user gets a transcript row and decides.
   *
   * Each detected run is also closed as `aborted`, so reopening the session
   * reports it once rather than on every load.
   */
  private async recordInterruptedRuns(runs: RunJournalEntry[]): Promise<void> {
    for (const run of runs) {
      log("WARN", "session", "Restored a session with an unfinished run", {
        generation: String(run.generation),
        startedAt: run.startedAt,
      });
      await this.persistAppMarker("interrupted_run", {
        generation: run.generation,
        startedAt: run.startedAt,
      });
      await this.persistRunFinished(run.generation, "aborted");
    }
  }

  private async prepareDynamicContext(_latestUserPrompt?: string): Promise<Message[]> {
    return this.messages;
  }

  private async persistMessage(message: Message, required = false): Promise<void> {
    if (
      !this.sessionPreview &&
      message.role === "user" &&
      (message.provenance?.source === "human" || !message.provenance)
    ) {
      this.sessionPreview = getUserSessionPrompt(message.content, message.provenance) ?? "";
    }
    // Transient sessions (subagent spawns) have no session file — skip.
    if (!this.sessionPath) return;
    const entryId = crypto.randomUUID();
    const entry: MessageEntry = {
      type: "message",
      id: entryId,
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      message,
    };
    if (required) {
      await this.sessionManager.appendRequiredMessage(this.sessionPath, entry);
    } else {
      await this.sessionManager.appendEntry(this.sessionPath, entry);
      await this.sessionManager.updateLeaf(this.sessionPath, entryId);
    }
    this.currentLeafId = entryId;
    const meta = this.promptHints.get(message);
    if (meta) {
      const messages = this.activeLoopMessages ?? this.messages;
      const index = messages.indexOf(message);
      if (index < 0) throw new Error("Prompt hint message is not in the accepted transcript");
      const afterMessageCount = messages
        .slice(0, index + 1)
        .filter((m) => m.role !== "system").length;
      await this.persistAppMarker(
        "user_hint",
        { ...meta },
        afterMessageCount - this.persistedTranscriptCount(),
      );
      this.promptHints.delete(message);
    }
  }

  private createSlashCommandContext(): SlashCommandContext {
    return {
      switchModel: (provider, model, options) => this.switchModel(provider, model, options),
      compact: (focus?: string) => this.compact(undefined, "manual", focus),
      newSession: () => this.newSession(),
      listSessions: async () => {
        const sessions = await this.sessionManager.list(this.cwd);
        if (sessions.length === 0) return "No sessions found.";
        return sessions
          .map((s) => `  ${s.id.slice(0, 8)} — ${s.timestamp} (${s.messageCount} messages)`)
          .join("\n");
      },
      getSettings: () => this.settingsManager.getAll() as unknown as Record<string, unknown>,
      setSetting: async (key, value) => {
        await this.settingsManager.set(
          key as keyof ReturnType<SettingsManager["getAll"]>,
          value as never,
        );
      },
      getModelList: () => {
        const current = `Current: ${this.provider}:${getModelDisplayId(this.model)}\n\nAvailable models:\n`;
        const list = MODELS.map(
          (model) =>
            `  ${model.provider}:${getModelDisplayId(model.id)} — ${model.name} (${model.costTier})`,
        ).join("\n");
        return current + list;
      },
      quit: () => {
        process.exit(0);
      },
      branch: async (stepsBack?: number) => {
        const result = await this.branch(stepsBack);
        return `Branched: rewound from ${result.branchedFrom} to ${result.messagesKept} messages. New messages will fork from here.`;
      },
      listBranches: async () => {
        const branches = await this.listBranches();
        if (branches.length <= 1) return "No branches — conversation is linear.";
        const lines = branches.map(
          (b, i) =>
            `  ${i + 1}. ${b.leafId.slice(0, 8)} — ${b.entryCount} entries (${b.leafId === this.currentLeafId ? "active" : "inactive"})`,
        );
        return `${branches.length} branch(es):\n${lines.join("\n")}`;
      },
      addDirectory: (dir) => this.addDirectory(dir),
      removeDirectory: (dir) => this.removeDirectory(dir),
      getAdditionalRoots: () => this.getAdditionalRoots(),
    };
  }

  /**
   * Import a Claude Code / Codex / Cursor transcript as a resumable GG Coder
   * session in this session's sessions directory. Never throws — a bad path or
   * an unrecognized format comes back as `{ ok: false, error }` so both the CLI
   * and the desktop app can show it verbatim.
   */
  async importForeignTranscript(
    filePath: string,
    opts: { cwd?: string } = {},
  ): Promise<ImportForeignTranscriptResult> {
    try {
      const imported = await importForeignSession({
        filePath: resolveHomePath(filePath),
        sessionManager: this.sessionManager,
        provider: this.provider,
        model: this.model,
        cwd: opts.cwd ?? undefined,
      });
      log("INFO", "import", "Imported foreign transcript", {
        format: imported.format,
        messages: String(imported.messageCount),
      });
      return {
        ok: true,
        sessionId: imported.sessionId,
        sessionPath: imported.sessionPath,
        cwd: imported.cwd,
        format: imported.format,
        messageCount: imported.messageCount,
        dropped: describeDropped(imported.dropped),
        ...(imported.preview ? { preview: imported.preview } : {}),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Expand a leading `~` so `/import ~/.codex/...` works from any shell. */
function resolveHomePath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
