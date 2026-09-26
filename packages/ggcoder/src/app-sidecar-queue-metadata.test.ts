import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { withRealSidecar } from "./test-support/real-sidecar.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./core/programmatic/profile.js";
import { queuedPromptMetadataRoundTrip, queuedSegments } from "./test-support/queued-prompt-metadata.js";

it("emits an exact cancellation ID only for success and preserves the consumed duplicate", async () => {
  await withRealSidecar(async ({ project, manager, open, request, subscribe, generation }) => {
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
    const pane = await open(saved.path);
    const stream = await subscribe(pane);
    expect((await request("/prompt", pane, { text: "held" })).status).toBe(202);
    await generation.started;
    for (const meta of [{ kenSent: true }, { enhancements: queuedSegments }]) {
      expect((await request("/prompt", pane, { text: "same", meta })).status).toBe(202);
    }
    await stream.waitFor("queued", 2);
    expect(await (await request("/queued/cancel", pane, { id: "q1" })).json()).toMatchObject({ cancelled: true });
    const cancelled = await stream.waitFor("queued", 3);
    expect(cancelled.data).toMatchObject({ cancelledId: "q1", count: 1, messages: [{ id: "q2", text: "same" }] });
    expect(await (await request("/queued/cancel", pane, { id: "q1" })).json()).toMatchObject({ cancelled: false });
    expect((await stream.waitFor("queued", 4)).data).not.toHaveProperty("cancelledId");
    generation.release();
    await stream.waitFor("run_end");
    const before = stream.events.filter(event => event.type === "queued").length;
    expect(await (await request("/queued/cancel", pane, { id: "q2" })).json()).toMatchObject({ cancelled: false });
    expect((await stream.waitFor("queued", before + 1)).data).not.toHaveProperty("cancelledId");
    const reopened = await open(saved.path);
    const history = await (await request("/history", reopened)).json();
    expect(history.history.filter((row: { role: string; text: string }) => row.role === "user" && row.text === "same")).toEqual([
      expect.objectContaining({ text: "same", enhancements: queuedSegments }),
    ]);
  }, { queueDrain: "steering" });
}, 60_000);

it.each([
  ["steering", false], ["stranded", false], ["steering", true], ["stranded", true],
] as const)("restores exact queued display hints through %s after cancellation (attachment=%s)", async (mode, withAttachment) => {
  const { history, modelMessages, hintsBeforeConsumption } = await queuedPromptMetadataRoundTrip(mode, withAttachment);
  expect(history.find((row) => row.text === "Use TypeScript")?.images?.length ?? 0).toBe(withAttachment ? 1 : 0);
  expect(hintsBeforeConsumption).toHaveLength(1); // Only the idle control, never guessed queue anchors.
  expect(JSON.stringify(modelMessages)).not.toMatch(/kenSent|enhancements|type script|Language name/);
  expect(JSON.stringify(modelMessages)).not.toContain("Cancelled prompt");
  expect(history.filter((row) => row.role === "user").map(({ text, kenSent, enhancements }) => ({
    text, kenSent, enhancements,
  }))).toEqual([
    { text: "Idle control", kenSent: true, enhancements: undefined },
    { text: "Use TypeScript", kenSent: undefined, enhancements: queuedSegments },
    { text: "Ken queued prompt", kenSent: true, enhancements: undefined },
  ]);
}, 60_000);

it.each([false, true])("rejects busy workflow HTTP requests with current setup=%s without queue hints or writes", async (approved) => {
  await withRealSidecar(async ({ project, manager, open, request, subscribe, generation }) => {
    if (approved) {
      const proposal = await buildProgrammaticProfileProposal(project);
      expect((await persistProgrammaticProfile(project, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
    }
    const profile = path.join(project, ".gg/programmatic/profile.json");
    const before = await fs.readFile(profile).catch(() => null);
    const saved = await manager.create(project, "openai", "gpt-5", { openAICodexContextProfile: "stable" });
    const pane = await open(saved.path);
    const events = await subscribe(pane);
    expect((await request("/prompt", pane, { text: "held initial request" })).status).toBe(202);
    await generation.started;
    for (const text of ["/setup-programmatic", "/programmatic", "/programmatic\tfocus", "/programmatic-run"]) {
      const response = await request("/prompt", pane, { text, meta: { kenSent: true } });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Wait for the current work to finish, then try again. This request was not added to a waiting list." });
    }
    expect(await fs.readFile(profile).catch(() => null)).toEqual(before);
    await expect(fs.stat(path.join(project, ".gg/programmatic/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const queued = await request("/prompt", pane, { text: "ordinary steering", meta: { kenSent: true } });
    expect(await queued.json()).toMatchObject({ queued: true, count: 1, queueId: "q1" });
    generation.release();
    await events.waitFor("run_end");
    expect(events.events.filter((event) => event.type === "run_start")).toHaveLength(1);
    const reopened = await open(saved.path);
    const history = await (await request("/history", reopened)).json();
    expect(history.history.filter((row: { role: string }) => row.role === "user")).toEqual([
      expect.objectContaining({ text: "held initial request" }),
      expect.objectContaining({ text: "ordinary steering", kenSent: true }),
    ]);
    expect(await fs.readFile(profile).catch(() => null)).toEqual(before);
  }, { queueDrain: "steering" });
}, 60_000);
