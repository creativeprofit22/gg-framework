import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppSidecarRoadmapPhaseAdvancementCoordinator } from "./app-sidecar-phase-advancement.js";
import { AppSidecarCompletionIntentTracker } from "./app-sidecar-completion-intent.js";
import {
  AppSidecarPhaseCompletionCoordinator,
  AppSidecarPhaseImplementationPlanTracker,
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
import {
  ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
  roadmapCriterionId,
  safeToolEnvironmentDigest,
  SessionVerificationEvidenceLedger,
} from "./core/verification-evidence.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const NOW = "2026-08-29T00:00:00.000Z";
const roots: string[] = [];
const session = { sessionId: "coding-session", sessionPath: "/sessions/coding.jsonl" };
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
    getVerificationEvidenceLedgerSnapshot: () => ({
      currentEvidence: [
        {
          command: "pnpm test",
          status: "passed",
          reason: "bounded test command",
          executionId: "execution-1",
          observedAt: NOW,
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("app-sidecar direct Roadmap completion", () => {
  it("leaves no completion-pending state or armed intent when canonical plan progress is missing", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-missing-plan-phase-"));
    roots.push(agentDir);
    const cwd = "/project/missing-plan-completion";
    const repository = new ProjectNotesRepository(agentDir);
    await repository.migrate(cwd, document());
    const onCompletionIntent = vi.fn();
    const broadcastNotesSnapshot = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      captureVerificationWorkspace: async () => verificationWorkspace,
      resolvePlanProgress: () => null,
      broadcastNotesSnapshot,
      onCompletionIntent,
    });

    const statusOutput = await host.createSessionTools("coding", owningSession)[0]!.execute(
      RoadmapStatusParams.parse({
        update_id: "completion-intent-missing-plan",
        phase_id: "phase-1",
        expected_revision: 1,
        transition: "done",
        progress: "Verification passed without canonical plan progress",
        evidence: ["pnpm test exited successfully"],
        verification_bindings: [
          {
            criterion_id: roadmapCriterionId(1, "Targeted tests pass"),
            execution_id: "execution-1",
          },
        ],
        verification: { result: "passed" },
      }),
      {} as never,
    );

    expect(JSON.parse(String(statusOutput))).toMatchObject({
      result: "missing-plan-progress",
      phaseId: "phase-1",
      revision: 1,
    });
    const unchanged = await repository.load(cwd);
    expect(unchanged.status).toBe("ok");
    if (unchanged.status !== "ok") throw new Error("expected unchanged snapshot");
    expect(unchanged.snapshot.document.phases[0]).toMatchObject({
      status: "in-progress",
      roadmapEvents: [],
    });
    expect(broadcastNotesSnapshot).not.toHaveBeenCalled();
    expect(onCompletionIntent).not.toHaveBeenCalled();
  });

  it("moves In Progress directly to Done without Ken, Review, queue, or retry events", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-direct-phase-"));
    roots.push(agentDir);
    const cwd = "/project/direct-completion";
    const repository = new ProjectNotesRepository(agentDir);
    await repository.migrate(cwd, document());
    let latestSnapshot: ProjectNotesSnapshot | null = null;
    const completionIntents = new AppSidecarCompletionIntentTracker();
    const completionIntentRun = completionIntents.beginRun();
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      captureVerificationWorkspace: async () => verificationWorkspace,
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      broadcastNotesSnapshot: (snapshot) => {
        latestSnapshot = snapshot;
      },
      onCompletionIntent: (intent) => {
        completionIntents.record(intent);
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
        verification_bindings: [
          {
            criterion_id: roadmapCriterionId(1, "Targeted tests pass"),
            execution_id: "execution-1",
          },
        ],
        verification: { result: "passed" },
      }),
      {} as never,
    );
    expect(JSON.parse(String(statusOutput))).toMatchObject({
      result: "committed",
      statusOutcome: "completion-pending",
    });

    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd,
      repository,
      broadcastSnapshot: (snapshot) => {
        latestSnapshot = snapshot;
      },
    });
    const finalizer = completionIntents.finalizeRun(completionIntentRun);
    const outcome = await finalizer.checkpoint({
      coordinator,
      tracker: new AppSidecarPhaseImplementationPlanTracker(),
      checkpointId: "checkpoint-current",
      phaseId: "phase-1",
      expectedSession: session,
      currentPlanProgress: { total: 1, completed: [1] },
      runOutcome: "succeeded",
      timestamp: "2026-08-29T00:01:00.000Z",
    });
    const repeatedOutcome = await finalizer.checkpoint({
      coordinator,
      tracker: new AppSidecarPhaseImplementationPlanTracker(),
      checkpointId: "checkpoint-repeat",
      phaseId: "phase-1",
      expectedSession: session,
      currentPlanProgress: { total: 1, completed: [1] },
      runOutcome: "succeeded",
      timestamp: "2026-08-29T00:01:01.000Z",
    });

    expect(outcome).toMatchObject({ status: "committed", evaluation: { gateOutcome: "done" } });
    expect(repeatedOutcome).not.toMatchObject({
      status: "committed",
      evaluation: { gateOutcome: "done" },
    });
    const settledSnapshot = await repository.load(cwd);
    expect(settledSnapshot.status).toBe("ok");
    if (settledSnapshot.status !== "ok") throw new Error("expected settled snapshot");
    expect(
      settledSnapshot.snapshot.document.phases[0]!.roadmapEvents.filter(
        (event) => event.type === "phase-advancement-checkpoint",
      ),
    ).toHaveLength(1);
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

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "clears a Done intent after a %s owning run before the next run",
    async (runOutcome) => {
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), `roadmap-${runOutcome}-phase-`));
      roots.push(agentDir);
      const cwd = `/project/${runOutcome}-completion`;
      const repository = new ProjectNotesRepository(agentDir);
      await repository.migrate(cwd, document());
      const completionIntents = new AppSidecarCompletionIntentTracker();
      const completionIntentRun = completionIntents.beginRun();
      const host = new AppSidecarRoadmapToolHost({
        cwd,
        repository,
        reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
        projectAutopilot: { isEnabled: () => false },
        captureVerificationWorkspace: async () => verificationWorkspace,
        resolvePlanProgress: () => ({ total: 1, completed: [1] }),
        broadcastNotesSnapshot: () => undefined,
        onCompletionIntent: (intent) => {
          completionIntents.record(intent);
        },
      });
      await host.createSessionTools("coding", owningSession)[0]!.execute(
        RoadmapStatusParams.parse({
          update_id: `completion-intent-${runOutcome}`,
          phase_id: "phase-1",
          expected_revision: 1,
          transition: "done",
          progress: "Verification passed before the owning run ended",
          evidence: ["pnpm test exited successfully"],
          verification_bindings: [
            {
              criterion_id: roadmapCriterionId(1, "Targeted tests pass"),
              execution_id: "execution-1",
            },
          ],
          verification: { result: "passed" },
        }),
        {} as never,
      );
      const coordinator = new AppSidecarPhaseCompletionCoordinator({
        cwd,
        repository,
        broadcastSnapshot: () => undefined,
      });
      const finalizer = completionIntents.finalizeRun(completionIntentRun);

      const outcome = await finalizer.checkpoint({
        coordinator,
        tracker: new AppSidecarPhaseImplementationPlanTracker(),
        checkpointId: `checkpoint-${runOutcome}`,
        phaseId: "phase-1",
        expectedSession: session,
        currentPlanProgress: { total: 1, completed: [1] },
        runOutcome,
        timestamp: "2026-08-29T00:01:00.000Z",
      });
      const laterRun = completionIntents.beginRun();
      const laterOutcome = await completionIntents.finalizeRun(laterRun).checkpoint({
        coordinator,
        tracker: new AppSidecarPhaseImplementationPlanTracker(),
        checkpointId: `checkpoint-after-${runOutcome}`,
        phaseId: "phase-1",
        expectedSession: session,
        currentPlanProgress: { total: 1, completed: [1] },
        runOutcome: "succeeded",
        timestamp: "2026-08-29T00:02:00.000Z",
      });

      expect(outcome).toMatchObject({
        status: "open",
        phase: { status: "in-progress" },
        evaluation: {
          targetStatus: null,
          unmetGateCodes: expect.arrayContaining(["run-not-successful"]),
        },
        advancementCheckpoint: null,
      });
      expect(laterOutcome).not.toMatchObject({
        status: "committed",
        evaluation: { gateOutcome: "done" },
      });
      const snapshot = await repository.load(cwd);
      expect(snapshot.status).toBe("ok");
      if (snapshot.status !== "ok") throw new Error("expected final snapshot");
      expect(snapshot.snapshot.document.phases[0]).toMatchObject({ status: "in-progress" });
      expect(snapshot.snapshot.document.phases[0]!.roadmapEvents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "phase-advancement-checkpoint" })]),
      );
    },
  );

  it.each([
    { name: "unchanged workspace", mutate: "none", accepted: true },
    { name: "changed worktree", mutate: "workspace", accepted: false },
    { name: "changed safe environment", mutate: "environment", accepted: false },
  ] as const)("checks legacy ledger freshness against the $name", async ({ mutate, accepted }) => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-legacy-freshness-"));
    roots.push(agentDir);
    const cwd = "/project/legacy-freshness";
    const repository = new ProjectNotesRepository(agentDir);
    await repository.migrate(cwd, document());
    const workspace = {
      version: 1 as const,
      repository: {
        projectKey: cwd,
        identityHash: "1".repeat(64),
        rootCommit: "2".repeat(40),
      },
      headCommit: "3".repeat(40),
      worktreeDigest: "4".repeat(64),
      clean: true,
    };
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.recordToolResult({
      name: "bash",
      args: { command: "pnpm test" },
      isError: false,
      details: {
        bashDiagnostics: {
          executionId: "execution-1",
          command: "pnpm test",
          cwd,
          startedAt: Date.parse(NOW),
          reason: "completed",
          exitCode: 0,
        },
      },
      workspace,
    });
    const codingSession: AppSidecarRoadmapToolSession = {
      ...owningSession(),
      getVerificationEvidenceLedgerSnapshot: () => ledger.snapshot(),
    };
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => ({ total: 1, completed: [1] }),
      captureVerificationWorkspace: async () =>
        mutate === "workspace" ? { ...workspace, worktreeDigest: "5".repeat(64) } : workspace,
      captureSafeToolEnvironmentDigest: () =>
        mutate === "environment" ? "6".repeat(64) : safeToolEnvironmentDigest(),
      broadcastNotesSnapshot: vi.fn(),
    });
    const output = await host.createSessionTools("coding", () => codingSession)[0]!.execute(
      RoadmapStatusParams.parse({
        update_id: `legacy-freshness-${mutate}`,
        phase_id: "phase-1",
        expected_revision: 1,
        transition: "done",
        progress: "Verification freshness checked",
        evidence: ["pnpm test"],
        verification_bindings: [
          {
            criterion_id: roadmapCriterionId(1, "Targeted tests pass"),
            execution_id: "execution-1",
          },
        ],
        verification: { result: "passed" },
      }),
      {} as never,
    );

    expect(JSON.parse(String(output))).toMatchObject(
      accepted
        ? { result: "committed", statusOutcome: "completion-pending" }
        : {
            result: "verification-incomplete",
            unmetEvidenceCodes: expect.arrayContaining(["stale-evidence"]),
          },
    );
  });
});
