import { MENTOR_DISPLAY_NAME, PRODUCT_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";

/**
 * Small pill badge with a consistent shape/size across the app. Defaults to a
 * neutral surface pill (Resend scarcity: color is reserved as a data signal).
 * Pass an explicit `color` to tint the background/border/text — used for source
 * badges where the hue *is* the indicator.
 */
export function Badge({
  children,
  color,
  title,
}: {
  children: React.ReactNode;
  color?: string;
  /** Native tooltip, for badges whose colour carries state worth spelling out. */
  title?: string;
}): React.ReactElement {
  const style = color
    ? {
        color,
        // color-mix, not appended hex alpha: `color` may be a `var(--x)` token.
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 21.9608%, transparent) 0%, color-mix(in srgb, ${color} 9.4118%, transparent) 100%)`,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2)",
      }
    : undefined;
  return (
    <span className="badge" style={style} title={title}>
      {children}
    </span>
  );
}

/** Project source → display label + accent color. One home so badges stay consistent. */
const SOURCE_STYLES: Record<string, { label: string; color: string }> = {
  ggcoder: { label: PRODUCT_DISPLAY_NAME, color: theme.primary }, // blue
  "claude-code": { label: "Claude Code", color: "#d97757" }, // Anthropic clay
  codex: { label: "Codex", color: "#aeb6c2" }, // neutral silver
  folder: { label: "Folder", color: theme.textDim }, // on disk, never opened
  ken: { label: MENTOR_DISPLAY_NAME, color: theme.ken }, // orchid/magenta mentor
};

export function sourceStyle(source: string): { label: string; color: string } {
  return SOURCE_STYLES[source] ?? { label: source, color: theme.textMuted };
}
