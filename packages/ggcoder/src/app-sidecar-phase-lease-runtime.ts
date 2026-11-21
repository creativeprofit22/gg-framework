import { randomUUID } from "node:crypto";
import type { AgentSession } from "./core/agent-session.js";
import { captureSidecarError } from "./core/sidecar-error-reporter.js";
import type { AppSidecarPhaseBindingService } from "./app-sidecar-phase-binding.js";
import { recordRoadmapDurabilityDiagnostic } from "./app-sidecar-roadmap-daemon.js";
import type { ProjectNotesRepository } from "./project-notes-repository.js";
import { PHASE_LEASE_RENEW_INTERVAL_MS } from "./roadmap-phase-lease-repository.js";

/**
 * Per-session Roadmap phase-lease runtime (Local Fork). Owns the deferred
 * release state, run-boundary release/renew/catch-up helpers and the lease
 * heartbeat. `getSession` is read at every use so a swapped session (new
 * session, build reset) is honoured exactly like the former inline closure.
 */
interface AppSidecarPhaseLeaseRuntimeDeps {
  cwd: string;
  getSession: () => AgentSession;
  phaseBinding: AppSidecarPhaseBindingService;
  notesRepository: ProjectNotesRepository;
  durableRoadmapExecution: boolean;
  broadcast: (type: string, data: unknown) => void;
}

interface AppSidecarPhaseLeaseRuntime {
  releaseCurrentPhaseLease(operationId: string): Promise<void>;
  releaseOrDeferPhaseLease(operationId: string): Promise<void>;
  catchUpCompactedPhaseLink(): Promise<void>;
  settleDeferredPhaseLeaseRelease(): Promise<boolean>;
  renewCurrentPhaseLease(operationId: string): Promise<void>;
  /** Start the unref'd lease heartbeat (no-op without durable execution). */
  startHeartbeat(): void;
  /**
   * Stop the lease heartbeat; idempotent. Session dispose calls this first so
   * a disposed session whose lease release failed or was deferred cannot keep
   * renewing (and so pinning) its lease past orphan recovery.
   */
  stopHeartbeat(): void;
}

export function createAppSidecarPhaseLeaseRuntime(
  deps: AppSidecarPhaseLeaseRuntimeDeps,
): AppSidecarPhaseLeaseRuntime {
  const { cwd, getSession, phaseBinding, notesRepository, durableRoadmapExecution, broadcast } =
    deps;
  let deferredPhaseLeaseReleaseOperationId: string | null = null;
  let phaseLeaseHeartbeat: ReturnType<typeof setInterval> | null = null;
  async function releaseCurrentPhaseLease(operationId: string): Promise<void> {
    if (!getSession().getRoadmapPhaseLeaseMarker()) return;
    if (getSession().getPhaseLeaseRunState() === "running") {
      deferredPhaseLeaseReleaseOperationId = operationId;
      throw new Error("Phase lease release deferred until the provider run settles.");
    }
    const outcome = await phaseBinding.releaseCurrent(operationId, getSession());
    if (
      outcome.status === "released" ||
      (outcome.status === "duplicate" && outcome.lease === null)
    ) {
      if (deferredPhaseLeaseReleaseOperationId === operationId) {
        deferredPhaseLeaseReleaseOperationId = null;
      }
      return;
    }
    throw new Error(`Phase lease release failed: ${outcome.status}`);
  }
  async function releaseOrDeferPhaseLease(operationId: string): Promise<void> {
    if (getSession().getPhaseLeaseRunState() === "running") {
      deferredPhaseLeaseReleaseOperationId = operationId;
      return;
    }
    await releaseCurrentPhaseLease(operationId);
  }
  /**
   * Run boundary: move the Notes phase link onto the current session after a
   * mid-run compaction (the compaction event moved only the lease, so the
   * agent's held Notes revision stayed valid). No-op without a compaction.
   */
  async function catchUpCompactedPhaseLink(): Promise<void> {
    try {
      await phaseBinding.handOffCompactedSession(getSession());
    } catch (error) {
      captureSidecarError(error, "app-sidecar.phase-link-catch-up");
    }
  }
  async function settleDeferredPhaseLeaseRelease(): Promise<boolean> {
    const operationId = deferredPhaseLeaseReleaseOperationId;
    if (!operationId) return false;
    await releaseCurrentPhaseLease(operationId);
    deferredPhaseLeaseReleaseOperationId = null;
    return true;
  }
  async function renewCurrentPhaseLease(operationId: string): Promise<void> {
    const marker = getSession().getRoadmapPhaseLeaseMarker();
    const active = getSession().getActivePhaseContext();
    if (!marker || !active) return;
    const loaded = await notesRepository.load(cwd);
    if (loaded.status !== "ok") throw new Error("Project Notes unavailable for lease renewal.");
    const outcome = await phaseBinding.lease(
      {
        version: 2,
        action: "renew",
        phaseId: marker.phaseId,
        expectedProjectKey: loaded.snapshot.projectKey,
        expectedRevision: loaded.snapshot.revision,
        planId: marker.planId,
        operationId: `${operationId}:${marker.leaseId}`,
        lease: { leaseId: marker.leaseId, fence: marker.fence },
        confirmTakeover: false,
        takeoverReason: null,
        predecessorProof: null,
      },
      getSession(),
    );
    if (outcome.status === "renewed" || outcome.status === "duplicate") return;
    if (outcome.status === "phase-lease-lost") {
      recordRoadmapDurabilityDiagnostic("phase-lease-lost");
      await getSession().clearActivePhaseContext("phase-rebound");
    }
    throw new Error(`Phase lease renewal failed: ${outcome.status}`);
  }
  function startHeartbeat(): void {
    stopHeartbeat();
    phaseLeaseHeartbeat = durableRoadmapExecution
      ? setInterval(() => {
          const marker = getSession().getRoadmapPhaseLeaseMarker();
          const active = getSession().getActivePhaseContext();
          if (!marker || !active) return;
          void notesRepository
            .load(cwd)
            .then(async (loaded) => {
              if (loaded.status !== "ok") return;
              const outcome = await phaseBinding.lease(
                {
                  version: 2,
                  action: "renew",
                  phaseId: marker.phaseId,
                  expectedProjectKey: loaded.snapshot.projectKey,
                  expectedRevision: loaded.snapshot.revision,
                  planId: marker.planId,
                  operationId: `heartbeat:${marker.leaseId}:${randomUUID()}`,
                  lease: { leaseId: marker.leaseId, fence: marker.fence },
                  confirmTakeover: false,
                  takeoverReason: null,
                  predecessorProof: null,
                },
                getSession(),
              );
              if (outcome.status === "phase-lease-lost") {
                recordRoadmapDurabilityDiagnostic("phase-lease-lost");
                await getSession().clearActivePhaseContext("phase-rebound");
                broadcast("error", {
                  message: "Roadmap phase lease lost; this session is now read-only.",
                });
              }
            })
            .catch((error) => captureSidecarError(error, "app-sidecar.phase-lease-heartbeat"));
        }, PHASE_LEASE_RENEW_INTERVAL_MS)
      : null;
    phaseLeaseHeartbeat?.unref();
  }
  function stopHeartbeat(): void {
    if (phaseLeaseHeartbeat === null) return;
    clearInterval(phaseLeaseHeartbeat);
    phaseLeaseHeartbeat = null;
  }
  return {
    releaseCurrentPhaseLease,
    releaseOrDeferPhaseLease,
    catchUpCompactedPhaseLink,
    settleDeferredPhaseLeaseRelease,
    renewCurrentPhaseLease,
    startHeartbeat,
    stopHeartbeat,
  };
}
