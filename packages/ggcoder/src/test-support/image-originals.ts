import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ToolResult } from "@kenkaiiii/gg-ai";

/** Offline, distinct originals; previews intentionally differ from the saved bytes. */
export async function imageOriginals(project: string) {
  const directory = path.join(project, "my images, originals");
  await fs.mkdir(directory);
  const images: NonNullable<ToolResult["imageResult"]>["images"] = [];
  const hashes: string[] = [];
  for (const colour of ["red", "blue"]) {
    const original = await sharp({ create: { width: 16, height: 16, channels: 3, background: colour } }).png().toBuffer();
    const file = path.join(directory, `${colour}, original image.png`);
    await fs.writeFile(file, original, { flag: "wx" });
    hashes.push(createHash("sha256").update(original).digest("hex"));
    images.push({ type: "image", mediaType: "image/png", data: (await sharp(original).resize(8, 8).png().toBuffer()).toString("base64"), path: file });
  }
  const result: ToolResult = {
    type: "tool_result", toolCallId: "generated-images",
    content: [
      { type: "text", text: `Generated 2 images → ${images.map((image) => image.path).join(", ")}` },
      { type: "image", mediaType: images[0]!.mediaType, data: images[0]!.data },
    ],
    imageResult: { version: 1, images },
  };
  return { result, images, hashes };
}
