// Semantic aliases for inline consumers. App.css owns Dark defaults;
// appearance.css supplies Light at the document root, including body portals.
// Opaque inline borders and chip fills retain their distinct Dark values.
//
// These are `var(--x)` strings, so they work anywhere CSS parses a value
// (style props, `color-mix()`, custom properties). They do NOT work where CSS
// isn't involved: canvas `fillStyle`, SVG presentation attributes, or string
// math like appending hex alpha. For canvas use `resolveColor()`; for SVG put
// the colour in `style`; for alpha use `color-mix(in srgb, X N%, transparent)`.
export const theme = {
  // Surfaces — near-black, separated by lightness alone. Borders are alpha
  // white in the stylesheet; these opaque values are the closest solid
  // equivalents for the few inline-style consumers that need one.
  background: "var(--bg)",
  surface1: "var(--surface-1)",
  surface2: "var(--surface-2)",
  border: "var(--inline-border)",
  borderStrong: "var(--inline-border-strong)",

  // Text — one ink at four levels.
  text: "var(--text)",
  textSecondary: "var(--text-secondary)",
  textMuted: "var(--text-muted)",
  textDim: "var(--text-dim)",

  // Accent: periwinkle, luminous enough to carry near-black text on a fill.
  primary: "var(--primary)",
  // The ink that fill carries. Anything placed ON a primary surface (a badge
  // inside a selected pill, for one) has to switch to this or it is unreadable.
  onPrimary: "var(--on-primary)",
  secondary: "var(--secondary)",
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--error)",
  info: "var(--info)",

  // Aliases mapped onto the accent family for existing consumers.
  accent: "var(--primary)",
  code: "var(--text)",
  language: "var(--info)",
  footerText: "var(--text-muted)",
  commandColor: "var(--primary)",

  inputBackground: "var(--surface-1)",

  // User text + chip: shared by the user bubble and the chat input so the
  // "this is you" color reads identically in both places.
  userText: "var(--user-text)",
  userBackground: "var(--inline-user-bg)",

  // Ken Kai (mentor agent): soft cyan. Used as the FULL text color of Ken's
  // replies (and the @Ken active chip in the input), so it must read well as
  // body text on the dark canvas: a lighter, calmer hue than the saturated
  // magenta it replaced (which vibrated as full paragraphs). Distinct from the
  // GG Coder blue dot and the greener `info` teal — the color IS the only
  // signal that a reply is Ken's, not GG Coder's.
  ken: "var(--ken)",
} as const;

// User-message chip background — mirrors USER_MESSAGE_BACKGROUND in the TUI.
export const USER_MESSAGE_BACKGROUND = "var(--inline-user-bg)";

const VAR_REF = /^var\((--[\w-]+)\)$/;

/**
 * Resolve a `theme` value to a concrete colour for non-CSS consumers (canvas).
 * Reads the live custom property, so it always matches the stylesheet. Plain
 * colours pass through; an unresolvable reference comes back unchanged, which
 * canvas ignores rather than throwing.
 */
export function resolveColor(value: string, root: Element = document.documentElement): string {
  const name = VAR_REF.exec(value)?.[1];
  if (!name) return value;
  return getComputedStyle(root).getPropertyValue(name).trim() || value;
}
