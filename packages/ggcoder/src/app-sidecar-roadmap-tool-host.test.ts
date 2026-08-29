import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  AppSidecarRoadmapReviewRunCoordinator,
  AppSidecarRoadmapReviewScheduler,
  createAppSidecarRoadmapReviewTrigger,
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
  type NotesPhase,
} from "./project-notes-repository.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
const originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const tempDirectories: string[] = [];

function eligibleFinalReview(
  phaseId: string,
  revision: number,
  verificationStatusUpdateId: string,
  verification: "passed" | "exception-requested" = "passed",
) {
  return vi.fn(async () => ({
    phaseId,
    revision,
    sessionId: "phase-session",
    verificationStatusUpdateId,
    verification,
    ...(verification === "passed"
      ? {
          evidenceEvaluation: {
            ready: true as const,
            unmetEvidenceCodes: [] as [],
            criterionCoverage: [],
          },
        }
      : {}),
  }));
}

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
    update_id: "reviewer-wiring-status",
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
    getAutopilotFinalReviewClaim: () => ({
      projectKey: cwd,
      phaseId: "reviewer-wiring-phase",
      verificationStatusUpdateId: "reviewer-wiring-update",
      triggerId: "reviewer-wiring-trigger",
      statusUpdateId: "reviewer-wiring-status",
      reviewId: "reviewer-wiring-review",
    }),
    revalidateFinalReviewEligibility: eligibleFinalReview(
      "reviewer-wiring-phase",
      1,
      "reviewer-wiring-update",
    ),
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
    expect(loop).toContain("const executionResult = finalReviewExecutionResult(");
    expect(loop).toContain("revalidateRoadmapFinalReviewEligibility");
    expect(loop!.indexOf("revalidateRoadmapFinalReviewEligibility")).toBeLessThan(
      loop!.indexOf("ensureKenAutoSession()"),
    );
    expect(source).toContain("revalidateFinalReviewEligibility: async (input)");
    expect(loop).toMatch(
      /catch \(err\) \{[\s\S]*?broadcastError\("autopilot_error", "autopilot review failed", err\)/,
    );
    expect(loop).toContain("reportRoadmapReviewSchedulingFailure");
    expect(loop).toContain('broadcast("autopilot_error"');
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

  it("reports expected and current Notes revisions for a stale retry", async () => {
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        recordRoadmapStatusUpdate: vi.fn(async () => ({
          status: "stale-revision" as const,
          revision: 25,
        })),
        recordRoadmapFinalReview: vi.fn(async () => ({ status: "missing" as const })),
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      broadcastNotesSnapshot: vi.fn(),
    });
    const tool = host.createSessionTools("ken")[0]!;
    const output = await tool.execute(
      RoadmapStatusParams.parse({
        update_id: "stale-update",
        phase_id: "phase-stale",
        expected_revision: 23,
        transition: "in-progress",
        progress: "Retrying status.",
      }),
      {} as never,
    );
    if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");

    expect(JSON.parse(output)).toEqual({
      result: "stale-revision",
      phaseId: "phase-stale",
      revision: 25,
      message:
        "Project Notes revision is stale: expected 23, current 25. Reload the current snapshot and retry once with expected_revision=25.",
    });
  });

  it("accepts the active event IDs before reporting a stale Autopilot revision", async () => {
    const claim = createAppSidecarRoadmapReviewTrigger("phase-review-stale", "verification-stale");
    const recordRoadmapFinalReview = vi.fn(async () => ({
      status: "stale-revision" as const,
      revision: 25,
    }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
        recordRoadmapFinalReview,
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      getAutopilotFinalReviewClaim: () => claim,
      revalidateFinalReviewEligibility: eligibleFinalReview(
        claim.phaseId,
        23,
        claim.verificationStatusUpdateId,
      ),
      broadcastNotesSnapshot: vi.fn(),
    });
    const tool = host.createSessionTools("ken-autopilot")[0]!;
    const output = await tool.execute(
      RoadmapStatusParams.parse({
        update_id: claim.statusUpdateId,
        phase_id: claim.phaseId,
        expected_revision: 23,
        transition: "review",
        progress: "Reviewing the stale phase.",
        evidence: ["Inspected implementation evidence"],
        final_review: {
          review_id: claim.reviewId,
          decision: "accepted",
          evidence: ["Inspected implementation evidence"],
        },
      }),
      {} as never,
    );
    if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");

    expect(recordRoadmapFinalReview).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        statusUpdate: expect.objectContaining({ updateId: claim.statusUpdateId }),
        review: expect.objectContaining({ reviewId: claim.reviewId }),
      }),
    );
    expect(JSON.parse(output)).toEqual({
      result: "stale-revision",
      phaseId: claim.phaseId,
      revision: 25,
      message:
        "Project Notes revision is stale: expected 23, current 25. Reload the current snapshot and retry once with expected_revision=25.",
    });
  });

  it("rejects Autopilot event IDs outside the active deterministic claim", async () => {
    const claim = createAppSidecarRoadmapReviewTrigger("phase-claim", "verification-claim");
    let activeClaim: typeof claim | null = claim;
    const recordRoadmapFinalReview = vi.fn(async () => ({ status: "missing" as const }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
        recordRoadmapFinalReview,
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      getAutopilotFinalReviewClaim: () => activeClaim,
      broadcastNotesSnapshot: vi.fn(),
    });
    const tool = host.createSessionTools("ken-autopilot")[0]!;
    const output = await tool.execute(
      RoadmapStatusParams.parse({
        update_id: claim.statusUpdateId,
        phase_id: claim.phaseId,
        expected_revision: 1,
        transition: "review",
        progress: "Reviewed the phase.",
        evidence: ["Inspected implementation evidence"],
        final_review: {
          review_id: "model-selected-id",
          decision: "accepted",
          evidence: ["Inspected implementation evidence"],
        },
      }),
      {} as never,
    );
    if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");

    expect(JSON.parse(output)).toMatchObject({
      result: "final-review-claim-mismatch",
      phaseId: claim.phaseId,
    });
    const statusMismatchOutput = await tool.execute(
      RoadmapStatusParams.parse({
        update_id: "model-selected-status-id",
        phase_id: claim.phaseId,
        expected_revision: 1,
        transition: "review",
        progress: "Reviewed the phase with a reused status ID.",
        evidence: ["Inspected implementation evidence"],
        final_review: {
          review_id: claim.reviewId,
          decision: "accepted",
          evidence: ["Inspected implementation evidence"],
        },
      }),
      {} as never,
    );
    if (typeof statusMismatchOutput !== "string") {
      throw new Error("roadmap_status returned non-text output");
    }
    expect(JSON.parse(statusMismatchOutput)).toMatchObject({
      result: "final-review-claim-mismatch",
      phaseId: claim.phaseId,
    });
    activeClaim = null;
    const missingClaimOutput = await tool.execute(
      RoadmapStatusParams.parse({
        update_id: "review-without-claim",
        phase_id: claim.phaseId,
        expected_revision: 1,
        transition: "review",
        progress: "Reviewed the phase again.",
        evidence: ["Inspected implementation evidence"],
        final_review: {
          review_id: claim.reviewId,
          decision: "accepted",
          evidence: ["Inspected implementation evidence"],
        },
      }),
      {} as never,
    );
    if (typeof missingClaimOutput !== "string") {
      throw new Error("roadmap_status returned non-text output");
    }
    expect(JSON.parse(missingClaimOutput).result).toBe("final-review-claim-mismatch");
    expect(recordRoadmapFinalReview).not.toHaveBeenCalled();
  });

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

  it.each(["ken", "ken-autopilot"] as const)(
    "fails closed before repository final review for %s when current eligibility is absent",
    async (role) => {
      const claim = createAppSidecarRoadmapReviewTrigger("phase-gated", "verification-gated");
      const recordRoadmapFinalReview = vi.fn(async () => ({ status: "missing" as const }));
      const host = new AppSidecarRoadmapToolHost({
        cwd: "/project",
        repository: {
          recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
          recordRoadmapFinalReview,
        },
        reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
        projectAutopilot: { isEnabled: () => true },
        ...(role === "ken-autopilot" ? { getAutopilotFinalReviewClaim: () => claim } : {}),
        broadcastNotesSnapshot: vi.fn(),
      });
      const tool = host.createSessionTools(role)[0]!;

      for (const decision of ["accepted", "rejected"] as const) {
        const output = await tool.execute(
          RoadmapStatusParams.parse({
            update_id:
              role === "ken-autopilot" ? claim.statusUpdateId : `gated-${role}-${decision}`,
            phase_id: claim.phaseId,
            expected_revision: 7,
            transition: "review",
            progress: "Semantic review attempted.",
            evidence: ["Implementation inspected"],
            final_review: {
              review_id: role === "ken-autopilot" ? claim.reviewId : `manual-${decision}`,
              decision,
              evidence: ["Implementation inspected"],
              ...(decision === "rejected" ? { reason: "Criterion unsupported." } : {}),
            },
          }),
          {} as never,
        );
        if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");
        expect(JSON.parse(output)).toMatchObject({
          result: "verification-incomplete",
          phaseId: claim.phaseId,
          revision: 7,
        });
      }
      expect(recordRoadmapFinalReview).not.toHaveBeenCalled();
    },
  );

  it("fails closed when final-review eligibility throws or returns mismatched identity", async () => {
    const recordRoadmapFinalReview = vi.fn(async () => ({ status: "missing" as const }));
    const revalidateFinalReviewEligibility = vi
      .fn()
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockResolvedValueOnce({
        phaseId: "another-phase",
        revision: 9,
        sessionId: "another-session",
        verificationStatusUpdateId: "another-verification",
        verification: "passed",
        evidenceEvaluation: { ready: true, unmetEvidenceCodes: [], criterionCoverage: [] },
      });
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
        recordRoadmapFinalReview,
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      revalidateFinalReviewEligibility,
      broadcastNotesSnapshot: vi.fn(),
    });
    const tool = host.createSessionTools("ken")[0]!;
    for (const update_id of ["eligibility-throws", "eligibility-mismatches"]) {
      const output = await tool.execute(
        RoadmapStatusParams.parse({
          update_id,
          phase_id: "phase-gated",
          expected_revision: 9,
          transition: "review",
          progress: "Semantic review attempted.",
          evidence: ["Implementation inspected"],
          final_review: {
            review_id: update_id,
            decision: "accepted",
            evidence: ["Implementation inspected"],
          },
        }),
        {} as never,
      );
      if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");
      expect(JSON.parse(output).result).toBe("verification-incomplete");
    }
    expect(recordRoadmapFinalReview).not.toHaveBeenCalled();
  });

  it("keeps a current typed verification exception on its separate repository path", async () => {
    const recordRoadmapFinalReview = vi.fn(async () => ({ status: "missing" as const }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: {
        recordRoadmapStatusUpdate: vi.fn(async () => ({ status: "missing" as const })),
        recordRoadmapFinalReview,
      },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      revalidateFinalReviewEligibility: eligibleFinalReview(
        "phase-exception",
        12,
        "verification-exception",
        "exception-requested",
      ),
      broadcastNotesSnapshot: vi.fn(),
    });
    const output = await host.createSessionTools("ken")[0]!.execute(
      RoadmapStatusParams.parse({
        update_id: "review-exception",
        phase_id: "phase-exception",
        expected_revision: 12,
        transition: "review",
        progress: "Reviewed the typed exception.",
        evidence: ["Exception inspected"],
        final_review: {
          review_id: "manual-exception",
          decision: "accepted",
          evidence: ["Exception inspected"],
          accepts_verification_exception: true,
        },
      }),
      {} as never,
    );
    if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");
    expect(JSON.parse(output).result).toBe("notes-missing");
    expect(recordRoadmapFinalReview).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "queued" as const, message: "Automatic final review is queued" },
    { mode: "duplicate" as const, message: "Automatic final review was already queued" },
    { mode: "autopilot-disabled" as const, message: "Autopilot is disabled" },
    { mode: "unavailable" as const, message: "scheduling is unavailable" },
    { mode: "failed" as const, message: "scheduling failed" },
  ])(
    "reports the durable Review transition separately when scheduling is $mode",
    async ({ mode, message }) => {
      const sessionLink = { sessionId: "session-queue", sessionPath: "/sessions/queue.jsonl" };
      const phase: NotesPhase = {
        id: "phase-queue",
        title: "Queue final review",
        goal: "Schedule the reviewer",
        doneWhen: ["Review is queued"],
        order: 0,
        status: "review",
        sourcePrompt: "Queue final review",
        referenceIds: [],
        session: sessionLink,
        reminder: null,
        attentionReason: null,
        createdAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:01:00.000Z",
        completedAt: null,
        archivedAt: null,
        overrides: { status: null, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [],
        roadmapEvents: [
          {
            type: "status-update",
            id: "verification-queue",
            actor: "gg-coder",
            transition: "review",
            progress: "Verified",
            blocker: null,
            requiredExternalAction: null,
            evidence: ["pnpm test"],
            verification: "passed",
            verificationReason: null,
            verificationSession: sessionLink,
            statusOutcome: "applied",
            proposedReferences: [],
            timestamp: "2026-08-23T10:01:00.000Z",
          },
        ],
      };
      const schedulingError = new Error("scheduler unavailable");
      const onError = vi.fn();
      const onReviewReady = vi.fn((trigger) => {
        if (mode === "failed") throw schedulingError;
        return {
          status: mode === "duplicate" ? ("duplicate" as const) : ("queued" as const),
          trigger,
        };
      });
      const host = new AppSidecarRoadmapToolHost({
        cwd: "/project",
        repository: {
          recordRoadmapStatusUpdate: vi.fn(async () => ({
            status: "duplicate" as const,
            revision: 23,
            phaseId: phase.id,
            phase,
            statusOutcome: "same-status" as const,
            proposals: [],
          })),
          recordRoadmapFinalReview: vi.fn(async () => ({ status: "missing" as const })),
        },
        reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
        projectAutopilot: { isEnabled: () => mode !== "autopilot-disabled" },
        broadcastNotesSnapshot: vi.fn(),
        ...(mode === "unavailable" ? {} : { onReviewReady }),
        onError,
      });
      const tool = host.createSessionTools("coding", () => ({
        getActivePhaseContext: () => ({
          version: 1,
          projectKey: "/project",
          phase: {
            id: phase.id,
            title: phase.title,
            goal: phase.goal,
            doneWhen: phase.doneWhen,
            sourcePrompt: phase.sourcePrompt,
            status: phase.status,
            archivedAt: null,
          },
          session: sessionLink,
          references: [],
          executionStage: "reviewing",
        }),
        getMessages: () => [],
        getState: () => sessionLink,
      }))[0]!;
      const output = await tool.execute(
        RoadmapStatusParams.parse({
          update_id: "verification-queue",
          phase_id: phase.id,
          expected_revision: 23,
          transition: "review",
          progress: "Verification remains ready.",
          evidence: ["pnpm test"],
        }),
        {} as never,
      );
      if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");

      expect(JSON.parse(output)).toMatchObject({
        result: "duplicate",
        revision: 23,
        phaseTransitionOutcome: "same-status",
        finalReviewScheduleOutcome: mode,
        message: expect.stringContaining(message),
      });
      if (mode === "failed") {
        expect(onError).toHaveBeenCalledWith(schedulingError, {
          phaseId: phase.id,
          updateId: "verification-queue",
        });
      } else {
        expect(onError).not.toHaveBeenCalled();
      }
      if (mode === "autopilot-disabled" || mode === "unavailable") {
        expect(onReviewReady).not.toHaveBeenCalled();
      } else {
        expect(onReviewReady).toHaveBeenCalledOnce();
      }
    },
  );

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
      await fs.readFile(
        new URL("../../../fixtures/project-notes-v3.json", import.meta.url),
        "utf8",
      ),
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
    const afterFinalReview = vi.fn(async () => {
      if (decision === "accepted") throw new Error("binding unavailable");
    });
    const onError = vi.fn();
    let toolResult: unknown;
    let claimedReviewId: string | undefined;
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => true },
      broadcastNotesSnapshot: vi.fn(),
      getAutopilotFinalReviewClaim: () => reviewRuns.activeClaim(),
      revalidateFinalReviewEligibility: eligibleFinalReview(
        phase.id,
        migrated.snapshot.revision,
        "verification-automatic-review",
      ),
      now: () => "2026-08-23T10:02:00.000Z",
      afterFinalReview,
      onError,
    });
    const autopilotTool = host.createSessionTools("ken-autopilot")[0]!;
    const codingTool = host.createSessionTools("coding", () => {
      throw new Error("ordinary GG Coder must be rejected before session access");
    })[0]!;

    await expect(
      scheduler.drain(async (trigger) => {
        claimedReviewId = trigger.reviewId;
        const input = RoadmapStatusParams.parse({
          update_id: trigger.statusUpdateId,
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
        });
        if (decision === "accepted") {
          const codingOutput = await codingTool.execute(input, {} as never);
          if (typeof codingOutput !== "string") {
            throw new Error("roadmap_status returned non-text output");
          }
          expect(JSON.parse(codingOutput)).toEqual({
            result: "reviewer-not-authorized",
            phaseId: trigger.phaseId,
          });
          expect(recordFinalReview).not.toHaveBeenCalled();
        }
        await reviewRuns.run(
          trigger,
          async () => {
            const output = await autopilotTool.execute(input, {} as never);
            if (typeof output !== "string") {
              throw new Error("roadmap_status returned non-text output");
            }
            toolResult = JSON.parse(output) as unknown;
          },
          () => false,
        );
        return {
          status: "typed-non-commit" as const,
          attempt: null,
          code: "test-review-persisted",
          retryable: false,
        };
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
    expect(toolResult).toMatchObject({
      gateOutcome,
      ...(decision === "rejected"
        ? {
            message:
              "Final review submitted and applied; the phase returned to implementation for remediation.",
          }
        : {}),
    });
    expect(recordFinalReview).toHaveBeenCalledOnce();
    if (decision === "accepted") {
      expect(afterFinalReview).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "binding unavailable" }),
        expect.objectContaining({ phaseId: phase.id }),
      );
    } else {
      expect(afterFinalReview).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }
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
        projectKey: "/project",
        phaseId: "phase-incomplete",
        verificationStatusUpdateId: "verification-passed",
        triggerId: "trigger-incomplete",
        statusUpdateId: "status-incomplete",
        reviewId: "review-incomplete",
      }),
      revalidateFinalReviewEligibility: eligibleFinalReview(
        "phase-incomplete",
        31,
        "verification-passed",
      ),
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
