import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import type { StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import type { GenerateImageAuth } from "./generate-image.js";

// A real, decodable 1×1 PNG so sharp (shrinkToFit / downscaleForPreview) works.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_PNG_B64 = TINY_PNG.toString("base64");

function ctx(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, toolCallId: "test" };
}

function isStructured(result: string | StructuredToolResult): result is StructuredToolResult {
  return typeof result !== "string";
}

/** A fake auth that always resolves the OpenAI token successfully. */
function fakeAuth(): GenerateImageAuth & { hasProviderAuth(p: string): Promise<boolean> } {
  return {
    async resolveCredentials() {
      return { accessToken: "test-token", accountId: "acct-123" };
    },
    async hasProviderAuth() {
      return true;
    },
  };
}

/** A fake auth that throws (OpenAI not connected). */
function noAuth(): GenerateImageAuth & { hasProviderAuth(p: string): Promise<boolean> } {
  return {
    async resolveCredentials() {
      throw new Error("Not logged in to openai");
    },
    async hasProviderAuth() {
      return false;
    },
  };
}

/**
 * Build a fake SSE stream that emits a response.output_item.done event with
 * image_generation_call result data, mimicking the Codex responses endpoint.
 */
function makeImageSSEResponse(b64Images: string[], status = 200): Response {
  const events: string[] = [
    `data: ${JSON.stringify({ type: "response.created" })}`,
    `data: ${JSON.stringify({ type: "response.in_progress" })}`,
  ];
  for (const b64 of b64Images) {
    events.push(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          status: "completed",
          result: b64,
        },
      })}`,
    );
  }
  events.push(`data: ${JSON.stringify({ type: "response.completed" })}`);
  events.push("data: [DONE]");
  const sseBody = events.join("\n\n") + "\n\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ggcoder-genimg-"));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("generate_image param schema", () => {
  it("requires prompt and accepts optional params", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const schema = tool.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ prompt: "a cat" }).success).toBe(true);
    expect(
      schema.safeParse({
        prompt: "a cat",
        size: "1024x1024",
        quality: "high",
        n: 2,
        output_format: "webp",
        background: "opaque",
        out_path: "out.png",
      }).success,
    ).toBe(true);
    for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
      expect(schema.safeParse({ prompt: "x", model, background: "transparent" }).success).toBe(
        true,
      );
    }
    for (const model of ["gpt-image-2", "gpt-image-2.5", "unknown"]) {
      expect(schema.safeParse({ prompt: "x", model }).success).toBe(false);
    }
    // Invalid quality rejected.
    expect(schema.safeParse({ prompt: "x", quality: "ultra" }).success).toBe(false);
    // n out of range.
    expect(schema.safeParse({ prompt: "x", n: 5 }).success).toBe(false);
  });
});

describe("generate_image — generation (no image input)", () => {
  it("calls the Codex responses endpoint and returns structured image result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeImageSSEResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "a cat sitting on a desk" }, ctx());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");

    // The body should have image_generation tool with action: "generate"
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("gpt-6-astra");
    expect(body.stream).toBe(true);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto", context: "all_turns" });
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers.version).toBe("0.153.4");
    expect(headers["User-Agent"]).toBe("codex_cli_rs/0.153.4");
    expect(headers).not.toHaveProperty("X-OpenAI-Internal-Codex-Responses-Lite");
    const { codexRequestProfile } = await import("@kenkaiiii/gg-ai");
    expect(codexRequestProfile("gpt-6-astra", "low").headers["X-OpenAI-Internal-Codex-Responses-Lite"]).toBe("true");
    expect(body.tools[0].type).toBe("image_generation");
    expect(body.tools[0].model).toBe("gpt-image-2.5-flare");
    expect(body.tools[0].action).toBe("generate");

    // The prompt should be in the input content
    const inputContent = body.input[0].content;
    expect(inputContent[0].type).toBe("input_text");
    expect(inputContent[0].text).toBe("a cat sitting on a desk");

    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const blocks = Array.isArray(result.content) ? result.content : [];
    const texts = blocks.filter((c) => c.type === "text");
    const images = blocks.filter((c) => c.type === "image");
    expect(texts.length).toBe(1);
    expect(images.length).toBe(1);
    // Should have imagePreviews in details.
    const details = result.details as { imagePreviews?: unknown[] };
    expect(Array.isArray(details?.imagePreviews)).toBe(true);
    expect(details!.imagePreviews!.length).toBe(1);
  });

  it.each(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const)(
    "forwards explicit model %s and transparent background",
    async (model) => {
      const fetchMock = vi.fn().mockResolvedValue(makeImageSSEResponse([TINY_PNG_B64]));
      globalThis.fetch = fetchMock;
      const { createGenerateImageTool } = await import("./generate-image.js");
      const tool = createGenerateImageTool(tmpDir, fakeAuth());
      const result = await tool.execute(
        { prompt: "a logo", model, background: "transparent" },
        ctx(),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(body.model).toBe("gpt-6-astra");
      expect(body.tools[0]).toMatchObject({
        model,
        action: "generate",
        background: "transparent",
        output_format: "png",
      });
      expect(isStructured(result)).toBe(true);
    },
  );

  it("generates multiple images without sending unsupported tool n", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => makeImageSSEResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "two icons", n: 2 }, ctx());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init?.body as string);
      expect(body.tools[0].n).toBeUndefined();
      expect(body.tools[0].model).toBe("gpt-image-2.5-flare");
    }
    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const details = result.details as { imagePreviews?: unknown[] };
    expect(details.imagePreviews).toHaveLength(2);
  });

  it("saves the image to out_path when provided", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeImageSSEResponse([TINY_PNG_B64]),
      ) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const outPath = path.join(tmpDir, "custom.png");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    await tool.execute({ prompt: "a logo", out_path: outPath }, ctx());

    const saved = await readFile(outPath);
    expect(saved.length).toBe(TINY_PNG.length);
  });
});

describe("generate_image — edit (with image input)", () => {
  it.each([undefined, "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const)(
    "includes the reference image and sets action to edit with model %s",
    async (model) => {
      const refPath = path.join(tmpDir, "input.png");
      await mkdir(path.dirname(refPath), { recursive: true });
      await writeFile(refPath, TINY_PNG);

      const fetchMock = vi.fn().mockResolvedValue(makeImageSSEResponse([TINY_PNG_B64]));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const { createGenerateImageTool } = await import("./generate-image.js");
      const tool = createGenerateImageTool(tmpDir, fakeAuth());
      const result = await tool.execute(
        { prompt: "make the background darker", image: refPath, model },
        ctx(),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(body.tools[0].action).toBe("edit");
      expect(body.model).toBe("gpt-6-astra");
      expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty("X-OpenAI-Internal-Codex-Responses-Lite");
      expect(body.tools[0].model).toBe(model ?? "gpt-image-2.5-flare");

      // The input should have both text and input_image
      const inputContent = body.input[0].content;
      expect(inputContent).toHaveLength(2);
      expect(inputContent[0].type).toBe("input_text");
      expect(inputContent[1].type).toBe("input_image");
      expect(inputContent[1].image_url).toContain("data:image/png;base64,");

      expect(isStructured(result)).toBe(true);
    },
  );

  it("returns a helpful error when the image path does not exist", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      { prompt: "edit this", image: path.join(tmpDir, "nonexistent.png") },
      ctx(),
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("Could not read");
  });
});

describe("generate_image — error handling", () => {
  it("rejects transparent JPEG before calling OpenAI", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      { prompt: "a logo", background: "transparent", output_format: "jpeg" },
      ctx(),
    );
    expect(result).toBe("Transparent backgrounds require png or webp output, not jpeg.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[1024, 1024, "matched"], [1536, 1024, "mismatched"], [1254, 1254, "mismatched"]] as const)("reports original %ix%i dimensions honestly (%s)", async (width, height, status) => {
    const { default: sharp } = await import("sharp");
    const bytes = await sharp({ create: { width, height, channels: 3, background: "red" } }).png().toBuffer();
    const fetchMock = vi.fn().mockResolvedValue(makeImageSSEResponse([bytes.toString("base64")]));
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const out = path.join(tmpDir, "dimensions.png");
    const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute({ prompt: "a square", size: "1024x1024", out_path: out }, ctx());
    if (!isStructured(result)) throw new Error("Expected saved image result");
    expect(await readFile(out)).toEqual(bytes);
    expect(result.details).toMatchObject({ sizing: [{ path: out, requested: "1024x1024", actual: `${width}x${height}`, status }] });
    if (typeof result.content === "string") throw new Error("Expected image content array");
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    expect(text).toContain(`Requested: 1024x1024; actual: ${width}x${height}`);
    if (status === "mismatched") {
      expect(text).toContain("WARNING: Image saved, requested dimensions not met");
      expect(text).toContain("Exact-size verification failed");
      expect(text).not.toContain("Requested dimensions matched");
    } else {
      expect(text).toContain("Requested dimensions matched");
      expect(text).not.toContain("WARNING");
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).tools[0].size).toBe("1024x1024");
  });

  it("returns a user-facing message when OpenAI is not connected", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, noAuth());
    const result = await tool.execute({ prompt: "a cat" }, ctx());
    expect(typeof result).toBe("string");
    expect(result).toContain("not connected");
  });

  it("returns a user-facing message on API error (non-200)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "content moderation blocked" }), { status: 400 }),
      ) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "blocked content" }, ctx());
    expect(typeof result).toBe("string");
    expect(result).toContain("failed");
    expect(result).toContain("moderation");
  });

  it("returns empty-results message when API succeeds but returns no image data", async () => {
    // SSE stream with no image_generation_call events
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeImageSSEResponse([])) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "something" }, ctx());
    expect(typeof result).toBe("string");
    expect(result).toBe(
      "Image generation returned no image results from GPT-6 Astra. No fallback model was used.",
    );
    expect(result).not.toContain("moderation");
  });

  it.each([
    [
      "response.failed",
      { type: "response.failed", response: { error: { message: "Unsupported Astra image tool" } } },
      "Unsupported Astra image tool",
    ],
    ["response.incomplete", { type: "response.incomplete" }, "incomplete"],
    ["error", { type: "error", message: "quota exceeded" }, "quota exceeded"],
    [
      "outer substitution",
      { type: "response.completed", response: { model: "gpt-5.5" } },
      "substitution",
    ],
    [
      "inner substitution",
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          model: "gpt-image-2",
          status: "completed",
          result: TINY_PNG_B64,
        },
      },
      "substitution",
    ],
  ])("rejects %s without fallback", async (_name, event, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`));
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute(
      { prompt: "a square" },
      ctx(),
    );
    expect(result).toContain(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe("gpt-6-astra");
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it("rejects malformed and truncated streams rather than reporting moderation", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    for (const data of [
      "data: {broken}\n\n",
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: TINY_PNG_B64 } })}\n\n`,
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(data));
      globalThis.fetch = fetchMock;
      const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute(
        { prompt: "a square" },
        ctx(),
      );
      expect(result).toContain("failed");
      expect(result).not.toContain("moderation");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(await readdir(tmpDir)).toEqual([]);
    }
  });

  it("accepts fragmented events and an unterminated final completion event", async () => {
    const data = await makeImageSSEResponse([TINY_PNG_B64]).text();
    const bytes = new TextEncoder().encode(data.replace(/\n\ndata: \[DONE\]\n\n$/, ""));
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
            controller.close();
          },
        }),
      ),
    );
    const { createGenerateImageTool } = await import("./generate-image.js");
    expect(
      isStructured(
        await createGenerateImageTool(tmpDir, fakeAuth()).execute({ prompt: "a square" }, ctx()),
      ),
    ).toBe(true);
  });

  it("rejects stream cancellation and never overwrites the input image", async () => {
    const source = path.join(tmpDir, "source.png");
    await writeFile(source, Buffer.from(TINY_PNG_B64, "base64"));
    const { createGenerateImageTool } = await import("./generate-image.js");
    globalThis.fetch = vi.fn().mockResolvedValue(makeImageSSEResponse([TINY_PNG_B64]));
    const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute(
      { prompt: "edit", image: source, out_path: source },
      ctx(),
    );
    expect(result).toContain("EEXIST");
    expect((await readFile(source)).toString("base64")).toBe(TINY_PNG_B64);
    const abort = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      abort.abort();
      return makeImageSSEResponse([TINY_PNG_B64]);
    });
    expect(
      await createGenerateImageTool(tmpDir, fakeAuth()).execute(
        { prompt: "a square" },
        ctx(abort.signal),
      ),
    ).toContain("aborted");
  });

  it("respects abort signal before making the API call", async () => {
    const ac = new AbortController();
    ac.abort();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "a cat" }, ctx(ac.signal));
    expect(typeof result).toBe("string");
    expect(result).toContain("aborted");
  });
});
