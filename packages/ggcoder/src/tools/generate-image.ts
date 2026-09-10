import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { codexRequestProfile } from "@kenkaiiii/gg-ai";
import type { AgentTool, StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import { downscaleForPreview, shrinkToFit } from "../utils/image.js";

/**
 * Structural subset of AuthStorage the tool needs at execute time. Using a
 * structural type avoids importing the full class (and its gg-core dependency
 * chain) into the tool module — the caller satisfies this with its real
 * AuthStorage instance.
 */
export type GenerateImageAuth = {
  resolveCredentials(provider: string): Promise<{
    accessToken: string;
    accountId?: string;
  }>;
};

/**
 * The Codex backend endpoint — the SAME endpoint our OpenAI Codex streaming
 * provider uses for chat. ChatGPT OAuth tokens (from auth.openai.com PKCE flow)
 * are rejected by api.openai.com/v1/images/* (missing `api.model.images.request`
 * scope), but they work here. Image generation is done via the Responses API's
 * built-in `image_generation` tool, with the image model selected on that tool.
 */
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
/** Model that supports the image_generation Responses API tool. */
const IMAGE_GEN_MODEL = "gpt-6-astra";

const GenerateImageParams = z.object({
  prompt: z.string().describe("Text description of the image to generate or the edit to apply"),
  model: z
    .enum(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])
    .optional()
    .describe(
      "Image model. Default: gpt-image-2.5-flare for fast, high-quality generation. " +
        "Use gpt-image-2.5-sunburst when editing precision matters most.",
    ),
  image: z
    .string()
    .optional()
    .describe(
      "Path to an existing image file to edit (use the path returned by a previous " +
        "generate_image call, or a user-attached image path). When omitted, a new " +
        "image is generated from scratch.",
    ),
  size: z
    .string()
    .optional()
    .describe(
      "Requested resolution, forwarded to the image service; exact output dimensions are not guaranteed. " +
        "Actual dimensions and shape may differ. Originals are never silently resized; mismatches are warned. " +
        "Request sizes with both edges multiples of 16px, max edge ≤3840px, " +
        "long:short ratio ≤3:1, total pixels 655,360–8,294,400. " +
        "Popular: 1024x1024, 1536x1024, 1024x1536, 2048x2048. Default: auto.",
    ),
  quality: z
    .enum(["low", "medium", "high", "auto"])
    .optional()
    .describe(
      "Rendering quality. Use 'low' for fast drafts, 'high' for final assets. Default: auto.",
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Number of images to generate (1–4, default 1)"),
  out_path: z
    .string()
    .optional()
    .describe(
      "Where to save the generated image (relative to cwd or absolute). " +
        "Defaults to .gg/generated/<timestamp>.png",
    ),
  output_format: z
    .enum(["png", "jpeg", "webp"])
    .optional()
    .describe("Output file format (default png)"),
  background: z
    .enum(["opaque", "auto"])
    .optional()
    .describe("Background type (default auto). Transparent backgrounds are not supported by this tool."),
});

type GenerateImageArgs = z.infer<typeof GenerateImageParams>;

function defaultOutPath(cwd: string, format: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = format === "png" ? "png" : format === "jpeg" ? "jpg" : "webp";
  return path.join(cwd, ".gg", "generated", `${stamp}.${ext}`);
}

/** Format → media type for StructuredToolResult. */
function mediaTypeFor(format: string): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

export function createGenerateImageTool(
  cwd: string,
  auth: GenerateImageAuth,
): AgentTool<typeof GenerateImageParams> {
  return {
    name: "generate_image",
    description:
      "Generate or edit images using OpenAI's GPT Image 2.5 models: Flare (default, fast) " +
      "or Sunburst (precise editing). Works even when a different " +
      "chat provider is active — only requires OpenAI to be connected. Only use this tool when " +
      "the user explicitly asks to create, generate, or edit an image. Pass `image` with a " +
      "file path to edit an existing image (e.g. a previously generated one or a user attachment). " +
      "Use `out_path` to save to a specific location (defaults to .gg/generated/). " +
      "Requested dimensions are forwarded to the image service, but actual dimensions and shape may differ. " +
      "Originals are never silently resized; mismatches are warned.",
    parameters: GenerateImageParams,
    async execute(
      args: GenerateImageArgs,
      context: ToolContext,
    ): Promise<StructuredToolResult> {
      if (context.signal.aborted) return { content: "Image generation aborted before start.", isError: true };
      // Stale callers can bypass the public schema; reject before credential refresh or provider usage.
      const background: unknown = args.background;
      if (background === "transparent") {
        return { content: "Transparent backgrounds are not supported by this tool. Use opaque or auto.", isError: true };
      }

      // Resolve OpenAI credentials at execution time (lazy — token refresh
      // happens on use, not at registration).
      let token: string;
      let accountId: string | undefined;
      try {
        const creds = await auth.resolveCredentials("openai");
        token = creds.accessToken;
        accountId = creds.accountId;
      } catch {
        return {
          content: "OpenAI is not connected. The user needs to connect their OpenAI account " +
            "to use image generation.",
          isError: true,
        };
      }

      const outputFormat = args.output_format ?? "png";
      const mediaType = mediaTypeFor(outputFormat);
      const outPath = args.out_path
        ? resolvePath(cwd, args.out_path)
        : defaultOutPath(cwd, outputFormat);

      const requestedCount = args.n ?? 1;
      const savedPaths: string[] = [];
      const sizing: Array<{
        path: string;
        requested: string;
        actual: string | null;
        status: "matched" | "mismatched" | "not-requested" | "unverified";
      }> = [];
      let failure: string | undefined;
      const completionReport = () =>
        `Partial completion: saved ${savedPaths.length} of ${requestedCount} requested images.\n` +
        `Saved originals: ${savedPaths.join(", ")}\nFailure: ${failure}\n` +
        "No retry or fallback was attempted; saved originals were not overwritten. " +
        "Resolve the reported error before requesting only the missing images with a new output path.";
      const sizeReport = () => sizing.map((item) => {
        const dimensions = `Requested: ${item.requested}; actual: ${item.actual ?? "unknown"}.`;
        if (item.status === "mismatched") return `WARNING: Image saved, requested dimensions not met. ${dimensions} Original bytes preserved; no resizing applied to the saved image. Exact-size verification failed. (${item.path})`;
        if (item.status === "unverified") return `WARNING: Image saved, dimensions could not be verified. ${dimensions} (${item.path})`;
        return `${dimensions} ${item.status === "matched" ? "Requested dimensions matched." : "No exact dimensions requested."} (${item.path})`;
      }).join("\n");

      try {
        // Build the image_generation tool definition with the requested params.
        const imageTool: Record<string, unknown> = {
          type: "image_generation",
          model: args.model ?? "gpt-image-2.5-flare",
          output_format: outputFormat,
        };
        if (args.size) imageTool.size = args.size;
        if (args.quality) imageTool.quality = args.quality;
        if (args.background) imageTool.background = args.background;

        // Build the input content — prompt text, optionally with a reference image.
        const inputContent: Array<Record<string, unknown>> = [
          { type: "input_text", text: args.prompt },
        ];

        if (args.image) {
          // Edit mode: read the reference image and include it as input_image.
          const imagePath = resolvePath(cwd, args.image);
          let fileBuffer: Buffer;
          try {
            fileBuffer = await readFile(imagePath);
          } catch {
            return { content: `Could not read the image at ${args.image}. Check the path is correct.`, isError: true };
          }
          // The Responses API accepts images as data URLs.
          const refMediaType =
            imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg")
              ? "image/jpeg"
              : imagePath.toLowerCase().endsWith(".webp")
                ? "image/webp"
                : "image/png";
          inputContent.push({
            type: "input_image",
            image_url: `data:${refMediaType};base64,${fileBuffer.toString("base64")}`,
          });
          imageTool.action = "edit";
        } else {
          imageTool.action = "generate";
        }

        // Call the Codex responses endpoint (same one our Codex streaming
        // provider uses) with the image_generation built-in tool. ChatGPT OAuth
        // tokens work here, unlike api.openai.com/v1/images/*.
        // The Responses image tool does not accept an `n` property. Generate
        // multiple images with separate requests. Save each completed request
        // before starting another so later failures cannot discard its originals.
        const imageBuffers: Buffer[] = [];
        const requestedPixels = /^(\d+)x(\d+)$/.exec(args.size ?? "");
        try {
          while (savedPaths.length < requestedCount) {
            const generated = await callImageGeneration(
              inputContent, imageTool, token, accountId, context.signal,
            );
            if (generated.length === 0) {
              if (savedPaths.length === 0) {
                return { content: "Image generation returned no image results from GPT-6 Astra. No fallback model was used.", isError: true };
              }
              throw new Error("Image generation returned no image results from GPT-6 Astra.");
            }
            for (const buf of generated.slice(0, requestedCount - savedPaths.length)) {
              const savePath = requestedCount === 1 ? outPath : insertIndex(outPath, savedPaths.length);
              await mkdir(path.dirname(savePath), { recursive: true });
              context.signal.throwIfAborted();
              await writeFile(savePath, buf, { flag: "wx" });
              savedPaths.push(savePath);
              imageBuffers.push(buf);
              // Inspect the saved original buffer, never a resized model/preview derivative.
              let actual: string | null = null;
              let status: (typeof sizing)[number]["status"] = "unverified";
              try {
                const { default: sharp } = await import("sharp");
                const meta = await sharp(buf).metadata();
                if (meta.width && meta.height) {
                  actual = `${meta.width}x${meta.height}`;
                  status = requestedPixels
                    ? meta.width === Number(requestedPixels[1]) && meta.height === Number(requestedPixels[2])
                      ? "matched"
                      : "mismatched"
                    : !args.size || args.size === "auto" ? "not-requested" : "unverified";
                }
              } catch {
                // Preserve valid returned bytes even when dimension inspection is unavailable.
              }
              sizing.push({ path: savePath, requested: args.size ?? "auto", actual, status });
            }
          }
        } catch (err) {
          if (savedPaths.length === 0) throw err;
          failure = context.signal.aborted ? "Image generation aborted." : err instanceof Error ? err.message : String(err);
        }

        // The primary image (first) gets the full treatment: model-visible
        // image + inline preview. Additional images are previewed only.
        const primary = imageBuffers[0]!;
        const primaryPath = savedPaths[0]!;

        // Shrink for the model (provider image limits) and a smaller copy for
        // the inline terminal/webview preview.
        const { buffer: shrunk, mediaType: detectedType } = await shrinkToFit(primary, mediaType);
        const previewBuffer = await downscaleForPreview(shrunk);

        const imagePreviews = [
          {
            base64: previewBuffer.toString("base64"),
            mediaType: detectedType,
            path: primaryPath,
          },
        ];

        // Include additional images as previews too.
        for (let i = 1; i < imageBuffers.length; i++) {
          const extraBuf = imageBuffers[i]!;
          const extraPath = savedPaths[i]!;
          const extraShrunk = await shrinkToFit(extraBuf, mediaType);
          const extraPreview = await downscaleForPreview(extraShrunk.buffer);
          imagePreviews.push({
            base64: extraPreview.toString("base64"),
            mediaType: extraShrunk.mediaType,
            path: extraPath,
          });
        }

        const summary =
          savedPaths.length === 1
            ? `Generated image → ${primaryPath}`
            : `Generated ${savedPaths.length} images → ${savedPaths.join(", ")}`;

        const allContent: StructuredToolResult["content"] = [
          { type: "text", text: `${failure ? completionReport() : summary}\n${sizeReport()}` },
          {
            type: "image",
            mediaType: detectedType,
            data: shrunk.toString("base64"),
          },
        ];

        return {
          content: allContent,
          imageResult: {
            version: 1,
            images: imagePreviews.map(({ base64, mediaType, path }) => ({
              type: "image", data: base64, mediaType, path,
            })),
          },
          details: { imagePreviews, sizing, requestedCount, savedCount: savedPaths.length, savedPaths, failure },
          ...(failure ? { isError: true } : {}),
        };
      } catch (err) {
        if (savedPaths.length > 0) {
          const reason = err instanceof Error ? err.message : String(err);
          failure = failure ? `${failure}; preview failed: ${reason}` : `Preview failed: ${reason}`;
          return {
            content: `${completionReport()}\n${sizeReport()}`,
            details: { sizing, requestedCount, savedCount: savedPaths.length, savedPaths, failure },
            isError: true,
          };
        }
        if (context.signal.aborted) return { content: "Image generation aborted.", isError: true };
        const reason = err instanceof Error ? err.message : String(err);
        return { content: `Image generation failed: ${reason}`, isError: true };
      }
    },
  };
}

/** Insert a numeric index before the extension for multi-image output. */
function insertIndex(filePath: string, index: number): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}_${index}${ext}`;
}

/**
 * Call the Codex responses endpoint with the `image_generation` built-in tool.
 * Reads the SSE stream and extracts base64 image data from
 * `response.output_item.done` events where `item.type === "image_generation_call"`.
 *
 * The Codex backend requires `stream: true` and the ChatGPT OAuth token (which
 * our auth.openai.com PKCE flow produces). The top-level model orchestrates the
 * request; imageTool.model selects the GPT Image model separately.
 */
async function callImageGeneration(
  inputContent: Array<Record<string, unknown>>,
  imageTool: Record<string, unknown>,
  token: string,
  accountId: string | undefined,
  signal: AbortSignal,
): Promise<Buffer[]> {
  signal.throwIfAborted();
  const profile = codexRequestProfile(IMAGE_GEN_MODEL, "low");
  // Responses-Lite rejects hosted image tools; retain the normal chat profile unchanged.
  delete profile.headers["X-OpenAI-Internal-Codex-Responses-Lite"];
  const body: Record<string, unknown> = {
    model: IMAGE_GEN_MODEL,
    store: false,
    stream: true,
    instructions: "Generate the image the user requested.",
    input: [{ role: "user", content: inputContent }],
    tools: [imageTool],
    tool_choice: "auto",
    reasoning: profile.reasoning,
    parallel_tool_calls: profile.parallelToolCalls,
    include: ["reasoning.encrypted_content"],
  };

  const response = await fetch(CODEX_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      Accept: "text/event-stream",
      ...profile.headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: string; error?: { message?: string } };
      if (parsed.detail) detail = parsed.detail;
      else if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Keep raw text
    }
    throw new Error(`OpenAI Image API (${response.status}): ${detail}`);
  }

  if (!response.body) {
    throw new Error("OpenAI Image API returned no response body.");
  }

  // Read the SSE stream and extract image_generation_call output items.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const imageBuffers: Buffer[] = [];

  let completed = false;
  const eventSchema = z.object({
    type: z.string(),
    message: z.string().optional(),
    response: z
      .object({
        model: z.string().optional(),
        status: z.string().optional(),
        error: z.object({ message: z.string().optional() }).nullish(),
      })
      .optional(),
    item: z
      .object({
        type: z.string(),
        model: z.string().optional(),
        status: z.string().optional(),
        result: z.string().nullish(),
      })
      .optional(),
  });
  function consume(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    // Only complete lines reach JSON parsing; malformed events are not fragments.
    const evt = eventSchema.parse(JSON.parse(data));
    if (evt.response?.model && evt.response.model !== IMAGE_GEN_MODEL) {
      throw new Error("Image orchestration model substitution rejected.");
    }
    if (
      evt.type === "error" ||
      evt.type === "response.failed" ||
      evt.type === "response.incomplete" ||
      evt.response?.error ||
      evt.response?.status === "failed" ||
      evt.response?.status === "incomplete"
    ) {
      throw new Error(
        evt.response?.error?.message ?? evt.message ?? `Astra image request failed (${evt.type}).`,
      );
    }
    if (evt.type === "response.completed") completed = true;
    if (evt.type === "response.output_item.done" && evt.item?.type === "image_generation_call") {
      if (evt.item.model && evt.item.model !== imageTool.model) {
        throw new Error("Image model substitution rejected.");
      }
      if (evt.item.status !== "completed" || !evt.item.result) {
        throw new Error("Image tool did not complete with a result.");
      }
      const image = Buffer.from(evt.item.result, "base64");
      if (imageBuffers.length >= 4 || image.toString("base64") !== evt.item.result) {
        throw new Error("Invalid image result data.");
      }
      imageBuffers.push(image);
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 128 * 1024 * 1024) throw new Error("Image stream event exceeds 128 MiB.");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    signal.throwIfAborted();
    if (!completed) throw new Error("Astra image stream ended before response completion.");
    return imageBuffers;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
