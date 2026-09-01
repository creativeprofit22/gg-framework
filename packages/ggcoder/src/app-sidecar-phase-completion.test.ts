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

function pendingDurablePhase() {
  const candidate = phase();
  const identity = {
    projectKey: "C:/project",
    identityHash: "1".repeat(64),
    rootCommit: "2".repeat(40),
  };
  const workspace = {
    version: 1 as const,
    repository: identity,
    headCommit: "3".repeat(40),
    worktreeDigest: "4".repeat(64),
    clean: true,
  };
  candidate.execution = {
    version: 1,
    state: "completion-pending",
    repository: identity,
    plan: {
      planId: "plan-1",
      contentHash: "5".repeat(64),
      snapshotPath: ".gg/plans/approved/plan-1.md",
      approvedAt: NOW,
      approvedRevision: 2,
      baseCommit: workspace.headCommit,
      steps: [{
        id: "6".repeat(64), index: 1, text: "Complete", state: "completed",
        completedAt: NOW, workspace,
      }],
    },
    evidence: [],
    pendingCompletion: {
      completionId: "completion-pending",
      statusRevision: 8,
      runJournal: { sessionPath: session.sessionPath, generation: 7 },
      planHash: "5".repeat(64),
      workspace,
    },
    lastSession: session,
    migration: { source: "native", reconciledAt: NOW },
  };
  return { candidate, workspace };
}

function repository(): PhaseCompletionRepository {
  const settledOutcome = {
    status: "committed" as const,
    snapshot: snapshot({ ...phase(), status: "done", completedAt: NOW }),
    phase: { ...phase(), status: "done" as const, completedAt: NOW },
    evaluation: {
      gateOutcome: "done" as const,
      unmetGateCodes: [],
      implementationCheckpointId: "checkpoint-settled",
      verificationStatusUpdateId: "completion-pending",
      targetStatus: "done" as const,
      reason: "Passed",
    },
    advancementCheckpoint: null,
  };
  return {
    recordImplementationCheckpoint: vi.fn(async (_cwd, request) => ({
      status: "committed" as const,
      snapshot: snapshot(),
      phase: phase(),
      request,
    })),
    settlePhaseCompletion: vi.fn(async () => settledOutcome),
    settleDurablePhaseCompletion: vi.fn(async () => settledOutcome),
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

  it("hydrates durable plan progress across physical sessions", () => {
    const durable = phase();
    const repository = {
      projectKey: "C:/project",
      identityHash: "1".repeat(64),
      rootCommit: "2".repeat(40),
    };
    const workspace = {
      version: 1 as const,
      repository,
      headCommit: "3".repeat(40),
      worktreeDigest: "4".repeat(64),
      clean: true,
    };
    durable.execution = {
      version: 1,
      state: "implementing",
      repository,
      plan: {
        planId: "plan-1",
        contentHash: "5".repeat(64),
        snapshotPath: ".gg/plans/approved/plan-1.md",
        approvedAt: NOW,
        approvedRevision: 2,
        baseCommit: workspace.headCommit,
        steps: [
          { id: "6".repeat(64), index: 1, text: "First", state: "completed", completedAt: NOW, workspace },
          { id: "7".repeat(64), index: 2, text: "Second", state: "pending", completedAt: null, workspace: null },
        ],
      },
      evidence: [],
      pendingCompletion: null,
      lastSession: session,
      migration: { source: "native", reconciledAt: NOW },
    };
    const tracker = new AppSidecarPhaseImplementationPlanTracker();
    const freshSession = { sessionId: "fresh", sessionPath: "/sessions/fresh.jsonl" };
    expect(restorePhaseImplementationPlanEvidence({ tracker, phase: durable, expectedSession: freshSession })).toBe(true);
    expect(
      tracker.resolve({ phaseId: durable.id, session: freshSession, current: { total: 0, completed: [] } }),
    ).toEqual({ total: 2, completed: [1] });
  });

  it("settles direct completion", async () => {
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

  it("does not settle after the session loses its lease fence", async () => {
    const repo = repository();
    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd: "C:/project",
      repository: repo,
      broadcastSnapshot: vi.fn(),
      mutateWithLeaseFence: async () => ({ status: "phase-lease-lost" as const }),
    });

    const outcome = await coordinator.settle({
      checkpointId: "checkpoint-fenced",
      completionIntentId: "completion-intent-fenced",
      phaseId: "phase-24",
      expectedSession: session,
      planStepTotal: 1,
      completedPlanSteps: [1],
      runOutcome: "succeeded",
      timestamp: NOW,
    });

    expect(outcome).toEqual({ status: "phase-lease-lost" });
    expect(repo.settlePhaseCompletion).not.toHaveBeenCalled();
  });

  it("recovers a successful pending completion from its durable run journal", async () => {
    const { candidate, workspace } = pendingDurablePhase();
    const repo = repository();
    repo.load = vi.fn(async () => ({
      status: "ok" as const,
      snapshot: { ...snapshot(candidate), revision: 9 },
      recoveredFromBackup: false,
    }));
    repo.clearDurablePhaseCompletion = vi.fn();
    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd: "C:/project",
      repository: repo,
      broadcastSnapshot: vi.fn(),
      captureWorkspaceSnapshot: async () => workspace,
    });

    const outcome = await coordinator.settleDurableRun({
      phaseId: candidate.id,
      expectedSession: session,
      runGeneration: 7,
      runOutcome: "succeeded",
    });

    expect(outcome).toMatchObject({ status: "committed" });
    expect(repo.settleDurablePhaseCompletion).toHaveBeenCalledWith("C:/project", {
      phaseId: candidate.id,
      completionId: "completion-pending",
      expectedRevision: 9,
      planHash: candidate.execution!.plan!.contentHash,
      workspace,
    });
    expect(repo.settlePhaseCompletion).not.toHaveBeenCalled();
    expect(repo.clearDurablePhaseCompletion).not.toHaveBeenCalled();
  });

  it("clears pending completion after a failed owning run", async () => {
    const { candidate, workspace } = pendingDurablePhase();
    const repo = repository();
    repo.load = vi.fn(async () => ({
      status: "ok" as const,
      snapshot: { ...snapshot(candidate), revision: 9 },
      recoveredFromBackup: false,
    }));
    repo.clearDurablePhaseCompletion = vi.fn(async () => ({
      status: "committed" as const, snapshot: snapshot(candidate), phase: candidate,
    }));
    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd: "C:/project",
      repository: repo,
      broadcastSnapshot: vi.fn(),
      captureWorkspaceSnapshot: async () => workspace,
    });

    await coordinator.settleDurableRun({
      phaseId: candidate.id,
      expectedSession: session,
      runGeneration: 7,
      runOutcome: "failed",
    });

    expect(repo.clearDurablePhaseCompletion).toHaveBeenCalledWith(
      "C:/project",
      expect.objectContaining({ completionId: "completion-pending", expectedRevision: 9 }),
    );
    expect(repo.settlePhaseCompletion).not.toHaveBeenCalled();
  });

  it("reports missing plan progress when a completion intent cannot settle", async () => {
    const repo = repository();
    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd: "C:/project",
      repository: repo,
      broadcastSnapshot: vi.fn(),
    });

    const outcome = await checkpointSettledPhaseImplementation({
      coordinator,
      tracker: new AppSidecarPhaseImplementationPlanTracker(),
      checkpointId: "checkpoint-missing-plan",
      completionIntentId: "completion-intent-current",
      phaseId: "phase-24",
      expectedSession: session,
      currentPlanProgress: { total: 0, completed: [] },
      runOutcome: "succeeded",
      timestamp: NOW,
    });

    expect(outcome).toEqual({
      status: "missing-plan-progress",
      completionIntentId: "completion-intent-current",
      message: "Completion was not settled because same-session canonical plan progress is unavailable.",
    });
    expect(repo.recordImplementationCheckpoint).not.toHaveBeenCalled();
    expect(repo.settlePhaseCompletion).not.toHaveBeenCalled();
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
