import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../stream.js";
import type { StreamOptions, ThinkingLevel } from "../types.js";
import {
  QWEN_CLOUD_MODEL_CAPABILITIES as models,
  QWEN_CLOUD_TOKEN_PLAN_ENDPOINT as endpoint,
  normalizeQwenCloudThinking,
} from "../qwen-cloud-policy.js";

const key = "sk-sp-fake-isolatedSecretToken";
const options: StreamOptions = {
  provider: "qwen-cloud",
  model: models[0]!.id,
  apiKey: key,
  messages: [{ role: "user", content: "Hello" }],
};
function sse(
  frames: unknown[] = [{ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }],
) {
  return new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
function mock(response: () => Response = () => sse()) {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("synthesizes the same reasoning, text, tools and usage from JSON and replays reasoning separately", async () => {
  const message = {
    role: "assistant",
    reasoning_content: "private reasoning",
    content: "answer",
    tool_calls: [
      { id: "call", type: "function", function: { name: "read", arguments: '{"p":"a"}' } },
    ],
  };
  const usage = {
    prompt_tokens: 20,
    completion_tokens: 8,
    prompt_tokens_details: { cached_tokens: 5 },
  };
  const fetch = mock(() =>
    Response.json({ choices: [{ message, finish_reason: "tool_calls" }], usage }),
  );
  const result = stream({ ...options, model: "qwen-cloud/glm-5.3", streaming: false });
  const events = [];
  for await (const event of result) events.push(event);
  const response = await result;
  expect(events).toEqual([
    { type: "thinking_delta", text: "private reasoning" },
    { type: "text_delta", text: "answer" },
    { type: "toolcall_delta", id: "call", name: "read", argsJson: '{"p":"a"}' },
    { type: "toolcall_done", id: "call", name: "read", args: { p: "a" } },
    { type: "done", stopReason: "tool_use" },
  ]);
  expect(response).toEqual({
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "private reasoning" },
        { type: "text", text: "answer" },
        { type: "tool_call", id: "call", name: "read", args: { p: "a" } },
      ],
    },
    stopReason: "tool_use",
    usage: { inputTokens: 15, outputTokens: 8, cacheRead: 5, cacheWrite: 0 },
  });
  await stream({
    ...options,
    streaming: false,
    messages: [
      ...options.messages,
      response.message,
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call", content: "result" }] },
    ],
  });
  const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
  expect(url).toBe(endpoint);
  const body = JSON.parse(init.body as string);
  expect(body.stream).toBe(false);
  expect(body).not.toHaveProperty("stream_options");
  expect(body.messages[1]).toMatchObject(message);
  mock(() =>
    sse([
      {
        choices: [
          {
            delta: {
              ...message,
              tool_calls: message.tool_calls.map((tc) => ({ ...tc, index: 0 })),
            },
            finish_reason: "tool_calls",
          },
        ],
        usage,
      },
    ]),
  );
  expect(await stream(options)).toEqual(response);
});

it.each([
  {},
  { choices: [] },
  { choices: [{ message: {}, finish_reason: null }] },
  { error: { message: "isolatedSecretToken" } },
])("rejects incomplete JSON without leaking the response: %j", async (body) => {
  const fetch = mock(() => Response.json(body));
  await expect(stream({ ...options, streaming: false })).rejects.toThrow(
    "Qwen Cloud returned an invalid response.",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.each([true, false])("Qwen Token Plan real SDK boundary (streaming=%s)", (streaming) => {
  const options: StreamOptions = {
    provider: "qwen-cloud",
    model: models[0]!.id,
    apiKey: key,
    messages: [{ role: "user", content: "Hello" }],
    streaming,
  };
  const mock = (response?: () => Response) => {
    const fetch = vi.fn(async () =>
      response
        ? response()
        : streaming
          ? sse()
          : Response.json({
              choices: [
                { message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
              ],
            }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  it.each([
    [{ temperature: 0 }, { temperature: 0 }],
    [{ temperature: 1.99 }, { temperature: 1.99 }],
    [{ topP: 0.8 }, { top_p: 0.8 }],
    [{ topP: 1 }, { top_p: 1 }],
    [{ stop: ["END", "\nUser:"] }, { stop: ["END", "\nUser:"] }],
    [{ temperature: 0, stop: ["END"] }, { temperature: 0, stop: ["END"] }],
    [{}, {}],
  ])("forwards supplied sampling/stopping options only: %j", async (supplied, expected) => {
    const fetch = mock();
    await stream({ ...options, ...supplied });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint);
    const body = JSON.parse(init.body as string);
    for (const field of ["temperature", "top_p", "stop"] as const) {
      if (field in expected) expect(body[field]).toEqual(expected[field as keyof typeof expected]);
      else expect(body).not.toHaveProperty(field);
    }
    expect(body).not.toHaveProperty("topP");
  });

  it("leaves nullish sampling/stopping options omitted", async () => {
    const fetch = mock();
    await stream({ ...options, temperature: null, topP: null, stop: null } as unknown as StreamOptions);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    for (const field of ["temperature", "top_p", "stop"]) expect(body).not.toHaveProperty(field);
  });

  it.each([
    { temperature: -0.1 },
    { temperature: 2 },
    { temperature: NaN },
    { temperature: Infinity },
    { temperature: "isolatedSecretToken" },
    { topP: 0 },
    { topP: -0.1 },
    { topP: 1.01 },
    { topP: NaN },
    { topP: Infinity },
    { topP: "isolatedSecretToken" },
    { temperature: 0, topP: 0.8 },
    { stop: ["isolatedSecretToken", 123] },
    { stop: { secret: "isolatedSecretToken" } },
    { stop: "isolatedSecretToken" },
    { thinking: "low", temperature: 0 },
    { thinking: "xhigh", temperature: 0.59 },
  ])("rejects invalid sampling/stopping locally with a fixed error: %j", async (supplied) => {
    const fetch = mock();
    await expect(stream({ ...options, ...supplied } as StreamOptions)).rejects.toMatchObject({
      message: "Qwen Cloud sampling or stop configuration is not allowed.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves allowed sampling and stop options across the model/thinking matrix", async () => {
    for (const model of models) {
      for (const thinking of [undefined, "high"] as const) {
        for (const sampling of [{ temperature: 0.6 }, { topP: 0.9 }]) {
          const fetch = mock();
          await stream({ ...options, model: model.id, thinking, ...sampling, stop: ["END"] });
          const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
          const body = JSON.parse(init.body as string);
          expect(body.stop).toEqual(["END"]);
          if ("temperature" in sampling) {
            expect(body.temperature).toBe(0.6);
            expect(body).not.toHaveProperty("top_p");
          } else {
            expect(body.top_p).toBe(0.9);
            expect(body).not.toHaveProperty("temperature");
          }
        }
      }
    }
  });

  it("resolves only dedicated runtime auth, never generic auth or OpenAI endpoint settings", async () => {
    const fetch = mock();
    vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", key);
    vi.stubEnv("DASHSCOPE_API_KEY", key);
    vi.stubEnv("OPENAI_BASE_URL", "https://forbidden.example/v1");
    await expect(stream({ ...options, apiKey: undefined })).rejects.toThrow(
      "Qwen Cloud requires a valid Token Plan key.",
    );
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", key);
    await stream({ ...options, apiKey: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    });
  });

  for (const model of models) {
    it(`${model.id}: fixed route, output bound and full effort matrix`, async () => {
      for (const level of [undefined, "low", "medium", "high", "xhigh", "max", "ultra"] as (
        ThinkingLevel | undefined
      )[]) {
        const fetch = mock();
        await stream({ ...options, model: model.id, thinking: level });
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(endpoint);
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(init.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        });
        const body = JSON.parse(init.body as string);
        const normalized = normalizeQwenCloudThinking(model.id, level);
        expect(body.model).toBe(model.apiModelId);
        expect(body.stream).toBe(streaming);
        if (streaming) expect(body.stream_options).toEqual({ include_usage: true });
        else expect(body).not.toHaveProperty("stream_options");
        const isGlm = model.apiModelId.startsWith("glm-");
        expect(body[isGlm ? "max_tokens" : "max_completion_tokens"]).toBe(model.maxOutputTokens);
        expect(body).not.toHaveProperty(isGlm ? "max_completion_tokens" : "max_tokens");
        expect(body.enable_thinking).toBe(
          model.apiModelId === "glm-5.3" ? undefined : !!normalized,
        );
        expect(body.reasoning_effort).toBe(
          model.thinking.kind === "binary" ? undefined : normalized,
        );
        for (const field of [
          "thinking_budget", "preserve_thinking", "clear_thinking", "temperature", "top_p", "stop",
        ])
          expect(body).not.toHaveProperty(field);
      }
      const fetch = mock();
      for (const maxTokens of [0, -1, 1.5, NaN, Infinity, model.maxOutputTokens + 1]) {
        await expect(stream({ ...options, model: model.id, maxTokens })).rejects.toThrow(
          "output limit",
        );
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  }
  it("streams reasoning, text, fragmented tools and empty-choice cached usage; roundtrips reasoning", async () => {
    const fetch = mock(() =>
      sse([
        {
          choices: [
            {
              delta: {
                reasoning_content: "private reasoning",
                content: "answer",
                tool_calls: [
                  { index: 0, id: "call", function: { name: "read", arguments: '{"p":' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 5 },
          },
        },
      ]),
    );
    const result = stream({ ...options, streaming: true, thinking: "low" });
    const events = [];
    for await (const event of result) events.push(event);
    const response = await result;
    expect(response.usage).toMatchObject({ inputTokens: 15, outputTokens: 8, cacheRead: 5 });
    expect(events.map((e) => e.type)).toEqual([
      "thinking_delta",
      "text_delta",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_done",
      "done",
    ]);
    await stream({
      ...options,
      streaming: true,
      messages: [
        ...options.messages,
        response.message,
        { role: "tool", content: [{ type: "tool_result", toolCallId: "call", content: "result" }] },
      ],
    });
    const init = (fetch.mock.calls[1] as unknown as [string, RequestInit])[1];
    const assistant = JSON.parse(init.body as string).messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistant.reasoning_content).toBe("private reasoning");
    expect(assistant.content).toBe("answer");
    expect(assistant.tool_calls[0].function.arguments).toBe('{"p":"a"}');
  });
  for (const status of [301, 302, 303, 307, 308])
    for (const location of [
      endpoint,
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    ]) {
      it(`refuses ${status} redirect to ${location}`, async () => {
        const fetch = mock(() => new Response(key, { status, headers: { location } }));
        await expect(stream(options)).rejects.toThrow("Qwen Cloud");
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    }
  it("rejects all endpoint overrides and caller transport hooks before sending", async () => {
    const fetch = mock();
    for (const baseUrl of [
      endpoint,
      "https://tokenplan-intl.qwencloud.com/compatible-mode/v1",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "https://custom.example",
      endpoint + "?x=1",
      endpoint + "#x",
      endpoint + "/extra",
      endpoint.replace("https:", "http:"),
      endpoint.replace(".com/", ".com:444/"),
      endpoint.replace("https://", "https://u:p@"),
      endpoint.replace(".com/", ".com.evil/"),
      endpoint.replace("chat/completions", "responses"),
    ]) {
      await expect(stream({ ...options, baseUrl })).rejects.toThrow("configuration");
    }
    for (const extra of [
      { fetch },
      { defaultHeaders: {} },
      { accountId: "other" },
      { model: "glm-5.3" },
      { model: "qwen-cloud/unknown" },
    ])
      await expect(stream({ ...options, ...extra })).rejects.toThrow("configuration");
    for (const apiKey of [
      undefined,
      "sk-payg",
      "sk-sp-",
      "sk-sp-a b",
      "sk-sp-a\n",
      "sk-sp-" + "a".repeat(251),
    ])
      await expect(stream({ ...options, apiKey })).rejects.toThrow("Token Plan key");
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    await expect(stream(options)).rejects.toThrow("configuration");
    expect(fetch).not.toHaveBeenCalled();
  });
  for (const status of [400, 401, 403, 402, 429, 500])
    for (const echo of [key, "isolatedSecretToken"]) {
      it(`sanitizes ${status} full or isolated echoes without retry`, async () => {
        vi.stubEnv("OPENAI_LOG", "debug");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const fetch = mock(
          () =>
            new Response(JSON.stringify({ error: { message: echo } }), {
              status,
              headers: { "x-request-id": echo },
            }),
        );
        const error = await Promise.resolve(stream(options)).catch((e) => e);
        expect(String(error)).not.toContain(echo);
        expect(JSON.stringify(error)).not.toContain(echo);
        expect(error.cause).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
      });
    }
  it("preserves explicit structured overflow classification without retaining upstream details", async () => {
    const echo = "isolatedSecretToken";
    const fetch = mock(() => Response.json({
      error: { code: "context_length_exceeded", message: echo },
    }, { status: 400, headers: { "x-request-id": echo } }));
    const error = await Promise.resolve(stream(options)).catch((e) => e);
    expect(error.message).toBe("Qwen Cloud Token Plan prompt is too long.");
    expect(String(error)).not.toContain(echo);
    expect(JSON.stringify(error)).not.toContain(echo);
    expect(error.cause).toBeUndefined();
    expect(error.requestId).toBeUndefined();
    expect(error.headers).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [400, undefined, "request failed"],
    [400, "invalid_request_error", "request failed"],
    [400, "prefix_context_length_exceeded", "request failed"],
    [400, { code: "context_length_exceeded" }, "request failed"],
    [401, "context_length_exceeded", "authentication failed"],
    [403, "context_length_exceeded", "authentication failed"],
    [402, "context_length_exceeded", "usage limit reached"],
    [429, "context_length_exceeded", "usage limit reached"],
    [500, "context_length_exceeded", "request failed"],
    [503, "context_length_exceeded", "request failed"],
  ])("does not infer overflow from status %s or untrusted wording/code %s", async (status, code, expected) => {
    const fetch = mock(() => Response.json({
      error: { code, message: "context_length_exceeded: prompt is too long isolatedSecretToken" },
    }, { status: status as number }));
    const error = await Promise.resolve(stream(options)).catch((e) => e);
    expect(error.message).toBe(`Qwen Cloud Token Plan ${expected}.`);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("isolatedSecretToken");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sanitizes in-stream and transport errors", async () => {
    mock(() => sse([{ error: { message: "isolatedSecretToken" } }]));
    await expect(stream({ ...options, streaming: true })).rejects.toThrow(
      "Token Plan request failed",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(key);
      }),
    );
    await expect(stream(options)).rejects.toThrow("Token Plan request failed");
  });
  it("bounds the whole request and supports cancellation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error(key)), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = Promise.resolve(stream({ ...options, signal: controller.signal })).catch(
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(String(await pending)).toBe("AbortError: Aborted");
    const timeout = Promise.resolve(stream(options)).catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(String(await timeout)).toContain("cancelled or timed out");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
