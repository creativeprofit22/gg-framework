// Provider-coupled defaults live in @kenkaiiii/gg-core. This app shim adds the
// environment-defined Azure deployment without changing the shared registry.
import type { Provider } from "@kenkaiiii/gg-ai";
import { getModel, MODELS, type ModelInfo } from "@kenkaiiii/gg-core/models";
import {
  AZURE_OPENAI_PROVIDER,
  resolveAzureOpenAIConfig,
  type AzureOpenAIEnvironment,
} from "./auth-storage.js";

export const AZURE_MODEL_ID_PREFIX = `${AZURE_OPENAI_PROVIDER}:`;

export function azureModelId(deployment: string): string {
  return `${AZURE_MODEL_ID_PREFIX}${deployment}`;
}

export function resolveTransportModel(
  provider: Provider,
  modelId: string,
  environment: AzureOpenAIEnvironment = process.env,
): string {
  if (provider !== AZURE_OPENAI_PROVIDER) return modelId;

  const config = resolveAzureOpenAIConfig(environment);
  if (!config) return modelId;

  const configuredModelId = azureModelId(config.deployment);
  if (modelId !== configuredModelId) {
    throw new Error(
      `Azure OpenAI model "${modelId}" does not match configured deployment "${configuredModelId}".`,
    );
  }
  return config.deployment;
}

export function getModelDisplayId(modelId: string): string {
  return modelId.startsWith(AZURE_MODEL_ID_PREFIX)
    ? modelId.slice(AZURE_MODEL_ID_PREFIX.length)
    : modelId;
}

type AzureIdentityCapabilities = Omit<ModelInfo, "name" | "provider">;

const GPT_56_CAPABILITIES = {
  contextWindow: 1_050_000,
  codexContextWindow: 272_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
  supportsImages: true,
  supportsVideo: false,
} as const;

/**
 * Upstream retired GPT-5.6 from the OpenAI catalog, but an Azure customer can
 * still run a GPT-5.6 deployment. Keep its capabilities for Azure identity
 * mapping only, so such a deployment is not downgraded to the conservative
 * fallback. These entries never reappear in the OpenAI model menu.
 */
const RETIRED_AZURE_IDENTITIES: readonly AzureIdentityCapabilities[] = [
  { id: "gpt-5.6-sol", ...GPT_56_CAPABILITIES, defaultThinkingLevel: "low", costTier: "high", maxThinkingLevel: "ultra" },
  { id: "gpt-5.6-terra", ...GPT_56_CAPABILITIES, defaultThinkingLevel: "medium", costTier: "medium", maxThinkingLevel: "ultra" },
  { id: "gpt-5.6-luna", ...GPT_56_CAPABILITIES, defaultThinkingLevel: "medium", costTier: "low", maxThinkingLevel: "max" },
];

export function registerConfiguredAzureModel(
  environment: AzureOpenAIEnvironment = process.env,
): ModelInfo | undefined {
  const config = resolveAzureOpenAIConfig(environment);
  if (!config) return undefined;

  const id = azureModelId(config.deployment);
  const existing = MODELS.find((model) => model.id === id);
  if (existing) return existing;

  const modelIdentity = config.modelIdentity ?? config.deployment;
  const identityModel: AzureIdentityCapabilities | undefined =
    MODELS.find((candidate) => candidate.provider === "openai" && candidate.id === modelIdentity) ??
    RETIRED_AZURE_IDENTITIES.find((candidate) => candidate.id === modelIdentity);
  const conservativeCapabilities: Omit<ModelInfo, "id" | "name" | "provider"> = {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsThinking: false,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "low",
  };
  const model: ModelInfo = {
    ...(identityModel ?? conservativeCapabilities),
    id,
    name: `Azure OpenAI (${config.deployment})`,
    provider: AZURE_OPENAI_PROVIDER,
    modelIdentity: identityModel?.id ?? config.modelIdentity,
  };
  MODELS.push(model);
  return model;
}

registerConfiguredAzureModel();

export function resolveModelMaxTokens(modelId: string, maxTokens?: number): number {
  const modelMaxTokens = getModel(modelId)?.maxOutputTokens;
  if (maxTokens) return modelMaxTokens ? Math.min(maxTokens, modelMaxTokens) : maxTokens;
  return modelMaxTokens ?? 16_384;
}

export * from "@kenkaiiii/gg-core/models";
