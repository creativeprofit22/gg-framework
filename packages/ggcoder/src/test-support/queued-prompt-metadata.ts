import fs from "node:fs/promises";
import type { Message } from "@kenkaiiii/gg-ai";
import { withRealSidecar } from "./real-sidecar.js";

export const queuedSegments = [
  { kind: "text" as const, text: "Use " },
  { kind: "term" as const, text: "TypeScript", original: "type script", note: "Language name" },
];

/** Real HTTP, queue consumption, disk reopen and history reconstruction; generation alone is replaced. */
export async function queuedPromptMetadataRoundTrip(mode: "steering" | "stranded", withAttachment = false) {
  return withRealSidecar(async ({ project, manager, open, request, subscribe, generation }) => {
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
    const pane = await open(saved.path);
    const stream = await subscribe(pane);
    const idle = await request("/prompt", pane, { text: "Idle control", meta: { kenSent: true } });
    if (idle.status !== 202) throw new Error("Idle prompt not accepted");
    await generation.started;
    const attachments = [];
    if (withAttachment) {
      const { default: sharp } = await import("sharp");
      const image = await sharp({ create: { width: 8, height: 8, channels: 3,
        background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
      attachments.push({ kind: "image", name: "pixel.png", mediaType: "image/png", data: image.toString("base64") });
    }
    for (const prompt of [
      { text: "Use TypeScript", meta: { enhancements: queuedSegments }, attachments },
      { text: "Cancelled prompt", meta: { kenSent: true, enhancements: queuedSegments } },
      { text: "Ken queued prompt", meta: { kenSent: true } },
    ]) {
      const response = await request("/prompt", pane, prompt);
      if (response.status !== 202) throw new Error("Queued prompt not accepted");
    }
    const cancelled = await request("/queued/cancel", pane, { id: "q2" });
    if (!(await cancelled.json()).cancelled) throw new Error("Queue cancellation failed");
    const readEntries = async () => (await fs.readFile(saved.path, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: Message; data?: { kind?: string } });
    const hintsBeforeConsumption = (await readEntries()).filter((entry) => entry.data?.kind === "user_hint");
    generation.release();
    await stream.waitFor("run_end", mode === "steering" ? 1 : 3);
    const reopened = await open(saved.path);
    const response = await request("/history", reopened);
    if (!response.ok) throw new Error("Reopened history failed");
    const { history } = await response.json() as { history: Array<{
      role: "user" | "assistant"; text: string; kenSent?: boolean; enhancements?: typeof queuedSegments; images?: string[];
    }> };
    const modelMessages = (await readEntries()).flatMap((entry) => entry.message ? [entry.message] : []);
    return { history, modelMessages, hintsBeforeConsumption };
  }, { queueDrain: mode });
}
