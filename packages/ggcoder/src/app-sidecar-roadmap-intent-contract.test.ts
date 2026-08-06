import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapDraftToolHost } from "./app-sidecar-roadmap-draft-tool-host.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";
import { APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT } from "./app-sidecar-roadmap-draft-tool-host.js";
import { AgentSession } from "./core/agent-session.js";
import { ProjectNotesRepository } from "./project-notes-repository.js";

interface ToolStep {
  name: "roadmap_inspect" | "roadmap_phase_draft";
  args: Record<string, unknown>;
}

interface IntentContractEval {
  name: string;
  request: string;
  expectedTools: ToolStep["name"][];
  expectsDraft: boolean;
}

interface IntentModelRoute {
  request: string;
  responses: ToolStep[];
}

const appIntentEvals: IntentContractEval[] = [
  {
    name: "create",
    request: "Create our roadmap for the billing migration.",
    expectedTools: ["roadmap_inspect", "roadmap_phase_draft"],
    expectsDraft: true,
  },
  {
    name: "extend",
    request: "Add release hardening to our roadmap.",
    expectedTools: ["roadmap_inspect", "roadmap_phase_draft"],
    expectsDraft: true,
  },
  {
    name: "duplicate avoidance",
    request: "Add core delivery to our roadmap.",
    expectedTools: ["roadmap_inspect"],
    expectsDraft: false,
  },
  {
    name: "explicit roadmap.md",
    request: "Create roadmap.md for this repository.",
    expectedTools: [],
    expectsDraft: false,
  },
  {
    name: "external-roadmap review",
    request: "Review https://linear.app/acme/team/roadmap and identify delivery risks.",
    expectedTools: [],
    expectsDraft: false,
  },
];

// Kept separate from appIntentEvals so behavioral expectations cannot select their own outcome.
const appIntentModelRoutes: IntentModelRoute[] = [
  {
    request: "Create our roadmap for the billing migration.",
    responses: [
      { name: "roadmap_inspect", args: {} },
      {
        name: "roadmap_phase_draft",
        args: {
          expected_revision: 1,
          summary: "Add billing migration delivery work.",
          phases: [
            {
              title: "Billing migration",
              goal: "Move billing safely to the new system.",
              doneWhen: ["Migration checks pass"],
              sourcePrompt: "Create our roadmap for the billing migration.",
            },
          ],
        },
      },
    ],
  },
  {
    request: "Add release hardening to our roadmap.",
    responses: [
      { name: "roadmap_inspect", args: {} },
      {
        name: "roadmap_phase_draft",
        args: {
          expected_revision: 1,
          summary: "Add release hardening without duplicating core delivery.",
          phases: [
            {
              title: "Release hardening",
              goal: "Prove the release is safe to ship and recover.",
              doneWhen: ["Critical checks pass", "Rollback is rehearsed"],
              sourcePrompt: "Add release hardening to our roadmap.",
            },
          ],
        },
      },
    ],
  },
  {
    request: "Add core delivery to our roadmap.",
    responses: [{ name: "roadmap_inspect", args: {} }],
  },
  { request: "Create roadmap.md for this repository.", responses: [] },
  {
    request: "Review https://linear.app/acme/team/roadmap and identify delivery risks.",
    responses: [],
  },
];

const tempDirs: string[] = [];
const originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
const originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

beforeEach(() => {
  process.env.AZURE_OPENAI_API_KEY = "intent-eval-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://intent.eval/openai/v1/responses";
  process.env.AZURE_OPENAI_DEPLOYMENT = "intent-eval";
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
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function responseWithTool(step: ToolStep, index: number): Response {
  const callId = `call_${index}`;
  const itemId = `fc_${index}`;
  const args = JSON.stringify(step.args);
  return new Response(
    [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: itemId, call_id: callId, name: step.name },
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: itemId,
        arguments: args,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: itemId,
          call_id: callId,
          name: step.name,
          arguments: args,
        },
      },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 10, output_tokens: 3 } },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function responseWithText(text: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 4 } },
      })}\n\n`,
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

interface IntentPromptContext {
  request: string | null;
  instructions: string | null;
  declaredTools: string[];
  consumedTools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractIntentPromptContext(body: Record<string, unknown>): IntentPromptContext {
  const input = Array.isArray(body.input) ? body.input.filter(isRecord) : [];
  const userMessages = input.filter((item) => item.role === "user");
  const currentUserMessage = userMessages.at(-1);
  const requestParts = Array.isArray(currentUserMessage?.content)
    ? currentUserMessage.content
        .filter(isRecord)
        .filter((part) => part.type === "input_text" && typeof part.text === "string")
        .map((part) => part.text as string)
    : [];

  const completedCallIds = new Set(
    input
      .filter((item) => item.type === "function_call_output" && typeof item.call_id === "string")
      .map((item) => item.call_id as string),
  );
  const consumedTools = input
    .filter(
      (item) =>
        item.type === "function_call" &&
        typeof item.call_id === "string" &&
        completedCallIds.has(item.call_id) &&
        typeof item.name === "string",
    )
    .map((item) => item.name as string);

  const declaredTools = Array.isArray(body.tools)
    ? body.tools
        .filter(isRecord)
        .filter((tool) => tool.type === "function" && typeof tool.name === "string")
        .map((tool) => tool.name as string)
    : [];

  return {
    request: requestParts.length > 0 ? requestParts.join("\n") : null,
    instructions: typeof body.instructions === "string" ? body.instructions : null,
    declaredTools,
    consumedTools,
  };
}

function createIntentModelFetch(
  requestBodies: Record<string, unknown>[],
): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    const context = extractIntentPromptContext(body);
    const route = appIntentModelRoutes.find((candidate) => candidate.request === context.request);
    if (!route) {
      throw new Error(`Unmatched intent-eval request: ${JSON.stringify(context.request)}`);
    }
    if (!context.instructions?.includes("## App Roadmap intent")) {
      throw new Error(`Intent-eval route ${JSON.stringify(route.request)} lacks app instructions.`);
    }
    for (const toolName of ["roadmap_inspect", "roadmap_phase_draft"]) {
      if (!context.declaredTools.includes(toolName)) {
        throw new Error(
          `Intent-eval route ${JSON.stringify(route.request)} lacks tool ${toolName}.`,
        );
      }
    }

    const expectedHistory = route.responses
      .slice(0, context.consumedTools.length)
      .map((response) => response.name);
    if (
      context.consumedTools.length > route.responses.length ||
      JSON.stringify(context.consumedTools) !== JSON.stringify(expectedHistory)
    ) {
      throw new Error(
        `Intent-eval route ${JSON.stringify(route.request)} received unexpected tool history ` +
          JSON.stringify(context.consumedTools),
      );
    }

    const response = route.responses[context.consumedTools.length];
    return response
      ? responseWithTool(response, context.consumedTools.length + 1)
      : responseWithText("Intent handled.");
  });
}

async function createProject(): Promise<{
  root: string;
  project: string;
  repository: ProjectNotesRepository;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-intent-eval-"));
  tempDirs.push(root);
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  const repository = new ProjectNotesRepository(path.join(root, "agent"));
  const migrated = await repository.migrate(project, {
    version: 3,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    phases: [
      {
        id: "phase-core-delivery",
        title: "Core delivery",
        goal: "Ship the core product.",
        doneWhen: ["Core acceptance checks pass"],
        order: 0,
        status: "not-started",
        sourcePrompt: "Ship the core product.",
        referenceIds: [],
        session: null,
        reminder: null,
        attentionReason: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
        completedAt: null,
        archivedAt: null,
        overrides: { status: null, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [],
        roadmapEvents: [],
      },
    ],
    references: [],
    updatedAt: "2026-08-05T00:00:00.000Z",
    legacyImportedAt: null,
  });
  expect(migrated.status).toBe("ok");
  return { root, project, repository };
}

async function runAppIntentEval(evaluation: IntentContractEval): Promise<{
  requestBodies: Record<string, unknown>[];
  calledTools: string[];
  pendingDraft: ReturnType<AppSidecarRoadmapDraftCoordinator["pending"]>;
}> {
  const { root, project, repository } = await createProject();
  const drafts = new AppSidecarRoadmapDraftCoordinator({
    createId: (() => {
      let id = 0;
      return () => `draft-id-${++id}`;
    })(),
    now: () => "2026-08-05T12:00:00.000Z",
  });
  const host = new AppSidecarRoadmapDraftToolHost({
    cwd: project,
    repository,
    drafts,
    getOwningSession: () =>
      ({
        getSessionPath: () => path.join(root, "sessions", "intent-eval.jsonl"),
        getState: () => ({ sessionId: "intent-eval-session" }),
      }) as unknown as AgentSession,
  });
  const requestBodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", createIntentModelFetch(requestBodies));

  const session = new AgentSession({
    provider: "azure",
    model: "azure:intent-eval",
    baseUrl: "https://intent.eval/openai/v1/responses",
    cwd: project,
    systemPrompt: APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
    maxTurns: 5,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    selfCorrectionHooks: false,
    orchestrationPrompt: false,
    additionalTools: host.createSessionTools(),
  });
  const calledTools: string[] = [];
  session.eventBus.on("tool_call_start", ({ name }) => calledTools.push(name));
  try {
    await session.initialize();
    await session.prompt(evaluation.request);
  } finally {
    await session.dispose();
  }
  return { requestBodies, calledTools, pendingDraft: drafts.pending(project) };
}

describe("app Roadmap behavioral intent-contract evals", () => {
  for (const evaluation of appIntentEvals) {
    it(`${evaluation.name}: consumes ${JSON.stringify(evaluation.request)}`, async () => {
      const result = await runAppIntentEval(evaluation);
      expect(JSON.stringify(result.requestBodies[0]?.input)).toContain(evaluation.request);
      expect(result.requestBodies[0]?.instructions).toContain("## App Roadmap intent");
      expect(result.calledTools).toEqual(evaluation.expectedTools);
      expect(result.pendingDraft !== null).toBe(evaluation.expectsDraft);
    }, 15_000);
  }

  it("rejects a mutated request instead of replaying the original fixture", async () => {
    const original = appIntentEvals[0]!;
    const mutated = {
      ...original,
      request: "Create our roadmap for the identity migration.",
    };

    try {
      await runAppIntentEval(mutated);
      expect.unreachable("The prompt-aware mock should reject an unmatched request.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).cause).toMatchObject({
        message: 'Unmatched intent-eval request: "Create our roadmap for the identity migration."',
      });
    }
  });

  it("CLI sessions consume the request without app-only tools or intent steering", async () => {
    const { project } = await createProject();
    const request = "Create our roadmap for the billing migration.";
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return responseWithText("CLI request handled as ordinary work.");
      }),
    );
    const session = new AgentSession({
      provider: "azure",
      model: "azure:intent-eval",
      baseUrl: "https://intent.eval/openai/v1/responses",
      cwd: project,
      systemPrompt: "You are GG Coder in a CLI session.",
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
      selfCorrectionHooks: false,
      orchestrationPrompt: false,
    });
    try {
      await session.initialize();
      await session.prompt(request);
    } finally {
      await session.dispose();
    }
    expect(JSON.stringify(requestBody?.input)).toContain(request);
    expect(requestBody?.instructions).not.toContain("## App Roadmap intent");
    expect(requestBody?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "roadmap_inspect" }),
        expect.objectContaining({ name: "roadmap_phase_draft" }),
      ]),
    );
  });
});
