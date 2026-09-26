import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolResult } from "@kenkaiiii/gg-ai";
import { restoreToolImages } from "./app-sidecar-image-history.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const image = { type: "image" as const, mediaType: "image/png", data: "AA==" };
async function original() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-image-history-"));
  temporary.push(dir);
  const file = path.join(dir, "my images, original.png");
  await fs.writeFile(file, Buffer.from("original"));
  return file;
}
function legacy(text: string, count = 1): ToolResult {
  return { type: "tool_result", toolCallId: "image", content: [{ type: "text", text }, ...Array.from({ length: count }, () => image)] };
}

it("recovers only exact existing single-image legacy paths including spaces and commas", async () => {
  const file = await original();
  expect((await restoreToolImages(legacy(`Generated image → ${file}\nRequested: auto`)))[0]?.path).toBe(file);
  expect((await restoreToolImages(legacy(`Captured https://example.test → ${file} [image/png] (1280×800)`)))[0]?.path).toBe(file);
  for (const summary of [`Generated 2 images → ${file}, ${file}`, `Generated image → ${file},`, `prefix → ${file}`, `Generated image → ${file}.missing`]) {
    expect((await restoreToolImages(legacy(summary)))[0]?.path).toBeUndefined();
  }
  expect((await restoreToolImages(legacy(`Generated image → ${file}`, 2))).map((item) => item.path)).toEqual([undefined, undefined]);
});

it("keeps previews for missing originals without claiming access", async () => {
  const file = await original();
  const result: ToolResult = { ...legacy("ignored"), imageResult: { version: 1, images: [
    { ...image, path: file }, { ...image, data: "AQ==", path: `${file}.missing.png` },
  ] } };
  expect(await restoreToolImages(result)).toEqual([
    { src: "data:image/png;base64,AA==", path: file },
    { src: "data:image/png;base64,AQ==", path: undefined },
  ]);
  await fs.unlink(file);
  expect((await restoreToolImages(result)).map((item) => item.path)).toEqual([undefined, undefined]);
  expect((await restoreToolImages(result)).map((item) => item.src)).toEqual(["data:image/png;base64,AA==", "data:image/png;base64,AQ=="]);
});

it("fails closed on malformed metadata instead of guessing a legacy association", async () => {
  const file = await original();
  const valid = { version: 1, images: [{ ...image, path: file }] };
  const invalid: unknown[] = [
    null, { ...valid, version: 2 }, { ...valid, images: [] },
    { ...valid, images: Array(5).fill(valid.images[0]) },
    { ...valid, images: [valid.images[0], { ...valid.images[0], path: "relative.png" }] },
    { ...valid, images: [{ ...valid.images[0], data: "bad!" }, valid.images[0]] },
    ...[{ path: "relative.png" }, { path: `${file}\n` }, { data: "bad!" }, { data: "A".repeat(2_000_004) }, { mediaType: "image/svg+xml" }].map((change) => ({ ...valid, images: [{ ...valid.images[0], ...change }] })),
  ];
  for (const imageResult of invalid) {
    // JSON sessions are an untyped input boundary.
    const result = JSON.parse(JSON.stringify({ ...legacy(`Generated image → ${file}`), imageResult })) as ToolResult;
    expect((await restoreToolImages(result))[0]?.path).toBeUndefined();
  }
});
