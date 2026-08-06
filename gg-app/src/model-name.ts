import type { ModelOption } from "./agent";

/**
 * Resolve a model id to its friendly registry name for display (footer +
 * menus). The wire id (e.g. "gemini-3-flash") is an implementation detail —
 * users see the name (e.g. "Gemini 3.5 Flash"). Falls back to the id when the
 * model isn't in the list yet, and to an ellipsis when there's no id at all.
 */
export function modelDisplayName(
  models: readonly ModelOption[],
  id: string | undefined | null,
): string {
  if (!id) return "\u2026";
  return models.find((m) => m.id === id)?.name ?? id;
}
