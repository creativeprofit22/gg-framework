import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import type { StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import type { GenerateImageAuth } from "./generate-image.js";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { SessionManager } from "../core/session-manager.js";
import { restoreToolImages } from "../app-sidecar-image-history.js";
import { resolveToolSchema, stream, StreamResult, type Message } from "@kenkaiiii/gg-ai";
import type * as GgAi from "@kenkaiiii/gg-ai";
import { agentLoop } from "@kenkaiiii/gg-agent";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...await importOriginal<typeof GgAi>(),
  stream: vi.fn(),
}));

/** Exercise the real normalization, emitted event, and saved conversation result. */
async function failureText(raw: string | StructuredToolResult): Promise<string> {
  vi.mocked(stream).mockReturnValueOnce(new StreamResult((async function* () {
    yield* [];
    return {
      message: { role: "assistant", content: [{ type: "tool_call", id: "image", name: "generate_image", args: {} }] },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  })()));
  const messages: Message[] = [{ role: "user", content: "Generate an image" }];
  let ended = false;
  for await (const event of agentLoop(messages, {
    provider: "anthropic", model: "offline", maxTurns: 1,
    tools: [{ name: "generate_image", description: "image fixture", parameters: z.object({}), execute: async () => raw }],
  })) {
    if (event.type !== "tool_call_end") continue;
    ended = true;
    expect(event.isError).toBe(true);
    expect(event.result).not.toContain("sk-image-fixture-secret-1234567890");
  }
  expect(ended).toBe(true);
  const results = messages.flatMap((message) => message.role === "tool" ? message.content : []);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ toolCallId: "image", isError: true });
  expect(typeof results[0]!.content).toBe("string");
  expect(results[0]!.content).not.toContain("sk-image-fixture-secret-1234567890");
  return results[0]!.content as string;
}

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
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("Unexpected offline fixture request"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("generate_image param schema", () => {
  it("pins the public sizing limitation in the tool description and provider schema", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    expect(tool.description).toBe(
      "Generate or edit images using OpenAI's GPT Image 2.5 models: Flare (default, fast) " +
      "or Sunburst (precise editing). Works even when a different " +
      "chat provider is active — only requires OpenAI to be connected. Only use this tool when " +
      "the user explicitly asks to create, generate, or edit an image. Pass `image` with a " +
      "file path to edit an existing image (e.g. a previously generated one or a user attachment). " +
      "Use `out_path` to save to a specific location (defaults to .gg/generated/). " +
      "Requested dimensions are forwarded to the image service, but actual dimensions and shape may differ. " +
      "Originals are never silently resized; mismatches are warned.",
    );
    expect(resolveToolSchema(tool)).toMatchObject({
      properties: {
        background: {
          type: "string",
          enum: ["opaque", "auto"],
          description: "Background type (default auto). Transparent backgrounds are not supported by this tool.",
        },
        size: {
          type: "string",
          description:
            "Requested resolution, forwarded to the image service; exact output dimensions are not guaranteed. " +
            "Actual dimensions and shape may differ. Originals are never silently resized; mismatches are warned. " +
            "Request sizes with both edges multiples of 16px, max edge ≤3840px, " +
            "long:short ratio ≤3:1, total pixels 655,360–8,294,400. " +
            "Popular: 1024x1024, 1536x1024, 1024x1536, 2048x2048. Default: auto.",
        },
      },
    });
  });

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
      for (const background of ["opaque", "auto"]) {
        expect(schema.safeParse({ prompt: "x", model, background }).success).toBe(true);
      }
      expect(schema.safeParse({ prompt: "x", model, background: "transparent" }).success).toBe(false);
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

  it.each([
    ["gpt-image-2.5-flare", "opaque"],
    ["gpt-image-2.5-flare", "auto"],
    ["gpt-image-2.5-sunburst", "opaque"],
    ["gpt-image-2.5-sunburst", "auto"],
  ] as const)(
    "forwards explicit model %s and supported background %s",
    async (model, background) => {
      const fetchMock = vi.fn().mockResolvedValue(makeImageSSEResponse([TINY_PNG_B64]));
      globalThis.fetch = fetchMock;
      const { createGenerateImageTool } = await import("./generate-image.js");
      const tool = createGenerateImageTool(tmpDir, fakeAuth());
      const result = await tool.execute(
        { prompt: "a logo", model, background },
        ctx(),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(body.model).toBe("gpt-6-astra");
      expect(body.tools[0]).toMatchObject({
        model,
        action: "generate",
        background,
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

  it.each(["HTTP400", "EEXIST", "empty"] as const)("preserves completed originals after a later %s failure", async (failure) => {
    const first = path.join(tmpDir, "batch_0.png");
    const collision = path.join(tmpDir, "batch_1.png");
    const existing = Buffer.from("existing original — do not overwrite");
    if (failure === "EEXIST") await writeFile(collision, existing);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeImageSSEResponse([TINY_PNG_B64]))
      .mockImplementationOnce(async () => {
        // Persistence must happen before the next provider request begins.
        expect(await readFile(first)).toEqual(TINY_PNG);
        return failure === "HTTP400"
          ? new Response(JSON.stringify({ detail: "unsupported request" }), { status: 400 })
          : makeImageSSEResponse(failure === "empty" ? [] : [TINY_PNG_B64]);
      });
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute(
      { prompt: "two icons", n: 2, out_path: path.join(tmpDir, "batch.png"), size: "1024x1024" }, ctx(),
    );
    expect(await readFile(first)).toEqual(TINY_PNG);
    if (failure === "EEXIST") expect(await readFile(collision)).toEqual(existing);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (!isStructured(result)) throw new Error("Expected structured partial result");
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      requestedCount: 2, savedCount: 1, savedPaths: [first],
      sizing: [{ path: first, actual: "1x1", status: "mismatched" }],
    });
    const text = typeof result.content === "string" ? result.content : result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    expect(text).toContain("Partial completion: saved 1 of 2");
    expect(text).toContain(first);
    expect(text).toContain(failure === "HTTP400" ? "400" : failure === "EEXIST" ? "EEXIST" : "no image results");
    expect(text).toContain("Exact-size verification failed");
    expect(text).toContain("No retry or fallback");
    expect(result.imageResult?.images.map((image) => image.path)).toEqual([first]);
    expect(Array.isArray(result.content) && result.content.filter((part) => part.type === "image")).toHaveLength(1);
  });

  it("preserves the first original when cancelled before the second response", async () => {
    const controller = new AbortController();
    const first = path.join(tmpDir, "cancel_0.png");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeImageSSEResponse([TINY_PNG_B64]))
      .mockImplementationOnce(async () => {
        expect(await readFile(first)).toEqual(TINY_PNG);
        controller.abort();
        throw controller.signal.reason;
      });
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute(
      { prompt: "two icons", n: 2, out_path: path.join(tmpDir, "cancel.png") }, ctx(controller.signal),
    );
    if (!isStructured(result)) throw new Error("Expected structured partial result");
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ requestedCount: 2, savedCount: 1, savedPaths: [first], failure: "Image generation aborted." });
    expect(createHash("sha256").update(await readFile(first)).digest("hex")).toBe(createHash("sha256").update(TINY_PNG).digest("hex"));
    expect(result.imageResult?.images.map((image) => image.path)).toEqual([first]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports all saved originals when preview generation fails without retrying", async () => {
    const images = await import("../utils/image.js");
    vi.spyOn(images, "downscaleForPreview").mockRejectedValueOnce(new Error("offline preview failure"));
    const fetchMock = vi.fn().mockImplementation(async () => makeImageSSEResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute(
      { prompt: "two icons", n: 2, out_path: path.join(tmpDir, "preview.png") }, ctx(),
    );
    if (!isStructured(result)) throw new Error("Expected structured partial result");
    const paths = [0, 1].map((i) => path.join(tmpDir, `preview_${i}.png`));
    expect(result.isError).toBe(true);
    expect(result.imageResult).toBeUndefined();
    expect(result.details).toMatchObject({ requestedCount: 2, savedCount: 2, savedPaths: paths });
    const text = await failureText(result);
    expect(text).toContain("Partial completion: saved 2 of 2 requested images.");
    expect(text).toContain("Preview failed: offline preview failure");
    expect(text).toContain("No retry or fallback");
    for (const file of paths) {
      expect(text).toContain(file);
      expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(createHash("sha256").update(TINY_PNG).digest("hex"));
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("round-trips two distinct originals with spaces and commas through the agent and session storage", async () => {
    const { default: sharp } = await import("sharp");
    const originals = await Promise.all(["red", "blue"].map((background) => sharp({
      create: { width: 8, height: 8, channels: 3, background },
    }).png().toBuffer()));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(makeImageSSEResponse([originals[0]!.toString("base64")]))
      .mockResolvedValueOnce(makeImageSSEResponse([originals[1]!.toString("base64")]));
    const { createGenerateImageTool } = await import("./generate-image.js");
    const outPath = path.join(tmpDir, "my images, originals", "two colours, original.png");
    vi.mocked(stream).mockReturnValueOnce(new StreamResult((async function* () {
      yield* [];
      return {
        message: { role: "assistant", content: [{ type: "tool_call", id: "images", name: "generate_image", args: { prompt: "two colours", n: 2, out_path: outPath } }] },
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    })()));
    const messages: Message[] = [{ role: "user", content: "Generate two colours" }];
    for await (const _event of agentLoop(messages, {
      provider: "anthropic", model: "offline", maxTurns: 1,
      tools: [createGenerateImageTool(tmpDir, fakeAuth())],
    })) { /* Drain the real loop; only provider responses are fixtures. */ }
    const result = messages.flatMap((message) => message.role === "tool" ? message.content : [])[0]!;
    expect(result.isError).not.toBe(true);
    expect(result.imageResult?.images).toHaveLength(2);
    expect(Array.isArray(result.content) && result.content.filter((block) => block.type === "image")).toHaveLength(1);
    const paths = [0, 1].map((i) => outPath.replace(/\.png$/, `_${i}.png`));
    expect(result.imageResult?.images.map((image) => image.path)).toEqual(paths);
    const hashes = originals.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
    expect(hashes[0]).not.toBe(hashes[1]);
    const manager = new SessionManager(path.join(tmpDir, "sessions"));
    const saved = await manager.create(tmpDir, "openai", "offline");
    await manager.appendRequiredMessage(saved.path, {
      type: "message", id: randomUUID(), parentId: null, timestamp: new Date().toISOString(),
      message: { role: "tool", content: [result] },
    });
    for (let reopen = 0; reopen < 2; reopen++) {
      const loaded = await new SessionManager(path.join(tmpDir, "sessions")).load(saved.path);
      const restored = loaded.entries.flatMap((entry) => entry.type === "message" && entry.message.role === "tool" ? entry.message.content : [])[0]!;
      const images = await restoreToolImages(restored);
      expect(images.map((image) => image.path)).toEqual(paths);
      expect(images.map((image) => image.src)).toEqual(result.imageResult!.images.map((image) => `data:${image.mediaType};base64,${image.data}`));
      for (const [i, originalPath] of paths.entries()) {
        expect(createHash("sha256").update(await readFile(originalPath)).digest("hex")).toBe(hashes[i]);
      }
    }
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
    expect(result).toMatchObject({ isError: true });
    expect(await failureText(result)).toContain("Could not read");
  });
});

describe("generate_image — error handling", () => {
  it.each([undefined, "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const)(
    "rejects stale transparent requests for %s before credentials or provider usage",
    async (model) => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
      const { createGenerateImageTool } = await import("./generate-image.js");
      const auth = fakeAuth();
      const credentials = vi.spyOn(auth, "resolveCredentials");
      const tool = createGenerateImageTool(tmpDir, auth);
      for (const output_format of [undefined, "png", "webp", "jpeg"]) {
        // Serialized stale input deliberately bypasses the current public schema.
        const args = JSON.parse(JSON.stringify({ prompt: "a logo", model, background: "transparent", output_format }));
        const result = await tool.execute(args, ctx());
        expect(await failureText(result)).toBe("Transparent backgrounds are not supported by this tool. Use opaque or auto.");
      }
      expect(credentials).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readdir(tmpDir)).toEqual([]);
    },
  );

  it.each([[1024, 1024, "matched"], [1536, 1024, "mismatched"], [1254, 1254, "mismatched"]] as const)("reports original %ix%i dimensions honestly (%s)", async (width, height, status) => {
    const { default: sharp } = await import("sharp");
    const bytes = await sharp({ create: { width, height, channels: 3, background: "red" } }).png().toBuffer();
    const fetchMock = vi.fn().mockResolvedValue(makeImageSSEResponse([bytes.toString("base64")]));
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const out = path.join(tmpDir, "dimensions.png");
    const result = await createGenerateImageTool(tmpDir, fakeAuth()).execute({ prompt: "a square", size: "1024x1024", out_path: out }, ctx());
    if (!isStructured(result)) throw new Error("Expected saved image result");
    expect(result.isError).not.toBe(true);
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
    expect(result).toMatchObject({ isError: true });
    expect(await failureText(result)).toContain("not connected");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns a user-facing message on API error (non-200)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "content moderation blocked; sk-image-fixture-secret-1234567890" }), { status: 400 }),
      ) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "blocked content" }, ctx());
    expect(result).toMatchObject({ isError: true });
    expect(await failureText(result)).toContain("failed");
    expect(await failureText(result)).toContain("moderation");
    expect(await failureText(result)).toContain("[REDACTED]");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("returns empty-results message when API succeeds but returns no image data", async () => {
    // SSE stream with no image_generation_call events
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeImageSSEResponse([])) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "something" }, ctx());
    expect(result).toMatchObject({ isError: true });
    expect(await failureText(result)).toBe(
      "Image generation returned no image results from GPT-6 Astra. No fallback model was used.",
    );
    expect(await failureText(result)).not.toContain("moderation");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
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
    expect(await failureText(result)).toContain(expected);
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
      expect(await failureText(result)).toContain("failed");
      expect(await failureText(result)).not.toContain("moderation");
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
    expect(await failureText(result)).toContain("EEXIST");
    expect((await readFile(source)).toString("base64")).toBe(TINY_PNG_B64);
    const abort = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      abort.abort();
      return makeImageSSEResponse([TINY_PNG_B64]);
    });
    expect(
      await failureText(await createGenerateImageTool(tmpDir, fakeAuth()).execute(
        { prompt: "a square" },
        ctx(abort.signal),
      )),
    ).toContain("aborted");
  });

  it("respects abort signal before making the API call", async () => {
    const ac = new AbortController();
    ac.abort();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "a cat" }, ctx(ac.signal));
    expect(result).toMatchObject({ isError: true });
    expect(await failureText(result)).toContain("aborted");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
