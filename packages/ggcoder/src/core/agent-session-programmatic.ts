// Local Fork-owned: programmatic assessment and discovery review for
// AgentSession. Kept out of agent-session.ts so upstream syncs of that file
// stay small.
import {
  isProgrammaticAssessment,
  isProgrammaticAssessmentEvent,
  type ProgrammaticAreaProgress,
  type ProgrammaticAssessment,
} from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { ProviderError, type Message, type MessageProvenance } from "@kenkaiiii/gg-ai";
import type { PromptMeta } from "@kenkaiiii/gg-core/desktop-session-ux";
import type {
  DiscoveryReviewRequest,
  DiscoveryReview,
} from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import type { BusEventMap, EventBus } from "./event-bus.js";
import type { SlashCommandRegistry } from "./slash-commands.js";
import { getPromptCommand } from "./prompt-commands.js";
import {
  discoverCommands,
  registryCommandListings,
  programmaticReadinessGuidance,
  type ProgrammaticReadiness,
} from "./command-discovery.js";
import {
  buildProgrammaticAdvisoryContext,
  buildProgrammaticAssessmentContext,
  parseProgrammaticAssessmentInput,
  renderProgrammaticAdvisoryContext,
} from "./programmatic/advisory-context.js";
import {
  recheckAssessmentEvidence,
  type AssessmentEvidenceAuthorization,
  type AssessmentEvidenceRequest,
} from "./programmatic/assessment-evidence.js";
import {
  ADVISORY_LIMITATIONS,
  AdvisoryEvidence,
  INCOMPLETE_ADVISORY_NOTICE,
  type ProgrammaticAdvisoryTurn,
  ADVISORY_READ_TOOLS,
} from "./programmatic/advisory.js";
import {
  DiscoveryReviewBoundary,
  discoveryEvidencePaths,
  discoveryReviewPrompt,
} from "./programmatic/discovery-review.js";
import { readRecommendationHistory } from "./programmatic/recommendation-history.js";
import { recommendationDetail } from "./programmatic/recommendations.js";
import { createCommandInformationTool } from "../tools/command-information.js";
import { createProgrammaticAdvisoryResultTool } from "../tools/programmatic-advisory-result.js";
import { NotLoggedInError } from "./auth-storage.js";
import type { CreateToolsResult } from "../tools/index.js";
import {
  ProgrammaticAssessmentCoordinator,
  type ProgrammaticAssessmentOutcome,
} from "./programmatic/assessment.js";
import {
  captureAssessmentHistoryPolicy,
  saveAssessmentHistory,
} from "./programmatic/assessment-history.js";
import { ProgrammaticSetupInspection } from "./programmatic/setup-inspection.js";
import {
  collectProgrammaticAreaMap,
  type AreaMapCollectResult,
} from "./programmatic/area-map-collect.js";
import {
  mergeAreaCandidates,
  runAreaPasses,
  selectAreaSearch,
  type AreaSearchDecision,
  type AreaStatusFact,
  type MergedAreaCandidate,
} from "./programmatic/area-search.js";
import { runAreaPass } from "./programmatic/area-pass.js";
import type { ProgrammaticAreaV1 } from "./programmatic/area-map.js";
import {
  assessmentAreas,
  createAreaProgress,
  settledAreaProgress,
  withoutFinds,
  type AreaSearchCache,
} from "./programmatic/area-progress.js";
import {
  AreaRetryUnavailableError,
  assertAreaRetryFresh,
  citedFileDigests,
  retryTarget,
  structuralAreaMapDigest,
} from "./programmatic/area-retry.js";
import type { ProgrammaticChatRetryArea } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { createGitHistoryTool } from "../tools/git-history.js";
import type { AgentSessionOptions } from "./agent-session.js";

type DiscoveryCandidates = {
  owner: string | null;
  sequence: number;
  records: NonNullable<ProgrammaticAssessmentOutcome["discoveryRecords"]>;
} | null;

type PromptTemplateOptions = {
  disableTools?: boolean;
  onAccepted?: () => void | Promise<void>;
  meta?: PromptMeta;
};

/** Live AgentSession state used by programmatic flows; every getter reads the current value. */
export interface SessionProgrammaticHost {
  tools: {
    registered(): Map<string, AgentTool>;
    deferred(): Map<string, AgentTool>;
    list(): AgentTool[];
    guard(tool: AgentTool): AgentTool;
    reconcile(): void;
    isCapabilityAllowed(name: string): boolean;
    unavailable(): Set<string>;
    supports(name: string, args?: unknown): boolean;
    register(tool: AgentTool): void;
    searchedPromoted(): Set<string>;
    capabilityPromoted(): Set<string>;
  };
  boundaries: {
    advisoryTurn(): ProgrammaticAdvisoryTurn | undefined;
    setAdvisoryTurn(turn: ProgrammaticAdvisoryTurn | undefined): void;
    setupInspection(): ProgrammaticSetupInspection | undefined;
    setSetupInspection(inspection: ProgrammaticSetupInspection | undefined): void;
    discoveryReview(): DiscoveryReviewBoundary | undefined;
    setDiscoveryReview(review: DiscoveryReviewBoundary | undefined): void;
    advisoryEvidence(): AdvisoryEvidence;
    setAdvisoryEvidence(evidence: AdvisoryEvidence): void;
    setPendingAdvisoryPresentation(presentation: undefined): void;
    programmaticProfile(): CreateToolsResult["programmaticProfile"] | undefined;
    commandCreation(): CreateToolsResult["commandCreation"] | undefined;
  };
  assessment: {
    active(): boolean;
    setActive(active: boolean): void;
    sequence(): number;
    /** Pre-increments the session sequence and returns the new value. */
    nextSequence(): number;
    candidates(): DiscoveryCandidates;
    setCandidates(candidates: DiscoveryCandidates): void;
    areaSearch(): AreaSearchCache | null;
    setAreaSearch(cache: AreaSearchCache | null): void;
  };
  session: {
    sessionId(): string;
    cwd(): string;
    options(): AgentSessionOptions;
    planMode(): boolean;
    conversationIdentity(): { conversationId: string; sessionId: string };
    eventBus(): EventBus;
    readReadiness(): Promise<ProgrammaticReadiness>;
    slashCommands(): SlashCommandRegistry;
    hookText(): string;
    hookToolCallCount(): number;
    hookFileEditCounts(): Map<string, number>;
  };
  transcript: {
    acceptPromptTemplate(
      content: string,
      provenance: MessageProvenance,
      options?: PromptTemplateOptions,
    ): Promise<void>;
    expandResolvedPromptCommand(prompt: string, args: string): string;
    messages(): Message[];
    persistMessage(message: Message): Promise<void>;
    setLastPersistedIndex(index: number): void;
  };
}

export async function reviewDiscoveryCandidate(
  sessionHost: SessionProgrammaticHost,
  request: DiscoveryReviewRequest,
): Promise<DiscoveryReview> {
  const owner = sessionHost.session.sessionId(),
    sequence = sessionHost.assessment.sequence();
  const allowed = () =>
    sessionHost.session.sessionId() === owner &&
    sessionHost.assessment.sequence() === sequence &&
    !sessionHost.session.options().signal?.aborted &&
    !sessionHost.session.planMode() &&
    !sessionHost.session.options().transient &&
    !sessionHost.session.options().allowedTools &&
    !sessionHost.session.options().subagentWorker &&
    sessionHost.session.options().agentContext !== "none" &&
    sessionHost.session.options().coderSlashCommands !== false;
  if (
    !allowed() ||
    sessionHost.assessment.active() ||
    sessionHost.boundaries.advisoryTurn() ||
    sessionHost.boundaries.setupInspection() ||
    sessionHost.boundaries.discoveryReview()
  )
    throw new Error("Candidate review requires an idle Code session outside plan mode.");
  if (request.source === "history") {
    const loaded = await readRecommendationHistory(sessionHost.session.cwd(), {
      signal: sessionHost.session.options().signal,
    });
    const candidate =
      "history" in loaded
        ? recommendationDetail(loaded.history, request.candidateId, 0)?.discovery
        : undefined;
    if (
      !allowed() ||
      !candidate ||
      candidate.assessmentId !== request.assessmentId ||
      candidate.revision !== request.expectedRevision
    )
      throw new Error("Historical candidate changed or is unavailable. Reload history.");
    return {
      status: "reinspection-required",
      candidate,
      summary:
        "Historical evidence cannot restore review authority. Discover opportunities again to obtain current evidence before preparing a proposal.",
    };
  }
  const current = sessionHost.assessment.candidates();
  const record = current?.records.find(
    ({ display }) =>
      display.candidateId === request.candidateId &&
      display.assessmentId === request.assessmentId &&
      display.revision === request.expectedRevision,
  );
  if (!record || current?.owner !== owner || current.sequence !== sequence)
    throw new Error(
      "Candidate evidence is previous or belongs to another session. Discover opportunities again.",
    );
  const candidate = record.display;
  if (!candidate.nextStep.available)
    return { status: "unsupported", candidate, summary: candidate.nextStep.reason };
  const paths = discoveryEvidencePaths(
    sessionHost.boundaries.advisoryEvidence().list(),
    record.recommendation.evidence.items.flatMap((item) => ("source" in item ? [item.source] : [])),
  );
  const boundary = new DiscoveryReviewBoundary(
    candidate,
    paths,
    record.recommendation.choice,
    (text) => sessionHost.boundaries.commandCreation()?.inspectionEvidence(text),
  );
  sessionHost.boundaries.setDiscoveryReview(boundary);
  const promoted = new Set<string>();
  try {
    for (const [name, tool] of sessionHost.tools.deferred())
      if (
        boundary.allows(name) &&
        !sessionHost.tools.registered().has(name) &&
        sessionHost.tools.isCapabilityAllowed(name)
      ) {
        sessionHost.tools.registered().set(name, sessionHost.tools.guard(tool));
        promoted.add(name);
      }
    sessionHost.tools.reconcile();
    if (
      !sessionHost.tools.list().some((tool) => tool.name === "read") ||
      !sessionHost.tools.list().some((tool) => tool.name === "command_information")
    )
      throw new Error(
        "Current permissions do not allow the required local and catalog inspection.",
      );
    sessionHost.boundaries.commandCreation()?.cancel();
    await sessionHost.transcript.acceptPromptTemplate(
      discoveryReviewPrompt(candidate),
      { source: "human", kind: "prompt", visibility: "transcript" },
      {},
    );
    if (!allowed() || sessionHost.boundaries.discoveryReview() !== boundary || !boundary.active)
      throw new Error("Candidate review owner changed or was cancelled.");
    return {
      status: boundary.prepared ? "prepared" : "reinspection-required",
      candidate,
      summary: boundary.prepared
        ? "Read-only review is in the transcript. No command was created or run; later changes require separate exact review and approval."
        : "Review did not establish current local evidence, command resolution or a complete inspected proposal as required for this choice. No actionable proposal is available; retry inspection explicitly.",
    };
  } catch (error) {
    sessionHost.boundaries.commandCreation()?.cancel();
    throw error;
  } finally {
    boundary.close();
    sessionHost.boundaries.setDiscoveryReview(undefined);
    for (const name of promoted) sessionHost.tools.registered().delete(name);
    sessionHost.tools.reconcile();
  }
}

export async function assessProgrammatic(
  sessionHost: SessionProgrammaticHost,
  mode: "setup" | "configured",
  focus: string | undefined,
  provenance: MessageProvenance,
  options: {
    disableTools?: boolean;
    onAccepted?: () => void | Promise<void>;
    meta?: PromptMeta;
    assessmentRequestId?: string;
    retryArea?: ProgrammaticChatRetryArea;
  },
): Promise<ProgrammaticAssessmentOutcome & { setupFacts?: unknown; scanFacts?: unknown }> {
  if (
    sessionHost.assessment.active() ||
    sessionHost.boundaries.advisoryTurn() ||
    sessionHost.boundaries.setupInspection() ||
    sessionHost.boundaries.discoveryReview()
  )
    throw new Error("An assessment or review is already active.");
  sessionHost.assessment.setActive(true);
  let retry: AreaRetry | undefined;
  if (options.retryArea) {
    try {
      retry = await checkAreaRetry(sessionHost, mode, focus, options, options.retryArea);
    } catch (error) {
      // Refused before the sequence moves, so the previous results stay reviewable.
      sessionHost.assessment.setActive(false);
      throw error;
    }
  }
  const { conversationId, sessionId } = sessionHost.session.conversationIdentity();
  const identity = {
    conversationId,
    sessionId,
    sequence: sessionHost.assessment.nextSequence(),
    ...(options.assessmentRequestId ? { requestId: options.assessmentRequestId } : {}),
  };
  const signal = sessionHost.session.options().signal;
  // Transient internal sessions have no desktop conversation identity.
  const publish = (event: BusEventMap["programmatic_assessment"]) => {
    if (conversationId && sessionId)
      sessionHost.session.eventBus().emit("programmatic_assessment", event);
  };
  const host = { id: crypto.randomUUID(), startedAt: new Date().toISOString() };
  const owner = sessionHost.session.sessionId();
  const current = () =>
    sessionHost.session.sessionId() === owner &&
    sessionHost.assessment.sequence() === identity.sequence;
  // Model-derived finds that fail the display contract are dropped; rows still show.
  const publishProgress = (stage: "areas" | "merging", areas: ProgrammaticAreaProgress[]) => {
    for (const rows of [areas, withoutFinds(areas)]) {
      const event: unknown = { ...identity, phase: "progress", stage, areas: rows };
      if (isProgrammaticAssessmentEvent(event)) return publish(event);
    }
  };
  const allowed = () =>
    !options.disableTools &&
    !sessionHost.session.planMode() &&
    !sessionHost.session.options().transient &&
    !sessionHost.session.options().allowedTools &&
    !sessionHost.session.options().subagentWorker &&
    sessionHost.session.options().agentContext !== "none" &&
    sessionHost.session.options().coderSlashCommands !== false &&
    sessionHost.session.sessionId() === owner &&
    sessionHost.assessment.sequence() === identity.sequence &&
    !signal?.aborted &&
    sessionHost.tools.isCapabilityAllowed("programmatic_scan") &&
    !sessionHost.tools.unavailable().has("programmatic_scan");
  publish({ ...identity, phase: "started" });
  sessionHost.assessment.setAreaSearch(null);
  const areaRun: AreaRunHooks = {
    ...(retry ? { retry } : {}),
    progress: (stage, areas) => {
      if (allowed()) publishProgress(stage, areas);
    },
    stopped: (areas) => {
      // Stop aborts the signal, so `allowed()` would drop the final rows and leave them "reading".
      if (signal?.aborted && current() && areas.some((area) => area.status === "stopped"))
        publishProgress("areas", areas);
    },
    remember: (cache) => {
      if (
        sessionHost.session.sessionId() === owner &&
        sessionHost.assessment.sequence() === identity.sequence
      )
        sessionHost.assessment.setAreaSearch({ ...cache, owner, sequence: identity.sequence });
    },
  };
  const historyPolicy = await captureAssessmentHistoryPolicy(sessionHost.session.cwd(), mode);
  try {
    const outcome = await runProgrammaticAssessment(
      sessionHost,
      mode,
      focus,
      provenance,
      options,
      host,
      areaRun,
    );
    // Retain transient accepted candidates independently of history consent or save outcome.
    if (
      sessionHost.session.sessionId() === owner &&
      sessionHost.assessment.sequence() === identity.sequence &&
      outcome.discoveryRecords
    )
      sessionHost.assessment.setCandidates({
        owner,
        sequence: identity.sequence,
        records: outcome.discoveryRecords,
      });
    outcome.assessment.history = await saveAssessmentHistory(
      sessionHost.session.cwd(),
      outcome,
      host,
      historyPolicy,
      {
        signal,
        assertCurrent: () => {
          if (!allowed()) throw new Error("Assessment owner changed before rename.");
        },
        validateBeforeSave: async () => {
          await sessionHost.session.options().validateToolExecution?.();
        },
        onFileMutated: (relative) => {
          sessionHost.session
            .hookFileEditCounts()
            .set(relative, (sessionHost.session.hookFileEditCounts().get(relative) ?? 0) + 1);
        },
      },
    );
    if (conversationId && sessionId) outcome.assessment.lifecycle = identity;
    if (!isProgrammaticAssessment(outcome.assessment))
      throw new Error("Invalid host assessment projection.");
    publish({ ...identity, phase: "completed", assessment: outcome.assessment });
    return outcome;
  } catch (error) {
    if (sessionHost.assessment.candidates()?.sequence === identity.sequence)
      sessionHost.assessment.setCandidates(null);
    const assessment: ProgrammaticAssessment = {
      version: 1,
      mode,
      status: signal?.aborted ? "cancelled" : "unavailable",
      summary: "The assessment did not finish. No approval is implied.",
      limitations: ["The idea search couldn't finish. Nothing was retried."],
      coverage: [],
      observations: [],
      history:
        mode === "setup"
          ? { status: "setup-not-saved" }
          : !historyPolicy.profileDigest && !historyPolicy.unavailable
            ? { status: "disabled" }
            : {
                status: "unsaved",
                assessmentId: host.id,
                reason:
                  "The host did not reach an authorized history save; existing history was retained.",
              },
      deterministic:
        mode === "setup"
          ? { status: "not-run", reason: "setup" }
          : {
              status: signal?.aborted ? "cancelled" : "unavailable",
              reason: "No counted deterministic result is available.",
            },
    };
    if (conversationId && sessionId) assessment.lifecycle = identity;
    publish({ ...identity, phase: "completed", assessment });
    throw error;
  } finally {
    sessionHost.assessment.setActive(false);
  }
}

// Fixed, bounded folder-level history for the advisory area map (partial by design).
const AREA_HISTORY_REQUEST = {
  name: "git_history",
  args: { action: "change_frequency", group_by: "folder", depth: 4, limit: 50, since_days: 90 },
} as const satisfies AssessmentEvidenceRequest;

async function collectAssessmentAreaMap(
  cwd: string,
  signal: AbortSignal,
  authorization: AssessmentEvidenceAuthorization,
  historyEnabled: boolean,
): Promise<{
  result: AreaMapCollectResult;
  facts: { areaMap: unknown; areaMapOmitted?: Record<string, number> };
}> {
  const result: AreaMapCollectResult = await collectProgrammaticAreaMap(cwd, {
    signal,
    ...(historyEnabled
      ? {
          history: async () => {
            if (!(await authorization.authorize(AREA_HISTORY_REQUEST)))
              return JSON.stringify({ status: "unavailable", reason: "not-authorized" });
            // Run directly: the host consumes the facts, so no model receipt is minted.
            const output = await createGitHistoryTool(cwd).execute(
              { ...AREA_HISTORY_REQUEST.args },
              { signal, toolCallId: "assessment-area-history" },
            );
            const raw = typeof output === "string" ? output : output.content;
            return typeof raw === "string" ? raw : "";
          },
        }
      : {}),
  }).catch((error: unknown) => {
    if (signal.aborted) throw error;
    return { status: "unavailable" as const, reason: "unreadable" as const };
  });
  if (result.status !== "ok") return { result, facts: { areaMap: result } };
  // Skipped manifests make the map partial; surface the bounded counts so it isn't read as complete.
  const skipped = Object.values(result.omitted).some((count) => count > 0);
  return {
    result,
    facts: {
      areaMap: result.areaMap,
      ...(skipped ? { areaMapOmitted: result.omitted } : {}),
    },
  };
}

const AREA_MERGE_INSTRUCTION = `

Host area search: the project was searched one part at a time. "areaSearch.candidates" lists the candidate needs those searches found, already de-duplicated by the host, each with the parts it came from and evidence citing the reusable receipts above. "areaSearch.areas" says which parts were searched fully, partly or not at all. Merge any candidates that still describe the same need, compare each against the full command list, and pick one outcome per need under the policy above. Parts that were not searched may hide needs; do not invent needs for them.`;

interface AreaRetry {
  cache: AreaSearchCache;
  area: ProgrammaticAreaV1;
}

interface AreaRunHooks {
  progress(stage: "areas" | "merging", areas: ProgrammaticAreaProgress[]): void;
  /** One final "areas" snapshot after Stop; never a merge stage. */
  stopped(areas: ProgrammaticAreaProgress[]): void;
  remember(cache: Omit<AreaSearchCache, "owner" | "sequence">): void;
  retry?: AreaRetry;
}

/** Validates a one-area retry without events, sequence changes or provider calls. */
async function checkAreaRetry(
  sessionHost: SessionProgrammaticHost,
  mode: "setup" | "configured",
  focus: string | undefined,
  options: { disableTools?: boolean },
  request: ProgrammaticChatRetryArea,
): Promise<AreaRetry> {
  const cache = sessionHost.assessment.areaSearch();
  if (
    !cache ||
    cache.owner !== sessionHost.session.sessionId() ||
    cache.sequence !== request.sequence ||
    sessionHost.assessment.sequence() !== request.sequence
  )
    throw new AreaRetryUnavailableError("no-search");
  const area = retryTarget(cache, request.areaId);
  if (mode !== "configured" || focus?.trim() || options.disableTools || !area)
    throw new AreaRetryUnavailableError("not-retryable");
  const signal = sessionHost.session.options().signal ?? new AbortController().signal;
  const collected = await collectProgrammaticAreaMap(sessionHost.session.cwd(), { signal }).catch(
    (error: unknown) => {
      signal.throwIfAborted();
      throw error;
    },
  );
  if (collected.status !== "ok") throw new AreaRetryUnavailableError("changed");
  await assertAreaRetryFresh(sessionHost.session.cwd(), cache, collected.areaMap, signal);
  return { cache, area };
}

async function runProgrammaticAssessment(
  sessionHost: SessionProgrammaticHost,
  mode: "setup" | "configured",
  focus: string | undefined,
  provenance: MessageProvenance,
  options: { disableTools?: boolean; onAccepted?: () => void | Promise<void>; meta?: PromptMeta },
  host: { id: string; startedAt: string },
  areaRun: AreaRunHooks,
): Promise<ProgrammaticAssessmentOutcome & { setupFacts?: unknown; scanFacts?: unknown }> {
  const input = parseProgrammaticAssessmentInput(focus ?? "");
  if (!input.success) throw new Error("Invalid assessment focus.");
  // One readiness and registry view per turn: the late page recheck must list what the first page listed.
  const turnReadiness = await sessionHost.session.readReadiness();
  if (mode === "configured") {
    const guidance = programmaticReadinessGuidance(turnReadiness);
    if (guidance) throw new Error(guidance);
  }
  const signal = sessionHost.session.options().signal ?? new AbortController().signal;
  const discoveryOptions = {
    workspaceActions: sessionHost.session.options().workspaceCommands,
    workspaceCaseInsensitive: sessionHost.session.options().workspaceCommandCaseInsensitive,
    registryActions:
      sessionHost.session.options().advertiseRegistryCommands === false
        ? []
        : registryCommandListings(sessionHost.session.slashCommands().getAll()),
    readReadiness: async () => turnReadiness,
  };
  const discovery = await discoverCommands(sessionHost.session.cwd(), discoveryOptions);
  const evidenceAuthorization: AssessmentEvidenceAuthorization = {
    isAllowed: ({ name }) =>
      !options.disableTools &&
      !signal.aborted &&
      !sessionHost.tools.unavailable().has(name) &&
      sessionHost.tools.isCapabilityAllowed(name),
    authorize: async (request) => {
      if (!evidenceAuthorization.isAllowed(request)) return false;
      try {
        const sessionOptions = sessionHost.session.options();
        if (
          sessionOptions.approveToolExecution &&
          !(await sessionOptions.approveToolExecution(request.name, request.args, signal))
        )
          return false;
        if (!evidenceAuthorization.isAllowed(request)) return false;
        await sessionHost.session.options().validateToolExecution?.();
        return evidenceAuthorization.isAllowed(request);
      } catch {
        signal.throwIfAborted();
        return false;
      }
    },
  };
  const areaMapFacts = await collectAssessmentAreaMap(
    sessionHost.session.cwd(),
    signal,
    evidenceAuthorization,
    !options.disableTools,
  ).catch((error: unknown) => {
    if (!signal.aborted) throw error;
    // The coordinator reports the cancellation; this placeholder is never shown.
    const result = { status: "unavailable" as const, reason: "unreadable" as const };
    return { result, facts: { areaMap: result } };
  });
  const retry = areaRun.retry;
  const areaSearch: AreaSearchDecision = retry
    ? {
        mode: "areas",
        selected: retry.cache.passes.map(({ area }) => area),
        skipped: retry.cache.skipped,
      }
    : selectAreaSearch({
        mode,
        focus: input.data.focus,
        areaMap: areaMapFacts.result,
        readAllowed:
          !sessionHost.tools.unavailable().has("read") &&
          sessionHost.tools.isCapabilityAllowed("read"),
        toolsDisabled: options.disableTools === true,
      });
  if (retry) {
    // Recheck after the full map collection; the files may have changed since the request.
    if (areaMapFacts.result.status !== "ok") throw new AreaRetryUnavailableError("changed");
    await assertAreaRetryFresh(
      sessionHost.session.cwd(),
      retry.cache,
      areaMapFacts.result.areaMap,
      signal,
    );
  }
  // Per-area passes carry their own samples, so the merge turn skips the whole-repo sample.
  const context =
    areaSearch.mode === "areas"
      ? buildProgrammaticAdvisoryContext(input.data, discovery)
      : await buildProgrammaticAssessmentContext(input.data, discovery, sessionHost.session.cwd(), {
          signal,
          authorization: evidenceAuthorization,
        }).catch((error: unknown) => {
          if (!signal.aborted) throw error;
          return buildProgrammaticAdvisoryContext(input.data, discovery);
        });
  const promoted = new Set<string>();
  const previousResult = sessionHost.tools.registered().get("programmatic_advisory_result");
  let setupFacts: unknown;
  let scanFacts: unknown;
  let areaStatuses: AreaStatusFact[] | undefined;
  let coordinator: ProgrammaticAssessmentCoordinator | undefined;
  const information = createCommandInformationTool(sessionHost.session.cwd(), discoveryOptions);
  let previousInformation: AgentTool | undefined;
  let turnInformation: AgentTool | undefined;
  try {
    for (const name of [...ADVISORY_READ_TOOLS, "programmatic_profile"]) {
      const deferred = sessionHost.tools.deferred().get(name);
      if (
        deferred &&
        !sessionHost.tools.registered().has(name) &&
        sessionHost.tools.isCapabilityAllowed(name)
      ) {
        sessionHost.tools.registered().set(name, sessionHost.tools.guard(deferred));
        promoted.add(name);
      }
    }
    // The model's own list calls must see this turn's discovery view, not live readiness.
    previousInformation = sessionHost.tools.registered().get("command_information");
    if (previousInformation) {
      turnInformation = sessionHost.tools.guard(information);
      sessionHost.tools.registered().set("command_information", turnInformation);
    }
    sessionHost.tools.reconcile();
    coordinator = new ProgrammaticAssessmentCoordinator(
      sessionHost.session.cwd(),
      context,
      () => sessionHost.tools.list(),
      {
        mode,
        scanAvailable: !options.disableTools && sessionHost.tools.supports("programmatic_scan", {}),
      },
    );
    const turn = coordinator.scope.turn;
    // Retain session-owned receipts across assessments, never initial samples.
    for (const receipt of sessionHost.boundaries.advisoryEvidence().list())
      turn.evidence.retain(receipt);
    sessionHost.boundaries.setAdvisoryEvidence(turn.evidence);
    sessionHost.boundaries.setAdvisoryTurn(turn);
    if (mode === "setup") {
      sessionHost.boundaries.programmaticProfile()?.cancel();
      sessionHost.boundaries.setSetupInspection(new ProgrammaticSetupInspection(true));
    }
    const freshInformation: typeof information = {
      ...information,
      execute: async (args, toolContext) => {
        if (
          sessionHost.boundaries.advisoryTurn() !== turn ||
          !turn.active ||
          !sessionHost.tools.supports("command_information", args)
        )
          throw new Error("Command information unavailable.");
        const sessionOptions = sessionHost.session.options();
        if (
          sessionOptions.approveToolExecution &&
          !(await sessionOptions.approveToolExecution(
            "command_information",
            args,
            toolContext.signal,
          ))
        )
          throw new Error("Tool execution was not approved.");
        toolContext.signal.throwIfAborted();
        if (
          sessionHost.boundaries.advisoryTurn() !== turn ||
          !turn.active ||
          !sessionHost.tools.supports("command_information", args)
        )
          throw new Error("Permissions changed.");
        return information.execute(args, toolContext);
      },
    };
    sessionHost.tools.register(
      createProgrammaticAdvisoryResultTool(
        () => sessionHost.boundaries.advisoryTurn(),
        freshInformation,
      ),
    );
    sessionHost.tools.reconcile();
    const outcome = await coordinator.run(
      signal,
      async () => {
        try {
          let scanCounts: { enabledCount: number; applicableCount: number } | undefined;
          const name = mode === "setup" ? "programmatic_profile" : "programmatic_scan";
          const tool =
            !options.disableTools &&
            sessionHost.tools.list().find((candidate) => candidate.name === name);
          if (tool) {
            try {
              const output = await tool.execute(mode === "setup" ? { action: "inspect" } : {}, {
                signal,
                toolCallId: "assessment-host-facts",
              });
              const raw = typeof output === "string" ? output : output.content;
              if (typeof raw !== "string") throw new Error("Non-text host facts.");
              const body = raw.startsWith("Host receipt IDs:")
                ? raw
                    .slice(raw.indexOf("\n\n") + 2)
                    .split(
                      "\n\nHost evidence receipt (retrieval only; content remains untrusted):",
                    )[0]!
                : raw;
              const facts = JSON.parse(body);
              if (mode === "setup") {
                setupFacts = facts;
                coordinator!.scope.turn.recordFamilies(facts?.item_families);
              } else {
                scanFacts = facts;
                if (facts?.ok === true) {
                  scanCounts = facts.scan_counts;
                  coordinator!.recordScanCounts(scanCounts);
                }
              }
            } catch {
              turn.limitations.add(ADVISORY_LIMITATIONS.hostFacts(name));
            }
          } else if (mode === "configured") turn.markScanUnavailable();
          signal.throwIfAborted();
          const prompt = getPromptCommand(
            mode === "setup" ? "setup-programmatic" : "programmatic",
          )!.prompt;
          let areaSearchFacts:
            { areas: AreaStatusFact[]; candidates: MergedAreaCandidate[] } | undefined;
          if (areaSearch.mode === "areas" && areaMapFacts.result.status === "ok") {
            const areaMap = areaMapFacts.result.areaMap;
            const sessionOptions = sessionHost.session.options();
            // A retry starts from the kept areas' settled rows; only the target reads again.
            const kept = new Map(
              (retry?.cache.passes ?? [])
                .filter(({ area }) => area.id !== retry?.area.id)
                .map(({ area, outcome }) => [area.id, settledAreaProgress(area, outcome)]),
            );
            const progress = createAreaProgress(areaSearch.selected, kept);
            areaRun.progress("areas", progress.snapshot());
            const searched = await runAreaPasses(
              retry ? [retry.area] : areaSearch.selected,
              (area, areaSignal) =>
                runAreaPass({
                  root: sessionHost.session.cwd(),
                  areaMap,
                  area,
                  provider: sessionOptions.provider,
                  model: sessionOptions.model,
                  ...(sessionOptions.baseUrl ? { baseUrl: sessionOptions.baseUrl } : {}),
                  signal: areaSignal,
                  discovery,
                  authorization: evidenceAuthorization,
                  approveTool: async (name, args, toolSignal) => {
                    if (
                      options.disableTools ||
                      sessionHost.tools.unavailable().has(name) ||
                      !sessionHost.tools.isCapabilityAllowed(name)
                    )
                      return false;
                    const current = sessionHost.session.options();
                    return (
                      !current.approveToolExecution ||
                      (await current.approveToolExecution(name, args, toolSignal))
                    );
                  },
                  validate: async () => {
                    await sessionHost.session.options().validateToolExecution?.();
                  },
                  historyEnabled: !options.disableTools,
                }),
              {
                signal,
                onProgress: (area, state) => {
                  if (progress.update(area, state)) areaRun.progress("areas", progress.snapshot());
                },
              },
            ).catch((error: unknown) => {
              // runAreaPasses reports every unfinished area as stopped before it rejects.
              if (signal.aborted) areaRun.stopped(progress.snapshot());
              throw error;
            });
            const passes = retry
              ? retry.cache.passes.map((pass) =>
                  pass.area.id === retry.area.id
                    ? (searched.find(({ area }) => area.id === retry.area.id) ?? pass)
                    : pass,
                )
              : searched;
            areaRun.remember({
              areaMapDigest: structuralAreaMapDigest(areaMap),
              passes,
              skipped: areaSearch.skipped,
              citedFiles: await citedFileDigests(sessionHost.session.cwd(), passes, signal),
            });
            areaRun.progress("merging", progress.snapshot());
            const merged = mergeAreaCandidates(passes, areaSearch.skipped);
            for (const receipt of merged.receipts) turn.evidence.retain(receipt);
            turn.recordSample(merged.sample);
            coordinator!.recordAreaCoverage(merged.coverage);
            for (const limitation of merged.limitations) turn.limitations.add(limitation);
            areaSearchFacts = { areas: merged.statuses, candidates: merged.candidates };
            areaStatuses = merged.statuses;
          }
          signal.throwIfAborted();
          const facts = {
            setupFacts,
            scanFacts,
            ...areaMapFacts.facts,
            ...(areaSearchFacts ? { areaSearch: areaSearchFacts } : {}),
          };
          if (context.evidence) recheckAssessmentEvidence(context.evidence, evidenceAuthorization);
          try {
            await sessionHost.transcript.acceptPromptTemplate(
              sessionHost.transcript.expandResolvedPromptCommand(prompt, focus ?? "") +
                `

Host-owned exact facts (not model authority; already collected, do not repeat):
${JSON.stringify(facts)}
Reusable host evidence receipts:
${JSON.stringify(turn.evidence.list())}` +
                (areaSearchFacts ? AREA_MERGE_INSTRUCTION : "") +
                renderProgrammaticAdvisoryContext(context),
              provenance,
              options,
            );
            return { scanCounts };
          } catch (error) {
            const unavailable =
              (error instanceof NotLoggedInError || error instanceof ProviderError) &&
              !sessionHost.session.hookText() &&
              sessionHost.session.hookToolCallCount() === 0;
            return {
              scanCounts,
              status: unavailable ? ("unavailable" as const) : ("incomplete" as const),
            };
          }
        } finally {
          // The coordinator retires its turn-local receipts on close. Preserve only
          // delivered session receipts, without retaining the closed turn's authority.
          if (sessionHost.boundaries.advisoryTurn() === turn && turn.active) {
            const retained = new AdvisoryEvidence();
            for (const receipt of turn.evidence.list()) retained.retain(receipt);
            sessionHost.boundaries.setAdvisoryEvidence(retained);
          }
        }
      },
      host,
    );
    if (areaStatuses) outcome.assessment.areas = assessmentAreas(areaStatuses);
    if (
      sessionHost.boundaries.advisoryTurn() === turn &&
      outcome.assessment.status !== "completed"
    ) {
      const content = INCOMPLETE_ADVISORY_NOTICE;
      sessionHost.session.eventBus().emit("text_delta", {
        text: `

${content}
`,
      });
      const notice: Message = { role: "assistant", content };
      sessionHost.transcript.messages().push(notice);
      await sessionHost.transcript.persistMessage(notice);
      sessionHost.transcript.setLastPersistedIndex(sessionHost.transcript.messages().length);
    }
    return {
      ...outcome,
      ...(setupFacts === undefined ? {} : { setupFacts }),
      ...(scanFacts === undefined ? {} : { scanFacts }),
    };
  } finally {
    coordinator?.scope.close();
    sessionHost.boundaries.setAdvisoryTurn(undefined);
    sessionHost.boundaries.discoveryReview()?.close();
    sessionHost.assessment.setCandidates(null);
    sessionHost.boundaries.setupInspection()?.close();
    sessionHost.boundaries.setSetupInspection(undefined);
    sessionHost.boundaries.setPendingAdvisoryPresentation(undefined);
    if (previousResult)
      sessionHost.tools.registered().set("programmatic_advisory_result", previousResult);
    else sessionHost.tools.registered().delete("programmatic_advisory_result");
    if (
      previousInformation &&
      sessionHost.tools.registered().get("command_information") === turnInformation
    )
      sessionHost.tools.registered().set("command_information", previousInformation);
    for (const name of promoted)
      if (
        !sessionHost.tools.searchedPromoted().has(name) &&
        !sessionHost.tools.capabilityPromoted().has(name)
      )
        sessionHost.tools.registered().delete(name);
    sessionHost.tools.reconcile();
  }
}
