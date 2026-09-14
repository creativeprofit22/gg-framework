import type { Provider } from "@kenkaiiii/gg-ai";
import { getDefaultModel, getModel } from "./model-registry.js";

export function resolveRpcModel(provider: Provider, explicitModel: string | undefined): string {
  return explicitModel ?? getDefaultModel(provider).id;
}

export function resolveSavedCliModel(provider: Provider, savedModel: string | undefined): string {
  const registeredModel = savedModel ? getModel(savedModel) : undefined;
  return registeredModel?.provider === provider
    ? registeredModel.id
    : getDefaultModel(provider).id;
}

export function resolveInteractiveCliModel(
  provider: Provider,
  explicitModel: string | undefined,
  savedModel: string | undefined,
): string {
  if (explicitModel === undefined) return resolveSavedCliModel(provider, savedModel);

  const registeredModel = getModel(explicitModel);
  if (!registeredModel) {
    throw new Error(`Unknown --model value "${explicitModel}".`);
  }
  if (registeredModel.provider !== provider) {
    throw new Error(
      `Model "${explicitModel}" belongs to ${registeredModel.provider}, not ${provider}.`,
    );
  }
  return registeredModel.id;
}
