import { describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
  type AppSidecarRoadmapToolSession,
} from "./app-sidecar-roadmap-tool-host.js";
import type { RoadmapVerificationEvidenceEvaluation } from "./core/verification-evidence.js";
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

function doneInput() {
  return RoadmapStatusParams.parse({
    update_id: "completion-intent-1",
    phase_id: "phase-1",
    expected_revision: 4,
    transition: "done",
    progress: "Implementation and verification completed",
    evidence: ["pnpm test exited successfully"],
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
      message: "Done was not recorded because same-session canonical plan progress is unavailable.",
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
    expect(broadcastNotesSnapshot).not.toHaveBeenCalled();
    expect(onCompletionIntent).not.toHaveBeenCalled();
  });
});
