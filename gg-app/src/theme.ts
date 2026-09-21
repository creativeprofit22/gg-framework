// Semantic aliases for inline consumers. App.css owns Dark defaults;
// appearance.css supplies Light at the document root, including body portals.
// Opaque inline borders and chip fills retain their distinct Dark values.
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

  // Accent — periwinkle, luminous enough to carry near-black text on a fill.
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

  // User text + chip — mirrors the ggcoder TUI (commandColor #818cf8 on the
  // #374151 message fill). Shared by the user bubble and the chat input so the
  // "this is you" color reads identically in both places.
  userText: "var(--user-text)",
  userBackground: "var(--inline-user-bg)",

  // Ken Kai (mentor agent) — soft cyan. Used as the FULL text color of Ken's
  // replies (and the @Ken active chip in the input), so it must read well as
  // body text on the dark canvas: a lighter, calmer hue than the saturated
  // magenta it replaced (which vibrated as full paragraphs). Distinct from the
  // GG Coder blue dot and the greener `info` teal — the color IS the only
  // signal that a reply is Ken's, not GG Coder's.
  ken: "var(--ken)",
} as const;

// User-message chip background — mirrors USER_MESSAGE_BACKGROUND in the TUI.
export const USER_MESSAGE_BACKGROUND = "var(--inline-user-bg)";
