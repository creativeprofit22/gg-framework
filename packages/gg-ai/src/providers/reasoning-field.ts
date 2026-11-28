/**
 * OpenAI-compatible endpoints disagree on what to call the reasoning field.
 * DeepSeek, GLM, Moonshot and Xiaomi use `reasoning_content`; newer vLLM builds
 * and several gateways use `reasoning`. Reading only one name loses 100% of the
 * thinking content on the others — silently, since the turn still succeeds.
 *
 * Order matters: `reasoning_content` stays first so every endpoint we ship today
 * behaves byte-identically.
 */
export const REASONING_FIELD_ALIASES = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

export const DEFAULT_REASONING_FIELD = REASONING_FIELD_ALIASES[0];

/** Read the first reasoning alias present as a non-empty string. */
export function readReasoning(
  obj: Record<string, unknown> | undefined | null,
): { field: string; text: string } | undefined {
  if (!obj) return undefined;
  for (const field of REASONING_FIELD_ALIASES) {
    const value = obj[field];
    if (typeof value === "string" && value) return { field, text: value };
  }
  return undefined;
}

/** Stable cache key for one endpoint (provider + base URL + model). */
export function reasoningFieldKey(
  provider: string,
  baseUrl: string | undefined,
  model: string,
): string {
  return `${provider}|${baseUrl ?? ""}|${model}`;
}

/** Bounded so a long-lived sidecar can't grow it without limit. */
const MAX_REMEMBERED_ENDPOINTS = 64;
const detectedFields = new Map<string, string>();

export function rememberReasoningField(key: string, field: string): void {
  if (detectedFields.get(key) === field) return;
  detectedFields.set(key, field);
  while (detectedFields.size > MAX_REMEMBERED_ENDPOINTS) {
    const oldest = detectedFields.keys().next();
    if (oldest.done) break;
    detectedFields.delete(oldest.value);
  }
}

/**
 * The field this endpoint was last seen using. Falls back to
 * `reasoning_content` — a first turn has no history to echo back, so there is
 * no ordering hazard in defaulting.
 */
export function getReasoningField(key: string): string {
  return detectedFields.get(key) ?? DEFAULT_REASONING_FIELD;
}

/** Test-only: drop all remembered endpoints. */
export function resetReasoningFieldCache(): void {
  detectedFields.clear();
}
