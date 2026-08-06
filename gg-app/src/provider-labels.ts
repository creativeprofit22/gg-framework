/**
 * Provider id → display label for grouping headings.
 *
 * Keys match `ModelInfo.provider` in gg-core's model registry, which is the same
 * id set as `AuthProviderMeta.value` in ggcoder's `core/auth-providers.ts` (and
 * therefore `PROVIDER_LOGOS`) — so the model picker's group names read exactly
 * like the login hub's tiles.
 */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  xai: "xAI (Grok)",
  moonshot: "Moonshot",
  glm: "Z.AI (GLM)",
  minimax: "MiniMax",
  xiaomi: "Xiaomi (MiMo)",
  deepseek: "DeepSeek",
  sakana: "Sakana (Fugu)",
  openrouter: "OpenRouter",
  local: "Local",
};

/**
 * Order groups appear in the picker. Providers missing here fall in after the
 * known ones (alphabetically), and `local` is pinned last: it's the user's own
 * machine rather than an account, and its length depends on what they've pulled.
 */
const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "gemini",
  "xai",
  "moonshot",
  "glm",
  "minimax",
  "xiaomi",
  "deepseek",
  "sakana",
  "openrouter",
];

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Sort key for a provider group. Unknown providers sort after known, before local. */
export function providerRank(provider: string): number {
  if (provider === "local") return PROVIDER_ORDER.length + 1;
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

/**
 * Group models by provider, preserving each provider's model order from the
 * registry (which is curated: newest/flagship first).
 */
export function groupByProvider<T extends { provider: string }>(
  models: readonly T[],
): { provider: string; label: string; models: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const existing = groups.get(model.provider);
    if (existing) existing.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups.entries()]
    .map(([provider, groupModels]) => ({
      provider,
      label: providerLabel(provider),
      models: groupModels,
    }))
    .sort(
      (a, b) =>
        providerRank(a.provider) - providerRank(b.provider) || a.label.localeCompare(b.label),
    );
}
