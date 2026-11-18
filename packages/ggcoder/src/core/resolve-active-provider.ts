import type { Provider } from "@kenkaiiii/gg-ai";
import chalk from "chalk";
import type { AuthStorage } from "./auth-storage.js";
import { getDefaultModel, getModel } from "./model-registry.js";
import { isStartableProvider } from "./resolve-start.js";

export type ActiveProviderAuth = Pick<
  AuthStorage,
  "hasProviderAuth" | "legacySignIns" | "takeLegacySignIn"
>;

/**
 * Pick the provider/model to start with. If the preferred provider isn't
 * one the user is logged into, fall back to the first provider they ARE
 * logged into (in `allProviders` order). Throws if nothing is logged in.
 *
 * This prevents the CLI from crashing with "Not logged in" on startup just
 * because settings.json remembers a provider the user later logged out of.
 */
export async function resolveActiveProvider(
  authStorage: ActiveProviderAuth,
  preferred: Provider,
  savedModel: string | undefined,
  providerWasExplicit = false,
): Promise<{ provider: Provider; model: string; loggedInProviders: Provider[] }> {
  const allProviders: Provider[] = [
    "anthropic",
    "xiaomi",
    "openai",
    "azure",
    "gemini",
    "glm",
    "moonshot",
    "minimax",
    "deepseek",
    "openrouter",
    "opencode-go",
    "opencode",
    "sakana",
    "xai",
  ];
  // Retired sign-ins (old Claude, Codex, Kimi, Grok or Google tokens) are never
  // used. Tell the user once, then remove them.
  for (const retired of await authStorage.legacySignIns()) {
    if (!(await authStorage.takeLegacySignIn(retired.provider))) continue;
    console.warn(chalk.yellow(`⚠ ${retired.message}\n  Run "ggcoder login" to connect again.`));
  }
  // Qwen is opt-in only: neither fall into it nor silently leave it on missing auth.
  if (preferred === "qwen-cloud") {
    if (!(await authStorage.hasProviderAuth(preferred))) {
      throw new Error("Qwen Cloud requires dedicated Token Plan runtime authentication.");
    }
    const savedModelInfo = savedModel ? getModel(savedModel) : undefined;
    return {
      provider: preferred,
      model:
        savedModelInfo?.provider === preferred ? savedModelInfo.id : getDefaultModel(preferred).id,
      loggedInProviders: [preferred],
    };
  }
  const loggedInProviders: Provider[] = [];
  // Local Fork: an Azure key without a deployment has no model to start with.
  for (const p of allProviders) {
    if (isStartableProvider(p) && (await authStorage.hasProviderAuth(p))) loggedInProviders.push(p);
  }

  if (loggedInProviders.length === 0) {
    throw new Error('Not logged in to any provider. Run "ggcoder login" to authenticate.');
  }

  if (loggedInProviders.includes(preferred)) {
    const savedModelInfo = savedModel ? getModel(savedModel) : undefined;
    return {
      provider: preferred,
      model:
        savedModelInfo?.provider === preferred ? savedModelInfo.id : getDefaultModel(preferred).id,
      loggedInProviders,
    };
  }

  if (providerWasExplicit) {
    // Throws the clear "no Azure deployment" error instead of "not logged in".
    if (!isStartableProvider(preferred)) getDefaultModel(preferred);
    throw new Error(`Not logged in to ${preferred}. Run "ggcoder login" to authenticate.`);
  }

  // Preferred provider isn't authenticated — fall back to the first one
  // that is, and use that provider's default model (the saved model
  // belonged to a provider the user can no longer reach).
  const provider = loggedInProviders[0]!;
  return { provider, model: getDefaultModel(provider).id, loggedInProviders };
}
