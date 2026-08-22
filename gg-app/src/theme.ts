// Verified OKLCH/APCA design tokens (Warp × Linear × Resend synthesis).
// Mirrors the :root custom properties in App.css so inline-style consumers and
// the stylesheet share one source of truth. Existing key names are kept as
// aliases (new hex values) to minimize component churn.
//
// `borderStrong`, `userText` and `userBackground` have no `theme.X` reader — they
// are consumed through their CSS vars. Keep them: completeness of the mirror is
// this file's job. An alias with neither a `theme.X` reader nor a CSS var is
// simply dead.
export const theme = {
  // Surfaces — cool charcoal ramp, elevation by ΔL only (no shadows).
  background: "#0f1115",
  surface1: "#161922",
  surface2: "#1d212b",
  border: "#272b36",
  borderStrong: "#353a47",

  // Text — neutral-cool, APCA-gated.
  text: "#f4f6f8",
  textSecondary: "#c3c9d4",
  textMuted: "#9aa3b2",
  textDim: "#5b6472",

  // Accents — true sibling set (OKLCH L 69–76); dot/icon/border/verb colors.
  primary: "#4d9dff",
  secondary: "#9b8cf7",
  success: "#36c489",
  warning: "#e3a23f",
  error: "#f2716e",
  info: "#2dd4bf",

  // Aliases mapped onto the accent family for existing consumers.
  accent: "#9b8cf7",
  code: "#e3a23f",
  language: "#2dd4bf",
  footerText: "#9aa3b2",
  commandColor: "#9b8cf7",

  inputBackground: "#161922",

  // User text + chip — mirrors the ggcoder TUI (commandColor #818cf8 on the
  // #374151 message fill). Shared by the user bubble and the chat input so the
  // "this is you" color reads identically in both places.
  userText: "#818cf8",
  userBackground: "#313a49",

  // Ken Kai (mentor agent) — soft cyan. Used as the FULL text color of Ken's
  // replies (and the @Ken active chip in the input), so it must read well as
  // body text on the dark canvas: a lighter, calmer hue than the saturated
  // magenta it replaced (which vibrated as full paragraphs). Distinct from the
  // GG Coder blue dot and the greener `info` teal — the color IS the only
  // signal that a reply is Ken's, not GG Coder's.
  ken: "#5ad1e6",
} as const;

// User-message chip background — mirrors USER_MESSAGE_BACKGROUND in the TUI.
export const USER_MESSAGE_BACKGROUND = "#313a49";
