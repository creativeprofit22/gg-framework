import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
  type AppSidecarRoadmapSessionRole,
} from "./app-sidecar-roadmap-tool-host.js";
import { AgentSession } from "./core/agent-session.js";

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

  it("keeps phase completion review isolated to Autopilot Ken", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const loop = source.match(
      /async function runAutopilotReview[\s\S]*?async function runAutopilotPlanReview/,
    )?.[0];

    expect(loop).toContain("ensureKenAutoSession()");
    expect(loop).not.toContain("ensureKenSession()");
    expect(loop).toContain("phaseCompletionVerdict");
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
});
