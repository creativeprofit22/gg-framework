import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalProjectKey,
  type NotesDocumentV3,
  type NotesRepositoryIdentityV1,
  type NotesVerificationEvidenceV2,
  type NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core/project-notes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roadmapCriterionId } from "./core/verification-evidence.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";
import { createApprovedPlan } from "./roadmap-phase-execution.js";

const NOW = "2026-08-30T10:00:00.000Z";
let agentDir: string;
let cwd: string;
let repository: ProjectNotesRepository;
let document: NotesDocumentV3;
const identity: NotesRepositoryIdentityV1 = {
  projectKey: "project-key",
  identityHash: "1".repeat(64),
  rootCommit: "2".repeat(40),
};
const workspace: NotesWorkspaceSnapshotV1 = {
  version: 1,
  repository: identity,
  headCommit: "3".repeat(40),
  worktreeDigest: "4".repeat(64),
  clean: true,
};

beforeEach(async () => {
  agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-execution-notes-agent-"));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-execution-notes-project-"));
  repository = new ProjectNotesRepository(agentDir);
  document = JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as NotesDocumentV3;
  Object.assign(document.phases[0]!, {
    doneWhen: Array.from({ length: 7 }, (_, index) => `criterion ${index + 1}`),
    status: "in-progress",
    attentionReason: null,
    lifecycleEvents: [],
    overrides: { ...document.phases[0]!.overrides, status: null },
    pendingAutomaticLifecycleTransition: null,
  });
  Object.assign(document.phases[1]!, {
    status: "not-started",
    archivedAt: null,
    completedAt: null,
    lifecycleEvents: [],
  });
  await repository.migrate(cwd, document);
});

afterEach(async () => {
  await Promise.all([
    fs.rm(agentDir, { recursive: true, force: true }),
    fs.rm(cwd, { recursive: true, force: true }),
  ]);
});

function approvedPlan() {
  return createApprovedPlan({
    planId: "plan-1",
    content: "# Plan\n\n## Steps\n\n1. Persist canonical progress\n2. Settle completion safely\n",
    snapshotPath: ".gg/plans/approved/plan-1.md",
    approvedAt: NOW,
    approvedRevision: 1,
    baseCommit: workspace.headCommit,
  });
}

function v2Evidence(index: number): NotesVerificationEvidenceV2 {
  return {
    version: 2,
    executionId: `execution-${index}`,
    commandHash: `${index}`.repeat(64),
    commandDisplay: "pnpm check",
    cwd,
    exitCode: 0,
    classifierVersion: "roadmap-verification-v1",
    verdict: "approved",
    criterionId: roadmapCriterionId(index, document.phases[0]!.doneWhen[index - 1]!),
    observedAt: NOW,
    workspace,
    safeToolEnvironmentDigest: "9".repeat(64),
  };
}

async function approve() {
  return repository.approvePhaseExecutionPlan(cwd, {
    operationId: "approve-1",
    phaseId: document.phases[0]!.id,
    expectedRevision: 1,
    repository: identity,
    plan: approvedPlan(),
    lastSession: document.phases[0]!.session,
  });
}

describe("Project Notes durable phase execution", () => {
  it("atomically commits seven V2 records and pending completion in one revision", async () => {
    const plan = approvedPlan();
    await approve();
    await repository.checkpointPhaseExecutionStep(cwd, {
      phaseId: document.phases[0]!.id,
      expectedRevision: 2,
      planHash: plan.contentHash,
      stepId: plan.steps[0]!.id,
      completedAt: NOW,
      workspace,
    });
    await repository.checkpointPhaseExecutionStep(cwd, {
      phaseId: document.phases[0]!.id,
      expectedRevision: 3,
      planHash: plan.contentHash,
      stepId: plan.steps[1]!.id,
      completedAt: NOW,
      workspace,
    });
    const verificationEvidence = Array.from({ length: 7 }, (_, index) => v2Evidence(index + 1));
    const request = {
      updateId: "atomic-completion",
      phaseId: document.phases[0]!.id,
      expectedRevision: 3,
      actor: "gg-coder" as const,
      transition: "done" as const,
      progress: "Seven criteria verified",
      blocker: null,
      requiredExternalAction: null,
      evidence: ["All bounded checks passed"],
      verification: "passed" as const,
      verificationReason: null,
      proposedReferences: [],
      timestamp: NOW,
      expectedSession: document.phases[0]!.session,
      requireBoundPhase: true,
      autopilotEnabled: false,
      durableCompletion: {
        runJournal: { sessionPath: "/sessions/atomic.jsonl", generation: 1 },
        planHash: plan.contentHash,
        workspace,
        safeToolEnvironmentDigest: "9".repeat(64),
        verificationEvidence,
      },
    };

    expect(await repository.recordRoadmapStatusUpdate(cwd, request)).toEqual({
      status: "stale-revision",
      revision: 4,
    });
    const afterConflict = await repository.load(cwd);
    expect(afterConflict).toMatchObject({ status: "ok", snapshot: { revision: 4 } });
    if (afterConflict.status !== "ok") throw new Error("Expected persisted Project Notes");
    expect(afterConflict.snapshot.document.phases[0]!.execution).toMatchObject({
      evidence: [],
      pendingCompletion: null,
    });

    const retry = { ...request, expectedRevision: 4 };
    expect(await repository.recordRoadmapStatusUpdate(cwd, retry)).toMatchObject({
      status: "committed",
      snapshot: { revision: 5 },
      phase: {
        execution: {
          evidence: verificationEvidence,
          pendingCompletion: { completionId: request.updateId, statusRevision: 5 },
        },
      },
    });
    expect(await repository.recordRoadmapStatusUpdate(cwd, retry)).toMatchObject({
      status: "duplicate",
      revision: 5,
    });
    expect(
      await repository.recordRoadmapStatusUpdate(cwd, {
        ...retry,
        durableCompletion: {
          ...retry.durableCompletion,
          verificationEvidence: retry.durableCompletion.verificationEvidence.slice(0, 1),
        },
      }),
    ).toEqual({ status: "operation-conflict", revision: 5 });
  });

  it("makes V2 execution replay idempotent and rejects conflicting identity reuse", async () => {
    const plan = approvedPlan();
    await approve();
    const evidence = v2Evidence(1);
    const request = {
      phaseId: document.phases[0]!.id,
      expectedRevision: 2,
      planHash: plan.contentHash,
      evidence,
    };
    expect(await repository.recordPhaseExecutionEvidence(cwd, request)).toMatchObject({
      status: "committed",
      snapshot: { revision: 3 },
    });
    expect(await repository.recordPhaseExecutionEvidence(cwd, request)).toEqual({
      status: "duplicate",
      revision: 3,
    });
    expect(
      await repository.recordPhaseExecutionEvidence(cwd, {
        ...request,
        expectedRevision: 3,
        evidence: { ...evidence, criterionId: "8".repeat(64) },
      }),
    ).toEqual({ status: "operation-conflict", revision: 3 });
  });

  it("persists snapshot reconciliation before execution can resume", async () => {
    await expect(approve()).resolves.toMatchObject({ status: "committed" });
    const plan = approvedPlan();
    const request = {
      phaseId: document.phases[0]!.id,
      expectedRevision: 2,
      planHash: plan.contentHash,
      timestamp: "2026-08-31T10:00:00.000Z",
    };

    await expect(
      repository.markPhaseExecutionNeedsReconciliation(cwd, request),
    ).resolves.toMatchObject({ status: "committed", snapshot: { revision: 3 } });
    await expect(
      repository.markPhaseExecutionNeedsReconciliation(cwd, request),
    ).resolves.toMatchObject({ status: "duplicate", revision: 3 });
    const loaded = await repository.load(cwd);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("Expected persisted Project Notes");
    expect(
      loaded.snapshot.document.phases.find((phase) => phase.id === request.phaseId)?.execution
        ?.state,
    ).toBe("needs-reconciliation");
  });
  it("settles once after a crash, unrelated revision, and retry", async () => {
    const approval = await approve();
    expect(approval).toMatchObject({ status: "committed", snapshot: { revision: 2 } });
    expect(await approve()).toMatchObject({ status: "duplicate", revision: 2 });
    const plan = approvedPlan();

    expect(
      await repository.checkpointPhaseExecutionStep(cwd, {
        phaseId: document.phases[0]!.id,
        expectedRevision: 2,
        planHash: plan.contentHash,
        stepId: plan.steps[1]!.id,
        completedAt: NOW,
        workspace,
      }),
    ).toEqual({ status: "step-order-invalid" });

    const firstStep = {
      phaseId: document.phases[0]!.id,
      expectedRevision: 2,
      planHash: plan.contentHash,
      stepId: plan.steps[0]!.id,
      completedAt: NOW,
      workspace,
    };
    expect(
      await repository.checkpointPhaseExecutionStep(cwd, {
        ...firstStep,
        workspace: {
          ...workspace,
          repository: { ...workspace.repository, identityHash: "9".repeat(64) },
        },
      }),
    ).toEqual({ status: "workspace-mismatch" });
    expect(await repository.checkpointPhaseExecutionStep(cwd, firstStep)).toMatchObject({
      status: "committed",
      snapshot: { revision: 3 },
    });
    expect(await repository.checkpointPhaseExecutionStep(cwd, firstStep)).toMatchObject({
      status: "duplicate",
      revision: 3,
    });
    repository = new ProjectNotesRepository(agentDir);
    expect(
      await repository.checkpointPhaseExecutionStep(cwd, {
        ...firstStep,
        expectedRevision: 3,
        completedAt: "2026-08-31T10:00:00.000Z",
        workspace: { ...workspace, worktreeDigest: "8".repeat(64), clean: false },
      }),
    ).toMatchObject({ status: "duplicate", revision: 3 });
    const restarted = await repository.load(cwd);
    expect(
      restarted.status === "ok" && restarted.snapshot.document.phases[0]!.execution?.plan?.steps[0],
    ).toMatchObject({
      completedAt: NOW,
      workspace,
    });
    expect(
      await repository.checkpointPhaseExecutionStep(cwd, {
        ...firstStep,
        expectedRevision: 3,
        stepId: plan.steps[1]!.id,
      }),
    ).toMatchObject({ status: "committed", snapshot: { revision: 4 } });

    const evidence = {
      commandHash: "5".repeat(64),
      commandDisplay: "pnpm test",
      exitCode: 0,
      classifierVersion: "roadmap-v1",
      verdict: "approved" as const,
      criterionId: "criterion-1",
      observedAt: NOW,
      workspace,
    };
    expect(
      await repository.recordPhaseExecutionEvidence(cwd, {
        phaseId: document.phases[0]!.id,
        expectedRevision: 4,
        planHash: plan.contentHash,
        evidence,
      }),
    ).toMatchObject({ status: "committed", snapshot: { revision: 5 } });

    const completionRequest = {
      updateId: "completion-1",
      phaseId: document.phases[0]!.id,
      expectedRevision: 5,
      actor: "gg-coder" as const,
      transition: "done" as const,
      progress: "Implementation and verification completed",
      blocker: null,
      requiredExternalAction: null,
      evidence: document.phases[0]!.doneWhen.map((criterion) => `Verified: ${criterion}`),
      verification: "passed" as const,
      verificationReason: null,
      proposedReferences: [],
      timestamp: NOW,
      expectedSession: document.phases[0]!.session,
      requireBoundPhase: true,
      autopilotEnabled: false,
      durableCompletion: {
        runJournal: { sessionPath: "/sessions/one.jsonl", generation: 2 },
        planHash: plan.contentHash,
        workspace,
        safeToolEnvironmentDigest: "9".repeat(64),
        verificationEvidence: Array.from({ length: 7 }, (_, index) => v2Evidence(index + 1)),
      },
    };
    expect(await repository.recordRoadmapStatusUpdate(cwd, completionRequest)).toMatchObject({
      status: "committed",
      snapshot: { revision: 6 },
    });

    repository = new ProjectNotesRepository(agentDir);
    const afterRestart = await repository.load(cwd);
    expect(afterRestart.status).toBe("ok");
    if (afterRestart.status !== "ok") throw new Error("Expected persisted Project Notes");
    const restartedPhase = afterRestart.snapshot.document.phases.find(
      (phase) => phase.id === completionRequest.phaseId,
    )!;
    expect(afterRestart.snapshot.revision).toBe(6);
    expect(restartedPhase.execution).toMatchObject({
      state: "completion-pending",
      pendingCompletion: {
        completionId: "completion-1",
        statusRevision: 6,
        runJournal: completionRequest.durableCompletion.runJournal,
        planHash: plan.contentHash,
        workspace,
        safeToolEnvironmentDigest: "9".repeat(64),
      },
    });
    expect(restartedPhase.roadmapEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "status-update",
          id: "completion-1",
          statusOutcome: "completion-pending",
        }),
      ]),
    );
    expect(await repository.recordRoadmapStatusUpdate(cwd, completionRequest)).toMatchObject({
      status: "duplicate",
      revision: 6,
    });
    expect(
      await repository.recordRoadmapStatusUpdate(cwd, {
        ...completionRequest,
        progress: "Changed retry payload",
      }),
    ).toMatchObject({ status: "operation-conflict", revision: 6 });
    expect(
      await repository.recordRoadmapStatusUpdate(cwd, {
        ...completionRequest,
        durableCompletion: {
          ...completionRequest.durableCompletion,
          runJournal: { ...completionRequest.durableCompletion.runJournal, generation: 3 },
        },
      }),
    ).toMatchObject({ status: "operation-conflict", revision: 6 });
    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: { revision: 6 },
    });

    const pendingCompletion = {
      completionId: completionRequest.updateId,
      statusRevision: 6,
      ...completionRequest.durableCompletion,
    };

    const settlement = {
      phaseId: document.phases[0]!.id,
      expectedRevision: 6,
      completionId: pendingCompletion.completionId,
      planHash: plan.contentHash,
      workspace,
    };
    const committedSettlement = await repository.settleDurablePhaseCompletion(cwd, settlement);
    expect(committedSettlement).toMatchObject({
      status: "committed",
      snapshot: { revision: 7 },
      phase: { status: "done", execution: { state: "completed" } },
      advancementCheckpoint: {
        verificationStatusUpdateId: pendingCompletion.completionId,
        completedPhaseId: settlement.phaseId,
        nextPhaseId: document.phases[1]!.id,
      },
    });
    if (committedSettlement.status !== "committed") throw new Error("Expected settlement commit");
    expect(
      committedSettlement.phase.roadmapEvents.filter(
        (event) =>
          event.type === "implementation-checkpoint" &&
          event.verificationStatusUpdateId === pendingCompletion.completionId,
      ),
    ).toHaveLength(1);
    expect(
      committedSettlement.phase.roadmapEvents.filter(
        (event) =>
          event.type === "phase-advancement-checkpoint" &&
          "verificationStatusUpdateId" in event &&
          event.verificationStatusUpdateId === pendingCompletion.completionId,
      ),
    ).toHaveLength(1);

    expect(
      await repository.recordPhaseExecutionEvidence(cwd, {
        phaseId: document.phases[0]!.id,
        expectedRevision: 7,
        planHash: plan.contentHash,
        evidence: { ...evidence, commandHash: "6".repeat(64), criterionId: "criterion-2" },
      }),
    ).toMatchObject({ status: "committed", snapshot: { revision: 8 } });

    // Simulate a crash after repository settlement but before local pending state is cleared.
    repository = new ProjectNotesRepository(agentDir);
    expect(await repository.settleDurablePhaseCompletion(cwd, settlement)).toMatchObject({
      status: "duplicate",
      revision: 8,
      advancementCheckpoint: {
        id: committedSettlement.advancementCheckpoint?.id,
        verificationStatusUpdateId: pendingCompletion.completionId,
      },
    });
    expect(
      await repository.settleDurablePhaseCompletion(cwd, {
        ...settlement,
        planHash: "9".repeat(64),
      }),
    ).toMatchObject({ status: "operation-conflict", revision: 8 });
    expect(
      await repository.settleDurablePhaseCompletion(cwd, {
        ...settlement,
        workspace: { ...workspace, worktreeDigest: "7".repeat(64) },
      }),
    ).toMatchObject({ status: "operation-conflict", revision: 8 });

    const afterRetry = await repository.load(cwd);
    expect(afterRetry).toMatchObject({ status: "ok", snapshot: { revision: 8 } });
    if (afterRetry.status !== "ok") throw new Error("Expected persisted Project Notes");
    const settledEvents = afterRetry.snapshot.document.phases[0]!.roadmapEvents;
    expect(
      settledEvents.filter(
        (event) =>
          event.type === "implementation-checkpoint" &&
          event.verificationStatusUpdateId === pendingCompletion.completionId,
      ),
    ).toHaveLength(1);
    expect(
      settledEvents.filter(
        (event) =>
          event.type === "phase-advancement-checkpoint" &&
          "verificationStatusUpdateId" in event &&
          event.verificationStatusUpdateId === pendingCompletion.completionId,
      ),
    ).toHaveLength(1);
  });

  it("rejects every completion mutation during reconciliation without writing", async () => {
    const plan = approvedPlan();
    const phaseId = document.phases[0]!.id;
    const session = document.phases[0]!.session;
    if (!session) throw new Error("Expected a bound phase session");

    await approve();
    await repository.markPhaseExecutionNeedsReconciliation(cwd, {
      phaseId,
      expectedRevision: 2,
      planHash: plan.contentHash,
      timestamp: "2026-08-31T10:00:00.000Z",
    });
    const before = await repository.load(cwd);
    expect(before).toMatchObject({ status: "ok", snapshot: { revision: 3 } });
    if (before.status !== "ok") throw new Error("Expected persisted Project Notes");

    const implementation = {
      checkpointId: "implementation-while-reconciling",
      phaseId,
      expectedSession: session,
      planStepTotal: plan.steps.length,
      completedPlanSteps: plan.steps.map((_step, index) => index + 1),
      runOutcome: "succeeded" as const,
      timestamp: "2026-08-31T10:01:00.000Z",
    };
    const pendingCompletion = {
      completionId: "completion-while-reconciling",
      statusRevision: 3,
      runJournal: { sessionPath: session.sessionPath!, generation: 1 },
      planHash: plan.contentHash,
      workspace,
    };
    const conflict = { status: "operation-conflict", revision: 3 };

    await expect(
      repository.checkpointPhaseExecutionStep(cwd, {
        phaseId,
        expectedRevision: 3,
        planHash: plan.contentHash,
        stepId: plan.steps[0]!.id,
        completedAt: "2026-08-31T10:01:00.000Z",
        workspace,
      }),
    ).resolves.toEqual(conflict);
    await expect(
      repository.recordPhaseExecutionEvidence(cwd, {
        phaseId,
        expectedRevision: 3,
        planHash: plan.contentHash,
        evidence: {
          commandHash: "5".repeat(64),
          commandDisplay: "pnpm test",
          exitCode: 0,
          classifierVersion: "roadmap-v1",
          verdict: "approved",
          criterionId: "criterion-1",
          observedAt: "2026-08-31T10:01:00.000Z",
          workspace,
        },
      }),
    ).resolves.toEqual(conflict);
    await expect(
      repository.beginDurablePhaseCompletion(cwd, {
        phaseId,
        expectedRevision: 3,
        pendingCompletion,
      }),
    ).resolves.toEqual(conflict);
    await expect(
      repository.clearDurablePhaseCompletion(cwd, {
        phaseId,
        expectedRevision: 3,
        completionId: pendingCompletion.completionId,
        currentWorkspace: workspace,
      }),
    ).resolves.toEqual(conflict);
    await expect(
      repository.settleDurablePhaseCompletion(cwd, {
        phaseId,
        expectedRevision: 3,
        completionId: pendingCompletion.completionId,
        planHash: plan.contentHash,
        workspace,
      }),
    ).resolves.toEqual(conflict);
    await expect(
      repository.recordRoadmapStatusUpdate(cwd, {
        updateId: pendingCompletion.completionId,
        phaseId,
        expectedRevision: 3,
        actor: "gg-coder",
        transition: "done",
        progress: "Implementation completed",
        blocker: null,
        requiredExternalAction: null,
        evidence: document.phases[0]!.doneWhen.map((criterion) => `Verified: ${criterion}`),
        verification: "passed",
        verificationReason: null,
        proposedReferences: [],
        timestamp: "2026-08-31T10:01:00.000Z",
        expectedSession: session,
        requireBoundPhase: true,
        autopilotEnabled: false,
        durableCompletion: {
          runJournal: pendingCompletion.runJournal,
          planHash: plan.contentHash,
          workspace,
          safeToolEnvironmentDigest: "9".repeat(64),
          verificationEvidence: Array.from({ length: 7 }, (_, index) => v2Evidence(index + 1)),
        },
      }),
    ).resolves.toEqual(conflict);
    await expect(
      repository.settlePhaseCompletion(cwd, {
        ...implementation,
        expectedRevision: 3,
        completionIntentId: pendingCompletion.completionId,
      }),
    ).resolves.toEqual(conflict);
    await expect(repository.recordImplementationCheckpoint(cwd, implementation)).resolves.toEqual(
      conflict,
    );
    await expect(
      repository.previewManualCompletionApproval(cwd, phaseId, 3, session),
    ).resolves.toEqual({ status: "unmet-gate", revision: 3, code: "inactive-phase" });
    await expect(
      repository.commitManualCompletionApproval(cwd, {
        phaseId,
        expectedRevision: 3,
        expectedSession: session,
        implementationCheckpointId: implementation.checkpointId,
        verificationStatusUpdateId: pendingCompletion.completionId,
        approvalId: "manual-approval-while-reconciling",
        timestamp: "2026-08-31T10:01:00.000Z",
      }),
    ).resolves.toEqual({ status: "unmet-gate", revision: 3, code: "inactive-phase" });

    await expect(repository.load(cwd)).resolves.toEqual(before);
  });

  it("imports once and clears failed completion while dropping stale evidence", async () => {
    const plan = approvedPlan();
    const execution = {
      version: 1 as const,
      state: "needs-reconciliation" as const,
      repository: identity,
      plan,
      evidence: [],
      pendingCompletion: null,
      lastSession: document.phases[0]!.session,
      migration: { source: "legacy-session" as const, reconciledAt: null },
    };
    const request = {
      operationId: "legacy-import-1",
      phaseId: document.phases[0]!.id,
      expectedRevision: 1,
      execution,
    };
    expect(await repository.importLegacyPhaseExecution(cwd, request)).toMatchObject({
      status: "committed",
      snapshot: { revision: 2 },
    });
    expect(await repository.importLegacyPhaseExecution(cwd, request)).toMatchObject({
      status: "duplicate",
      revision: 2,
    });
  });

  it("atomically reconciles exact fences and makes retries idempotent", async () => {
    const plan = approvedPlan();
    const phaseId = document.phases[0]!.id;
    const dirtyWorkspace = { ...workspace, worktreeDigest: "6".repeat(64), clean: false };
    const currentWorkspace = {
      ...workspace,
      headCommit: "5".repeat(40),
      worktreeDigest: "7".repeat(64),
    };
    await approve();
    await repository.checkpointPhaseExecutionStep(cwd, {
      phaseId,
      expectedRevision: 2,
      planHash: plan.contentHash,
      stepId: plan.steps[0]!.id,
      completedAt: NOW,
      workspace,
    });
    await repository.checkpointPhaseExecutionStep(cwd, {
      phaseId,
      expectedRevision: 3,
      planHash: plan.contentHash,
      stepId: plan.steps[1]!.id,
      completedAt: "2026-08-30T10:01:00.000Z",
      workspace: dirtyWorkspace,
    });
    await repository.recordPhaseExecutionEvidence(cwd, {
      phaseId,
      expectedRevision: 4,
      planHash: plan.contentHash,
      evidence: {
        commandHash: "8".repeat(64),
        commandDisplay: "pnpm test",
        exitCode: 0,
        classifierVersion: "roadmap-v1",
        verdict: "approved",
        criterionId: "criterion-1",
        observedAt: "2026-08-30T10:02:00.000Z",
        workspace: dirtyWorkspace,
      },
    });
    await repository.markPhaseExecutionNeedsReconciliation(cwd, {
      phaseId,
      expectedRevision: 5,
      planHash: plan.contentHash,
      timestamp: "2026-08-30T10:03:00.000Z",
    });
    const { steps: _steps, ...planExpectation } = plan;
    const request = {
      version: 3 as const,
      action: "reconcile-execution" as const,
      phaseId,
      expectedProjectKey: canonicalProjectKey(cwd),
      expectedRevision: 6,
      operationId: "reconcile-1",
      repository: identity,
      plan: planExpectation,
      workspace: currentWorkspace,
      currentWorkspace,
      currentSafeToolEnvironmentDigest: "9".repeat(64),
      cleanAncestorStepIds: [plan.steps[0]!.id],
      reconciledAt: "2026-08-30T10:04:00.000Z",
    };

    await expect(repository.reconcilePhaseExecution(cwd, request)).resolves.toMatchObject({
      status: "reconciled",
      revision: 7,
      phaseId,
      preservedStepIds: [plan.steps[0]!.id],
      revalidationStepIds: [plan.steps[1]!.id],
      revalidationEvidenceCount: 1,
      reconciledAt: request.reconciledAt,
      snapshot: { revision: 7 },
    });
    await expect(repository.reconcilePhaseExecution(cwd, request)).resolves.toMatchObject({
      status: "duplicate",
      revision: 7,
    });
    await expect(
      repository.reconcilePhaseExecution(cwd, {
        ...request,
        workspace: { ...currentWorkspace, worktreeDigest: "9".repeat(64) },
      }),
    ).resolves.toEqual({ status: "operation-conflict", revision: 7 });

    await expect(
      repository.reconcilePhaseExecution(cwd, {
        ...request,
        currentWorkspace: { ...currentWorkspace, worktreeDigest: "9".repeat(64) },
      }),
    ).resolves.toEqual({
      status: "duplicate",
      revision: 7,
      phaseId,
      preservedStepIds: [plan.steps[0]!.id],
      revalidationStepIds: [plan.steps[1]!.id],
      revalidationEvidenceCount: 1,
      reconciledAt: request.reconciledAt,
    });

    const loaded = await repository.load(cwd);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("Expected reconciled Notes");
    expect(loaded.snapshot.document.phases[0]!.execution).toMatchObject({
      state: "implementing",
      pendingCompletion: null,
      migration: {
        reconciledAt: request.reconciledAt,
        reconciliation: { operationId: request.operationId },
      },
      evidence: [{ state: "needs-revalidation" }],
    });
  });

  it("denies stale repository, plan, hash, and workspace fences without writing", async () => {
    const plan = approvedPlan();
    const phaseId = document.phases[0]!.id;
    await approve();
    await repository.markPhaseExecutionNeedsReconciliation(cwd, {
      phaseId,
      expectedRevision: 2,
      planHash: plan.contentHash,
      timestamp: "2026-08-30T10:03:00.000Z",
    });
    const { steps: _steps, ...planExpectation } = plan;
    const request = {
      version: 3 as const,
      action: "reconcile-execution" as const,
      phaseId,
      expectedProjectKey: canonicalProjectKey(cwd),
      expectedRevision: 3,
      operationId: "reconcile-denial",
      repository: identity,
      plan: planExpectation,
      workspace,
      currentWorkspace: workspace,
      currentSafeToolEnvironmentDigest: "9".repeat(64),
      cleanAncestorStepIds: [],
      reconciledAt: "2026-08-30T10:04:00.000Z",
    };

    await expect(
      repository.reconcilePhaseExecution(cwd, { ...request, expectedRevision: 2 }),
    ).resolves.toEqual({ status: "stale-revision", revision: 3 });
    await expect(
      repository.reconcilePhaseExecution(cwd, {
        ...request,
        repository: { ...identity, identityHash: "9".repeat(64) },
      }),
    ).resolves.toEqual({ status: "repository-mismatch" });
    await expect(
      repository.reconcilePhaseExecution(cwd, {
        ...request,
        plan: { ...planExpectation, planId: "wrong-plan" },
      }),
    ).resolves.toEqual({ status: "plan-mismatch" });
    await expect(
      repository.reconcilePhaseExecution(cwd, {
        ...request,
        plan: { ...planExpectation, contentHash: "9".repeat(64) },
      }),
    ).resolves.toEqual({ status: "plan-hash-mismatch" });
    await expect(
      repository.reconcilePhaseExecution(cwd, {
        ...request,
        workspace: { ...workspace, worktreeDigest: "9".repeat(64) },
      }),
    ).resolves.toEqual({ status: "workspace-mismatch" });

    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: { revision: 3 },
    });
  });
});
