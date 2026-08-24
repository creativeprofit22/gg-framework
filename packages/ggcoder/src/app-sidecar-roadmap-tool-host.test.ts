import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  AppSidecarRoadmapReviewRunCoordinator,
  AppSidecarRoadmapReviewScheduler,
} from "./app-sidecar-roadmap-review-scheduler.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
  type AppSidecarRoadmapSessionRole,
} from "./app-sidecar-roadmap-tool-host.js";
import { AgentSession } from "./core/agent-session.js";
import {
  ProjectNotesRepository,
  type NotesDocumentV3,
} from "./project-notes-repository.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
const originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const tempDirectories: string[] = [];

beforeEach(() => {
  process.env.AZURE_OPENAI_API_KEY = "reviewer-wiring-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://reviewer.wiring/openai/v1/responses";
  process.env.AZURE_OPENAI_DEPLOYMENT = "reviewer-wiring";
});

afterEach(async () => {
  if (originalAzureApiKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
  else process.env.AZURE_OPENAI_API_KEY = originalAzureApiKey;
  if (originalAzureBaseUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
  else process.env.AZURE_OPENAI_BASE_URL = originalAzureBaseUrl;
  if (originalAzureDeployment === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT;
  else process.env.AZURE_OPENAI_DEPLOYMENT = originalAzureDeployment;
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function roadmapStatusCallResponse(): Response {
  const argumentsJson = JSON.stringify({
    update_id: "reviewer-wiring-update",
    phase_id: "reviewer-wiring-phase",
    expected_revision: 1,
    transition: "review",
    progress: "Reviewer wiring reached the durable completion gate.",
    evidence: ["roadmap_status executed through AgentSession"],
    final_review: {
      review_id: "reviewer-wiring-review",
      decision: "rejected",
      reason: "Regression fixture exercises reviewer-owned final review.",
    },
  });
  return sseResponse([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_reviewer_wiring",
        call_id: "call_reviewer_wiring",
        name: "roadmap_status",
      },
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "fc_reviewer_wiring",
      arguments: argumentsJson,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_reviewer_wiring",
        call_id: "call_reviewer_wiring",
        name: "roadmap_status",
        arguments: argumentsJson,
      },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 10, output_tokens: 3 } },
    },
  ]);
}

function completionResponse(): Response {
  return sseResponse([
    { type: "response.output_text.delta", delta: "Review recorded." },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 12, output_tokens: 4 } },
    },
  ]);
}

async function exerciseReviewerSession(role: Exclude<AppSidecarRoadmapSessionRole, "coding">) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `reviewer-wiring-${role}-`));
  tempDirectories.push(cwd);
  const finalReviews: Array<Record<string, unknown>> = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  const host = new AppSidecarRoadmapToolHost({
    cwd,
    repository: {
      recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
      recordRoadmapFinalReview: vi.fn(async (_projectCwd, request) => {
        finalReviews.push(request as unknown as Record<string, unknown>);
        return { status: "missing" as const };
      }),
    },
    reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
    projectAutopilot: { isEnabled: () => role === "ken-autopilot" },
    broadcastNotesSnapshot: vi.fn(),
  });
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return requestBodies.length === 1 ? roadmapStatusCallResponse() : completionResponse();
  });
  vi.stubGlobal("fetch", fetchMock);

  let session: AgentSession | null = null;
  session = new AgentSession({
    provider: "azure",
    model: "azure:reviewer-wiring",
    baseUrl: process.env.AZURE_OPENAI_BASE_URL,
    cwd,
    systemPrompt: "Submit the final review through roadmap_status.",
    allowedTools: [...APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES],
    additionalTools: host.createSessionTools(role, () => session!),
    maxTurns: 3,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    selfCorrectionHooks: false,
    orchestrationPrompt: false,
  });

  try {
    await session.initialize();
    await session.prompt("Review the active Roadmap phase.");
  } finally {
    await session.dispose();
  }

  const declaredTools = requestBodies[0]?.tools as Array<Record<string, unknown>>;
  expect(declaredTools).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "function", name: "roadmap_status" })]),
  );
  expect(finalReviews).toHaveLength(1);
  expect(finalReviews[0]?.statusUpdate).toEqual(expect.objectContaining({ actor: role }));
}

describe("app sidecar reviewer roadmap_status production wiring", () => {
  it("wires the shared Ken allow-list and custom tool into both production constructors", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");

    expect(
      source.match(/allowedTools: \[\.\.\.APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES\]/g),
    ).toHaveLength(2);
    expect(source).toMatch(
      /ensureKenSession[\s\S]*?additionalTools: roadmapToolHost\.createSessionTools\("ken"/,
    );
    expect(source).toMatch(
      /ensureKenAutoSession[\s\S]*?additionalTools: roadmapToolHost\.createSessionTools\([\s\S]*?"ken-autopilot"/,
    );
  });

  it("keeps phase completion review isolated to Autopilot Ken and reports verdict failures", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const loop = source.match(
      /async function runAutopilotReview[\s\S]*?async function runAutopilotPlanReview/,
    )?.[0];

    expect(loop).toContain("ensureKenAutoSession()");
    expect(loop).not.toContain("ensureKenSession()");
    expect(loop).toMatch(
      /try \{[\s\S]*?return phaseCompletionVerdict\([\s\S]*?\} catch \(err\) \{[\s\S]*?broadcastError\("autopilot_error", "autopilot review failed", err\)/,
    );
  });

  it("persists the settled implementation checkpoint before run_end and Autopilot review", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const runAgent = source.match(
      /async function runAgent[\s\S]*?\/\/ ── Autopilot orchestration/,
    )?.[0];

    expect(source).toContain("restorePhaseImplementationPlanEvidence({");
    expect(runAgent).toContain("await checkpointSettledPhaseImplementation({");
    expect(runAgent).toContain("tracker: phaseImplementationPlans");
    expect(runAgent).toContain("currentPlanProgress: planProgressPayload()");
    expect(runAgent).toContain("deactivateApprovedPlan({ retainImplementationEvidence: true })");
    expect(runAgent).toContain(
      'runOutcome: cancelled ? "cancelled" : runSucceeded ? "succeeded" : "failed"',
    );
    expect(runAgent!.indexOf("await checkpointSettledPhaseImplementation({")).toBeLessThan(
      runAgent!.indexOf('broadcast("run_end"'),
    );
  });

  it.each(["ken", "ken-autopilot"] as const)(
    "registers and executes reviewer final review for %s",
    async (role) => {
      await exerciseReviewerSession(role);
    },
  );

  it("fails closed when the Autopilot claim provider is absent", async () => {
    const recordRoadmapFinalReview = vi.fn(async () => ({ status: "missing" as const }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "C:/workspace",
      repository: {
        recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
        recordRoadmapFinalReview,
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      broadcastNotesSnapshot: vi.fn(),
    });
    const roadmapStatus = host.createSessionTools("ken-autopilot")[0]!;

    const output = await roadmapStatus.execute(
      RoadmapStatusParams.parse({
        update_id: "status-missing-claim-provider",
        phase_id: "phase-missing-claim-provider",
        expected_revision: 1,
        progress: "Reviewed the phase.",
        transition: "review",
        evidence: ["Inspected implementation evidence"],
        final_review: {
          review_id: "review-missing-claim-provider",
          decision: "accepted",
          evidence: ["Inspected implementation evidence"],
        },
      }),
      {} as never,
    );

    if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");
    expect(JSON.parse(output).result).toBe("final-review-claim-mismatch");
    expect(recordRoadmapFinalReview).not.toHaveBeenCalled();
  });

  const automaticReviewCases = [
    { decision: "accepted" as const, gateOutcome: "done" as const, phaseStatus: "done" as const },
    {
      decision: "rejected" as const,
      gateOutcome: "review" as const,
      phaseStatus: "in-progress" as const,
    },
  ] as const;
  async function assertAutomaticReview({
    decision,
    gateOutcome,
    phaseStatus,
  }: (typeof automaticReviewCases)[number]): Promise<void> {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-roadmap-auto-review-"));
    tempDirectories.push(agentDir);
    const cwd = `/work/automatic-${decision}-final-review`;
    const document = JSON.parse(
      await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
    ) as NotesDocumentV3;
    const phase = document.phases[0]!;
    const session = phase.session!;
    phase.status = "review";
    phase.attentionReason = null;
    phase.overrides.status = null;
    phase.pendingAutomaticLifecycleTransition = null;
    phase.lifecycleEvents = phase.lifecycleEvents.slice(0, 2);
    phase.lifecycleEvents.push({
      id: "event-automatic-review",
      fromStatus: "in-progress",
      toStatus: "review",
      source: "agent",
      timestamp: "2026-08-23T09:59:00.000Z",
      reason: "Implementation and verification settled.",
      kind: "other",
    });
    phase.roadmapEvents = [
      {
        type: "implementation-checkpoint",
        id: "checkpoint-automatic-review",
        session,
        planStepTotal: 1,
        completedPlanSteps: [1],
        runOutcome: "succeeded",
        timestamp: "2026-08-23T10:00:00.000Z",
      },
      {
        type: "status-update",
        id: "verification-automatic-review",
        actor: "gg-coder",
        transition: "review",
        progress: "All automatic-review criteria passed.",
        blocker: null,
        requiredExternalAction: null,
        evidence: ["pnpm test"],
        verification: "passed",
        verificationReason: null,
        verificationSession: session,
        statusOutcome: "applied",
        proposedReferences: [],
        timestamp: "2026-08-23T10:01:00.000Z",
      },
    ];
    document.updatedAt = "2026-08-23T10:01:00.000Z";

    const repository = new ProjectNotesRepository(agentDir);
    const migrated = await repository.migrate(cwd, document);
    if (migrated.status !== "ok") {
      throw new Error(`automatic review fixture did not migrate: ${JSON.stringify(migrated)}`);
    }

    const scheduler = new AppSidecarRoadmapReviewScheduler();
    const reviewRuns = new AppSidecarRoadmapReviewRunCoordinator<unknown>();
    expect(scheduler.replay([phase])).toMatchObject([{ status: "queued" }]);
    const recordFinalReview = vi.spyOn(repository, "recordRoadmapFinalReview");
    let toolResult: unknown;
    let claimedReviewId: string | undefined;
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      broadcastNotesSnapshot: vi.fn(),
      getAutopilotFinalReviewClaim: () => reviewRuns.activeClaim(),
      now: () => "2026-08-23T10:02:00.000Z",
    });
    const autopilotTool = host.createSessionTools("ken-autopilot")[0]!;

    await expect(
      scheduler.drain(async (trigger) => {
        claimedReviewId = trigger.reviewId;
        await reviewRuns.run(
          trigger,
          async () => {
            const output = await autopilotTool.execute(
              RoadmapStatusParams.parse({
                update_id: "status-automatic-review",
                phase_id: trigger.phaseId,
                expected_revision: migrated.snapshot.revision,
                transition: "review",
                progress: `Autopilot independently ${decision} the completed phase.`,
                evidence: ["Reviewed implementation and verification evidence"],
                final_review: {
                  review_id: trigger.reviewId,
                  decision,
                  evidence: [`Independent final review ${decision}`],
                  reason: decision === "rejected" ? "Remediation is required." : undefined,
                },
              }),
              {} as never,
            );
            if (typeof output !== "string") {
              throw new Error("roadmap_status returned non-text output");
            }
            toolResult = JSON.parse(output) as unknown;
          },
          () => false,
        );
      }),
    ).resolves.toMatchObject([{ status: "started" }, { status: "completed" }]);

    if (
      !toolResult ||
      typeof toolResult !== "object" ||
      !("result" in toolResult) ||
      toolResult.result !== "completion-review-committed"
    ) {
      throw new Error(`automatic review did not complete: ${JSON.stringify(toolResult)}`);
    }
    expect(toolResult).toMatchObject({ gateOutcome });
    expect(recordFinalReview).toHaveBeenCalledOnce();
    const persisted = await repository.load(cwd);
    expect(persisted.status).toBe("ok");
    if (persisted.status !== "ok") throw new Error("automatic review result did not persist");
    expect(persisted.snapshot.document.phases[0]!.status).toBe(phaseStatus);
    const completionReviews = persisted.snapshot.document.phases[0]!.roadmapEvents.filter(
      (event) => event.type === "completion-review",
    );
    expect(completionReviews).toEqual([
      expect.objectContaining({
        id: claimedReviewId,
        reviewer: "ken-autopilot",
        decision,
        gateOutcome,
      }),
    ]);
  }

  it.each(automaticReviewCases)(
    "$decision final review persists once with gate $gateOutcome",
    assertAutomaticReview,
  );

  it("reports accepted completion gate failures as visible non-commits", async () => {
    const broadcastNotesSnapshot = vi.fn();
    const onNonCommit = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
        recordRoadmapFinalReview: vi.fn(async () => ({
          status: "completion-gate-blocked" as const,
          revision: 31,
          phaseId: "phase-incomplete",
          evaluation: {
            gateOutcome: "review" as const,
            unmetGateCodes: ["incomplete-plan" as const],
            implementationCheckpointId: "checkpoint-1-of-9",
            verificationStatusUpdateId: "verification-passed",
            targetStatus: "review" as const,
            reason: "Not every canonical plan step is complete.",
          },
        })),
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      broadcastNotesSnapshot,
      getAutopilotFinalReviewClaim: () => ({
        phaseId: "phase-incomplete",
        verificationStatusUpdateId: "verification-passed",
        triggerId: "trigger-incomplete",
        reviewId: "review-incomplete",
      }),
      onNonCommit,
      now: () => "2026-08-15T01:00:00.000Z",
    });
    const tool = host.createSessionTools("ken-autopilot")[0]!;
    const input = RoadmapStatusParams.parse({
      update_id: "status-incomplete",
      phase_id: "phase-incomplete",
      expected_revision: 31,
      transition: "review",
      progress: "Autopilot reviewed the phase.",
      evidence: ["Independent verification passed"],
      final_review: {
        review_id: "review-incomplete",
        decision: "accepted",
        evidence: ["The implementation was reviewed"],
      },
    });
    const output = await tool.execute(input, {} as never);
    if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");

    expect(JSON.parse(output)).toEqual({
      result: "completion-gate-blocked",
      phaseId: "phase-incomplete",
      revision: 31,
      gateOutcome: "review",
      unmetGateCodes: ["incomplete-plan"],
      message:
        "Final review was not committed because completion gates are unmet: incomplete-plan.",
    });
    expect(broadcastNotesSnapshot).not.toHaveBeenCalled();
    expect(onNonCommit).toHaveBeenCalledWith({
      result: "completion-gate-blocked",
      phaseId: "phase-incomplete",
      updateId: "status-incomplete",
    });
  });
});
