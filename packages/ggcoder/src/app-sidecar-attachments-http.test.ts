import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import sharp from "sharp";
import { withRealSidecar } from "./test-support/real-sidecar.js";

const file = { kind: "file", name: "notes.txt", mediaType: "text/plain", data: "aGVsbG8=" };
async function inlineImage() {
  const buffer = await sharp({ create: { width: 8, height: 8, channels: 3,
    background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
  return { kind: "image", name: "pixel.png", mediaType: "image/png", data: buffer.toString("base64") };
}

it.each([false, true].flatMap((busy) => ["", "Read this file"].map((text) => ({ busy, text }))))(
  "rejects unwritable attachments atomically (busy=$busy, text='$text')", async ({ busy, text }) => {
    await withRealSidecar(async ({ project, manager, open, request, subscribe, generation }) => {
      const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
      const pane = await open(saved.path);
      const stream = await subscribe(pane);
      if (busy) {
        expect((await request("/prompt", pane, { text: "Hold generation" })).status).toBe(202);
        await generation.started;
      }
      await fs.mkdir(path.join(project, ".gg"), { recursive: true });
      // A regular file cannot accept child writes, even with administrator permissions.
      await fs.writeFile(path.join(project, ".gg", "uploads"), "blocked");
      const before = await fs.readFile(saved.path, "utf8");
      const response = await request("/prompt", pane, { text, attachments: [file] });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "prompt_not_accepted",
        message: expect.stringContaining("notes.txt") });
      await stream.waitFor("error");
      // Reject the entire mixed batch, corrupt images downgraded to files, and
      // videos (whose model input requires the saved path rather than inline bytes).
      for (const attachments of [
        [await inlineImage(), file],
        [{ ...file, kind: "image", mediaType: "image/png" }],
        [{ ...file, kind: "video", mediaType: "video/mp4" }],
      ]) {
        const rejected = await request("/prompt", pane, { text, attachments });
        expect(rejected.status).toBe(500);
        expect(await rejected.json()).toMatchObject({ error: "prompt_not_accepted",
          message: expect.stringContaining("notes.txt") });
      }
      expect(stream.events.filter((event) => event.type === "queued")).toEqual([]);
      const userEntries = (value: string) => value.trim().split("\n").map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "message" && entry.message.role === "user");
      expect(userEntries(await fs.readFile(saved.path, "utf8"))).toEqual(userEntries(before));
      // Retry succeeds with the complete file, and no rejected queue entry remains.
      await fs.unlink(path.join(project, ".gg", "uploads"));
      const retry = await request("/prompt", pane, { text, attachments: [file] });
      expect(retry.status).toBe(202);
      expect(await retry.json()).toEqual(busy ? { queued: true, count: 1, queueId: "q1" } : { queued: false, count: 0 });
    });
  }, 60_000,
);

it("keeps valid inline image bytes when persistence fails", async () => {
  await withRealSidecar(async ({ project, manager, open, request }) => {
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
    const pane = await open(saved.path);
    await fs.mkdir(path.join(project, ".gg"), { recursive: true });
    await fs.writeFile(path.join(project, ".gg", "uploads"), "blocked");
    const image = await inlineImage();
    const response = await request("/prompt", pane, { text: "", attachments: [image] });
    expect(response.status, JSON.stringify(await response.json())).toBe(202);
    const entries = (await fs.readFile(saved.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    expect(user.message.content).toContainEqual({ type: "image", mediaType: "image/png", data: expect.any(String) });
    expect(user.message.content.find((part: { type: string }) => part.type === "image").data.length).toBeGreaterThan(0);
  });
}, 60_000);
