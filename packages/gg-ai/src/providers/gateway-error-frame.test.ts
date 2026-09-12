/**
 * Characterization + regression tests for gateway error frames delivered INSIDE
 * an HTTP 200 SSE stream.
 *
 * Gateways (Portkey, Azure APIM, OpenRouter, FastAPI-fronted endpoints) answer
 * 200 OK and then put the real failure in a stream frame that carries no
 * `choices` key:
 *
 *   {"statusCode": 429, "message": "rate limited"}
 *   {"detail": [{"msg": "context length exceeded"}]}
 *
 * The OpenAI SDK only throws for frames with a top-level `error` key, so these
 * shapes reach our loop and hit `if (!choice) continue;` — the failure is
 * discarded and the turn dies with a misleading transport error instead of the
 * provider's actual one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { ProviderError } from "../errors.js";
import { streamOpenAI } from "./openai.js";

const createMock = vi.fn();

vi.mock("openai", () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(args: { status?: number; message?: string }) {
      super(args.message ?? "api error");
      this.name = "APIError";
      this.status = args.status;
    }
  }
  class OpenAIMock {
    static APIError = APIError;
    chat = { completions: { create: createMock } };
  }
  return { default: OpenAIMock };
});

/** A stream that emits arbitrary raw frames, as a gateway would. */
function rawStream(frames: unknown[]): AsyncIterable<OpenAI.ChatCompletionChunk> {
  return (async function* () {
    for (const frame of frames) yield frame as OpenAI.ChatCompletionChunk;
  })() as AsyncIterable<OpenAI.ChatCompletionChunk>;
}

function textFrame(text: string, finish: string | null = null) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test",
    choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
  };
}

async function run(frames: unknown[]) {
  createMock.mockResolvedValueOnce(rawStream(frames));
  const result = streamOpenAI({
    provider: "openai",
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    apiKey: "k",
  });
  // The response promise rejects in tandem with the iterator; observe it up
  // front so a failing stream doesn't surface as an unhandled rejection.
  const settled = result.response.then(
    (r) => ({ response: r, error: null as Error | null }),
    (err: Error) => ({ response: null, error: err }),
  );

  const events = [];
  try {
    for await (const event of result) events.push(event);
  } catch {
    /* the rejection is captured via `settled` */
  }
  return { events, ...(await settled) };
}

describe("gateway error frames inside a 200 stream", () => {
  afterEach(() => {
    createMock.mockReset();
  });

  it("surfaces a Portkey-style statusCode 429 as a rate limit, not a transport stall", async () => {
    const { error } = await run([{ statusCode: 429, message: "rate limited by gateway" }]);

    expect(error).toBeInstanceOf(ProviderError);
    // The agent loop classifies retries off statusCode: 429 -> "rate_limit"
    // (honors a server reset delay), 504 -> generic transient transport retry.
    expect((error as ProviderError & { statusCode?: number }).statusCode).toBe(429);
    expect(error?.message).toContain("rate limited by gateway");
  });

  it("surfaces a FastAPI-style detail frame as a provider error", async () => {
    const { error } = await run([{ detail: [{ msg: "context length exceeded" }] }]);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error?.message).toContain("context length exceeded");
  });

  it("still ignores harmless gateway metadata frames", async () => {
    // Portkey sends hook_results/trace metadata before the real content.
    const { error, response } = await run([
      { hook_results: { beforeRequestHooks: [] }, trace_id: "abc" },
      textFrame("hello"),
      textFrame("", "stop"),
    ]);

    expect(error).toBeNull();
    expect(response?.message.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "hello" }),
    );
  });

  it("does not mistake the usage-only chunk for an error", async () => {
    // `choices: []` with usage is the standard final OpenAI usage chunk.
    const { error, response } = await run([
      textFrame("hi"),
      textFrame("", "stop"),
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ]);

    expect(error).toBeNull();
    expect(response?.usage.inputTokens).toBe(10);
  });

  it("does not truncate tool-call arguments when metadata arrives mid-call", async () => {
    const toolFrame = (args: string) => ({
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });

    const { error, response } = await run([
      toolFrame('{"command":"ec'),
      { trace_id: "mid-call-metadata" },
      toolFrame('ho hi"}'),
      textFrame("", "tool_calls"),
    ]);

    expect(error).toBeNull();
    const parts = response?.message.content;
    const call = Array.isArray(parts) ? parts.find((p) => p.type === "tool_call") : undefined;
    expect(call).toMatchObject({ args: { command: "echo hi" } });
  });
});
