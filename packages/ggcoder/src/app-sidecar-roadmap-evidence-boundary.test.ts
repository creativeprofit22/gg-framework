import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { AppSidecarRoadmapToolHost } from "./app-sidecar-roadmap-tool-host.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";

const PHASE_ID = "e349b4c7-ca8c-43da-8d14-e21f21677249";
const SESSION = { sessionId: "phase-session", sessionPath: "/sessions/phase.jsonl" };

function activeContext(): ActivePhaseContextV1 {
  return {
    version: 1,
    projectKey: "evidence-boundary",
    phase: {
      id: PHASE_ID,
      title: "Evidence boundary",
      goal: "Require harness-owned verification",
      doneWhen: [
        "criterion one",
        "criterion two",
        "criterion three",
        "criterion four",
        "criterion five",
      ],
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
    {
      role: "assistant",
      content: [{ type: "tool_call", id, name: "bash", args: { command } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: "Exit code: 0\nPASS" }],
    },
  ];
}

function codingSession(messages: Message[]) {
  return {
    getActivePhaseContext: () => activeContext(),
    getMessages: () => messages,
    getState: () => SESSION,
    updateActivePhaseStage: vi.fn(),
  };
}

function statusInput(evidence: string[]) {
  return {
    update_id: "revision-15-review",
    phase_id: PHASE_ID,
    expected_revision: 15,
    transition: "review",
    progress: "Verification submitted at revision 15.",
    evidence,
    verification: { result: "passed" },
    final_review: null,
    proposed_references: [],
    blocker: undefined,
    required_external_action: undefined,
  };
}

async function execute(
  tool: ReturnType<AppSidecarRoadmapToolHost["createSessionTools"]>[number],
  input: object,
) {
  const result = await tool.execute(input, {} as never);
  return JSON.parse(String(result)) as Record<string, unknown>;
}

describe("roadmap review verification evidence boundary", () => {
  it("keeps the revision-15 lifecycle in Review through attempted final review", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    let reviewRevision = 15;
    const recordRoadmapFinalReview = vi.fn(async () => {
      reviewRevision += 1;
      return {
        status: "committed" as const,
        snapshot: {
          revision: reviewRevision,
          document: { phases: [{ id: PHASE_ID, status: "review", completedAt: null }] },
        },
        statusOutcome: "applied" as const,
        proposals: [],
        evaluation: { gateOutcome: "review" as const, unmetGateCodes: ["incomplete-plan"] },
      };
    });
    const unsafe = Array.from(
      { length: 5 },
      (_, index) => `vitest run criterion-${index + 1}.test.ts || echo PASSED`,
    );
    const messages = unsafe.flatMap((command, index) => shellExchange(`unsafe-${index}`, command));
    messages.push(...shellExchange("row-700", "node scripts/final-smoke.mjs"));
    const broadcastNotesSnapshot = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "C:/fixture",
      repository: { recordRoadmapStatusUpdate, recordRoadmapFinalReview } as never,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: new AppSidecarProjectAutopilotState(),
      broadcastNotesSnapshot,
    });

    const result = await execute(
      host.createSessionTools("coding", () => codingSession(messages))[0]!,
      statusInput(unsafe.map((command, index) => `PASSED criterion ${index + 1}: ${command}`)),
    );

    expect(result).toMatchObject({
      result: "verification-incomplete",
      phaseId: PHASE_ID,
      revision: 15,
      unmetEvidenceCodes: ["rejected-evidence", "missing-approved-evidence"],
    });
    expect(String(result.message)).toContain("Review was not applied");
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();

    for (const expectedRevision of [15, 16]) {
      const review = await execute(host.createSessionTools("ken")[0]!, {
        update_id: `ken-review-${expectedRevision}`,
        phase_id: PHASE_ID,
        expected_revision: expectedRevision,
        transition: "review",
        progress: "Ken reviewed the submitted lifecycle evidence.",
        evidence: ["Lifecycle evidence reviewed."],
        verification: null,
        final_review: {
          review_id: `final-review-${expectedRevision}`,
          decision: "accepted",
          evidence: [],
          reason: "Implementation plan remains incomplete.",
          accepts_verification_exception: false,
        },
        proposed_references: [],
      });
      expect(review).toMatchObject({
        result: "completion-review-committed",
        revision: expectedRevision + 1,
        gateOutcome: "review",
        unmetGateCodes: ["incomplete-plan"],
      });
      expect(String(review.message)).toContain("phase remains in Review");
    }
    expect(recordRoadmapFinalReview).toHaveBeenCalledTimes(2);
    expect(broadcastNotesSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: 17,
        document: expect.objectContaining({
          phases: [expect.objectContaining({ status: "review", completedAt: null })],
        }),
      }),
    );
  });

  it("applies review only with five distinct classifier-approved current commands", async () => {
    const commands = Array.from(
      { length: 5 },
      (_, index) => `vitest run criterion-${index + 1}.test.ts`,
    );
    const recordRoadmapStatusUpdate = vi.fn(async () => ({
      status: "committed" as const,
      snapshot: { revision: 16 },
      phase: { status: "review" },
      statusOutcome: "applied" as const,
      proposals: [],
    }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "C:/fixture",
      repository: { recordRoadmapStatusUpdate, recordRoadmapFinalReview: vi.fn() } as never,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: new AppSidecarProjectAutopilotState(),
      broadcastNotesSnapshot: vi.fn(),
    });

    const result = await execute(
      host.createSessionTools("coding", () =>
        codingSession(
          commands.flatMap((command, index) => shellExchange(`safe-${index}`, command)),
        ),
      )[0]!,
      statusInput(commands.map((command, index) => `criterion ${index + 1}: ${command}`)),
    );

    expect(result).toMatchObject({ result: "committed", revision: 16, statusOutcome: "applied" });
    expect(String(result.message)).toContain("phase remains in Review");
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledOnce();
  });
});
