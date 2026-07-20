import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS } from "@kenkaiiii/gg-core/models";
import {
  AuthStorage,
  NotLoggedInError,
  resolveAzureOpenAIConfig,
  type AzureOpenAIEnvironment,
} from "./auth-storage.js";
import {
  getDefaultModel,
  getModelDisplayId,
  registerConfiguredAzureModel,
  resolveTransportModel,
} from "./model-registry.js";
import { getSupportedThinkingLevels } from "./thinking-level.js";
import { resolveStartOrFallback } from "./resolve-start.js";

const completeEnvironment: AzureOpenAIEnvironment = {
  AZURE_OPENAI_API_KEY: "azure-test-secret",
  AZURE_OPENAI_BASE_URL:
    "https://example.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
  AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
};

const addedModelIds = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (let index = MODELS.length - 1; index >= 0; index--) {
    const model = MODELS[index];
    if (model?.provider === "azure" && addedModelIds.has(model.id)) MODELS.splice(index, 1);
  }
  addedModelIds.clear();
});

describe("Azure OpenAI app boundaries", () => {
  it("resolves complete config as ephemeral AuthStorage credentials", async () => {
    expect(resolveAzureOpenAIConfig(completeEnvironment)).toEqual({
      apiKey: "azure-test-secret",
      baseUrl:
        "https://example.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
      deployment: "gpt-5.6-sol",
    });

    const auth = new AuthStorage("unused-auth.json", completeEnvironment);
    await expect(auth.hasProviderAuth("azure")).resolves.toBe(true);
    await expect(auth.resolveCredentials("azure")).resolves.toEqual({
      accessToken: "azure-test-secret",
      refreshToken: "",
      expiresAt: Number.POSITIVE_INFINITY,
      baseUrl:
        "https://example.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
    });
  });

  it.each(["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_DEPLOYMENT"] as const)(
    "rejects config missing %s at both app boundaries",
    async (missing) => {
      const environment = { ...completeEnvironment, [missing]: "  " };
      expect(resolveAzureOpenAIConfig(environment)).toBeUndefined();

      const auth = new AuthStorage("unused-auth.json", environment);
      await expect(auth.hasProviderAuth("azure")).resolves.toBe(false);
      await expect(auth.resolveCredentials("azure")).rejects.toBeInstanceOf(NotLoggedInError);

      const before = MODELS.length;
      expect(registerConfiguredAzureModel(environment)).toBeUndefined();
      expect(MODELS).toHaveLength(before);
    },
  );

  it.each([
    ["256 ASCII bytes", "a".repeat(256)],
    ["256 multibyte UTF-8 bytes", "é".repeat(128)],
  ])("accepts a deployment containing %s", async (_description, deployment) => {
    const environment = { ...completeEnvironment, AZURE_OPENAI_DEPLOYMENT: deployment };
    expect(resolveAzureOpenAIConfig(environment)?.deployment).toBe(deployment);

    const auth = new AuthStorage("unused-auth.json", environment);
    await expect(auth.hasProviderAuth("azure")).resolves.toBe(true);

    const modelId = `azure:${deployment}`;
    addedModelIds.add(modelId);
    expect(registerConfiguredAzureModel(environment)?.id).toBe(modelId);
  });

  it.each([
    ["257 ASCII bytes", "a".repeat(257)],
    ["258 multibyte UTF-8 bytes", "é".repeat(129)],
    ["257 mixed UTF-8 bytes", `${"a".repeat(255)}é`],
    ["an embedded C0 control character", "deployment\u0000name"],
    ["an embedded C1 control character", "deployment\u0085name"],
  ])(
    "rejects a deployment containing %s at every app boundary",
    async (_description, deployment) => {
      const environment = { ...completeEnvironment, AZURE_OPENAI_DEPLOYMENT: deployment };
      expect(resolveAzureOpenAIConfig(environment)).toBeUndefined();

      const auth = new AuthStorage("unused-auth.json", environment);
      await expect(auth.hasProviderAuth("azure")).resolves.toBe(false);
      await expect(auth.resolveCredentials("azure")).rejects.toBeInstanceOf(NotLoggedInError);

      const before = MODELS.length;
      expect(registerConfiguredAzureModel(environment)).toBeUndefined();
      expect(MODELS).toHaveLength(before);
    },
  );

  it.each([
    "not-a-url",
    "https://example.openai.azure.com/openai/v1",
    "http://example.openai.azure.com/openai/v1/responses",
    "https://user:password@example.openai.azure.com/openai/v1/responses",
    "https://example.openai.azure.com/openai/v1/responses#fragment",
    "https://example.openai.azure.com/openai/v1/responses/",
  ])("rejects non-strict Responses endpoint %s at every app boundary", async (baseUrl) => {
    const environment = { ...completeEnvironment, AZURE_OPENAI_BASE_URL: baseUrl };
    expect(resolveAzureOpenAIConfig(environment)).toBeUndefined();

    const auth = new AuthStorage("unused-auth.json", environment);
    await expect(auth.hasProviderAuth("azure")).resolves.toBe(false);
    await expect(auth.resolveCredentials("azure")).rejects.toBeInstanceOf(NotLoggedInError);

    const before = MODELS.length;
    expect(registerConfiguredAzureModel(environment)).toBeUndefined();
    expect(MODELS).toHaveLength(before);
  });

  it("registers and selects a namespaced Azure deployment alongside the same OpenAI model ID", async () => {
    addedModelIds.add("azure:gpt-5.6-sol");
    const openAIModel = MODELS.find(
      (candidate) => candidate.id === "gpt-5.6-sol" && candidate.provider === "openai",
    );
    const model = registerConfiguredAzureModel(completeEnvironment);

    expect(openAIModel).toBeDefined();
    expect(model).toMatchObject({
      id: "azure:gpt-5.6-sol",
      name: "Azure OpenAI (gpt-5.6-sol)",
      provider: "azure",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsThinking: false,
      supportsImages: false,
      supportsVideo: false,
      maxThinkingLevel: "low",
    });
    expect(JSON.stringify(model)).not.toContain("azure-test-secret");
    expect(registerConfiguredAzureModel(completeEnvironment)).toBe(model);
    expect(MODELS.filter((candidate) => candidate.id === "gpt-5.6-sol")).toEqual([openAIModel]);
    expect(MODELS.filter((candidate) => candidate.id === "azure:gpt-5.6-sol")).toEqual([model]);
    expect(getDefaultModel("azure")).toBe(model);
    expect(getModelDisplayId(model!.id)).toBe("gpt-5.6-sol");
    expect(getSupportedThinkingLevels("azure", model!.id)).toEqual([]);
    expect(resolveTransportModel("azure", model!.id, completeEnvironment)).toBe("gpt-5.6-sol");

    const selected = await resolveStartOrFallback(
      { hasProviderAuth: async (provider) => provider === "azure" },
      ["openai", "azure"],
      "azure",
      model!.id,
    );
    expect(selected).toEqual({
      provider: "azure",
      model: "azure:gpt-5.6-sol",
      loggedIn: true,
    });
  });
});
