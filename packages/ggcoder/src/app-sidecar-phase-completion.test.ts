import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarPhaseCompletionCoordinator,
  AppSidecarPhaseImplementationPlanTracker,
  checkpointSettledPhaseImplementation,
  restorePhaseImplementationPlanEvidence,
  type PhaseCompletionRepository,
} from "./app-sidecar-phase-completion.js";
import type { NotesPhase, ProjectNotesSnapshot } from "./project-notes-repository.js";

const NOW = "2026-07-28T12:00:00.000Z";
const session = { sessionId: "session-24", sessionPath: "/sessions/24.jsonl" };

function phase(): NotesPhase {
  return {
    id: "phase-24",
    title: "Completion gates",
    goal: "Finish only with durable evidence",
    doneWhen: ["All gates pass"],
    order: 0,
    status: "in-progress",
    sourcePrompt: "Implement Phase 24",
    referenceIds: [],
    session,
    reminder: null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [
      {
        type: "implementation-checkpoint",
        id: "checkpoint-prior",
        session,
        planStepTotal: 3,
        completedPlanSteps: [1, 2],
        runOutcome: "interrupted",
        timestamp: NOW,
      },
    ],
  };
}

function snapshot(candidate = phase()): ProjectNotesSnapshot {
  return {
    revision: 2,
    projectKey: "C:/project",
    document: {
      version: 3,
      reference: "",
      currentFocus: "",
      tasks: [],
      handoff: { text: "", updatedAt: null, readAt: null },
      updatedAt: NOW,
      legacyImportedAt: null,
      phases: [candidate],
      references: [],
    },
  };
}

function repository(): PhaseCompletionRepository {
  return {
    recordImplementationCheckpoint: vi.fn(async (_cwd, request) => ({
      status: "committed" as const,
      snapshot: snapshot(),
      phase: phase(),
      request,
    })),
    settlePhaseCompletion: vi.fn(async (_cwd, request) => ({
      status: "committed" as const,
      snapshot: snapshot({ ...phase(), status: "done", completedAt: NOW }),
      phase: { ...phase(), status: "done" as const, completedAt: NOW },
      evaluation: {
        gateOutcome: "done" as const,
        unmetGateCodes: [],
        implementationCheckpointId: request.checkpointId,
        verificationStatusUpdateId: request.completionIntentId,
        targetStatus: "done" as const,
        reason: "Passed",
      },
      advancementCheckpoint: null,
    })),
  };
}

describe("AppSidecarPhaseCompletionCoordinator", () => {
  it("retains canonical plan progress after prompt cleanup", () => {
    const tracker = new AppSidecarPhaseImplementationPlanTracker();
    expect(
      tracker.resolve({ phaseId: "phase-24", session, current: { total: 3, completed: [1, 2] } }),
    ).toEqual({ total: 3, completed: [1, 2] });
    expect(
      tracker.resolve({ phaseId: "phase-24", session, current: { total: 0, completed: [] } }),
    ).toEqual({ total: 3, completed: [1, 2] });
  });

  it("restores only plan shape from a prior same-session checkpoint", () => {
    const tracker = new AppSidecarPhaseImplementationPlanTracker();
    expect(
      restorePhaseImplementationPlanEvidence({ tracker, phase: phase(), expectedSession: session }),
    ).toBe(true);
    expect(
      tracker.resolve({ phaseId: "phase-24", session, current: { total: 0, completed: [] } }),
    ).toEqual({ total: 3, completed: [1, 2] });
  });

  it("settles direct completion with only the current run's intent ID", async () => {
    const repo = repository();
    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd: "C:/project",
      repository: repo,
      broadcastSnapshot: vi.fn(),
    });
    const tracker = new AppSidecarPhaseImplementationPlanTracker();

    const outcome = await checkpointSettledPhaseImplementation({
      coordinator,
      tracker,
      checkpointId: "checkpoint-current",
      completionIntentId: "completion-intent-current",
      phaseId: "phase-24",
      expectedSession: session,
      currentPlanProgress: { total: 3, completed: [1, 2, 3] },
      runOutcome: "succeeded",
      timestamp: NOW,
    });

    expect(repo.settlePhaseCompletion).toHaveBeenCalledWith("C:/project", {
      checkpointId: "checkpoint-current",
      completionIntentId: "completion-intent-current",
      phaseId: "phase-24",
      expectedSession: session,
      planStepTotal: 3,
      completedPlanSteps: [1, 2, 3],
      runOutcome: "succeeded",
      timestamp: NOW,
    });
    expect(outcome).toMatchObject({ status: "committed", evaluation: { gateOutcome: "done" } });
  });

  it("records ordinary failed runs without inventing completion intent", async () => {
    const repo = repository();
    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd: "C:/project",
      repository: repo,
      broadcastSnapshot: vi.fn(),
    });

    await checkpointSettledPhaseImplementation({
      coordinator,
      tracker: new AppSidecarPhaseImplementationPlanTracker(),
      checkpointId: "checkpoint-failed",
      phaseId: "phase-24",
      expectedSession: session,
      currentPlanProgress: { total: 3, completed: [1] },
      runOutcome: "failed",
      timestamp: NOW,
    });

    expect(repo.recordImplementationCheckpoint).toHaveBeenCalledOnce();
    expect(repo.settlePhaseCompletion).not.toHaveBeenCalled();
  });
});
