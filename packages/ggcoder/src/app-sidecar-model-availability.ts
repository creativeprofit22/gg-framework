import { resolveFastModeModel, type Provider } from "@kenkaiiii/gg-ai";
import { fetchChatGPTPlanModels, getAuthStorageKeys, requiredKeyLabel } from "@kenkaiiii/gg-core";
import { getAllModels } from "./core/model-registry.js";
import { log } from "./core/logger.js";
import type { AuthStorage } from "./core/auth-storage.js";

/** How long the ChatGPT plan's model list is trusted before it is read again. */
const PLAN_MODELS_TTL_MS = 10 * 60_000;
const planModelCache = new Map<string, { at: number; models: Promise<string[] | undefined> }>();

/** The models the signed-in ChatGPT plan serves, or undefined when unknown (offline, error). */
function chatgptPlanModels(accountId: string, accessToken: string): Promise<string[] | undefined> {
  const cached = planModelCache.get(accountId);
  if (cached && Date.now() - cached.at < PLAN_MODELS_TTL_MS) return cached.models;
  const models = fetchChatGPTPlanModels(accessToken).catch((err: unknown) => {
    log("WARN", "app-sidecar", "ChatGPT plan model list unavailable", {
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  });
  planModelCache.set(accountId, { at: Date.now(), models });
  return models;
}

/**
 * Why each model can't run on what the user connected, so the picker can say
 * so instead of letting the request fail: a model the ChatGPT plan doesn't
 * serve, or one that needs a particular key (Kimi Code plan, MiMo API Credits).
 */
export async function unavailableModelReasons(
  auth: Pick<AuthStorage, "resolveCredentials" | "pickStorageKey">,
  loggedIn: Provider[],
): Promise<(modelId: string) => string | undefined> {
  let planModels: string[] | undefined;
  if (loggedIn.includes("openai")) {
    const creds = await auth.resolveCredentials("openai").catch(() => undefined);
    if (creds?.accountId) planModels = await chatgptPlanModels(creds.accountId, creds.accessToken);
  }
  const keyed = new Map<string, boolean>();
  const hasAnyKey = async (keys: string[]): Promise<boolean> => {
    const id = keys.join(",");
    if (!keyed.has(id)) keyed.set(id, (await auth.pickStorageKey(keys)) !== undefined);
    return keyed.get(id)!;
  };
  const reasons = new Map<string, string>();
  for (const m of getAllModels()) {
    if (!loggedIn.includes(m.provider)) continue;
    if (m.provider === "openai" && planModels) {
      const base = resolveFastModeModel("openai", m.id).model;
      if (!planModels.includes(base)) reasons.set(m.id, "Not in your ChatGPT plan");
      continue;
    }
    const keys = getAuthStorageKeys(m.provider, m.id);
    const needs = requiredKeyLabel(m.provider, keys);
    if (needs && !(await hasAnyKey(keys))) reasons.set(m.id, needs);
  }
  return (modelId) => reasons.get(modelId);
}
