import type { Provider } from "@kenkaiiii/gg-ai";
import { getDefaultModel, getModel, getModelsForProvider } from "./model-registry.js";

// Local Fork: Azure has models only when a deployment is configured; without
// one it has no default, and choosing it crashed every new session.
export function isStartableProvider(provider: Provider): boolean {
  return provider !== "azure" || getModelsForProvider(provider).length > 0;
}

/** A resolved startup provider + model for an AgentSession. */
export interface ResolvedStart {
  provider: Provider;
  model: string;
}

/** The boot-time provider resolution, plus whether the user is logged in. */
export interface ResolvedStartResult extends ResolvedStart {
  /** False when no provider has usable credentials — the sidecar boots anyway
   *  (logged-out, login endpoints reachable) instead of crashing. */
  loggedIn: boolean;
}

/** Minimal auth surface needed to decide the startup provider (testable). */
export interface ProviderAuthLookup {
  hasProviderAuth(provider: string): Promise<boolean>;
}

/**
 * Pick a provider/model the user is logged into, preferring the saved defaults.
 * Mirrors the CLI's resolveActiveProvider, but NEVER throws when logged out:
 * instead it falls back to `preferred` + its default model and reports
 * `loggedIn: false`. This is what lets the gg-app sidecar boot (and serve the
 * login endpoints) for a fresh user with no credentials — throwing here used to
 * kill the sidecar before it listened, making login impossible.
 *
 * Credentials resolve lazily at prompt time, so a logged-out boot is safe: a
 * prompt sent before login fails cleanly through the run's error handling.
 */
export async function resolveStartOrFallback(
  auth: ProviderAuthLookup,
  allProviders: readonly Provider[],
  preferred: Provider,
  savedModel: string | undefined,
): Promise<ResolvedStartResult> {
  // Token Plan is explicit opt-in: never enter or leave it via startup fallback.
  if (preferred === "qwen-cloud") {
    const saved = savedModel ? getModel(savedModel) : undefined;
    return {
      provider: preferred,
      model: saved?.provider === preferred ? saved.id : getDefaultModel(preferred).id,
      loggedIn: await auth.hasProviderAuth(preferred),
    };
  }
  const loggedIn: Provider[] = [];
  for (const p of allProviders) {
    if (p !== "qwen-cloud" && isStartableProvider(p) && (await auth.hasProviderAuth(p)))
      loggedIn.push(p);
  }

  if (loggedIn.length === 0) {
    // Logged-out fallback: boot with the preferred provider's default model so
    // the sidecar still starts and the login flow is reachable.
    const provider = isStartableProvider(preferred) ? preferred : "anthropic";
    return { provider, model: getDefaultModel(provider).id, loggedIn: false };
  }

  if (loggedIn.includes(preferred)) {
    const saved = savedModel ? getModel(savedModel) : undefined;
    return {
      provider: preferred,
      model: saved?.provider === preferred ? saved.id : getDefaultModel(preferred).id,
      loggedIn: true,
    };
  }

  const provider = loggedIn[0]!;
  return { provider, model: getDefaultModel(provider).id, loggedIn: true };
}
