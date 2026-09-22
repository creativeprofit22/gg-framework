import type { Provider } from "@kenkaiiii/gg-ai";

export const DEFAULT_COMPACTION_THRESHOLD = 0.85;

/**
 * Latency caps on the context window used for compaction TRIGGERING.
 *
 * Some providers advertise huge windows (GLM: 1M, MiniMax/MiMo/Gemini: 1M+)
 * whose pricing model tolerates but whose transports may not: on the public
 * API every turn re-prefills the whole active context, and observed GLM
 * prefill was ~3-5K tok/s uncached (2026-09-22 sidecar log: 44-68s
 * time-to-first-token at 213K tokens). A session sitting at 21% of a 1M
 * window therefore paid a 45-70s tax on EVERY model call without ever
 * approaching the 85% compaction trigger.
 *
 * Three tiers, ALL evidence-driven — this is deliberately not GLM-only:
 *
 *   1. MEASURED SLOW — explicit cap (glm: 176K → trigger ~150K, from the
 *      incident log).
 *   2. MEASURED HEALTHY — no cap: the transport's prompt caching demonstrably
 *      keeps large contexts fast (anthropic: we send explicit cache_control
 *      breakpoints; openai: sidecar audit shows flat 5-6s TTFT p95 at 237K
 *      tokens, zero stalls in 2,000+ turns). Capping these would throw away
 *      working context for nothing.
 *   3. UNKNOWN — the conservative default cap below. Any provider we have
 *      not measured gets it, so a user on ANY model is protected from the
 *      mega-window + cold-prefill pattern. The `cache_health` /
 *      `prompt_cache_miss` diag lines (agent-loop) turn tier 3 into tier 1 or
 *      2 with one line here as evidence arrives — remove a provider's cap
 *      once its logs show healthy cache reads at large sizes, lower it when
 *      they show misses.
 *
 * The model's true context window still governs hard limits (request size,
 * output budgets); a cap only moves when compaction summarizes. min() keeps a
 * smaller advertised window authoritative — the default never raises a
 * trigger that the provider's real window already keeps lower.
 */
const PROVIDER_LATENCY_WINDOW_CAPS: Partial<Record<Provider, number>> = {
  glm: 176_000,
};

/** Providers with MEASURED healthy prompt caching — exempt from the default cap. */
const PROVIDERS_WITH_HEALTHY_CACHING: ReadonlySet<Provider> = new Set([
  "anthropic", // explicit cache_control breakpoints in our transport
  "openai", // sidecar audit 2026-09-22: flat TTFT p95 at 237K tokens, 0 stalls / 2000+ turns
] as Provider[]);

/** Conservative ceiling for providers whose cache behaviour is UNMEASURED.
 *  Only bites mega-windows (≥ ~470K): typical 200-272K windows are unaffected. */
const DEFAULT_LATENCY_WINDOW_CAP = 400_000;

/** The latency-capped effective context window for a provider, if one applies. */
export function resolveLatencyWindowCap(provider: Provider): number | undefined {
  const explicit = PROVIDER_LATENCY_WINDOW_CAPS[provider];
  if (explicit != null) return explicit;
  if (PROVIDERS_WITH_HEALTHY_CACHING.has(provider)) return undefined;
  return DEFAULT_LATENCY_WINDOW_CAP;
}

export interface CompactionPolicy {
  threshold: number;
  targetTokens: number;
  policyKey: string;
}

/** One trigger policy shared by app sessions and CLI compaction. */
export function resolveCompactionPolicy(options: {
  provider: Provider;
  model: string;
  contextWindow: number;
  threshold?: number;
  accountId?: string;
  approvedPlanPath?: string;
}): CompactionPolicy {
  const threshold =
    Number.isFinite(options.threshold) && options.threshold! > 0 && options.threshold! < 1
      ? options.threshold!
      : DEFAULT_COMPACTION_THRESHOLD;
  const latencyCap = resolveLatencyWindowCap(options.provider);
  // The trigger fires against the latency-capped window when one applies —
  // min() keeps a provider-declared window smaller than the cap authoritative.
  const effectiveWindow = latencyCap
    ? Math.min(options.contextWindow, latencyCap)
    : options.contextWindow;
  const targetTokens = Math.max(1, Math.ceil(effectiveWindow * threshold));
  const transport =
    options.provider === "openai" && options.accountId ? "codex_oauth" : "public_api";
  return {
    threshold,
    targetTokens,
    policyKey: JSON.stringify({
      provider: options.provider,
      model: options.model,
      transport,
      contextWindow: effectiveWindow,
      threshold,
      approvedPlanPath: options.approvedPlanPath ?? null,
    }),
  };
}
