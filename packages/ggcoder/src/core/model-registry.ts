// Provider-coupled defaults live in @kenkaiiii/gg-core. This app shim adds the
// environment-defined Azure deployment without changing the shared registry.
import { MODELS, type ModelInfo } from "@kenkaiiii/gg-core/models";
import {
  AZURE_OPENAI_PROVIDER,
  resolveAzureOpenAIConfig,
  type AzureOpenAIEnvironment,
} from "./auth-storage.js";

export function registerConfiguredAzureModel(
  environment: AzureOpenAIEnvironment = process.env,
): ModelInfo | undefined {
  const config = resolveAzureOpenAIConfig(environment);
  if (!config) return undefined;

  const existing = MODELS.find((model) => model.id === config.deployment);
  if (existing) {
    if (existing.provider === AZURE_OPENAI_PROVIDER) return existing;
    throw new Error(
      `Azure OpenAI deployment ID "${config.deployment}" collides with the existing ${existing.provider} model.`,
    );
  }

  const model: ModelInfo = {
    id: config.deployment,
    name: `Azure OpenAI (${config.deployment})`,
    provider: AZURE_OPENAI_PROVIDER,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsThinking: false,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "high",
  };
  MODELS.push(model);
  return model;
}

registerConfiguredAzureModel();

export * from "@kenkaiiii/gg-core/models";
