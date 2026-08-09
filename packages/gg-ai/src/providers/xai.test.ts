import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";

const createMock = vi.fn();
/** Constructor options each `new OpenAI(...)` was built with, in call order. */
const clientOptions: Record<string, unknown>[] = [];

vi.mock("openai", () => {
  class APIError extends Error {}
  class OpenAIMock {
    static APIError = APIError;
    chat = { completions: { create: createMock } };
    constructor(options: Record<string, unknown>) {
      clientOptions.push(options);
    }
  }
  return { default: OpenAIMock };
});

function emptyStream(): AsyncIterable<OpenAI.ChatCompletionChunk> {
  return (async function* () {
    yield {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "grok-4.5",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    } as OpenAI.ChatCompletionChunk;
  })();
}

async function streamXai(baseUrl?: string): Promise<Record<string, unknown>> {
  const { stream } = await import("../stream.js");
  clientOptions.length = 0;
  createMock.mockResolvedValueOnce(emptyStream());
  for await (const _event of stream({
    provider: "xai",
    model: "grok-4.5",
    messages: [{ role: "user", content: "hi" }],
    apiKey: "tok" + "en",
    ...(baseUrl ? { baseUrl } : {}),
  })) {
    /* consume */
  }
  return clientOptions[0] ?? {};
}

// Grok subscription OAuth routes to the Grok CLI chat proxy, which only serves
// recognized Grok-CLI clients. Injecting that identity in the transport (not at
// each call site) is what makes compaction, title-gen and sub-agents work too —
// they build their own streams and would otherwise be rejected.
describe("xai provider transport", () => {
  it("defaults to the public API host with no client-identity headers", async () => {
    const options = await streamXai();
    expect(options.baseURL).toBe("https://api.x.ai/v1");
    const headers = (options.defaultHeaders ?? {}) as Record<string, string>;
    // An API key is not a Grok CLI client — sending CLI identity to api.x.ai
    // would misrepresent the caller.
    expect(headers["X-XAI-Token-Auth"]).toBeUndefined();
  });

  it("attaches Grok CLI identity when routed to the OAuth chat proxy", async () => {
    const options = await streamXai("https://cli-chat-proxy.grok.com/v1");
    expect(options.baseURL).toBe("https://cli-chat-proxy.grok.com/v1");
    const headers = (options.defaultHeaders ?? {}) as Record<string, string>;
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(headers["x-grok-client-version"]).toMatch(/^\d+\.\d+/);
    // The proxy routes by override header, so the model must travel in it.
    expect(headers["x-grok-model-override"]).toBe("grok-4.5");
  });
});
