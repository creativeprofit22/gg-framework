import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "./core/agent-session.js";
import type { AppSidecarPhaseBindingService } from "./app-sidecar-phase-binding.js";
import { createAppSidecarPhaseLeaseRuntime } from "./app-sidecar-phase-lease-runtime.js";
import type { RoadmapPhaseLeaseMarkerV1 } from "./phase-context.js";
import type { ProjectNotesRepository } from "./project-notes-repository.js";
import { PHASE_LEASE_RENEW_INTERVAL_MS } from "./roadmap-phase-lease-repository.js";

const marker: RoadmapPhaseLeaseMarkerV1 = {
  version: 1,
  projectKey: "project",
  phaseId: "phase-1",
  planId: null,
  planHash: null,
  leaseId: "lease-1",
  fence: 1,
  daemonInstanceId: "daemon-1",
};

/**
 * `AgentSession.dispose()` clears neither the lease marker nor the active
 * phase context, so a session whose dispose-time release was deferred (run
 * still "running") keeps both. This stub models exactly that survivor.
 */
function setup(durableRoadmapExecution = true) {
  const session = {
    getRoadmapPhaseLeaseMarker: () => marker,
    getActivePhaseContext: () => ({ phase: { id: marker.phaseId } }),
    getPhaseLeaseRunState: () => "running",
    clearActivePhaseContext: async () => {},
  } as unknown as AgentSession;
  const lease = vi.fn(async () => ({ status: "renewed" }));
  const releaseCurrent = vi.fn(async () => ({ status: "released", lease: null }));
  const runtime = createAppSidecarPhaseLeaseRuntime({
    cwd: "/project",
    getSession: () => session,
    phaseBinding: { lease, releaseCurrent } as unknown as AppSidecarPhaseBindingService,
    notesRepository: {
      load: async () => ({ status: "ok", snapshot: { projectKey: "project", revision: 1 } }),
    } as unknown as ProjectNotesRepository,
    durableRoadmapExecution,
    broadcast: () => {},
  });
  return { runtime, lease, releaseCurrent };
}

describe("phase lease heartbeat lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps renewing a disposed session's deferred lease until the heartbeat is stopped", async () => {
    const { runtime, lease, releaseCurrent } = setup();
    runtime.startHeartbeat();

    // Dispose-time release while the run is still "running" is deferred.
    await expect(runtime.releaseCurrentPhaseLease("session-dispose:lease-1:1")).rejects.toThrow(
      /deferred/,
    );
    expect(releaseCurrent).not.toHaveBeenCalled();

    // Without stopping, the heartbeat renews the disposed session's lease.
    await vi.advanceTimersByTimeAsync(PHASE_LEASE_RENEW_INTERVAL_MS);
    expect(lease).toHaveBeenCalledTimes(1);
    expect(lease).toHaveBeenCalledWith(
      expect.objectContaining({ action: "renew", phaseId: "phase-1" }),
      expect.anything(),
    );

    runtime.stopHeartbeat();
    lease.mockClear();
    await vi.advanceTimersByTimeAsync(PHASE_LEASE_RENEW_INTERVAL_MS * 4);
    expect(lease).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops idempotently and never leaves a second interval behind", async () => {
    const { runtime, lease } = setup();
    runtime.startHeartbeat();
    runtime.startHeartbeat();
    expect(vi.getTimerCount()).toBe(1);
    runtime.stopHeartbeat();
    runtime.stopHeartbeat();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PHASE_LEASE_RENEW_INTERVAL_MS * 2);
    expect(lease).not.toHaveBeenCalled();
  });

  it("starts no timer without durable Roadmap execution", () => {
    const { runtime } = setup(false);
    runtime.startHeartbeat();
    expect(vi.getTimerCount()).toBe(0);
    runtime.stopHeartbeat();
  });
});
