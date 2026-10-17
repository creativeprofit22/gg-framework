import { expect, it } from "vitest";
import { withRealSidecar } from "./test-support/real-sidecar.js";

for (const connected of [false, true]) {
  it(`Qwen discovery is ${connected ? "connected" : "disconnected"} and generic routes cannot write Token Plan auth`, async () => {
    await withRealSidecar(
      async ({ project, manager, open, request }) => {
        const session = await manager.create(project, "anthropic", "claude-sonnet-4-6", {
          openAICodexContextProfile: "stable",
        });
        const id = await open(session.path);
        const response = await request("/models", id);
        expect(response.status).toBe(200);
        const { models } = (await response.json()) as { models: { provider: string }[] };
        expect(models.filter((m) => m.provider === "qwen-cloud")).toHaveLength(connected ? 11 : 0);
        for (const provider of ["qwen-cloud", "openai", "azure"]) {
          const rejected = await request("/auth/apikey", id, {
            provider,
            key: "sk-sp-fake-route-canary",
          });
          expect(rejected.status).toBe(400);
          expect(await rejected.text()).not.toContain("sk-sp-fake-route-canary");
        }
      },
      { qwenRuntimeKey: connected ? "sk-sp-fake-discovery-canary" : undefined },
    );
  }, 60_000);
}
