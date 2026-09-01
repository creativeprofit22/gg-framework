import { describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
  type AppSidecarRoadmapToolSession,
} from "./app-sidecar-roadmap-tool-host.js";
import type { RoadmapVerificationEvidenceEvaluation } from "./core/verification-evidence.js";
import { RoadmapCheckpointParams } from "./tools/roadmap-checkpoint.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const sessionLink = { sessionId: "phase-session", sessionPath: "/sessions/phase.jsonl" };

function owningSession(): AppSidecarRoadmapToolSession {
  return {
    getActivePhaseContext: () => ({
      version: 1,
      projectKey: "/project",
      phase: {
        id: "phase-1",
        title: "Direct completion",
        goal: "Complete without a reviewer",
        doneWhen: ["Tests pass"],
        sourcePrompt: "Implement it",
        status: "in-progress",
        archivedAt: null,
      },
      session: sessionLink,
      references: [],
      executionStage: "implementing",
    }),
    getMessages: () => [],
    getState: () => sessionLink,
    evaluateRoadmapVerificationEvidence: () => ({
      ready: true,
      unmetEvidenceCodes: [],
      criterionCoverage: [
        {
          criterionIndex: 0,
          criterion: "Tests pass",
          evidence: "pnpm test exited successfully",
          command: "pnpm test",
        },
      ],
    }),
  };
}

function doneInput(evidence = "pnpm test exited successfully") {
  return RoadmapStatusParams.parse({
    update_id: "completion-intent-1",
    phase_id: "phase-1",
    expected_revision: 4,
    transition: "done",
    progress: "Implementation and verification completed",
    evidence: [evidence],
    verification: { result: "passed" },
  });
}

describe("AppSidecarRoadmapToolHost", () => {
  it("never gives Ken or Autopilot Ken a Roadmap mutation tool", () => {
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate: vi.fn() },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      broadcastNotesSnapshot: vi.fn(),
    });

    expect(host.createSessionTools("ken")).toEqual([]);
    expect(host.createSessionTools("ken-autopilot")).toEqual([]);
    expect(APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES).not.toContain("roadmap_status");
    expect(APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES).not.toContain("roadmap_checkpoint");
  });

  it("fences a structured checkpoint before capturing its plan-bound workspace", async () => {
    const workspace = {
      version: 1 as const,
      repository: {
        projectKey: "/project",
        identityHash: "1".repeat(64),
        rootCommit: "2".repeat(40),
      },
      headCommit: "3".repeat(40),
      worktreeDigest: "4".repeat(64),
      clean: false,
    };
    const order: string[] = [];
    const checkpointPhaseExecutionStep = vi.fn(async () => {
      order.push("persist");
      return {
        status: "committed" as const,
        snapshot: { revision: 5 } as never,
        phase: {} as never,
      };
    });
    const broadcastNotesSnapshot = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate: vi.fn(), checkpointPhaseExecutionStep },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      captureWorkspaceSnapshot: async () => {
        order.push("capture");
        return workspace;
      },
      mutateWithLeaseFence: async (operation) => {
        order.push("fence-enter");
        const value = await operation();
        order.push("fence-exit");
        return { status: "executed" as const, value };
      },
      broadcastNotesSnapshot,
      now: () => "2026-08-31T10:00:00.000Z",
    });
    const tool = host
      .createSessionTools("coding", owningSession)
      .find((candidate) => candidate.name === "roadmap_checkpoint")!;
    const input = RoadmapCheckpointParams.parse({
      phase_id: "phase-1",
      plan_hash: "5".repeat(64),
      step_id: "6".repeat(64),
      expected_revision: 4,
    });

    expect(JSON.parse(String(await tool.execute(input, {} as never)))).toEqual({
      result: "committed",
      phaseId: "phase-1",
      stepId: "6".repeat(64),
      revision: 5,
    });
    expect(order).toEqual(["fence-enter", "capture", "persist", "fence-exit"]);
    expect(checkpointPhaseExecutionStep).toHaveBeenCalledWith("/project", {
      phaseId: "phase-1",
      expectedRevision: 4,
      planHash: "5".repeat(64),
      stepId: "6".repeat(64),
      completedAt: "2026-08-31T10:00:00.000Z",
      workspace,
    });
    expect(broadcastNotesSnapshot).toHaveBeenCalledWith({ revision: 5 });
  });

  it("rejects a structured checkpoint before workspace capture after lease loss", async () => {
    const checkpointPhaseExecutionStep = vi.fn();
    const captureWorkspaceSnapshot = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate: vi.fn(), checkpointPhaseExecutionStep },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      captureWorkspaceSnapshot,
      mutateWithLeaseFence: async () => ({ status: "phase-lease-lost" as const }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const tool = host
      .createSessionTools("coding", owningSession)
      .find((candidate) => candidate.name === "roadmap_checkpoint")!;
    const input = RoadmapCheckpointParams.parse({
      phase_id: "phase-1",
      plan_hash: "5".repeat(64),
      step_id: "6".repeat(64),
      expected_revision: 4,
    });

    expect(JSON.parse(String(await tool.execute(input, {} as never)))).toMatchObject({
      result: "phase-lease-lost",
      phaseId: "phase-1",
      revision: 4,
    });
    expect(captureWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(checkpointPhaseExecutionStep).not.toHaveBeenCalled();
  });

  it("records coding-session Done intent and retains its exact status ID", async () => {
    const recordRoadmapStatusUpdate = vi.fn(async () => ({
      status: "duplicate" as const,
      revision: 5,
      phaseId: "phase-1",
      phase: {} as never,
      statusOutcome: "completion-pending" as const,
      proposals: [],
    }));
    const onCompletionIntent = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      broadcastNotesSnapshot: vi.fn(),
      onCompletionIntent,
    });
    const tool = host.createSessionTools("coding", owningSession)[0]!;
    const output = await tool.execute(doneInput(), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "duplicate",
      phaseId: "phase-1",
      revision: 5,
      statusOutcome: "completion-pending",
      completionIntentId: "completion-intent-1",
    });
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        updateId: "completion-intent-1",
        actor: "gg-coder",
        transition: "done",
        verification: "passed",
        expectedSession: sessionLink,
      }),
    );
    expect(onCompletionIntent).toHaveBeenCalledWith({
      phaseId: "phase-1",
      statusUpdateId: "completion-intent-1",
      revision: 5,
      session: sessionLink,
    });
  });

  it("rejects Roadmap mutations after the session loses its lease fence", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      broadcastNotesSnapshot: vi.fn(),
      mutateWithLeaseFence: async () => ({ status: "phase-lease-lost" as const }),
    });

    const output = await host
      .createSessionTools("coding", owningSession)[0]!
      .execute(doneInput(), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "phase-lease-lost",
      phaseId: "phase-1",
      revision: 4,
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });

  it("fails closed when classifier-approved criterion coverage is incomplete", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const session = owningSession();
    session.evaluateRoadmapVerificationEvidence = (): RoadmapVerificationEvidenceEvaluation => ({
      ready: false,
      unmetEvidenceCodes: ["unmatched-evidence" as const],
    });
    const output = await host
      .createSessionTools("coding", () => session)[0]!
      .execute(doneInput(), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "verification-incomplete",
      unmetEvidenceCodes: ["unmatched-evidence"],
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });

  it("persists command-time workspace evidence and uses the resulting revision", async () => {
    const repositoryIdentity = {
      projectKey: "/project",
      identityHash: "1".repeat(64),
      rootCommit: "2".repeat(40),
    };
    const workspace = {
      version: 1 as const,
      repository: repositoryIdentity,
      headCommit: "3".repeat(40),
      worktreeDigest: "4".repeat(64),
      clean: true,
    };
    const phase = {
      id: "phase-1",
      status: "in-progress",
      execution: {
        version: 1,
        state: "implementing",
        repository: repositoryIdentity,
        plan: {
          planId: "plan-1",
          contentHash: "5".repeat(64),
          steps: [{ state: "completed" }],
        },
        evidence: [],
      },
    } as never;
    const loadedSnapshot = {
      revision: 4,
      projectKey: "/project",
      document: { phases: [phase], references: [] },
    };
    const evidenceSnapshot = { ...loadedSnapshot, revision: 5 };
    const recordPhaseExecutionEvidence = vi.fn(async () => ({
      status: "committed" as const,
      snapshot: evidenceSnapshot as never,
      phase,
    }));
    const recordRoadmapStatusUpdate = vi.fn(async () => ({
      status: "duplicate" as const,
      revision: 6,
      phaseId: "phase-1",
      phase,
      statusOutcome: "completion-pending" as const,
      proposals: [],
    }));
    const command = "pnpm test -- --token=synthetic-token-4f93a8";
    const session = owningSession();
    session.getVerificationEvidenceLedgerSnapshot = () => ({
      currentEvidence: [
        {
          command,
          status: "passed",
          reason: "bounded test",
          workspace,
          classifierVersion: "roadmap-verification-v1",
        },
      ],
      staleEvidence: [],
    });
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        load: vi.fn(async () => ({
          status: "ok" as const,
          snapshot: loadedSnapshot as never,
          recoveredFromBackup: false,
        })),
        recordPhaseExecutionEvidence,
        recordRoadmapStatusUpdate,
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      captureWorkspaceSnapshot: async () => workspace,
      getRunGeneration: () => 1,
      broadcastNotesSnapshot: vi.fn(),
      now: () => "2026-08-30T10:00:00.000Z",
    });
    const output = await host
      .createSessionTools("coding", () => session)[0]!
      .execute(doneInput(`${command} exited successfully`), {} as never);
    expect(JSON.parse(String(output))).toMatchObject({ result: "duplicate", revision: 6 });
    expect(recordPhaseExecutionEvidence).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        expectedRevision: 4,
        planHash: "5".repeat(64),
        evidence: expect.objectContaining({
          commandHash: "50c7de277d4a0807ed6cfff53ccc7ae26be29b9df51b350f5189cad82115490c",
          commandDisplay: "pnpm test -- --token=[REDACTED]",
        }),
      }),
    );
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledOnce();
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        expectedRevision: 5,
        durableCompletion: {
          runJournal: { sessionPath: "/sessions/phase.jsonl", generation: 1 },
          planHash: "5".repeat(64),
          workspace,
        },
      }),
    );
    expect(
      JSON.stringify([
        recordPhaseExecutionEvidence.mock.calls,
        recordRoadmapStatusUpdate.mock.calls,
      ]),
    ).not.toContain("synthetic-token-4f93a8");
  });

  it("rejects Done without canonical plan progress before recording completion-pending", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const broadcastNotesSnapshot = vi.fn();
    const onCompletionIntent = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      broadcastNotesSnapshot,
      onCompletionIntent,
    });

    const output = await host
      .createSessionTools("coding", owningSession)[0]!
      .execute(doneInput(), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "missing-plan-progress",
      phaseId: "phase-1",
      revision: 4,
      message: "Done was not recorded because canonical plan progress is unavailable.",
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
    expect(broadcastNotesSnapshot).not.toHaveBeenCalled();
    expect(onCompletionIntent).not.toHaveBeenCalled();
  });
});
