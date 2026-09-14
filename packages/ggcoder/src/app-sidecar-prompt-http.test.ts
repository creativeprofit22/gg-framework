import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withRealSidecar } from "./test-support/real-sidecar.js";

const attachment = { kind: "file", name: "notes.txt", mediaType: "text/plain", data: "aGVsbG8=" };

it.each([false, true])("rejects a fresh prompt when its required append fails (attachments=%s)", async (withAttachment) => {
  await withRealSidecar(async ({ project, manager, open, request, subscribe }) => {
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
    const pane = await open(saved.path);
    const stream = await subscribe(pane);
    // A directory at the session file is a deterministic append failure on every OS.
    await fs.rename(saved.path, `${saved.path}.backup`);
    await fs.mkdir(saved.path);
    const response = await request("/prompt", pane, { text: "Keep this retryable prompt",
      attachments: withAttachment ? [attachment] : [], meta: { kenSent: true } });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "prompt_not_accepted" });
    await stream.waitFor("error");
    // Failure releases startup ownership, allowing a non-generating command.
    const command = await request("/prompt", pane, { text: "/help" });
    expect(command.status).toBe(202);
    expect(await command.json()).toEqual({ queued: false, count: 0 });
  });
}, 60_000);

it.each(["text", "attachment", "template"])("accepts persisted %s before held generation and preserves the queued receipt", async (kind) => {
  await withRealSidecar(async ({ project, manager, open, request, subscribe, generation }) => {
    await fs.mkdir(path.join(project, ".gg", "commands"), { recursive: true });
    await fs.writeFile(path.join(project, ".gg", "commands", "fixture.md"), "A fixture template prompt");
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
    const pane = await open(saved.path);
    const stream = await subscribe(pane);
    const response = await request("/prompt", pane, {
      text: kind === "template" ? "/fixture" : "Persist before accepting",
      attachments: kind === "attachment" ? [attachment] : [],
    });
    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt).toEqual({ queued: false, count: 0 });
    await generation.started;
    const entries = (await fs.readFile(saved.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    expect(stream.events.filter((event) => event.type === "error")).toEqual([]);
    const text = "Queue while generating\n\nReferenced files:\n- src/context.ts";
    const queued = await request("/prompt", pane, { text, attachments: [attachment] });
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({ queued: true, count: 1, queueId: "q1" });
    const snapshot = await stream.waitFor("queued");
    expect(snapshot.data).toEqual({ count: 1, messages: [{ id: "q1", text }] });
    const duplicate = await request("/prompt", pane, { text });
    expect(await duplicate.json()).toEqual({ queued: true, count: 2, queueId: "q2" });
    const secondSnapshot = await stream.waitFor("queued", 2);
    expect(secondSnapshot.data).toEqual({ count: 2, messages: [{ id: "q1", text }, { id: "q2", text }] });
    generation.release();
    const failure = await stream.waitFor("error");
    expect(JSON.stringify(failure.data)).toContain("Fixture generation failed after acceptance");
    // A later provider failure is SSE-only: the accepted receipt cannot become retryable.
    expect(receipt).toEqual({ queued: false, count: 0 });
  });
}, 60_000);
