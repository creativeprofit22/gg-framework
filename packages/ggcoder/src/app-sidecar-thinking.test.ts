import { afterEach, describe, expect, it } from "vitest";
import { MODELS } from "@kenkaiiii/gg-core/models";
import type { AzureOpenAIEnvironment } from "./core/auth-storage.js";
import { registerConfiguredAzureModel } from "./core/model-registry.js";
import {
  clampThinkingLevel,
  getNextThinkingLevel,
  getSupportedThinkingLevels,
} from "./core/thinking-level.js";

const environment: AzureOpenAIEnvironment = {
  AZURE_OPENAI_API_KEY: "azure-test-secret",
  AZURE_OPENAI_BASE_URL:
    "https://example.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
  AZURE_OPENAI_DEPLOYMENT: "sidecar-thinking-test",
};
const modelId = "azure:sidecar-thinking-test";

afterEach(() => {
  const index = MODELS.findIndex((model) => model.id === modelId);
  if (index !== -1) MODELS.splice(index, 1);
});

describe("Azure sidecar thinking state", () => {
  it("keeps the thinking toggle off for a non-thinking Azure deployment", () => {
    const model = registerConfiguredAzureModel(environment)!;

    expect(getSupportedThinkingLevels(model.provider, model.id)).toEqual([]);
    expect(getNextThinkingLevel(model.provider, model.id, undefined)).toBeUndefined();
    expect(getNextThinkingLevel(model.provider, model.id, "high")).toBeUndefined();
  });

  it("clamps an existing thinking level off when switching to Azure", () => {
    const model = registerConfiguredAzureModel(environment)!;

    expect(clampThinkingLevel(model.provider, model.id, "high")).toBeUndefined();
  });
});
