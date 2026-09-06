import { describe, expect, it } from "vitest";
import { stream } from "./stream.js";
import type { Message, StreamOptions, ThinkingLevel } from "./types.js";

/** Capture real SDK serialization without credentials or outbound requests. */
async function captureRequest(options: Omit<StreamOptions, "apiKey" | "fetch">) {
  let body: Record<string, unknown> | undefined;
  const result = stream({
    ...options,
    apiKey: "offline-test-key",
    streaming: false,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "alignment-test",
          object: "chat.completion",
          created: 0,
          model: options.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  for await (const _event of result) {
    /* Drain the actual provider path. */
  }
  await result.response;
  expect(body).toBeDefined();
  return body!;
}

const messages: Message[] = [{ role: "user", content: "hello" }];

describe("model settings on the wire", () => {
  it.each([
    { provider: "glm" as const, model: "glm-5.3" },
    { provider: "moonshot" as const, model: "kimi-k3" },
    { provider: "moonshot" as const, model: "kimi-k3", baseUrl: "https://api.kimi.com/coding/v1" },
  ])("sends the documented output cap to $provider at $baseUrl", async (route) => {
    const body = await captureRequest({ ...route, messages, maxTokens: 1234 });
    expect(body.max_tokens).toBe(1234);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it.each(["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"])(
    "disables DeepSeek thinking explicitly and sends its documented output cap: %s",
    async (model) => {
      const body = await captureRequest({ provider: "deepseek", model, messages, maxTokens: 1234 });
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.max_tokens).toBe(1234);
      expect(body).not.toHaveProperty("max_completion_tokens");
      expect(body).not.toHaveProperty("reasoning_effort");
    },
  );

  it.each<[ThinkingLevel, string]>([
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
    ["ultra", "max"],
  ])("maps DeepSeek %s to %s (including saved legacy levels)", async (thinking, effort) => {
    const body = await captureRequest({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages,
      thinking,
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe(effort);
  });

  it("round-trips DeepSeek reasoning on assistant tool calls", async () => {
    const body = await captureRequest({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinking: "max",
      messages: [
        ...messages,
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "inspect the file" },
            { type: "tool_call", id: "call_1", name: "read", args: { file_path: "test.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call_1", content: "file contents" }],
        },
      ],
    });
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", reasoning_content: "inspect the file" }),
      ]),
    );
  });

  it.each(["max", "ultra"] as const)("preserves Fugu Ultra max for %s", async (thinking) => {
    const body = await captureRequest({
      provider: "sakana",
      model: "fugu-ultra",
      messages,
      thinking,
    });
    expect(body.reasoning_effort).toBe("max");
  });

  it("keeps plain Fugu at xhigh for saved max settings", async () => {
    const body = await captureRequest({
      provider: "sakana",
      model: "fugu",
      messages,
      thinking: "max",
    });
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it.each([false, true])("sends Qwen inline images/video from tools=%s", async (toolResult) => {
    const media = [
      { type: "image" as const, mediaType: "image/png" as const, data: "aW1hZ2U=" },
      {
        type: "video" as const,
        mediaType: "video/mp4" as const,
        data: "dmlkZW8=",
        fileId: "old-moonshot-file",
      },
    ];
    const body = await captureRequest({
      provider: "openrouter",
      model: "qwen/qwen3.6-plus",
      supportsImages: true,
      supportsVideo: true,
      messages: toolResult
        ? [
            ...messages,
            {
              role: "assistant",
              content: [{ type: "tool_call", id: "call_1", name: "read", args: {} }],
            },
            {
              role: "tool",
              content: [{ type: "tool_result", toolCallId: "call_1", content: media }],
            },
          ]
        : [{ role: "user", content: media }],
    });
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
          ]),
        }),
      ]),
    );
  });
});
