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
  // Surfaces — near-black, separated by lightness alone. Borders are alpha
  // white in the stylesheet; these opaque values are the closest solid
  // equivalents for the few inline-style consumers that need one.
  background: "#0a0a0c",
  surface1: "#141519",
  surface2: "#1c1e23",
  border: "#22242a",
  borderStrong: "#2f3138",

  // Text — one ink at four levels.
  text: "#f2f3f7",
  textSecondary: "#c8c9d2",
  textMuted: "#9a9ba5",
  textDim: "#63646e",

  // Accent — periwinkle, luminous enough to carry near-black text on a fill.
  primary: "#b0b6ff",
  secondary: "#b0b6ff",
  success: "#7fe89a",
  warning: "#f0cf63",
  error: "#ff6b60",
  info: "#62e8d8",

  // Aliases mapped onto the accent family for existing consumers.
  accent: "#b0b6ff",
  code: "#f2f3f7",
  language: "#62e8d8",
  footerText: "#9a9ba5",
  commandColor: "#b0b6ff",

  inputBackground: "#141519",

  // User text + chip — mirrors the ggcoder TUI (commandColor #818cf8 on the
  // #374151 message fill). Shared by the user bubble and the chat input so the
  // "this is you" color reads identically in both places.
  userText: "#f2f3f7",
  userBackground: "#26272c",

  // Ken Kai (mentor agent) — soft cyan. Used as the FULL text color of Ken's
  // replies (and the @Ken active chip in the input), so it must read well as
  // body text on the dark canvas: a lighter, calmer hue than the saturated
  // magenta it replaced (which vibrated as full paragraphs). Distinct from the
  // GG Coder blue dot and the greener `info` teal — the color IS the only
  // signal that a reply is Ken's, not GG Coder's.
  ken: "#62e8d8",
} as const;

// User-message chip background — mirrors USER_MESSAGE_BACKGROUND in the TUI.
export const USER_MESSAGE_BACKGROUND = "#26272c";
