/**
 * Learned output-token ceilings.
 *
 * A model's real `max_tokens` limit is not knowable from configuration: it
 * varies by provider, by route (a gateway can cap lower than the origin), by
 * model, and it changes under us. So the only reliable source is the provider
 * saying no — and when it does, that answer is worth keeping, because the
 * alternative is failing the same way on every subsequent turn of the session.
 *
 * In-memory and per-process by design: a stale ceiling that outlived a quota or
 * plan change should cost one rejection, not a config file the user has to find
 * and delete.
 */

const TTL_MS = 24 * 60 * 60 * 1000;

/** Below this, a "ceiling" is more likely a parse accident than a real limit. */
const MIN_PLAUSIBLE_CEILING = 256;
const MAX_PLAUSIBLE_CEILING = 10_000_000;

const ceilings = new Map<string, { limit: number; expiresAt: number }>();

/** Provider + route + model. The route matters: gateways cap independently. */
export function outputRouteKey(route: {
  provider: string;
  model: string;
  baseUrl?: string;
}): string {
  return `${route.provider}\u0000${route.baseUrl ?? "default"}\u0000${route.model}`;
}

/**
 * Extract an accepted output-token ceiling from a provider rejection.
 *
 * Deliberately narrow. Every pattern requires the message to be about output
 * budget (`max_tokens` / completion / output tokens), because context-window
 * errors quote numbers too and clamping the OUTPUT budget in response to an
 * oversized INPUT would silently truncate every later reply for no reason.
 */
export function parseOutputTokenCeiling(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  if (!/max_tokens|max output tokens|output tokens|completion tokens/i.test(msg)) return null;

  // Payment failures talk about max_tokens too — OpenRouter's 402 reads
  // "requires more credits, or fewer max_tokens: you requested up to N tokens".
  // Learning a ceiling from that would clamp every later turn for a problem
  // that a top-up fixes, and the number quoted is what we ASKED for, not a
  // limit the provider will accept.
  if ((err as Error & { statusCode?: unknown }).statusCode === 402) return null;
  if (/credit|billing|payment|insufficient|balance|quota/i.test(msg)) return null;

  const patterns = [
    // Anthropic: "max_tokens: 100000 > 64000, which is the maximum allowed…"
    /max_tokens:\s*\d+\s*>\s*(\d+)/i,
    // OpenAI: "…this model supports at most 16384 completion tokens"
    /(?:at most|maximum of|limit of)\s+([\d,_]+)\s*(?:output|completion)?\s*tokens/i,
    // Generic: "max output tokens is 8192" / "max_tokens must be <= 4096"
    /(?:max_tokens|max output tokens)\b[^\d]{0,30}?([\d,_]+)/i,
  ];

  for (const pattern of patterns) {
    const raw = msg.match(pattern)?.[1];
    if (raw === undefined) continue;
    const limit = Number(raw.replace(/[,_]/g, ""));
    if (
      Number.isFinite(limit) &&
      limit >= MIN_PLAUSIBLE_CEILING &&
      limit <= MAX_PLAUSIBLE_CEILING
    ) {
      return limit;
    }
  }
  return null;
}

/** Record a ceiling the provider stated. Lower wins: it is the one that held. */
export function rememberOutputCeiling(key: string, limit: number): void {
  const known = outputTokenCeiling(key);
  ceilings.set(key, {
    limit: known === undefined ? limit : Math.min(known, limit),
    expiresAt: Date.now() + TTL_MS,
  });
}

/** The learned ceiling for a route, or undefined when none is known or fresh. */
export function outputTokenCeiling(key: string): number | undefined {
  const entry = ceilings.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    ceilings.delete(key);
    return undefined;
  }
  return entry.limit;
}

/**
 * Clamp a requested output budget to what this route is known to accept.
 * Passes the request through untouched when nothing has been learned, so an
 * unproven route behaves exactly as before.
 */
export function clampOutputTokens(key: string, requested: number | undefined): number | undefined {
  const ceiling = outputTokenCeiling(key);
  if (ceiling === undefined) return requested;
  return requested === undefined ? ceiling : Math.min(requested, ceiling);
}

export function resetOutputCeilingsForTests(): void {
  ceilings.clear();
}
