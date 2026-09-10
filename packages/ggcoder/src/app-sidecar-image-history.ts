import fs from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "@kenkaiiii/gg-ai";
import { downscaleForPreview } from "./utils/image.js";

type HistoryImage = { src: string; path?: string };

async function existingOriginal(value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) return;
  try {
    return (await fs.stat(value)).isFile() ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Session metadata is untrusted. Reject the entire association rather than shifting image indexes. */
function imageResult(value: unknown): ToolResult["imageResult"] {
  if (!value || typeof value !== "object") return;
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || !Array.isArray(result.images) || result.images.length < 1 || result.images.length > 4) return;
  for (const value of result.images) {
    if (!value || typeof value !== "object") return;
    const image = value as Record<string, unknown>;
    if (image.type !== "image" || typeof image.path !== "string" || image.path.length > 32768 || /[\x00-\x1f\x7f]/.test(image.path)) return;
    if (!path.isAbsolute(image.path) || !["image/png", "image/jpeg", "image/webp"].includes(String(image.mediaType))) return;
    if (typeof image.data !== "string" || image.data.length === 0 || image.data.length > 2_000_000 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return;
  }
  return value as NonNullable<ToolResult["imageResult"]>;
}

/** Display-only previews survive storage without adding more images to model context. */
export async function restoreToolImages(result: ToolResult): Promise<HistoryImage[]> {
  const metadata = imageResult(result.imageResult);
  if (metadata) {
    return Promise.all(metadata.images.map(async (image) => ({
      src: `data:${image.mediaType};base64,${image.data}`,
      path: await existingOriginal(image.path),
    })));
  }
  if (!Array.isArray(result.content)) return [];
  const blocks = result.content.filter((block) => block.type === "image");
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  // Only a whole, single-image summary can identify a legacy original. Never split
  // comma-separated output or share one path across several images.
  const summary = text.split("\n")[0] ?? "";
  const legacyPath = result.imageResult === undefined && blocks.length === 1
    ? /^(?:Generated image → (.+)|Captured .+ → (.+) \[image\/(?:png|jpeg|webp)\] \(\d+×\d+\))$/.exec(summary)
    : null;
  const original = await existingOriginal(legacyPath?.[1] ?? legacyPath?.[2]);
  return Promise.all(blocks.map(async (block) => {
    let data = block.data;
    try {
      data = (await downscaleForPreview(Buffer.from(data, "base64"))).toString("base64");
    } catch {
      // Preserve the old preview, but never invent access to a missing original.
    }
    return { src: `data:${block.mediaType};base64,${data}`, path: original };
  }));
}
