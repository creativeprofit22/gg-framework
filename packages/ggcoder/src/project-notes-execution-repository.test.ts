import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalProjectKey,
  type NotesDocumentV3,
  type NotesRepositoryIdentityV1,
  type NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core/project-notes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

});
