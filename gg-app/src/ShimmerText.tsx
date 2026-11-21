import type { CSSProperties } from "react";

/**
 * A label with a bright spot sweeping across it — the web analog of the TUI
 * footer's ShimmerLabel (Footer.tsx). Used for "on full power" footer states
 * like plan mode and max-tier thinking. `base` is the resting color; `bright`
 * is the moving highlight, defaulting to `--shimmer-peak` (white) when omitted.
 * The sweep is pure CSS (background-clip: text), so it costs nothing when
 * off-screen.
 */
export function ShimmerText({
  children,
  base,
  bright,
}: {
  children: React.ReactNode;
  base: string;
  bright?: string;
}): React.ReactElement {
  const style: Record<string, string> = { "--shimmer-base": base };
  if (bright !== undefined) style["--shimmer-bright"] = bright;
  return (
    <span className="shimmer-text" style={style as CSSProperties}>
      {children}
    </span>
  );
}
