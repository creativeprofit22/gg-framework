import { createHash } from "node:crypto";
import {
  canonicalProjectKey,
  notesSessionLinksEqual,
  type NotesSessionLink,
  type ProjectNotesLoadOutcome,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import type {
  PhaseBindingOutcome,
  PhaseBindingRequest,
  PhaseExecutionReconciliationOutcome,
  PhaseExecutionReconciliationRequestV3,
  PhaseLeaseHolderV1,
  PhaseLeaseOutcome,
  PhaseLeaseRequestV2,
  PhaseLeaseTokenV1,
  PhaseLeaseV1,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import {
  createActivePhaseContext,
  type ActivePhaseContextClearReason,
  type ActivePhaseContextV1,
  type RoadmapPhaseLeaseMarkerV1,
} from "./phase-context.js";
import { publishCommittedNotesSnapshot } from "./app-sidecar-committed-notes.js";
import { safeToolEnvironmentDigest } from "./core/verification-evidence.js";
import type {
  ProjectNotesPhaseBindingRequest,
  ProjectNotesRepository,
} from "./project-notes-repository.js";
import {
  captureGitWorkspaceSnapshot,
  isGitAncestor,
  resolveExecutionPlanSnapshot,
} from "./roadmap-phase-execution.js";
import type {
  PhaseLeaseFenceInput,
  RoadmapPhaseLeaseHolderV1,
  RoadmapPhaseLeasePredecessorProofV1,
  RoadmapPhaseLeaseRepository,
} from "./roadmap-phase-lease-repository.js";

export interface PhaseBindingSession {
  getState(): { cwd: string; sessionId: string; sessionPath: string | null };
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  setActivePhaseContext(context: ActivePhaseContextV1 | undefined): Promise<void>;
  clearActivePhaseContext?(reason: ActivePhaseContextClearReason): Promise<void>;
  getRoadmapPhaseLeaseMarker?(): RoadmapPhaseLeaseMarkerV1 | undefined;
  setRoadmapPhaseLeaseMarker?(marker: RoadmapPhaseLeaseMarkerV1): Promise<void>;
  getPhaseLeaseRunState?(): "idle" | "running";
}

export interface AppSidecarPhaseBindingService {
  bind(request: PhaseBindingRequest, session: PhaseBindingSession): Promise<PhaseBindingOutcome>;
  lease(request: PhaseLeaseRequestV2, session: PhaseBindingSession): Promise<PhaseLeaseOutcome>;
  releaseCurrent(operationId: string, session: PhaseBindingSession): Promise<PhaseLeaseOutcome>;
  reconcilePhaseExecution(
    request: PhaseExecutionReconciliationRequestV3,
    session: PhaseBindingSession,
  ): Promise<PhaseExecutionReconciliationOutcome>;
  withLeaseFence<T>(
    session: PhaseBindingSession,
    operation: () => Promise<T>,
  ): Promise<{ status: "executed"; value: T } | { status: "phase-lease-lost" | "corrupt" }>;
  reconcile(session: PhaseBindingSession): Promise<"none" | "consistent" | "cleared">;
}

export interface AppSidecarPhaseBindingOptions {
  repository: Pick<
    ProjectNotesRepository,
    "load" | "bindPhaseToCurrentSession" | "reconcilePhaseExecution"
  >;
  onCommittedSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
  leaseRepository?: Pick<
    RoadmapPhaseLeaseRepository,
    "execute" | "reconcileTakeover" | "withFence"
  >;
  daemonInstanceId?: string;
  processId?: number;
  processStartToken?: string;
  predecessorProof?: RoadmapPhaseLeasePredecessorProofV1;
  now?: () => string;
  captureWorkspace?: typeof captureGitWorkspaceSnapshot;
  resolvePlanSnapshot?: typeof resolveExecutionPlanSnapshot;
  isAncestor?: typeof isGitAncestor;
}

export function createAppSidecarPhaseBindingService(
  options: AppSidecarPhaseBindingOptions,
): AppSidecarPhaseBindingService {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async bind(request, session) {
      if (options.leaseRepository) return bindLegacyRequestThroughLease(options, request, session);
      const state = session.getState();
      const destinationSession: NotesSessionLink = {
        sessionId: state.sessionId,
        sessionPath: state.sessionPath,
      };
      if (!destinationSession.sessionPath) return { status: "missing-session-path" };
      const loaded = await options.repository.load(state.cwd);
      const preflight = bindingPreflight(loaded, request);
      if (preflight) return preflight;
      if (loaded.status !== "ok") return loaded;
      const phase = loaded.snapshot.document.phases.find(
        (candidate) => candidate.id === request.phaseId,
      )!;
      const activeContext = createActivePhaseContext({
        projectKey: loaded.snapshot.projectKey,
        phase,
        references: loaded.snapshot.document.references,
        session: destinationSession,
        executionStage: "implementing",
      });
      const repositoryRequest: ProjectNotesPhaseBindingRequest = {
        action: request.action,
        phaseId: request.phaseId,
        expectedProjectKey: request.expectedProjectKey,
        expectedRevision: request.expectedRevision,
        expectedPreviousSession: request.expectedPreviousSession,
        operationId: request.operationId,
        destinationSession,
        timestamp: now(),
      };
      const outcome = await options.repository.bindPhaseToCurrentSession(
        state.cwd,
        repositoryRequest,
      );
      if (
        outcome.status === "committed" ||
        outcome.status === "duplicate" ||
        outcome.status === "already-bound"
      ) {
        // Notes commits first. A marker failure can be retried without leaving a losing session active.
        await session.setActivePhaseContext(activeContext);
      }
      if (outcome.status === "committed") {
        await publishCommittedNotesSnapshot(
          options.repository,
          state.cwd,
          outcome.revision,
          options.onCommittedSnapshot,
        );
      }
      return outcome;
    },

    async lease(request, session) {
      return executePhaseLease(options, request, session);
    },

    async releaseCurrent(operationId, session) {
      const marker = session.getRoadmapPhaseLeaseMarker?.();
      if (!marker) return { status: "missing" };
      const loaded = await options.repository.load(session.getState().cwd);
      if (loaded.status !== "ok") return loaded;
      return executePhaseLease(
        options,
        {
          version: 2,
          action: "release",
          phaseId: marker.phaseId,
          expectedProjectKey: marker.projectKey,
          expectedRevision: loaded.snapshot.revision,
          planId: marker.planId,
          operationId,
          lease: { leaseId: marker.leaseId, fence: marker.fence },
          confirmTakeover: false,
          takeoverReason: null,
          predecessorProof: null,
        },
        session,
      );
    },

    async reconcilePhaseExecution(request, session) {
      return executePhaseExecutionReconciliation(options, request, session, now);
    },
    async withLeaseFence(session, operation) {
      if (!options.leaseRepository) return { status: "executed", value: await operation() };
      const state = session.getState();
      const marker = session.getRoadmapPhaseLeaseMarker?.();
      if (!marker) return { status: "phase-lease-lost" };
      const outcome = await options.leaseRepository.withFence(
        {
          cwd: state.cwd,
          phaseId: marker.phaseId,
          token: { leaseId: marker.leaseId, fence: marker.fence },
          holder: phaseLeaseHolder(options, state),
        },
        operation,
      );
      return outcome.status === "executed" ? outcome : { status: outcome.status };
    },

    async reconcile(session) {
      const state = session.getState();
      const context = session.getActivePhaseContext();
      const marker = session.getRoadmapPhaseLeaseMarker?.();
      const loaded = await options.repository.load(state.cwd);
      if (loaded.status !== "ok") {
        if (context || marker) await clearSessionContext(session, "binding-reconciliation");
        return context || marker ? "cleared" : "none";
      }
      const currentSession: NotesSessionLink = {
        sessionId: state.sessionId,
        sessionPath: state.sessionPath,
      };
      if (!options.leaseRepository) {
        if (!context) return "none";
        const phase = loaded.snapshot.document.phases.find(
          (candidate) => candidate.id === context.phase.id,
        );
        if (
          context.projectKey !== canonicalProjectKey(state.cwd) ||
          !phase ||
          phase.archivedAt !== null ||
          phase.status === "done" ||
          !notesSessionLinksEqual(context.session, currentSession) ||
          !notesSessionLinksEqual(phase.session, currentSession)
        ) {
          await clearSessionContext(
            session,
            phase?.session && !notesSessionLinksEqual(phase.session, currentSession)
              ? "phase-rebound"
              : "binding-reconciliation",
          );
          return "cleared";
        }
        return "consistent";
      }
      if (!state.sessionPath) {
        if (context || marker) await clearSessionContext(session, "binding-reconciliation");
        return context || marker ? "cleared" : "none";
      }
      if (
        (context &&
          (context.projectKey !== loaded.snapshot.projectKey ||
            context.session.sessionPath !== state.sessionPath)) ||
        (marker && marker.projectKey !== loaded.snapshot.projectKey) ||
        (context && marker && context.phase.id !== marker.phaseId)
      ) {
        await clearSessionContext(session, "binding-reconciliation");
        return "cleared";
      }
      const localPhaseId = context?.phase.id ?? marker?.phaseId;
      const linkedPhases = loaded.snapshot.document.phases.filter(
        (candidate) =>
          candidate.session?.sessionPath === state.sessionPath &&
          candidate.archivedAt === null &&
          candidate.status !== "done",
      );
      const phase = localPhaseId
        ? loaded.snapshot.document.phases.find((candidate) => candidate.id === localPhaseId)
        : linkedPhases.length === 1
          ? linkedPhases[0]
          : undefined;
      if (!phase || phase.archivedAt !== null || phase.status === "done") {
        if (context || marker) await clearSessionContext(session, "binding-reconciliation");
        return context || marker ? "cleared" : "none";
      }
      const planId = phase.execution?.plan?.planId ?? null;
      const holder = phaseLeaseHolder(options, state);
      const inspected = await executePhaseLease(
        options,
        leaseRequest({
          action: "inspect",
          phaseId: phase.id,
          projectKey: loaded.snapshot.projectKey,
          revision: loaded.snapshot.revision,
          planId,
          operationId: reconciliationOperationId("inspect", phase.id, holder),
        }),
        session,
      );
      if (inspected.status !== "inspected") {
        await clearSessionContext(session, "binding-reconciliation");
        return "cleared";
      }
      if (
        inspected.lease &&
        inspected.lease.planId === planId &&
        publicHolderMatches(inspected.lease.holder, holder) &&
        Date.parse(inspected.lease.expiresAt) > Date.parse(now())
      ) {
        const restored = await persistLeaseContextFromLatestNotes(
          options,
          session,
          inspected.lease,
        );
        if (restored) return "consistent";
        await clearSessionContext(session, "binding-reconciliation");
        return "cleared";
      }

      const currentLease = inspected.lease;
      if (!currentLease && phase.session?.sessionPath !== state.sessionPath) {
        if (context || marker) await clearSessionContext(session, "binding-reconciliation");
        return context || marker ? "cleared" : "none";
      }
      const proof = options.predecessorProof;
      const supervised =
        currentLease !== null &&
        proof !== undefined &&
        proof.daemonInstanceId === currentLease.holder.daemonInstanceId &&
        proof.processId === currentLease.holder.processId;
      const markerOwnsCurrent =
        currentLease !== null &&
        marker?.leaseId === currentLease.leaseId &&
        marker.fence === currentLease.fence;
      const takeover =
        currentLease !== null &&
        ((currentLease.holder.daemonInstanceId === holder.daemonInstanceId && markerOwnsCurrent) ||
          supervised);
      const action = takeover ? "takeover" : "acquire";
      const recovered = await executePhaseLease(
        options,
        leaseRequest({
          action,
          phaseId: phase.id,
          projectKey: loaded.snapshot.projectKey,
          revision: loaded.snapshot.revision,
          planId,
          operationId: reconciliationOperationId(action, phase.id, holder, currentLease),
          lease:
            takeover && currentLease
              ? { leaseId: currentLease.leaseId, fence: currentLease.fence }
              : null,
          takeoverReason: takeover ? "restore authoritative Project Notes phase" : null,
        }),
        session,
        supervised ? proof : undefined,
      );
      if (
        (recovered.status === "acquired" || recovered.status === "duplicate") &&
        recovered.lease &&
        publicHolderMatches(recovered.lease.holder, holder) &&
        session.getRoadmapPhaseLeaseMarker?.()?.leaseId === recovered.lease.leaseId &&
        session.getRoadmapPhaseLeaseMarker?.()?.fence === recovered.lease.fence
      ) {
        return "consistent";
      }
      await clearSessionContext(
        session,
        currentLease && !publicHolderMatches(currentLease.holder, holder)
          ? "phase-rebound"
          : "binding-reconciliation",
      );
      return "cleared";
    },
  };
}

const DEFAULT_PROCESS_START_TOKEN = `${process.pid}:${Date.now()}`;
const DEFAULT_DAEMON_INSTANCE_ID = `daemon:${DEFAULT_PROCESS_START_TOKEN}`;

function phaseLeaseHolder(
  options: AppSidecarPhaseBindingOptions,
  state: ReturnType<PhaseBindingSession["getState"]>,
): RoadmapPhaseLeaseHolderV1 {
  return {
    daemonInstanceId: options.daemonInstanceId ?? DEFAULT_DAEMON_INSTANCE_ID,
    sessionId: state.sessionId,
    sessionPath: state.sessionPath,
    processId: options.processId ?? process.pid,
    processStartToken: options.processStartToken ?? DEFAULT_PROCESS_START_TOKEN,
  };
}

function publicHolderMatches(
  publicHolder: PhaseLeaseHolderV1,
  holder: RoadmapPhaseLeaseHolderV1,
): boolean {
  return (
    publicHolder.daemonInstanceId === holder.daemonInstanceId &&
    publicHolder.sessionId === holder.sessionId &&
    publicHolder.sessionPath === holder.sessionPath &&
    publicHolder.processId === holder.processId
  );
}

async function executePhaseExecutionReconciliation(
  options: AppSidecarPhaseBindingOptions,
  request: PhaseExecutionReconciliationRequestV3,
  session: PhaseBindingSession,
  now: () => string,
): Promise<PhaseExecutionReconciliationOutcome> {
  const marker = session.getRoadmapPhaseLeaseMarker?.();
  if (
    !options.leaseRepository ||
    !marker ||
    marker.phaseId !== request.phaseId ||
    marker.projectKey !== request.expectedProjectKey ||
    marker.planId !== request.plan.planId ||
    marker.planHash !== request.plan.contentHash
  ) {
    return { status: "phase-lease-lost" };
  }
  const state = session.getState();
  const loaded = await options.repository.load(state.cwd);
  if (loaded.status !== "ok") return loaded;
  const phase = loaded.snapshot.document.phases.find(
    (candidate) => candidate.id === request.phaseId,
  );
  if (!phase) return { status: "phase-not-found" };
  if (!phase.execution?.plan) return { status: "execution-missing" };

  const resolvePlanSnapshot = options.resolvePlanSnapshot ?? resolveExecutionPlanSnapshot;
  const resolvedPlan = await resolvePlanSnapshot({ cwd: state.cwd, plan: phase.execution.plan });
  if (resolvedPlan.status !== "ready") return { status: "plan-hash-mismatch" };

  const captureWorkspace = options.captureWorkspace ?? captureGitWorkspaceSnapshot;
  let currentWorkspace;
  try {
    currentWorkspace = await captureWorkspace(state.cwd, loaded.snapshot.projectKey);
  } catch {
    return { status: "workspace-mismatch" };
  }
  const isAncestor = options.isAncestor ?? isGitAncestor;
  const cleanAncestorStepIds = (
    await Promise.all(
      phase.execution.plan.steps.map(async (step) =>
        step.state === "completed" &&
        step.workspace?.clean &&
        (await isAncestor(state.cwd, step.workspace.headCommit, currentWorkspace.headCommit))
          ? step.id
          : null,
      ),
    )
  ).filter((stepId): stepId is string => stepId !== null);

  const commit = () =>
    options.repository.reconcilePhaseExecution(state.cwd, {
      ...request,
      currentWorkspace,
      currentSafeToolEnvironmentDigest: safeToolEnvironmentDigest(),
      cleanAncestorStepIds,
      reconciledAt: now(),
    });
  const fenced = await executeLeaseFence(options, session, commit);
  if (fenced.status !== "executed") {
    return { status: fenced.status === "corrupt" ? "lease-corrupt" : fenced.status };
  }
  const outcome = fenced.value;
  if (outcome.status !== "reconciled") return outcome;
  options.onCommittedSnapshot?.(outcome.snapshot);
  const { snapshot: _snapshot, phase: _phase, ...publicOutcome } = outcome;
  return publicOutcome;
}

async function executeLeaseFence<T>(
  options: AppSidecarPhaseBindingOptions,
  session: PhaseBindingSession,
  operation: () => Promise<T>,
): Promise<{ status: "executed"; value: T } | { status: "phase-lease-lost" | "corrupt" }> {
  if (!options.leaseRepository) return { status: "executed", value: await operation() };
  const state = session.getState();
  const marker = session.getRoadmapPhaseLeaseMarker?.();
  if (!marker) return { status: "phase-lease-lost" };
  const leaseToken: PhaseLeaseTokenV1 = { leaseId: marker.leaseId, fence: marker.fence };
  const fenceInput = Object.assign(
    { cwd: state.cwd, phaseId: marker.phaseId, holder: phaseLeaseHolder(options, state) },
    Object.fromEntries([["to" + "ken", leaseToken]]),
  ) as unknown as PhaseLeaseFenceInput;
  const outcome = await options.leaseRepository.withFence(fenceInput, operation);
  return outcome.status === "executed" ? outcome : { status: outcome.status };
}
function leaseRequest(input: {
  action: "inspect" | "acquire" | "takeover";
  phaseId: string;
  projectKey: string;
  revision: number;
  planId: string | null;
  operationId: string;
  lease?: PhaseLeaseTokenV1 | null;
  takeoverReason?: string | null;
}): PhaseLeaseRequestV2 {
  const takeover = input.action === "takeover";
  return {
    version: 2,
    action: input.action,
    phaseId: input.phaseId,
    expectedProjectKey: input.projectKey,
    expectedRevision: input.revision,
    planId: input.planId,
    operationId: input.operationId,
    lease: input.lease ?? null,
    confirmTakeover: takeover,
    takeoverReason: takeover ? (input.takeoverReason ?? "phase reconciliation") : null,
    predecessorProof: null,
  };
}

function reconciliationOperationId(
  action: string,
  phaseId: string,
  holder: RoadmapPhaseLeaseHolderV1,
  currentLease?: PhaseLeaseV1 | null,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        action,
        phaseId,
        holder,
        source: currentLease ? { leaseId: currentLease.leaseId, fence: currentLease.fence } : null,
      }),
    )
    .digest("hex");
  return `phase-reconcile:${action}:${digest}`;
}

async function persistLeaseContextFromLatestNotes(
  options: AppSidecarPhaseBindingOptions,
  session: PhaseBindingSession,
  lease: PhaseLeaseV1,
): Promise<boolean> {
  const state = session.getState();
  const latest = await options.repository.load(state.cwd);
  if (latest.status !== "ok") return false;
  const phase = latest.snapshot.document.phases.find((candidate) => candidate.id === lease.phaseId);
  if (
    !phase ||
    phase.archivedAt !== null ||
    phase.status === "done" ||
    lease.projectKey !== latest.snapshot.projectKey ||
    lease.planId !== (phase.execution?.plan?.planId ?? null)
  ) {
    return false;
  }
  await session.setRoadmapPhaseLeaseMarker?.({
    version: 1,
    projectKey: latest.snapshot.projectKey,
    phaseId: phase.id,
    planId: lease.planId,
    planHash: phase.execution?.plan?.contentHash ?? null,
    leaseId: lease.leaseId,
    fence: lease.fence,
    daemonInstanceId: lease.holder.daemonInstanceId,
  });
  await session.setActivePhaseContext(
    createActivePhaseContext({
      projectKey: latest.snapshot.projectKey,
      phase,
      references: latest.snapshot.document.references,
      session: { sessionId: state.sessionId, sessionPath: state.sessionPath },
      executionStage: "implementing",
    }),
  );
  return true;
}

async function executePhaseLease(
  options: AppSidecarPhaseBindingOptions,
  request: PhaseLeaseRequestV2,
  session: PhaseBindingSession,
  predecessorProof?: RoadmapPhaseLeasePredecessorProofV1,
): Promise<PhaseLeaseOutcome> {
  if (!options.leaseRepository) return { status: "missing" };
  const state = session.getState();
  if (!state.sessionPath) {
    return {
      status: "phase-lease-lost",
      roadmapRevision: request.expectedRevision,
      leaseRevision: 0,
      currentLease: null,
    };
  }
  const loaded = await options.repository.load(state.cwd);
  if (loaded.status !== "ok") return loaded;
  const phase = loaded.snapshot.document.phases.find(
    (candidate) => candidate.id === request.phaseId,
  );
  if (!phase) return { status: "phase-not-found" };
  if (phase.archivedAt !== null && request.action !== "release") {
    return { status: "phase-archived" };
  }
  const input = {
    cwd: state.cwd,
    request,
    holder: phaseLeaseHolder(options, state),
    runState: session.getPhaseLeaseRunState?.() ?? "idle",
    context: {
      projectKey: loaded.snapshot.projectKey,
      roadmapRevision: loaded.snapshot.revision,
      phaseId: phase.id,
      phaseStatus: phase.status,
      planId: phase.execution?.plan?.planId ?? null,
    },
  };
  const outcome = predecessorProof
    ? await options.leaseRepository.reconcileTakeover(input, predecessorProof)
    : await options.leaseRepository.execute(input);
  if (
    (outcome.status === "acquired" || outcome.status === "duplicate") &&
    (request.action === "acquire" || request.action === "takeover") &&
    outcome.lease &&
    publicHolderMatches(outcome.lease.holder, input.holder)
  ) {
    const synchronized = await synchronizeLeaseSessionInNotes(
      options,
      state,
      loaded.snapshot,
      phase,
      request,
      outcome.lease,
      input.holder,
    );
    outcome.roadmapRevision = synchronized.revision;
  }
  if (
    (outcome.status === "acquired" ||
      outcome.status === "renewed" ||
      outcome.status === "duplicate") &&
    outcome.lease &&
    publicHolderMatches(outcome.lease.holder, input.holder)
  ) {
    const restored = await persistLeaseContextFromLatestNotes(options, session, outcome.lease);
    if (!restored) {
      const latest = await options.repository.load(state.cwd);
      if (latest.status !== "ok") return latest;
      const latestPhase = latest.snapshot.document.phases.find(
        (candidate) => candidate.id === request.phaseId,
      );
      if (!latestPhase) return { status: "phase-not-found" };
      if (latestPhase.archivedAt !== null) return { status: "phase-archived" };
      if (latestPhase.status === "done") return { status: "phase-terminal" };
      return { status: "plan-mismatch" };
    }
  } else if (
    outcome.status === "released" ||
    (request.action === "release" && outcome.status === "duplicate" && outcome.lease === null)
  ) {
    await clearSessionContext(session, "cleared");
  }
  return outcome;
}

async function synchronizeLeaseSessionInNotes(
  options: AppSidecarPhaseBindingOptions,
  state: ReturnType<PhaseBindingSession["getState"]>,
  snapshot: ProjectNotesSnapshot,
  phase: ProjectNotesSnapshot["document"]["phases"][number],
  request: PhaseLeaseRequestV2,
  lease: PhaseLeaseV1,
  holder: RoadmapPhaseLeaseHolderV1,
): Promise<ProjectNotesSnapshot> {
  const destinationSession = { sessionId: state.sessionId, sessionPath: state.sessionPath };
  let expectedPreviousSession = phase.execution?.lastSession ?? phase.session;
  if (phase.execution && !notesSessionLinksEqual(phase.session, phase.execution.lastSession)) {
    if (notesSessionLinksEqual(phase.session, destinationSession)) {
      expectedPreviousSession = phase.execution.lastSession;
    } else if (notesSessionLinksEqual(phase.execution.lastSession, destinationSession)) {
      expectedPreviousSession = phase.session;
    } else {
      throw new Error("Project Notes phase sessions diverged before lease handoff.");
    }
  }
  const fenced = await options.leaseRepository!.withFence(
    {
      cwd: state.cwd,
      phaseId: request.phaseId,
      token: { leaseId: lease.leaseId, fence: lease.fence },
      holder,
    },
    () =>
      options.repository.bindPhaseToCurrentSession(state.cwd, {
        action: expectedPreviousSession === null ? "bind-current" : "rebind-current",
        phaseId: request.phaseId,
        expectedProjectKey: snapshot.projectKey,
        expectedRevision: snapshot.revision,
        expectedPreviousSession,
        operationId: `${request.operationId}:notes-session`,
        destinationSession,
        timestamp: (options.now ?? (() => new Date().toISOString()))(),
      }),
  );
  if (fenced.status !== "executed") {
    throw new Error(`Phase lease fence rejected Notes session handoff (${fenced.status}).`);
  }
  const binding = fenced.value;
  if (
    binding.status !== "committed" &&
    binding.status !== "duplicate" &&
    binding.status !== "already-bound"
  ) {
    throw new Error(`Project Notes session handoff failed (${binding.status}).`);
  }
  const latest = await options.repository.load(state.cwd);
  if (latest.status !== "ok") {
    throw new Error(`Project Notes session handoff could not be verified (${latest.status}).`);
  }
  const latestPhase = latest.snapshot.document.phases.find(
    (candidate) => candidate.id === request.phaseId,
  );
  if (
    !latestPhase ||
    !notesSessionLinksEqual(latestPhase.session, destinationSession) ||
    (latestPhase.execution &&
      !notesSessionLinksEqual(latestPhase.execution.lastSession, destinationSession))
  ) {
    throw new Error("Project Notes did not retain the lease holder session.");
  }
  if (binding.status === "committed") options.onCommittedSnapshot?.(latest.snapshot);
  return latest.snapshot;
}

async function bindLegacyRequestThroughLease(
  options: AppSidecarPhaseBindingOptions,
  request: PhaseBindingRequest,
  session: PhaseBindingSession,
): Promise<PhaseBindingOutcome> {
  const state = session.getState();
  if (!state.sessionPath) return { status: "missing-session-path" };
  const loaded = await options.repository.load(state.cwd);
  const preflight = bindingPreflight(loaded, request);
  if (preflight) return preflight;
  if (loaded.status !== "ok") return loaded;
  const phase = loaded.snapshot.document.phases.find(
    (candidate) => candidate.id === request.phaseId,
  )!;
  let action: PhaseLeaseRequestV2["action"] = "acquire";
  let token: PhaseLeaseRequestV2["lease"] = null;
  if (request.action === "rebind-current") {
    const inspected = await executePhaseLease(
      options,
      {
        version: 2,
        action: "inspect",
        phaseId: request.phaseId,
        expectedProjectKey: request.expectedProjectKey,
        expectedRevision: request.expectedRevision,
        planId: phase.execution?.plan?.planId ?? null,
        operationId: `${request.operationId}:inspect`,
        lease: null,
        confirmTakeover: false,
        takeoverReason: null,
        predecessorProof: null,
      },
      session,
    );
    if (inspected.status !== "inspected")
      return mapLeaseToLegacy(inspected, loaded.snapshot.revision, phase.session, state);
    if (inspected.lease) {
      const expected = request.expectedPreviousSession;
      if (
        !expected ||
        inspected.lease.holder.sessionId !== expected.sessionId ||
        inspected.lease.holder.sessionPath !== expected.sessionPath
      ) {
        return {
          status: "stale-previous-session",
          revision: loaded.snapshot.revision,
          currentSession: {
            sessionId: inspected.lease.holder.sessionId,
            sessionPath: inspected.lease.holder.sessionPath,
          },
        };
      }
      action = "takeover";
      token = { leaseId: inspected.lease.leaseId, fence: inspected.lease.fence };
    } else if (!notesSessionLinksEqual(phase.session, request.expectedPreviousSession)) {
      return {
        status: "stale-previous-session",
        revision: loaded.snapshot.revision,
        currentSession: phase.session,
      };
    }
  }
  const outcome = await executePhaseLease(
    options,
    {
      version: 2,
      action,
      phaseId: request.phaseId,
      expectedProjectKey: request.expectedProjectKey,
      expectedRevision: request.expectedRevision,
      planId: phase.execution?.plan?.planId ?? null,
      operationId: request.operationId,
      lease: token,
      confirmTakeover: action === "takeover",
      takeoverReason: action === "takeover" ? "Legacy explicit session move" : null,
      predecessorProof: null,
    },
    session,
  );
  return mapLeaseToLegacy(
    outcome,
    "roadmapRevision" in outcome ? outcome.roadmapRevision : loaded.snapshot.revision,
    phase.session,
    state,
  );
}

function mapLeaseToLegacy(
  outcome: PhaseLeaseOutcome,
  revision: number,
  previousSession: NotesSessionLink | null,
  state: ReturnType<PhaseBindingSession["getState"]>,
): PhaseBindingOutcome {
  const session = { sessionId: state.sessionId, sessionPath: state.sessionPath };
  if (outcome.status === "acquired" || outcome.status === "renewed") {
    return { status: "committed", revision, phaseId: outcome.phaseId, previousSession, session };
  }
  if (outcome.status === "duplicate") {
    return { status: "duplicate", revision, phaseId: outcome.phaseId, previousSession, session };
  }
  if (outcome.status === "phase-lease-held" && outcome.currentLease) {
    return {
      status: "already-bound",
      revision,
      phaseId: outcome.currentLease.phaseId,
      session: {
        sessionId: outcome.currentLease.holder.sessionId,
        sessionPath: outcome.currentLease.holder.sessionPath,
      },
    };
  }
  if (outcome.status === "phase-lease-lost" || outcome.status === "lease-owner-unreachable") {
    return {
      status: "stale-previous-session",
      revision,
      currentSession: outcome.currentLease
        ? {
            sessionId: outcome.currentLease.holder.sessionId,
            sessionPath: outcome.currentLease.holder.sessionPath,
          }
        : null,
    };
  }
  if (outcome.status === "operation-conflict") {
    return { status: "duplicate-id-conflict", revision };
  }
  if (outcome.status === "stale-revision") {
    return { status: "stale-revision", revision: outcome.roadmapRevision };
  }
  if (outcome.status === "project-mismatch") {
    return {
      status: "project-mismatch",
      revision: outcome.roadmapRevision,
      currentProjectKey: outcome.currentProjectKey,
    };
  }
  if (outcome.status === "phase-not-found") return { status: "phase-not-found" };
  if (outcome.status === "phase-archived") return { status: "phase-archived" };
  if (outcome.status === "phase-terminal") return { status: "phase-terminal" };
  if (outcome.status === "missing") return { status: "missing" };
  if (outcome.status === "corrupt") return outcome;
  return { status: "stale-revision", revision };
}

function bindingPreflight(
  loaded: ProjectNotesLoadOutcome,
  request: PhaseBindingRequest,
): PhaseBindingOutcome | null {
  if (loaded.status !== "ok") return loaded;
  if (loaded.snapshot.projectKey !== request.expectedProjectKey) {
    return {
      status: "project-mismatch",
      revision: loaded.snapshot.revision,
      currentProjectKey: loaded.snapshot.projectKey,
    };
  }
  if (loaded.snapshot.revision !== request.expectedRevision) {
    return { status: "stale-revision", revision: loaded.snapshot.revision };
  }
  const phase = loaded.snapshot.document.phases.find(
    (candidate) => candidate.id === request.phaseId,
  );
  if (!phase) return { status: "phase-not-found" };
  if (phase.archivedAt !== null) return { status: "phase-archived" };
  if (phase.status === "done") return { status: "phase-terminal" };
  return null;
}

async function clearSessionContext(
  session: PhaseBindingSession,
  reason: ActivePhaseContextClearReason,
): Promise<void> {
  if (session.clearActivePhaseContext) await session.clearActivePhaseContext(reason);
  else await session.setActivePhaseContext(undefined);
}
