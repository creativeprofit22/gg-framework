import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getNextThinkingLevel, getSupportedThinkingLevels } from "../core/thinking-level.js";

/**
 * What a POST /thinking asks for. An empty body cycles to the next level (the
 * footer's original click-to-cycle); `{"level": "<level>"}` sets that level and
 * `{"level": null}` turns thinking off, so a picker can jump straight to one.
 * A level the current model doesn't support is refused, not clamped.
 *
 * Upstream keeps this in its run-control-routes module; the Local Fork's
 * monolithic sidecar imports it from here instead.
 */
export function resolveThinkingRequest(
  provider: Provider,
  model: string,
  current: ThinkingLevel | undefined,
  raw: string,
): { ok: true; level: ThinkingLevel | undefined } | { ok: false; error: string } {
  if (raw.trim() === "") {
    return { ok: true, level: getNextThinkingLevel(provider, model, current) };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }
  if (typeof body !== "object" || body === null || !("level" in body)) {
    return { ok: true, level: getNextThinkingLevel(provider, model, current) };
  }
  const level = (body as { level: unknown }).level;
  if (level === null) return { ok: true, level: undefined };
  if (typeof level !== "string") return { ok: false, error: "level must be a string or null" };
  const match = getSupportedThinkingLevels(provider, model).find((l) => l === level);
  if (!match) return { ok: false, error: `${model} doesn't support thinking level "${level}"` };
  return { ok: true, level: match };
}
