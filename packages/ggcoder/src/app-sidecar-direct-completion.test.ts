import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppSidecarRoadmapPhaseAdvancementCoordinator } from "./app-sidecar-phase-advancement.js";
import {
  AppSidecarPhaseCompletionCoordinator,
  AppSidecarPhaseImplementationPlanTracker,
  checkpointSettledPhaseImplementation,
} from "./app-sidecar-phase-completion.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  AppSidecarRoadmapToolHost,
  type AppSidecarRoadmapToolSession,
} from "./app-sidecar-roadmap-tool-host.js";
import {
  ProjectNotesRepository,
  type NotesDocumentV3,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const NOW = "2026-08-29T00:00:00.000Z";
const roots: string[] = [];
const session = { sessionId: "coding-session", sessionPath: "/sessions/coding.jsonl" };

function document(): NotesDocumentV3 {
  const phase = {
    id: "phase-1",
    title: "Direct Roadmap completion",
    goal: "Finish without reviewer machinery",
    doneWhen: ["Targeted tests pass"],
    order: 0,
    status: "in-progress" as const,
    sourcePrompt: "Implement direct completion",
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
    roadmapEvents: [],
  };
  return {
    version: 3,
    reference: "",
    currentFocus: "Direct completion",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    phases: [
      phase,
      {
        ...structuredClone(phase),
        id: "phase-2",
        title: "Next phase",
        order: 1,
        status: "not-started",
        session: null,
      },
    ],
    references: [],
  };
}

function owningSession(): AppSidecarRoadmapToolSession {
  return {
    getActivePhaseContext: () => ({
      version: 1,
      projectKey: "/project",
      phase: {
        id: "phase-1",
        title: "Direct Roadmap completion",
        goal: "Finish without reviewer machinery",
        doneWhen: ["Targeted tests pass"],
        sourcePrompt: "Implement direct completion",
        status: "in-progress",
        archivedAt: null,
      },
      session,
      references: [],
      executionStage: "implementing",
    }),
    getMessages: () => [],
    getState: () => session,
    evaluateRoadmapVerificationEvidence: () => ({
      ready: true,
      unmetEvidenceCodes: [],
      criterionCoverage: [
        {
          criterionIndex: 0,
          criterion: "Targeted tests pass",
          evidence: "pnpm test exited successfully",
          command: "pnpm test",
        },
      ],
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("app-sidecar direct Roadmap completion", () => {
  it("moves In Progress directly to Done without Ken, Review, queue, or retry events", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-direct-phase-"));
    roots.push(agentDir);
    const cwd = "/project/direct-completion";
    const repository = new ProjectNotesRepository(agentDir);
    await repository.migrate(cwd, document());
    let latestSnapshot: ProjectNotesSnapshot | null = null;
    let completionIntentId: string | undefined;
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      broadcastNotesSnapshot: (snapshot) => {
        latestSnapshot = snapshot;
      },
      onCompletionIntent: (intent) => {
        completionIntentId = intent.statusUpdateId;
      },
    });

    expect(host.createSessionTools("ken")).toEqual([]);
    expect(host.createSessionTools("ken-autopilot")).toEqual([]);
    const statusOutput = await host.createSessionTools("coding", owningSession)[0]!.execute(
      RoadmapStatusParams.parse({
        update_id: "completion-intent-current",
        phase_id: "phase-1",
        expected_revision: 1,
        transition: "done",
        progress: "Implementation and verification completed",
        evidence: ["pnpm test exited successfully"],
        verification: { result: "passed" },
      }),
      {} as never,
    );
    expect(JSON.parse(String(statusOutput))).toMatchObject({
      result: "committed",
      statusOutcome: "completion-pending",
    });
    expect(completionIntentId).toBe("completion-intent-current");

    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd,
      repository,
      broadcastSnapshot: (snapshot) => {
        latestSnapshot = snapshot;
      },
    });
    const outcome = await checkpointSettledPhaseImplementation({
      coordinator,
      tracker: new AppSidecarPhaseImplementationPlanTracker(),
      checkpointId: "checkpoint-current",
      completionIntentId,
      phaseId: "phase-1",
      expectedSession: session,
      currentPlanProgress: { total: 1, completed: [1] },
      runOutcome: "succeeded",
      timestamp: "2026-08-29T00:01:00.000Z",
    });

    expect(outcome).toMatchObject({ status: "committed", evaluation: { gateOutcome: "done" } });
    expect(latestSnapshot!.document.phases[0]).toMatchObject({ status: "done" });
    expect(latestSnapshot!.document.phases[0]!.roadmapEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "completion-review" })]),
    );
    expect(latestSnapshot!.document.phases[0]!.lifecycleEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ toStatus: "review" })]),
    );
    expect(latestSnapshot!.document.phases[0]!.roadmapEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "phase-advancement-checkpoint",
          implementationCheckpointId: "checkpoint-current",
          verificationStatusUpdateId: "completion-intent-current",
          nextPhaseId: "phase-2",
        }),
      ]),
    );

    const setActivePhaseContext = vi.fn(async () => undefined);
    const advancement = createAppSidecarRoadmapPhaseAdvancementCoordinator({
      repository,
      isAutopilotEnabled: () => true,
    });
    const advancementSession = {
      getState: () => ({ cwd, ...session }),
      setActivePhaseContext,
    };
    await expect(advancement.recover(advancementSession)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(advancement.recover(advancementSession)).resolves.toMatchObject({
      status: "already-bound",
    });
    const finalSnapshot = await repository.load(cwd);
    expect(finalSnapshot.status).toBe("ok");
    if (finalSnapshot.status !== "ok") throw new Error("expected final snapshot");
    expect(
      finalSnapshot.snapshot.document.phases.filter((candidate) => candidate.id === "phase-2"),
    ).toHaveLength(1);
    expect(
      finalSnapshot.snapshot.document.phases[0]!.roadmapEvents.filter(
        (event) => event.type === "phase-advancement-confirmation",
      ),
    ).toHaveLength(1);
  });

  it("leaves an interrupted owning run open and requires fresh completion evidence", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-interrupted-phase-"));
    roots.push(agentDir);
    const cwd = "/project/interrupted-completion";
    const repository = new ProjectNotesRepository(agentDir);
    await repository.migrate(cwd, document());
    await repository.recordRoadmapStatusUpdate(cwd, {
      updateId: "completion-intent-interrupted",
      phaseId: "phase-1",
      expectedRevision: 1,
      actor: "gg-coder",
      transition: "done",
      progress: "Verification passed before interruption",
      blocker: null,
      requiredExternalAction: null,
      evidence: ["pnpm test exited successfully"],
      verification: "passed",
      verificationReason: null,
      proposedReferences: [],
      timestamp: NOW,
      expectedSession: session,
      requireBoundPhase: true,
      autopilotEnabled: false,
    });

    const outcome = await repository.settlePhaseCompletion(cwd, {
      checkpointId: "checkpoint-interrupted",
      completionIntentId: "completion-intent-interrupted",
      phaseId: "phase-1",
      expectedSession: session,
      planStepTotal: 1,
      completedPlanSteps: [],
      runOutcome: "interrupted",
      timestamp: "2026-08-29T00:01:00.000Z",
    });
    expect(outcome).toMatchObject({
      status: "open",
      phase: { status: "in-progress" },
      evaluation: {
        targetStatus: null,
        unmetGateCodes: expect.arrayContaining(["run-not-successful", "incomplete-plan"]),
      },
    });
  });
});
