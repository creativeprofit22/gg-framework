import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamEvent, StreamResponse } from "../types.js";
import { streamAzureOpenAIResponses } from "./azure-openai-responses.js";
import {
  parseEncryptedReasoningPart,
  parseResponsesSse,
  serializeEncryptedReasoningItem,
  serializeResponsesInput,
  serializeResponsesToolChoice,
  serializeResponsesTools,
} from "./openai-responses-core.js";

function rawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectStream(stream: {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  response: Promise<StreamResponse>;
}): Promise<string> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return JSON.stringify({ events, response: await stream.response });
}

describe("provider-neutral Responses parsing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the default skip policy and Azure strict policy for malformed frames", async () => {
    const wire =
      'data: {"type":"response.output_text.delta","delta":"one"}\n\n' +
      "data: not-json\n\n" +
      'data: {"type":"response.completed","response":{}}\n\n' +
      "data: [DONE]\n\n";

    const skipEvents = [];
    for await (const event of parseResponsesSse(rawSseResponse(wire).body!)) {
      skipEvents.push(event);
    }
    expect(JSON.stringify(skipEvents)).toBe(
      '[{"type":"response.output_text.delta","delta":"one"},{"type":"response.completed","response":{}}]',
    );

    let azureDiagnostic: unknown;
    const azureEvents = async () => {
      for await (const _event of parseResponsesSse(rawSseResponse(wire).body!, {
        onMalformedJson(diagnostic): never {
          azureDiagnostic = diagnostic;
          throw new Error("stop parsing");
        },
      })) {
        // Consume through the malformed frame.
      }
    };
    await expect(azureEvents()).rejects.toThrow("stop parsing");
    expect(azureDiagnostic).toEqual({
      stage: "json_parse",
      causeKind: "syntax_error",
    });
    expect(JSON.stringify(azureDiagnostic)).not.toContain("not-json");
  });

  it("serializes provider-neutral system, user, assistant, tool-call, and tool-result input", () => {
    const serialized = serializeResponsesInput([
      { role: "system", content: "Be concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this." },
          { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
        ],
      },
      { role: "assistant", content: "First answer." },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "private" },
          { type: "text", text: "Then call." },
          {
            type: "tool_call",
            id: "call_1",
            itemId: "fc_1",
            name: "read",
            args: { path: "a.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call_1", content: "contents" }],
      },
    ]);

    expect(JSON.stringify(serialized)).toBe(
      '{"system":"Be concise.","input":[{"role":"user","content":[{"type":"input_text","text":"Inspect this."},{"type":"input_image","detail":"auto","image_url":"data:image/png;base64,aW1hZ2U="}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"First answer.","annotations":[]}],"status":"completed"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Then call.","annotations":[]}],"status":"completed"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"},{"type":"function_call_output","call_id":"call_1","output":"contents"}]}',
    );
  });

  it("validates standard tool choices and encrypted reasoning replay items", () => {
    const tools = [{ name: "read", description: "Read", parameters: z.object({}) }];
    expect(
      serializeResponsesToolChoice({ name: "read" }, tools, {
        transportName: "Azure OpenAI",
        supportsNamedTool: true,
      }),
    ).toEqual({ type: "function", name: "read" });
    expect(() =>
      serializeResponsesToolChoice("required", undefined, {
        transportName: "Azure OpenAI",
        supportsNamedTool: true,
      }),
    ).toThrow("Azure OpenAI cannot require a tool call when no tools are configured.");

    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
      summary: [{ type: "summary_text", text: "summary" }],
    };
    expect(serializeEncryptedReasoningItem(reasoning)).toBe(reasoning);
    expect(parseEncryptedReasoningPart(reasoning)).toEqual({ type: "raw", data: reasoning });
    expect(serializeEncryptedReasoningItem({ ...reasoning, encrypted_content: 1 })).toBeUndefined();
  });

  it("drops another transport's origin-stamped reasoning after a model switch", () => {
    const own = { type: "reasoning", id: "rs_own", encrypted_content: "own", summary: [] };
    const grok = { type: "reasoning", id: "rs_grok", encrypted_content: "xai", summary: [] };
    const serialized = serializeResponsesInput(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "raw", data: grok, origin: "xai:grok-4.7" },
            { type: "raw", data: own },
            { type: "text", text: "done" },
          ],
        },
      ],
      { serializeRawAssistantPart: serializeEncryptedReasoningItem },
    );
    // Azure uses this serializer; Grok's encrypted reasoning would
    // be rejected there, while their own unstamped items still replay.
    expect(serialized.input).toContainEqual(own);
    expect(serialized.input).not.toContainEqual(grok);
  });

  it("serializes Zod tool declarations with explicit transport strictness", () => {
    const tools = serializeResponsesTools(
      [
        {
          name: "read",
          description: "Read a file",
          parameters: z.object({ path: z.string() }),
        },
      ],
      { strict: null },
    );

    expect(tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        // Upstream trims the blanket `additionalProperties: false` from
        // non-strict schemas; Zod still rejects unknown args at parse time.
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: null,
      },
    ]);
  });

  it("restores closed objects when the transport requests strict tools", () => {
    const [tool] = serializeResponsesTools(
      [
        {
          name: "read",
          description: "Read a file",
          parameters: z.object({ path: z.string() }),
        },
      ],
      { strict: true },
    );

    expect(tool).toMatchObject({ strict: true, parameters: { additionalProperties: false } });
  });

  it("characterizes Azure request and result bytes at the shared seam", async () => {
    let azureRequestBody = "";
    const azureFetch = vi.fn<typeof fetch>(async (_url, init) => {
      azureRequestBody = String(init?.body);
      return rawSseResponse(
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n',
      );
    });
    const azure = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [{ role: "user", content: "Say hello." }],
      apiKey: "test-key",
      baseUrl: "https://example.openai.azure.com/openai/v1/responses",
      fetch: azureFetch,
    });
    const azureTranscript = await collectStream(azure);

    expect(azureRequestBody).toBe(
      '{"model":"test-deployment","input":[{"role":"user","content":[{"type":"input_text","text":"Say hello."}]}],"stream":true,"store":false}',
    );
    expect(azureTranscript).toBe(
      '{"events":[{"type":"text_delta","text":"Hello"},{"type":"done","stopReason":"end_turn"}],"response":{"message":{"role":"assistant","content":"Hello"},"stopReason":"end_turn","usage":{"inputTokens":7,"outputTokens":2}}}',
    );
  });

  it("retains the Azure-strict terminal policy", async () => {
    const azure = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [{ role: "user", content: "Hi" }],
      apiKey: "test-key",
      baseUrl: "https://example.openai.azure.com/openai/v1/responses",
      fetch: vi.fn(async () =>
        rawSseResponse('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
      ),
    });

    await expect(azure.response).rejects.toMatchObject({
      message: "Azure OpenAI response stream ended before response.completed.",
    });
  });
});
