import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";
import { streamAzureOpenAIResponses } from "./azure-openai-responses.js";

const RESPONSES_URL =
  "https://example-resource.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview";
const TEST_CREDENTIAL = "test-key";

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("streamAzureOpenAIResponses", () => {
  it("streams text with the Azure wire contract and sanitizes non-2xx errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([
          { type: "response.output_text.delta", delta: "Hello" },
          { type: "response.output_text.delta", delta: " Azure" },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 7, output_tokens: 2 } },
          },
        ]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "<b>Deployment unavailable</b> test-key" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      );

    const success = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Say hello." },
        { role: "assistant", content: "Hello before." },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "Do not send this." },
            { type: "text", text: "Only send this." },
          ],
        },
      ],
      apiKey: TEST_CREDENTIAL,
      baseUrl: RESPONSES_URL,
      fetch: fetchMock,
    });
    const events = [];
    for await (const event of success) events.push(event);

    await expect(success.response).resolves.toEqual({
      message: { role: "assistant", content: "Hello Azure" },
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " Azure" },
      { type: "done", stopReason: "end_turn" },
    ]);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe(RESPONSES_URL);
    expect(requestInit).toEqual({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": "test-key",
      },
      body: JSON.stringify({
        model: "test-deployment",
        input: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Say hello." },
          { role: "assistant", content: "Hello before." },
          { role: "assistant", content: "Only send this." },
        ],
        stream: true,
      }),
      signal: undefined,
    });
    expect(String(requestUrl)).not.toContain("test-key");
    expect(String(requestInit?.body)).not.toContain("test-key");

    const failure = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [{ role: "user", content: "Try again." }],
      apiKey: "test-key",
      baseUrl: RESPONSES_URL,
      fetch: fetchMock,
    });

    const error = await failure.response.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "azure",
      statusCode: 429,
      message: "Deployment unavailable [REDACTED]",
    });
    expect(String(error)).not.toContain("test-key");
    expect(String(error)).not.toContain("<b>");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "error",
      event: {
        type: "error",
        error: {
          type: "too_many_requests",
          message: "<b>Capacity unavailable</b> test-key",
        },
      },
      message: "Capacity unavailable [REDACTED]",
      statusCode: 429,
    },
    {
      name: "response.failed",
      event: {
        type: "response.failed",
        response: {
          error: { code: "server_error", message: "<i>Generation failed</i> test-key" },
        },
      },
      message: "Generation failed [REDACTED]",
      statusCode: 500,
    },
    {
      name: "response.incomplete",
      event: {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "<b>max_output_tokens</b> test-key" } },
      },
      message: "Azure OpenAI response was incomplete: max_output_tokens [REDACTED].",
      statusCode: undefined,
    },
  ])("turns streamed $name into a sanitized ProviderError", async (testCase) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(sseResponse([testCase.event]));
    const stream = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [{ role: "user", content: "Test streaming failure." }],
      apiKey: TEST_CREDENTIAL,
      baseUrl: RESPONSES_URL,
      fetch: fetchMock,
    });

    const error = await stream.response.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "azure",
      message: testCase.message,
      statusCode: testCase.statusCode,
    });
    expect(String(error)).not.toContain("test-key");
    expect(String(error)).not.toMatch(/<[^>]+>/);
  });

  it.each([
    ["malformed URL", "not-a-url-secret-value"],
    [
      "v1 base URL",
      "https://example-resource.openai.azure.com/openai/v1?api-version=secret-value",
    ],
    [
      "non-HTTPS URL",
      "http://example-resource.openai.azure.com/openai/v1/responses?api-version=secret-value",
    ],
    [
      "embedded credentials",
      "https://user:secret-value@example-resource.openai.azure.com/openai/v1/responses",
    ],
    [
      "fragment",
      "https://example-resource.openai.azure.com/openai/v1/responses#secret-value",
    ],
    [
      "trailing slash",
      "https://example-resource.openai.azure.com/openai/v1/responses/?api-version=secret-value",
    ],
  ])("rejects a $name before fetch without exposing its value", async (_name, baseUrl) => {
    const fetchMock = vi.fn<typeof fetch>();
    const invalidStream = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [{ role: "user", content: "Test invalid endpoint." }],
      apiKey: TEST_CREDENTIAL,
      baseUrl,
      fetch: fetchMock,
    });

    const error = await invalidStream.response.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "azure",
      message:
        "Azure OpenAI baseUrl must be a full HTTPS URL ending in /responses, without credentials or a fragment.",
    });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("secret-value");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
