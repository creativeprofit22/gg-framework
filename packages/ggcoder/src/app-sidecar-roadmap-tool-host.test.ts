import { describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { RepositoryUnverifiableError } from "./roadmap-phase-execution.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
  type AppSidecarRoadmapToolSession,
} from "./app-sidecar-roadmap-tool-host.js";
import {
  ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
  SessionVerificationEvidenceLedger,
  roadmapCriterionId,
  safeToolEnvironmentDigest,
} from "./core/verification-evidence.js";
import { RoadmapCheckpointParams } from "./tools/roadmap-checkpoint.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const sessionLink = { sessionId: "phase-session", sessionPath: "/sessions/phase.jsonl" };
const verificationWorkspace = {
  version: 1 as const,
  repository: {
    projectKey: "/project",
    identityHash: "1".repeat(64),
    rootCommit: "2".repeat(40),
  },
  headCommit: "3".repeat(40),
  worktreeDigest: "4".repeat(64),
  clean: true,
};

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
    getVerificationEvidenceLedgerSnapshot: () => ({
      currentEvidence: [
        {
          command: "pnpm test",
          status: "passed",
          reason: "bounded test command",
          executionId: "execution-1",
          observedAt: "2026-08-30T09:59:00.000Z",
          cwd: "/project",
          safeToolEnvironmentDigest: safeToolEnvironmentDigest(),
          workspace: verificationWorkspace,
          classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
        },
      ],
      staleEvidence: [],
    }),
  };
}

function doneInput(evidence = "pnpm test exited successfully", expectedRevision = 4) {
  return RoadmapStatusParams.parse({
    update_id: "completion-intent-1",
    phase_id: "phase-1",
    expected_revision: expectedRevision,
    transition: "done",
    progress: "Implementation and verification completed",
    evidence: [evidence],
    verification_bindings: [
      { criterion_id: roadmapCriterionId(1, "Tests pass"), execution_id: "execution-1" },
    ],
    verification: { result: "passed" },
  });
}

describe("AppSidecarRoadmapToolHost", () => {
  describe.each([false, true])("real ledger freshness (durable=%s)", (durableExecution) => {
    it.each([
      "in-flight edit", "later edit", "fresh", "cwd", "cwd casing", "repository", "environment", "snapshot",
      "unavailable", "failed",
    ])("preserves %s evidence classification at the host boundary", async (scenario) => {
      const ledger = new SessionVerificationEvidenceLedger();
      const evidenceRevision = ledger.revision;
      const edit = () => ledger.recordToolResult({
        name: "edit", args: { file_path: "src/example.ts" }, isError: false,
      });
      if (scenario === "in-flight edit") edit();
      ledger.recordToolResult({
        name: "bash",
        args: { command: "pnpm test" },
        isError: false,
        evidenceRevision,
        workspace: verificationWorkspace,
        details: {
          bashDiagnostics: {
            executionId: "execution-1", command: "pnpm test",
            cwd: scenario === "cwd" ? "/other-project" : scenario === "cwd casing" ? "/PROJECT" : "/project",
            startedAt: 1000,
            ...(scenario === "unavailable" ? {} : {
              reason: scenario === "failed" ? "nonZeroExit" : "completed",
              exitCode: scenario === "failed" ? 1 : 0,
            }),
          },
        },
      });
      if (scenario === "later edit") edit();
      const stale = scenario === "in-flight edit" || scenario === "later edit";
      expect(ledger.snapshot()[stale ? "staleEvidence" : "currentEvidence"]).toEqual([
        expect.objectContaining({
          executionId: "execution-1",
          status: scenario === "unavailable" || scenario === "failed" ? scenario : "passed",
          workspace: verificationWorkspace,
        }),
      ]);
      expect(ledger.snapshot()[stale ? "currentEvidence" : "staleEvidence"]).toEqual([]);
      const session = owningSession();
      session.getVerificationEvidenceLedgerSnapshot = () => ledger.snapshot();
      const workspace = structuredClone(verificationWorkspace);
      if (scenario === "repository") workspace.repository.identityHash = "9".repeat(64);
      if (scenario === "snapshot") workspace.worktreeDigest = "9".repeat(64);
      const phase = {
        id: "phase-1",
        execution: {
          plan: { contentHash: "5".repeat(64), steps: [{ state: "completed" }] },
          evidence: [],
        },
      };
      const recordPhaseExecutionEvidence = vi.fn();
      const recordRoadmapStatusUpdate = vi.fn(async () => ({
        status: "duplicate" as const, revision: 5, phaseId: "phase-1",
        phase: phase as never, statusOutcome: "completion-pending" as const, proposals: [],
      }));
      const onCompletionIntent = vi.fn();
      const broadcastNotesSnapshot = vi.fn();
      const host = new AppSidecarRoadmapToolHost({
        cwd: "/project",
        durableExecution,
        repository: {
          load: async () => ({
            status: "ok" as const,
            snapshot: { revision: 4, document: { phases: [phase] } } as never,
            recoveredFromBackup: false,
          }),
          recordPhaseExecutionEvidence,
          recordRoadmapStatusUpdate,
        },
        reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
        projectAutopilot: { isEnabled: () => false },
        resolvePlanProgress: () => ({ total: 1, completed: [1] }),
        captureWorkspaceSnapshot: async () => workspace,
        captureVerificationWorkspace: async () => workspace,
        captureSafeToolEnvironmentDigest: () => scenario === "environment" ? "9".repeat(64) : safeToolEnvironmentDigest(),
        getRunGeneration: () => 1,
        broadcastNotesSnapshot,
        onCompletionIntent,
      });
      const output = JSON.parse(String(await host.createSessionTools("coding", () => session)[0]!
        .execute(doneInput(), {} as never)));
      if (scenario === "fresh" || (scenario === "cwd casing" && process.platform === "win32")) {
        expect(output).toMatchObject({ result: "duplicate", statusOutcome: "completion-pending" });
        expect(recordRoadmapStatusUpdate).toHaveBeenCalledOnce();
        if (durableExecution) {
          expect(recordRoadmapStatusUpdate).toHaveBeenCalledWith("/project", expect.objectContaining({
            durableCompletion: expect.objectContaining({
              verificationEvidence: [expect.objectContaining({ version: 2, executionId: "execution-1" })],
            }),
          }));
        }
      } else {
        expect(output).toMatchObject({
          result: "verification-incomplete",
          unmetEvidenceCodes: [
            scenario === "unavailable" ? "unavailable-evidence" :
              scenario === "failed" ? "failed-evidence" : "stale-evidence",
            "missing-approved-evidence",
          ],
        });
        expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
        expect(onCompletionIntent).not.toHaveBeenCalled();
        expect(broadcastNotesSnapshot).not.toHaveBeenCalled();
      }
      expect(recordPhaseExecutionEvidence).not.toHaveBeenCalled();
    });
  });

  it("never gives Ken or Autopilot Ken a Roadmap mutation tool", () => {
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate: vi.fn() },
      durableExecution: false,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      captureVerificationWorkspace: async () => verificationWorkspace,
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
      durableExecution: true,
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
      durableExecution: true,
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
      durableExecution: false,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      captureVerificationWorkspace: async () => verificationWorkspace,
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      broadcastNotesSnapshot: vi.fn(),
      onCompletionIntent,
    });
    const tool = host.createSessionTools("coding", owningSession)[0]!;
    const { evidence: _evidence, ...withoutEvidence } = doneInput();
    const output = await tool.execute(RoadmapStatusParams.parse(withoutEvidence), {} as never);

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
        completionMode: "legacy-run-finalizer",
        evidence: ["pnpm test"],
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
      durableExecution: false,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      captureVerificationWorkspace: async () => verificationWorkspace,
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
      durableExecution: false,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      captureVerificationWorkspace: async () => verificationWorkspace,
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const session = owningSession();
    session.getVerificationEvidenceLedgerSnapshot = () => ({
      currentEvidence: [],
      staleEvidence: [],
    });
    const output = await host
      .createSessionTools("coding", () => session)[0]!
      .execute(doneInput(), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "verification-incomplete",
      unmetEvidenceCodes: ["unmatched-evidence", "missing-approved-evidence"],
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });

  it("fails closed when durable completion preparation is unavailable", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate },
      durableExecution: true,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      broadcastNotesSnapshot: vi.fn(),
    });

    const output = await host
      .createSessionTools("coding", owningSession)[0]!
      .execute(doneInput(), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "missing-plan-progress",
      phaseId: "phase-1",
      revision: 4,
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });

  it("returns repository-unverifiable without recording done status", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const phase = {
      id: "phase-1",
      execution: {
        plan: { contentHash: "5".repeat(64), steps: [{ state: "completed" }] },
        evidence: [],
      },
    };
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        load: async () => ({
          status: "ok" as const,
          snapshot: { revision: 4, document: { phases: [phase] } } as never,
          recoveredFromBackup: false,
        }),
        recordPhaseExecutionEvidence: vi.fn(),
        recordRoadmapStatusUpdate,
      },
      durableExecution: true,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      captureWorkspaceSnapshot: async () => {
        throw new RepositoryUnverifiableError();
      },
      getRunGeneration: () => 1,
      broadcastNotesSnapshot: vi.fn(),
    });

    const output = await host
      .createSessionTools("coding", owningSession)[0]!
      .execute(doneInput(), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "repository-unverifiable",
      phaseId: "phase-1",
      revision: 4,
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });

  it("keeps revision-231 evidence current through metadata revisions and writes completion atomically", async () => {
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
      revision: 233,
      projectKey: "/project",
      document: { phases: [phase], references: [] },
    };
    const recordPhaseExecutionEvidence = vi.fn();
    const recordRoadmapStatusUpdate = vi.fn(async () => ({
      status: "duplicate" as const,
      revision: 234,
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
          executionId: "execution-1",
          command,
          status: "passed",
          reason: "bounded test",
          observedAt: "2026-08-30T09:59:00.000Z",
          cwd: "/project",
          workspace,
          safeToolEnvironmentDigest: "9".repeat(64),
          classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
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
      durableExecution: true,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      captureWorkspaceSnapshot: async () => workspace,
      captureSafeToolEnvironmentDigest: () => "9".repeat(64),
      getRunGeneration: () => 1,
      broadcastNotesSnapshot: vi.fn(),
      now: () => "2026-08-30T10:00:00.000Z",
    });
    const output = await host
      .createSessionTools("coding", () => session)[0]!
      .execute(doneInput("metadata-only revisions preserved this check", 233), {} as never);
    expect(JSON.parse(String(output))).toMatchObject({ result: "duplicate", revision: 234 });
    expect(recordPhaseExecutionEvidence).not.toHaveBeenCalled();
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledOnce();
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        expectedRevision: 233,
        completionMode: "durable",
        durableCompletion: expect.objectContaining({
          runJournal: { sessionPath: "/sessions/phase.jsonl", generation: 1 },
          planHash: "5".repeat(64),
          workspace,
          verificationEvidence: [
            expect.objectContaining({
              version: 2,
              executionId: "execution-1",
              commandHash: "50c7de277d4a0807ed6cfff53ccc7ae26be29b9df51b350f5189cad82115490c",
            }),
          ],
        }),
      }),
    );
    expect(
      JSON.stringify([
        recordPhaseExecutionEvidence.mock.calls,
        recordRoadmapStatusUpdate.mock.calls,
      ]),
    ).not.toContain("synthetic-token-4f93a8");
  });

  it("rejects invalid passed progress at the public tool boundary before persistence", () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const onCompletionIntent = vi.fn();
    const broadcastNotesSnapshot = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate },
      durableExecution: false,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      broadcastNotesSnapshot,
      onCompletionIntent,
    });
    const tool = host.createSessionTools("coding", owningSession)[0]!;
    expect(() =>
      tool.parameters.parse({
        update_id: "progress-1",
        phase_id: "phase-1",
        expected_revision: 4,
        transition: "in-progress",
        progress: "Check passed",
        verification: { result: "passed" },
      }),
    ).toThrow("Non-Done passed verification requires nonempty evidence");
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
    expect(broadcastNotesSnapshot).not.toHaveBeenCalled();
    expect(onCompletionIntent).not.toHaveBeenCalled();
  });

  it("rejects Done without canonical plan progress before recording completion-pending", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const broadcastNotesSnapshot = vi.fn();
    const onCompletionIntent = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate },
      durableExecution: false,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      captureVerificationWorkspace: async () => verificationWorkspace,
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
      message:
        "Done was not recorded because canonical approved-plan/checkpoint progress is unavailable for the bound session. Rebinding or status prose does not create canonical progress. Resume the original approved-plan session or obtain approval for a new recovery plan.",
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
    expect(broadcastNotesSnapshot).not.toHaveBeenCalled();
    expect(onCompletionIntent).not.toHaveBeenCalled();
  });
});
