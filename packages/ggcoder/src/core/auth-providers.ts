// Single source of truth for the providers the login UI offers and how each
// authenticates. Mirrors the CLI's `ggcoder login` provider list (ui/login.tsx)
// so the desktop app and the terminal stay in lockstep. The app fetches this
// (plus live connection status) from the sidecar's /auth/status endpoint.

import { XIAOMI_CREDITS_KEY, dualAuthProvider } from "@kenkaiiii/gg-core";

export type AuthMethod = "oauth" | "apikey";

/**
 * One API-key option for a provider that splits auth across multiple distinct
 * endpoints/credentials (currently only Xiaomi: Token Plan vs. API Credits).
 * Each variant stores under its own auth.json key so a user can hold both at
 * once — the model registry picks which one a given model resolves via
 * `getAuthStorageKeys()`.
 */
export interface ApiKeyVariant {
  /** Storage key in auth.json (distinct from `value` when multiple variants exist). */
  key: string;
  /** Display label, e.g. "Token Plan" or "API Credits". */
  label: string;
  /** Base URL stored alongside this variant's credential. */
  baseUrl?: string;
}

export interface AuthProviderMeta {
  /** Stable provider id (matches the gg-ai Provider union, plus storage keys). */
  value: string;
  /** Display name shown in the login list. */
  label: string;
  /** One-line model summary. */
  description: string;
  /** Supported auth methods, in preferred order (oauth first when both). */
  methods: AuthMethod[];
  /** Friendly label for the API key field (e.g. "Z.AI"). */
  apiKeyLabel?: string;
  /** Fixed base URL stored alongside an API key (e.g. Xiaomi's token plan). */
  apiKeyBaseUrl?: string;
  /**
   * When a provider's API-key auth splits across multiple endpoints, the
   * choices to present (in order). The first variant is the default. Absent
   * for every provider with a single API-key credential.
   */
  apiKeyVariants?: ApiKeyVariant[];
  /**
   * Per-method guidance overrides. Only providers whose methods differ in
   * billing/entitlement (the dual-auth ones) need these; everything else is
   * described generically by {@link describeAuthMethods}.
   */
  methodDetails?: Partial<Record<AuthMethod, AuthMethodMeta>>;
}

/**
 * What one auth method means for a provider, so both UIs can answer "which do I
 * pick?" without hardcoding provider knowledge in a component.
 */
export interface AuthMethodMeta {
  method: AuthMethod;
  /** Button/row label, e.g. "Sign in with Grok (SuperGrok / X Premium)". */
  label: string;
  /** What the user spends on this method. */
  billing: string;
  /** When to choose it. */
  when: string;
  /** Prerequisite the user must already have, if any. */
  requires?: string;
}

export const AUTH_PROVIDERS: AuthProviderMeta[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Claude Fable 5, Opus 5, Sonnet 5, Haiku 4.5",
    methods: ["oauth"],
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5",
    methods: ["oauth"],
  },
  {
    value: "gemini",
    label: "Gemini",
    description: "Gemini 3.1 Flash Lite, Gemini 3.5 Flash, Gemini 3.1 Pro (Preview)",
    methods: ["oauth"],
  },
  {
    value: "xai",
    label: "xAI (Grok)",
    description: "Grok 4.5 · OAuth or API key",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "xAI",
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Sign in with Grok",
        billing: "Uses your SuperGrok or X Premium subscription — no per-token API billing.",
        when: "Preferred. Pick this if you already pay for Grok.",
        requires:
          "An active SuperGrok or X Premium subscription. xAI gates this endpoint by tier, " +
          "so a valid login can still be refused — keep an API key as backup.",
      },
      apikey: {
        method: "apikey",
        label: "xAI API key",
        billing: "Metered pay-per-token billing on your console.x.ai credits.",
        when: "Use without a Grok subscription, or as the fallback when OAuth usage runs out.",
        requires: "An API key from console.x.ai.",
      },
    },
  },
  {
    value: "moonshot",
    label: "Moonshot",
    description: "Kimi K3, K2.7 Code · OAuth or API key",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "Moonshot",
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Sign in with Kimi",
        billing: "Uses your Kimi For Coding plan — no per-token API billing.",
        when: "Preferred. Pick this if you have a Kimi coding plan.",
        requires: "An active Kimi For Coding subscription.",
      },
      apikey: {
        method: "apikey",
        label: "Moonshot API key",
        billing: "Metered pay-per-token billing on your Moonshot platform credits.",
        when: "Use without a Kimi plan, or as the fallback when plan usage runs out.",
        requires: "An API key from platform.moonshot.ai.",
      },
    },
  },
  {
    value: "glm",
    label: "Z.AI (GLM)",
    description: "GLM-5.2, GLM-5.1, GLM-4.7, GLM-4.7 Flash",
    methods: ["apikey"],
    apiKeyLabel: "Z.AI",
  },
  {
    value: "minimax",
    label: "MiniMax",
    description: "MiniMax M3",
    methods: ["apikey"],
    apiKeyLabel: "MiniMax",
  },
  {
    value: "xiaomi",
    label: "Xiaomi (MiMo)",
    description: "MiMo-V2.5-Pro, MiMo-V2.5-Pro-UltraSpeed, MiMo-V2.5 · Token Plan or API Credits",
    methods: ["apikey"],
    apiKeyLabel: "Xiaomi MiMo",
    apiKeyBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    apiKeyVariants: [
      {
        key: "xiaomi",
        label: "Token Plan",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      },
      {
        key: XIAOMI_CREDITS_KEY,
        label: "API Credits (required for UltraSpeed)",
        baseUrl: "https://api.xiaomimimo.com/v1",
      },
    ],
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek V4 Pro, V4 Flash",
    methods: ["apikey"],
    apiKeyLabel: "DeepSeek",
  },
  {
    value: "sakana",
    label: "Sakana (Fugu)",
    description: "Fugu, Fugu Ultra",
    methods: ["apikey"],
    apiKeyLabel: "Sakana",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Multi-provider gateway",
    methods: ["apikey"],
    apiKeyLabel: "OpenRouter",
  },
];

export function getAuthProvider(value: string): AuthProviderMeta | undefined {
  return AUTH_PROVIDERS.find((p) => p.value === value);
}

/**
 * Per-method guidance for a provider, in resolution order. Providers with a
 * single method get a generic description; the dual-auth ones (Kimi, Grok) carry
 * explicit `methodDetails` because the choice changes what the user is billed.
 */
export function describeAuthMethods(provider: string): AuthMethodMeta[] {
  const meta = getAuthProvider(provider);
  if (!meta) return [];
  return meta.methods.map((method) => {
    const override = meta.methodDetails?.[method];
    // Copy rather than hand back the table entry itself: callers serialize this
    // alongside the provider meta, and a shared reference appearing twice in one
    // payload trips the sidecar's cycle-safe JSON encoder ([CIRCULAR]).
    if (override) return { ...override };
    return method === "oauth"
      ? {
          method,
          label: `Sign in with ${meta.label}`,
          billing: "Uses your existing plan with this provider.",
          when: "The only way to connect this provider.",
        }
      : {
          method,
          label: `${meta.apiKeyLabel ?? meta.label} API key`,
          billing: "Metered pay-per-token billing on this provider's credits.",
          when: "The only way to connect this provider.",
        };
  });
}

/**
 * How the runtime picks between two connected methods, phrased for the UI. Only
 * dual-auth providers have a choice to explain; everything else returns
 * undefined so callers can omit the note entirely.
 *
 * Keep this wording in sync with AuthStorage's actual resolution order in
 * gg-core (`DUAL_AUTH_PROVIDERS`) — it is the user-facing description of it.
 */
export function authPriorityNote(provider: string): string | undefined {
  const dual = dualAuthProvider(provider);
  if (!dual) return undefined;
  return (
    `With both connected, ${dual.oauthLabel} is used first. The ${dual.apiKeyLabel} takes over ` +
    `automatically while subscription usage is out (or if the OAuth login expires), then ` +
    `${dual.oauthLabel} resumes on its own.`
  );
}
