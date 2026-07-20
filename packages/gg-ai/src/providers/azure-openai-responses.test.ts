import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

function toolCallStream(events: Record<string, unknown>[]) {
  return streamAzureOpenAIResponses({
    provider: "azure",
    model: "test-deployment",
    messages: [{ role: "user", content: "Use tools." }],
    apiKey: TEST_CREDENTIAL,
    baseUrl: RESPONSES_URL,
    fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(sseResponse(events)),
  });
}

function addedToolCall(
  outputIndex: number,
  itemId: string | undefined,
  callId: string,
  name: string,
): Record<string, unknown> {
  return {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: {
      type: "function_call",
      ...(itemId ? { id: itemId } : {}),
      call_id: callId,
      name,
    },
  };
}

function completedToolCall(
  outputIndex: number,
  itemId: string | undefined,
  callId: string,
  name: string,
  argsJson: string,
): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: {
      type: "function_call",
      ...(itemId ? { id: itemId } : {}),
      call_id: callId,
      name,
      arguments: argsJson,
    },
  };
}

const COMPLETED_RESPONSE = {
  type: "response.completed",
  response: { usage: { input_tokens: 8, output_tokens: 3 } },
};

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
          {
            role: "user",
            content: [{ type: "input_text", text: "Say hello." }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello before.", annotations: [] }],
            status: "completed",
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Only send this.", annotations: [] }],
            status: "completed",
          },
        ],
        stream: true,
        store: false,
        instructions: "Be concise.",
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

  it("sends standard request controls, tool-result images, and replays encrypted reasoning", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rs_2" },
        },
        { type: "response.reasoning_summary_text.delta", delta: "Considering tools" },
        { type: "response.reasoning_text.delta", delta: " carefully" },
        { type: "response.reasoning_summary.delta", delta: " undocumented-summary" },
        { type: "response.reasoning.delta", delta: " undocumented-reasoning" },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_2",
            encrypted_content: "encrypted-new",
            summary: [{ type: "summary_text", text: "Considering tools" }],
          },
        },
        addedToolCall(1, "fc_2", "call_2", "inspect"),
        {
          type: "response.function_call_arguments.done",
          output_index: 1,
          item_id: "fc_2",
          arguments: '{"path":"image.png"}',
        },
        completedToolCall(1, "fc_2", "call_2", "inspect", '{"path":"image.png"}'),
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 30,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 10, cache_write_tokens: 4 },
            },
          },
        },
      ]);
    });
    const stream = streamAzureOpenAIResponses({
      provider: "azure",
      model: "gpt-5.6-sol",
      messages: [
        { role: "user", content: "Inspect the image." },
        {
          role: "assistant",
          content: [
            {
              type: "raw",
              data: {
                type: "reasoning",
                id: "rs_1",
                encrypted_content: "encrypted-old",
                summary: [],
              },
            },
            { type: "tool_call", id: "call_1", itemId: "fc_1", name: "inspect", args: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "call_1",
              content: [{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" }],
            },
          ],
        },
      ],
      tools: [
        {
          name: "inspect",
          description: "Inspect a file",
          parameters: z.object({ path: z.string() }),
        },
      ],
      toolChoice: { name: "inspect" },
      maxTokens: 4096,
      thinking: "ultra",
      promptCacheKey: "parent:subagent",
      supportsImages: true,
      apiKey: TEST_CREDENTIAL,
      baseUrl: RESPONSES_URL,
      fetch: fetchMock,
    });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(requestBody).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      max_output_tokens: 4096,
      prompt_cache_key: "parent:subagent",
      tool_choice: { type: "function", name: "inspect" },
      parallel_tool_calls: true,
      reasoning: { effort: "xhigh", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
    expect(JSON.stringify(requestBody?.input)).toContain("encrypted-old");
    expect(JSON.stringify(requestBody?.input)).toContain("data:image/png;base64,aW1hZ2U=");
    await expect(stream.response).resolves.toEqual({
      message: {
        role: "assistant",
        content: [
          {
            type: "raw",
            data: {
              type: "reasoning",
              id: "rs_2",
              encrypted_content: "encrypted-new",
              summary: [{ type: "summary_text", text: "Considering tools" }],
            },
          },
          {
            type: "tool_call",
            id: "call_2",
            itemId: "fc_2",
            name: "inspect",
            args: { path: "image.png" },
          },
        ],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 5, cacheRead: 10 },
    });
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "" },
      { type: "thinking_delta", text: "Considering tools" },
      { type: "thinking_delta", text: " carefully" },
    ]);
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "toolcall_done", id: "call_2" })]),
    );
  });

  it("rejects malformed encrypted reasoning items", async () => {
    const stream = streamAzureOpenAIResponses({
      provider: "azure",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Think." }],
      thinking: "high",
      apiKey: TEST_CREDENTIAL,
      baseUrl: RESPONSES_URL,
      fetch: vi.fn(async () =>
        sseResponse([
          {
            type: "response.output_item.done",
            item: { type: "reasoning", id: "rs_bad", encrypted_content: 123 },
          },
        ]),
      ),
    });

    await expect(stream.response).rejects.toMatchObject({
      provider: "azure",
      message: "Azure OpenAI returned a malformed response stream.",
    });
  });

  it("forwards cancellation to fetch without replaying the request", async () => {
    const controller = new AbortController();
    const abortCause = new DOMException("Cancelled", "AbortError");
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw abortCause;
    });
    const stream = streamAzureOpenAIResponses({
      provider: "azure",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Cancel." }],
      apiKey: TEST_CREDENTIAL,
      baseUrl: RESPONSES_URL,
      signal: controller.signal,
      fetch: fetchMock,
    });

    const error = await stream.response.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("correlates parallel calls by output_index and accepts equivalent final JSON", async () => {
    const stream = toolCallStream([
      addedToolCall(0, "fc_weather", "call/public:weather-1", "weather"),
      addedToolCall(1, "fc_time", "call.public.time+2", "time"),
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_weather",
        delta: '{"city":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_time",
        delta: '{"zone":"UTC"}',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_weather",
        delta: '"Seattle","units":"celsius"}',
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        item_id: "fc_time",
        arguments: '{"zone":"UTC"}',
      },
      completedToolCall(1, "fc_time", "call.public.time+2", "time", '{ "zone": "UTC" }'),
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc_weather",
        arguments: '{"city":"Seattle","units":"celsius"}',
      },
      completedToolCall(
        0,
        "fc_weather",
        "call/public:weather-1",
        "weather",
        '{"units":"celsius","city":"Seattle"}',
      ),
      COMPLETED_RESPONSE,
    ]);
    const events = [];
    for await (const event of stream) events.push(event);

    await expect(stream.response).resolves.toEqual({
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call/public:weather-1",
            itemId: "fc_weather",
            name: "weather",
            args: { units: "celsius", city: "Seattle" },
          },
          {
            type: "tool_call",
            id: "call.public.time+2",
            itemId: "fc_time",
            name: "time",
            args: { zone: "UTC" },
          },
        ],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 8, outputTokens: 3 },
    });
    expect(events).toEqual([
      {
        type: "toolcall_delta",
        id: "call/public:weather-1",
        name: "weather",
        argsJson: '{"city":',
      },
      {
        type: "toolcall_delta",
        id: "call.public.time+2",
        name: "time",
        argsJson: '{"zone":"UTC"}',
      },
      {
        type: "toolcall_delta",
        id: "call/public:weather-1",
        name: "weather",
        argsJson: '"Seattle","units":"celsius"}',
      },
      {
        type: "toolcall_done",
        id: "call.public.time+2",
        itemId: "fc_time",
        name: "time",
        args: { zone: "UTC" },
      },
      {
        type: "toolcall_done",
        id: "call/public:weather-1",
        itemId: "fc_weather",
        name: "weather",
        args: { units: "celsius", city: "Seattle" },
      },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  it("accepts function-call events without the optional item id", async () => {
    const stream = toolCallStream([
      addedToolCall(0, undefined, "call_1", "weather"),
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" },
      completedToolCall(0, undefined, "call_1", "weather", "{}"),
      COMPLETED_RESPONSE,
    ]);

    await expect(stream.response).resolves.toMatchObject({
      message: {
        content: [{ type: "tool_call", id: "call_1", name: "weather", args: {} }],
      },
      stopReason: "tool_use",
    });
  });

  it.each([
    {
      name: "duplicate output_item.added event",
      events: [
        addedToolCall(0, "fc_1", "call_1", "weather"),
        addedToolCall(0, "fc_1", "call_1", "weather"),
      ],
    },
    {
      name: "duplicate call_id",
      events: [
        addedToolCall(0, "fc_1", "call_1", "weather"),
        addedToolCall(1, "fc_2", "call_1", "time"),
      ],
    },
    {
      name: "duplicate arguments.done event",
      events: [
        addedToolCall(0, "fc_1", "call_1", "weather"),
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc_1",
          arguments: "{}",
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc_1",
          arguments: "{}",
        },
      ],
    },
    {
      name: "duplicate output_item.done event",
      events: [
        addedToolCall(0, "fc_1", "call_1", "weather"),
        completedToolCall(0, "fc_1", "call_1", "weather", "{}"),
        completedToolCall(0, "fc_1", "call_1", "weather", "{}"),
      ],
    },
  ])("rejects a $name", async ({ events }) => {
    const error = await toolCallStream(events).response.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "azure",
      message: "Azure OpenAI returned a malformed tool-call stream.",
    });
    expect((error as Error).cause).toBeUndefined();
  });

  it.each(["{", "[]", '"secret argument text"'])(
    "rejects malformed completed arguments without exposing them: %s",
    async (argumentsJson) => {
      const error = await toolCallStream([
        addedToolCall(0, "fc_1", "call_1", "weather"),
        completedToolCall(0, "fc_1", "call_1", "weather", argumentsJson),
      ]).response.catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        provider: "azure",
        message: "Azure OpenAI returned a malformed tool-call stream.",
      });
      expect(String(error)).not.toContain(argumentsJson);
      expect((error as Error).cause).toBeUndefined();
    },
  );

  it.each([
    {
      name: "call_id on output_item.added",
      events: [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "fc_1", name: "weather" },
        },
      ],
    },
    {
      name: "name on output_item.added",
      events: [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "fc_1", call_id: "call_1" },
        },
      ],
    },
    {
      name: "call_id on output_item.done",
      events: [
        addedToolCall(0, "fc_1", "call_1", "weather"),
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", id: "fc_1", name: "weather", arguments: "{}" },
        },
      ],
    },
    {
      name: "name on output_item.done",
      events: [
        addedToolCall(0, "fc_1", "call_1", "weather"),
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", id: "fc_1", call_id: "call_1", arguments: "{}" },
        },
      ],
    },
  ])("rejects a function call missing $name", async ({ events }) => {
    const error = await toolCallStream(events).response.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "azure",
      message: "Azure OpenAI returned a malformed tool-call stream.",
    });
  });

  it("rejects response completion while a tool call is incomplete", async () => {
    const error = await toolCallStream([
      addedToolCall(0, "fc_1", "call_1", "weather"),
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_1",
        delta: '{"city":"Seattle"}',
      },
      COMPLETED_RESPONSE,
    ]).response.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "azure",
      message: "Azure OpenAI tool-call stream ended before all calls completed.",
    });
  });

  it("rejects stream termination before response completion after a completed tool call", async () => {
    const error = await toolCallStream([
      addedToolCall(0, "fc_1", "call_1", "weather"),
      completedToolCall(0, "fc_1", "call_1", "weather", '{"city":"Seattle"}'),
    ]).response.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "azure",
      message: "Azure OpenAI response stream ended before response.completed.",
    });
  });

  it.each([
    ["malformed URL", "not-a-url-secret-value"],
    ["v1 base URL", "https://example-resource.openai.azure.com/openai/v1?api-version=secret-value"],
    [
      "non-HTTPS URL",
      "http://example-resource.openai.azure.com/openai/v1/responses?api-version=secret-value",
    ],
    [
      "embedded credentials",
      "https://user:secret-value@example-resource.openai.azure.com/openai/v1/responses",
    ],
    ["fragment", "https://example-resource.openai.azure.com/openai/v1/responses#secret-value"],
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
