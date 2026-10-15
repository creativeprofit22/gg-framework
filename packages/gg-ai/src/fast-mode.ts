import type { Provider } from "./types.js";

/**
 * Fast-mode model ids: `<base model id>` + this suffix selects the same model
 * at its provider's faster speed tier. The suffixed id is a registry/UI concept
 * only — `stream()` rewrites it to the base id plus `speed: "fast"` before any
 * provider sees it, so every model-id check downstream still matches.
 */
export const FAST_MODE_SUFFIX = "-fast";

/**
 * Base models that accept a fast speed tier, per provider:
 *  - Anthropic: `speed: "fast"` + `fast-mode-2026-02-01` beta. Opus 5.5 is the
 *    only supported model we register (Sonnet/Haiku/Fable reject it). On a
 *    Claude subscription it bills usage credits, never included plan usage.
 *  - OpenAI: `service_tier: "priority"` (what the Codex CLI sends for Fast mode;
 *    the ChatGPT backend rejects the literal "fast"). Every model listed here
 *    advertises the priority tier in openai/codex models.json; on a ChatGPT
 *    plan it draws included limits at 2.5x the standard rate.
 */
const FAST_MODE_BASE_MODELS: Readonly<Partial<Record<Provider, readonly string[]>>> = {
  anthropic: ["claude-opus-5-5"],
  openai: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"],
};

export interface FastModeResolution {
  /** The real model id to send on the wire. */
  model: string;
  /** True when the id selected a fast speed tier. */
  fast: boolean;
}

/**
 * Split a fast-mode model id into its base model. Ids without the suffix, or
 * whose base doesn't support fast mode for `provider`, pass through unchanged.
 */
export function resolveFastModeModel(provider: Provider, model: string): FastModeResolution {
  if (!model.endsWith(FAST_MODE_SUFFIX)) return { model, fast: false };
  const base = model.slice(0, -FAST_MODE_SUFFIX.length);
  return FAST_MODE_BASE_MODELS[provider]?.includes(base)
    ? { model: base, fast: true }
    : { model, fast: false };
}
