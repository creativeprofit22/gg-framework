import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Provider } from "@kenkaiiii/gg-ai";
import { MODELS, type ModelInfo } from "@kenkaiiii/gg-core/models";
import { getDefaultModel } from "./model-registry.js";
import { resolveActiveProvider, type ActiveProviderAuth } from "./resolve-active-provider.js";
import { resolveStartOrFallback } from "./resolve-start.js";

function auth(...connected: Provider[]): ActiveProviderAuth {
  const set = new Set<string>(connected);
  return {
    hasProviderAuth: async (p) => set.has(p),
    legacySignIns: async () => [],
    takeLegacySignIn: async () => false,
  };
}

// An Azure key with no deployment: the registry holds no Azure model at all.
const removedAzure: ModelInfo[] = [];
beforeAll(() => {
  for (let i = MODELS.length - 1; i >= 0; i--) {
    if (MODELS[i]!.provider === "azure") removedAzure.push(...MODELS.splice(i, 1));
  }
});
afterAll(() => {
  MODELS.push(...removedAzure);
});

describe("resolveActiveProvider with an Azure key but no deployment", () => {
  it("falls back to another signed-in provider when azure is saved", async () => {
    expect(await resolveActiveProvider(auth("azure", "openai"), "azure", undefined)).toEqual({
      provider: "openai",
      model: getDefaultModel("openai").id,
      loggedInProviders: ["openai"],
    });
  });

  it("does not pick azure even when it comes first among signed-in providers", async () => {
    const res = await resolveActiveProvider(auth("azure", "gemini"), "anthropic", undefined);
    expect(res.provider).toBe("gemini");
    expect(res.loggedInProviders).toEqual(["gemini"]);
  });

  it("reports a clear error instead of crashing when azure is the only sign-in", async () => {
    await expect(resolveActiveProvider(auth("azure"), "azure", undefined)).rejects.toThrow(
      "Not logged in to any provider",
    );
  });

  it("explains the missing deployment when azure was chosen explicitly", async () => {
    await expect(
      resolveActiveProvider(auth("azure", "openai"), "azure", undefined, true),
    ).rejects.toThrow("No Azure deployment is configured.");
  });

  it("keeps the desktop start path off azure too", async () => {
    const res = await resolveStartOrFallback(
      auth("azure"),
      ["anthropic", "azure"],
      "azure",
      undefined,
    );
    expect(res).toEqual({
      provider: "anthropic",
      model: getDefaultModel("anthropic").id,
      loggedIn: false,
    });
  });
});
