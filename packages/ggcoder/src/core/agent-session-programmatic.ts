// Local Fork-owned: programmatic assessment and discovery review for
// AgentSession. Kept out of agent-session.ts so upstream syncs of that file
// stay small.
import {
  isProgrammaticAssessment,
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
} from "./programmatic/assessment-evidence.js";
import {
  AdvisoryEvidence,
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
  const historyPolicy = await captureAssessmentHistoryPolicy(sessionHost.session.cwd(), mode);
  try {
    const outcome = await runProgrammaticAssessment(
      sessionHost,
      mode,
      focus,
      provenance,
      options,
      host,
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
      limitations: ["The host could not complete this assessment; no retry was attempted."],
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

async function runProgrammaticAssessment(
  sessionHost: SessionProgrammaticHost,
  mode: "setup" | "configured",
  focus: string | undefined,
  provenance: MessageProvenance,
  options: { disableTools?: boolean; onAccepted?: () => void | Promise<void>; meta?: PromptMeta },
  host: { id: string; startedAt: string },
): Promise<ProgrammaticAssessmentOutcome & { setupFacts?: unknown; scanFacts?: unknown }> {
  const input = parseProgrammaticAssessmentInput(focus ?? "");
  if (!input.success) throw new Error("Invalid assessment focus.");
  if (mode === "configured") {
    const guidance = programmaticReadinessGuidance(await sessionHost.session.readReadiness());
    if (guidance) throw new Error(guidance);
  }
  const signal = sessionHost.session.options().signal ?? new AbortController().signal;
  const discovery = await discoverCommands(sessionHost.session.cwd(), {
    workspaceActions: sessionHost.session.options().workspaceCommands,
    workspaceCaseInsensitive: sessionHost.session.options().workspaceCommandCaseInsensitive,
    registryActions:
      sessionHost.session.options().advertiseRegistryCommands === false
        ? []
        : registryCommandListings(sessionHost.session.slashCommands().getAll()),
    readReadiness: () => sessionHost.session.readReadiness(),
  });
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
  const context = await buildProgrammaticAssessmentContext(
    input.data,
    discovery,
    sessionHost.session.cwd(),
    {
      signal,
      authorization: evidenceAuthorization,
    },
  ).catch((error: unknown) => {
    if (!signal.aborted) throw error;
    return buildProgrammaticAdvisoryContext(input.data, discovery);
  });
  const promoted = new Set<string>();
  const previousResult = sessionHost.tools.registered().get("programmatic_advisory_result");
  let setupFacts: unknown;
  let scanFacts: unknown;
  let coordinator: ProgrammaticAssessmentCoordinator | undefined;
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
    const information = createCommandInformationTool(sessionHost.session.cwd(), {
      workspaceActions: sessionHost.session.options().workspaceCommands,
      workspaceCaseInsensitive: sessionHost.session.options().workspaceCommandCaseInsensitive,
      registryActions:
        sessionHost.session.options().advertiseRegistryCommands === false
          ? []
          : registryCommandListings(sessionHost.session.slashCommands().getAll()),
      readReadiness: () => sessionHost.session.readReadiness(),
    });
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
              turn.limitations.add(`${name}: host facts unavailable; no retry attempted.`);
            }
          } else if (mode === "configured") turn.markScanUnavailable();
          signal.throwIfAborted();
          const prompt = getPromptCommand(
            mode === "setup" ? "setup-programmatic" : "programmatic",
          )!.prompt;
          const facts = { setupFacts, scanFacts };
          if (context.evidence) recheckAssessmentEvidence(context.evidence, evidenceAuthorization);
          try {
            await sessionHost.transcript.acceptPromptTemplate(
              sessionHost.transcript.expandResolvedPromptCommand(prompt, focus ?? "") +
                `

Host-owned exact facts (not model authority; already collected, do not repeat):
${JSON.stringify(facts)}
Reusable host evidence receipts:
${JSON.stringify(turn.evidence.list())}` +
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
    if (
      sessionHost.boundaries.advisoryTurn() === turn &&
      outcome.assessment.status !== "completed"
    ) {
      const content = `## Recommendations — not started

Assessment did not submit a validated result (interrupted, unavailable, or incomplete). Any completed deterministic scan remains separate and unchanged.`;
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
    for (const name of promoted)
      if (
        !sessionHost.tools.searchedPromoted().has(name) &&
        !sessionHost.tools.capabilityPromoted().has(name)
      )
        sessionHost.tools.registered().delete(name);
    sessionHost.tools.reconcile();
  }
}
