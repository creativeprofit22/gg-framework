import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { AppSidecarRoadmapToolHost } from "./app-sidecar-roadmap-tool-host.js";
import {
  collectVerificationEvidence,
  evaluateRoadmapVerificationEvidence,
  roadmapCriterionId,
} from "./core/verification-evidence.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const PHASE_ID = "e349b4c7-ca8c-43da-8d14-e21f21677249";
const SESSION = { sessionId: "phase-session", sessionPath: "/sessions/phase.jsonl" };
const WORKSPACE = {
  version: 1 as const,
  repository: {
    projectKey: "C:/fixture",
    identityHash: "1".repeat(64),
    rootCommit: "2".repeat(40),
  },
  headCommit: "3".repeat(40),
  worktreeDigest: "4".repeat(64),
  clean: true,
};

function activeContext(): ActivePhaseContextV1 {
  return {
    version: 1,
    projectKey: "evidence-boundary",
    phase: {
      id: PHASE_ID,
      title: "Evidence boundary",
      goal: "Require harness-owned verification",
      doneWhen: ["criterion one", "criterion two"],
      sourcePrompt: "Implement the evidence boundary.",
      status: "in-progress",
      archivedAt: null,
    },
    session: SESSION,
    references: [],
    executionStage: "implementing",
  };
}

function shellExchange(id: string, command: string): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name: "bash", args: { command } }] },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: "Exit code: 0\nPASS" }],
    },
  ];
}

function codingSession(messages: Message[]) {
  const currentLedgerEvidence = collectVerificationEvidence(messages).map((item, index) => ({
    ...item,
    executionId: `execution-${index}`,
    observedAt: "2026-08-30T10:00:00.000Z",
    cwd: "C:/fixture",
    safeToolEnvironmentDigest: "9".repeat(64),
    workspace: WORKSPACE,
    classifierVersion: "roadmap-verification-v1",
  }));
  return {
    getActivePhaseContext: () => activeContext(),
    getMessages: () => messages,
    getState: () => SESSION,
    getVerificationEvidenceLedgerSnapshot: () => ({
      currentEvidence: currentLedgerEvidence,
      staleEvidence: [],
    }),
    evaluateRoadmapVerificationEvidence: (input: {
      doneWhen: readonly string[];
      evidence: readonly string[];
      verificationBindings: readonly { criterionId: string; executionId: string }[];
      expectedRevision: number | undefined;
    }) =>
      evaluateRoadmapVerificationEvidence({
        ...input,
        currentMessages: [],
        currentLedgerEvidence,
      }),
  };
}

function statusInput(evidence: string[]) {
  return RoadmapStatusParams.parse({
    update_id: "completion-intent-15",
    phase_id: PHASE_ID,
    expected_revision: 15,
    transition: "done",
    progress: "Verification submitted at revision 15.",
    evidence,
    verification_bindings: activeContext().phase.doneWhen.map((criterion, index) => ({
      criterion_id: roadmapCriterionId(index + 1, criterion),
      execution_id: `execution-${index}`,
    })),
    verification: { result: "passed" },
  });
}

describe("Roadmap Done verification evidence boundary", () => {
  it("rejects shell commands that can mask a failing verification", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const unsafe = [
      "vitest run criterion-1.test.ts || echo PASSED",
      "vitest run criterion-2.test.ts || echo PASSED",
    ];
    const host = new AppSidecarRoadmapToolHost({
      cwd: "C:/fixture",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      captureVerificationWorkspace: async () => WORKSPACE,
      captureSafeToolEnvironmentDigest: () => "9".repeat(64),
      resolvePlanProgress: () => ({ total: 2, completed: [1, 2] }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const output = await host
      .createSessionTools("coding", () =>
        codingSession(
          unsafe.flatMap((command, index) => shellExchange(`execution-${index}`, command)),
        ),
      )[0]!
      .execute(statusInput(unsafe), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "verification-incomplete",
      phaseId: PHASE_ID,
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });

  it("records intent only with distinct classifier-approved current commands", async () => {
    const commands = ["vitest run criterion-1.test.ts", "vitest run criterion-2.test.ts"];
    const recordRoadmapStatusUpdate = vi.fn(async () => ({
      status: "duplicate" as const,
      revision: 16,
      phaseId: PHASE_ID,
      phase: {} as never,
      statusOutcome: "completion-pending" as const,
      proposals: [],
    }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "C:/fixture",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      captureVerificationWorkspace: async () => WORKSPACE,
      captureSafeToolEnvironmentDigest: () => "9".repeat(64),
      resolvePlanProgress: () => ({ total: 2, completed: [1, 2] }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const output = await host
      .createSessionTools("coding", () =>
        codingSession(
          commands.flatMap((command, index) => shellExchange(`execution-${index}`, command)),
        ),
      )[0]!
      .execute(
        statusInput(commands.map((command, index) => `criterion ${index + 1}: ${command}`)),
        {} as never,
      );

    expect(JSON.parse(String(output))).toMatchObject({
      result: "duplicate",
      revision: 16,
      statusOutcome: "completion-pending",
      completionIntentId: "completion-intent-15",
    });
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledOnce();
  });
});
