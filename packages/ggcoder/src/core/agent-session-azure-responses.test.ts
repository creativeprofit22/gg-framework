import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RESPONSES_URL = "https://example.openai.azure.com/openai/v1/responses";

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalAzureApiKey: string | undefined;
let originalAzureBaseUrl: string | undefined;
let originalAzureDeployment: string | undefined;
let home: string;
let project: string;

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
  originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
  originalAzureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-agent-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-agent-project-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_BASE_URL = RESPONSES_URL;
  process.env.AZURE_OPENAI_DEPLOYMENT = "test-deployment";
  await writeJson(path.join(home, ".gg", "settings.json"), {
    autoCompact: false,
    idealReviewEnabled: false,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalAzureApiKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
  else process.env.AZURE_OPENAI_API_KEY = originalAzureApiKey;
  if (originalAzureBaseUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
  else process.env.AZURE_OPENAI_BASE_URL = originalAzureBaseUrl;
  if (originalAzureDeployment === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT;
  else process.env.AZURE_OPENAI_DEPLOYMENT = originalAzureDeployment;
  await Promise.all([
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(project, { recursive: true, force: true }),
  ]);
});

describe("AgentSession Azure Responses tool round trip", () => {
  it("declares, executes, submits, and follows an Azure function call with final text", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_1",
            delta: '{"path":',
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_1",
            delta: '"."}',
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: "fc_1",
            arguments: '{"path":"."}',
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "ls",
              arguments: '{"path":"."}',
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 3 } },
          },
        ]);
      }
      return sseResponse([
        { type: "response.output_text.delta", delta: "Azure tool complete." },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 14, output_tokens: 4 } },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "azure",
      model: "test-deployment",
      baseUrl: RESPONSES_URL,
      cwd: project,
      systemPrompt: "Use tools when requested.",
      maxTurns: 3,
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
    });
    const text: string[] = [];
    const toolResults: string[] = [];
    session.eventBus.on("text_delta", ({ text: delta }) => text.push(delta));
    session.eventBus.on("tool_call_end", ({ result }) => toolResults.push(result));

    try {
      await session.initialize();
      await session.prompt("List this project, then confirm completion.");
    } finally {
      await session.dispose();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "function", name: "ls" })]),
    );
    expect(JSON.stringify(requestBodies[0]?.input)).toContain("List this project");
    expect(toolResults).toHaveLength(1);

    const secondInput = requestBodies[1]?.input as Record<string, unknown>[];
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          id: "call_1",
          call_id: "call_1",
          name: "ls",
          arguments: '{"path":"."}',
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
          output: toolResults[0],
        }),
      ]),
    );
    expect(text.join("")).toBe("Azure tool complete.");
  });
});
