import { expect, it } from "vitest";
import { withRealSidecar } from "./test-support/real-sidecar.js";

it("rejects invalid direct programmatic focus before starting the source daemon run", async () => {
  await withRealSidecar(async ({ project, manager, open, request }) => {
    const saved = await manager.create(project, "openai", "gpt-5", {
      openAICodexContextProfile: "stable",
    });
    const sessionId = await open(saved.path);
    const before = await (await request("/history", sessionId)).json();
    for (const focus of ["x".repeat(4_001), "invalid\u0000focus", "invalid\u0085focus"]) {
      const response = await request("/prompt", sessionId, { text: `/programmatic ${focus}` });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "command_input_not_allowed",
        message: "Use an optional focus of at most 4,000 characters without control characters (newlines and tabs are allowed).",
      });
      const state = await (await request("/state", sessionId)).json();
      expect(state.running).toBe(false);
    }
    expect(await (await request("/history", sessionId)).json()).toEqual(before);
  });
}, 45_000);
