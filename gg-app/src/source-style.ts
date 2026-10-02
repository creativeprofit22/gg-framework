import { MENTOR_DISPLAY_NAME, PRODUCT_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";

/** Project source → display label + accent color. One home so badges stay consistent. */
const SOURCE_STYLES: Record<string, { label: string; color: string }> = {
  ggcoder: { label: PRODUCT_DISPLAY_NAME, color: theme.primary }, // blue
  // Theme tokens (appearance.css): Dark keeps clay/silver, Light swaps in readable ink.
  "claude-code": { label: "Claude Code", color: "var(--source-claude-code)" }, // Anthropic clay
  codex: { label: "Codex", color: "var(--source-codex)" }, // neutral silver
  folder: { label: "Folder", color: theme.textDim }, // on disk, never opened
  ken: { label: MENTOR_DISPLAY_NAME, color: theme.ken }, // orchid/magenta mentor
};

export function sourceStyle(source: string): { label: string; color: string } {
  return SOURCE_STYLES[source] ?? { label: source, color: theme.textMuted };
}
