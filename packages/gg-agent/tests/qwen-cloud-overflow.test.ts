import { afterEach, expect, it, vi } from "vitest";
import { agentLoop, isContextOverflow } from "../src/agent-loop.js";
import { stream } from "../../gg-ai/src/stream.js";
import { QWEN_CLOUD_TOKEN_PLAN_ENDPOINT } from "../../gg-ai/src/qwen-cloud-policy.js";
import type { Message } from "../../gg-ai/src/types.js";
import type { AgentEvent, TransformContextOptions } from "../src/types.js";

// Resolve the loop's package import to real source, not stale build outputs.
vi.mock("@kenkaiiii/gg-ai", () => import("../../gg-ai/src/index.js"));

afterEach(() => vi.unstubAllGlobals());

const options = {
  provider: "qwen-cloud" as const,
  model: "qwen-cloud/qwen3.8-max",
  apiKey: "sk-sp-synthetic-overflow-test",
};
const overflow = () => Response.json({
  error: { code: "context_length_exceeded", message: "synthetic-private-body" },
}, { status: 400, headers: { "x-request-id": "synthetic-private-id" } });

it("keeps the actual Qwen adapter error recognizable by the real loop classifier", async () => {
  const fetch = vi.fn(async () => overflow());
  vi.stubGlobal("fetch", fetch);
  const error = await Promise.resolve(stream({
    ...options, messages: [{ role: "user", content: "hello" }],
  })).catch((error) => error);
  expect(isContextOverflow(error)).toBe(true);
  expect(error.message).toBe("Qwen Cloud Token Plan prompt is too long.");
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain("synthetic-private");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("force-compacts a rejected Qwen prompt and recovers on the same route and model", async () => {
  const requests: Array<{ url: string; body: { model: string; messages: unknown[] } }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string) });
    if (requests.length === 1) return overflow();
    return new Response('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const transformContext = vi.fn((messages: Message[], opts: TransformContextOptions) =>
    opts.force ? [messages[messages.length - 1]!] : messages,
  );
  const events: AgentEvent[] = [];
  for await (const event of agentLoop([
    { role: "user", content: "old context" },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "current request" },
  ], { ...options, tools: [], transformContext })) events.push(event);

  expect(transformContext.mock.calls.filter(([, opts]) => opts.force)).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ type: "retry", reason: "overflow_compact" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "recovered" }));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(requests.map(({ url, body }) => [url, body.model])).toEqual([
    [QWEN_CLOUD_TOKEN_PLAN_ENDPOINT, "qwen3.8-max"],
    [QWEN_CLOUD_TOKEN_PLAN_ENDPOINT, "qwen3.8-max"],
  ]);
  expect(requests[1]!.body.messages).toHaveLength(1);
});
