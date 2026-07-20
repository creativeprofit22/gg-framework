import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamResponse } from "../types.js";
import { streamAzureOpenAIResponses } from "./azure-openai-responses.js";
import { streamOpenAICodex } from "./openai-codex.js";
import { parseResponsesSse } from "./openai-responses-core.js";

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

  it("preserves the Codex skip policy and Azure strict policy for malformed frames", async () => {
    const wire =
      'data: {"type":"response.output_text.delta","delta":"one"}\n\n' +
      "data: not-json\n\n" +
      'data: {"type":"response.completed","response":{}}\n\n' +
      "data: [DONE]\n\n";

    const codexEvents = [];
    for await (const event of parseResponsesSse(rawSseResponse(wire).body!)) {
      codexEvents.push(event);
    }
    expect(JSON.stringify(codexEvents)).toBe(
      '[{"type":"response.output_text.delta","delta":"one"},{"type":"response.completed","response":{}}]',
    );

    const azureEvents = async () => {
      for await (const _event of parseResponsesSse(rawSseResponse(wire).body!, {
        onMalformedJson(cause): never {
          throw cause;
        },
      })) {
        // Consume through the malformed frame.
      }
    };
    await expect(azureEvents()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("keeps Codex and Azure request and result bytes unchanged at the extraction seam", async () => {
    let codexRequestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        codexRequestBody = String(init?.body);
        return rawSseResponse(
          'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message"}}\n\n' +
            'data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"Hello"}\n\n' +
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n',
        );
      }),
    );

    const codex = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Say hello." }],
      apiKey: "test-token",
    });
    const codexTranscript = await collectStream(codex);

    expect(codexRequestBody).toBe(
      '{"model":"gpt-5.5","store":false,"stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"Say hello."}]}],"tool_choice":"auto","parallel_tool_calls":true,"include":["reasoning.encrypted_content"],"prompt_cache_key":"ggcoder","reasoning":{"effort":"none","summary":"auto"}}',
    );
    expect(codexTranscript).toBe(
      '{"events":[{"type":"text_delta","text":"Hello"},{"type":"done","stopReason":"end_turn"}],"response":{"message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"stopReason":"end_turn","usage":{"inputTokens":7,"outputTokens":2}}}',
    );

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
      '{"model":"test-deployment","input":[{"role":"user","content":"Say hello."}],"stream":true}',
    );
    expect(azureTranscript).toBe(
      '{"events":[{"type":"text_delta","text":"Hello"},{"type":"done","stopReason":"end_turn"}],"response":{"message":{"role":"assistant","content":"Hello"},"stopReason":"end_turn","usage":{"inputTokens":7,"outputTokens":2}}}',
    );
  });

  it("retains the existing Codex-compatible and Azure-strict terminal policies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        rawSseResponse(
          'data: {"type":"response.done","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        ),
      ),
    );
    const codex = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
      apiKey: "test-token",
    });

    expect(await collectStream(codex)).toBe(
      '{"events":[{"type":"done","stopReason":"end_turn"}],"response":{"message":{"role":"assistant","content":""},"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":1}}}',
    );

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
