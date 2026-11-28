import {
  buildLivePreviewPrompt,
  livePreviewChip,
  parseLivePreviewMeta,
} from "./core/live-preview.js";

export interface LivePreviewAnnouncement {
  text: string;
  element: string | null;
  queued: boolean;
}

/** Live preview: the agent gets the picked element and short-reply rules, while
 * every transcript shows only the typed words (core/live-preview.ts). Ordinary
 * prompts pass through and announce nothing. */
export function prepareLivePreviewPrompt(
  typed: string,
  rawMeta: unknown,
  cwd: string,
): { text: string; announcement: (queued: boolean) => LivePreviewAnnouncement | null } {
  const meta = parseLivePreviewMeta(rawMeta);
  if (!meta) return { text: typed, announcement: () => null };
  return {
    text: buildLivePreviewPrompt(typed, meta, cwd),
    announcement: (queued) => ({
      text: typed,
      element: meta.element ? livePreviewChip(meta.element) : null,
      queued,
    }),
  };
}
