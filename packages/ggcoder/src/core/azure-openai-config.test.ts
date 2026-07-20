import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS } from "@kenkaiiii/gg-core/models";
import {
  AuthStorage,
  NotLoggedInError,
  resolveAzureOpenAIConfig,
  type AzureOpenAIEnvironment,
} from "./auth-storage.js";
import { registerConfiguredAzureModel } from "./model-registry.js";

const completeEnvironment: AzureOpenAIEnvironment = {
  AZURE_OPENAI_API_KEY: "azure-test-secret",
  AZURE_OPENAI_BASE_URL:
    "https://example.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
  AZURE_OPENAI_DEPLOYMENT: "coding-deployment",
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
      deployment: "coding-deployment",
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

  it("registers one complete Azure deployment without exposing its API key", () => {
    addedModelIds.add("coding-deployment");
    const model = registerConfiguredAzureModel(completeEnvironment);

    expect(model).toMatchObject({
      id: "coding-deployment",
      name: "Azure OpenAI (coding-deployment)",
      provider: "azure",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsThinking: false,
      supportsImages: false,
      supportsVideo: false,
    });
    expect(JSON.stringify(model)).not.toContain("azure-test-secret");
    expect(registerConfiguredAzureModel(completeEnvironment)).toBe(model);
    expect(MODELS.filter((candidate) => candidate.id === "coding-deployment")).toHaveLength(1);
  });

  it("rejects a deployment ID collision without changing the registry", () => {
    const collidingModel = MODELS.find((model) => model.provider !== "azure")!;
    const environment = {
      ...completeEnvironment,
      AZURE_OPENAI_DEPLOYMENT: collidingModel.id,
    };
    const before = [...MODELS];

    expect(() => registerConfiguredAzureModel(environment)).toThrow(
      `Azure OpenAI deployment ID "${collidingModel.id}" collides with the existing ${collidingModel.provider} model.`,
    );
    expect(MODELS).toEqual(before);
  });
});
