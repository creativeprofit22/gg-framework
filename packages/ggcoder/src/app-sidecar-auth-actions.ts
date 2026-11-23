import {
  NotLoggedInError,
  OPENAI_CHATGPT_KEY,
  apiKeyStorageKeys,
  dualAuthProvider,
  signInWithClaudeCode,
  signOutOfClaudeCode,
  type AuthStorage,
} from "@kenkaiiii/gg-core";
import { desktopGuidance } from "./app-sidecar/desktop-guidance.js";
import type { AuthMethod, AuthProviderMeta } from "./core/auth-providers.js";
import { loginChatGPT, revokeChatGPTSignIn } from "./core/oauth/openai.js";
import type { OAuthLoginCallbacks } from "./core/oauth/types.js";

/** Runs one provider's sign-in. Claude Code holds the Claude login (auth.json
 * gets only a marker); ChatGPT is stored apart from the OpenAI API key. */
export async function runProviderSignIn(
  provider: string,
  auth: AuthStorage,
  cb: OAuthLoginCallbacks,
  options: { newAccount?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (provider === "anthropic") {
    await signInWithClaudeCode(auth, cb);
  } else if (provider === "openai") {
    // The current sign-in's ID token skips the account picker; another account
    // or workspace registers afresh instead.
    const { newAccount, signal } = options;
    const previous = newAccount ? undefined : await auth.getCredentials(OPENAI_CHATGPT_KEY);
    const creds = await loginChatGPT(cb, {
      ...(previous ? { previous } : {}),
      ...(newAccount ? { newAccount } : {}),
      ...(signal ? { signal } : {}),
    });
    await auth.setCredentials(OPENAI_CHATGPT_KEY, creds);
  } else {
    throw new Error(`Sign-in not implemented for ${provider}`);
  }
}

/** Message shown inside the sign-in dialog: never CLI login advice. */
export function signInErrorMessage(err: unknown, label: string): string {
  if (err instanceof NotLoggedInError) return `${label} sign-in didn't finish. Try again.`;
  return desktopGuidance(err instanceof Error ? err.message : String(err));
}

/** Where an API key is stored: multi-variant providers use the chosen variant's
 * key/baseUrl (default first); others the provider id + flat apiKeyBaseUrl. */
export function apiKeyTarget(
  meta: AuthProviderMeta,
  provider: string,
  variant: string | undefined,
): { storageKey: string; baseUrl?: string } {
  const chosen = meta.apiKeyVariants?.find((v) => v.key === variant) ?? meta.apiKeyVariants?.[0];
  const baseUrl = chosen?.baseUrl ?? meta.apiKeyBaseUrl;
  return { storageKey: chosen?.key ?? provider, ...(baseUrl ? { baseUrl } : {}) };
}

/** Disconnects a provider. `legacy` dismisses a retired sign-in only; a dual-auth
 * provider can drop one method and keep the other; no method clears everything.
 * Returns whether OpenAI revoked the plan session, when it was asked. */
export async function runProviderLogout(
  provider: string,
  method: AuthMethod | "legacy" | undefined,
  auth: AuthStorage,
): Promise<{ revoked?: boolean }> {
  if (method === "legacy") {
    await auth.takeLegacySignIn(provider);
    return {};
  }
  const dual = dualAuthProvider(provider);
  let revoked: boolean | undefined;
  if (method !== "apikey") {
    if (provider === "anthropic") await signOutOfClaudeCode(auth);
    else if (dual) {
      const plan = await auth.getCredentials(dual.oauthKey);
      // End the renewable session at OpenAI before dropping it locally.
      if (provider === "openai" && plan) revoked = await revokeChatGPTSignIn(plan);
      await auth.clearCredentials(dual.oauthKey);
    }
  }
  if (method !== "oauth") {
    // Every API key the provider holds (plan + pay-per-token for Kimi/Xiaomi).
    for (const key of apiKeyStorageKeys(provider)) await auth.clearCredentials(key);
    await auth.takeLegacySignIn(provider);
  }
  return revoked !== undefined ? { revoked } : {};
}
