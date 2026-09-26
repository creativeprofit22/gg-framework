import { expect, it } from "vitest";
import { withRealSidecar } from "./test-support/real-sidecar.js";

it("shows and persists a refusal instead of silently forwarding an unhandled event", async () => {
  await withRealSidecar(async ({ project, manager, open, request, subscribe, generation }) => {
    const saved = await manager.create(project, "anthropic", "claude-opus-5", {
      openAICodexContextProfile: "stable",
    });
    const pane = await open(saved.path);
    const events = await subscribe(pane);
    expect((await request("/prompt", pane, { text: "Reply with exactly OK." })).status).toBe(202);
    await generation.started;
    generation.release();
    await events.waitFor("run_end");

    const refusal = events.events.find((event) => event.type === "error");
    expect(refusal?.data).toEqual({
      headline: "The provider declined this request.",
      message: "The model stopped with a refusal. This is not an empty-response or connection error.",
      guidance: "Review your request and the conversation context before trying again.",
    });
    expect(JSON.stringify(refusal?.data)).not.toContain("GG Coder bug");
    // Error-marker persistence is asynchronous; query the real history route until it appears.
    await expect.poll(async () => {
      const response = await request("/history", pane);
      const body = await response.json() as { history: Array<{ error?: Record<string, unknown> }> };
      return body.history.find((entry) => entry.error?.headline === refusal?.data.headline)?.error;
    }).toMatchObject(refusal!.data);
  }, { truncated: "refusal" });
}, 60_000);
