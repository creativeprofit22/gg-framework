export const PRODUCT_DISPLAY_NAME = "Supah Coder";
export const PRODUCT_SHORT_NAME = "SC";
export const MENTOR_DISPLAY_NAME = "Ken";
export const MENTOR_HANDLE = "@Ken";
export const LEGACY_MENTOR_HANDLE = "@Supah";

/** Escapes a string for literal use inside a RegExp source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mentor handle names without the leading `@`, current handle first. */
const MENTOR_HANDLE_NAMES: readonly string[] = [MENTOR_HANDLE, LEGACY_MENTOR_HANDLE].map(
  (handle) => handle.replace(/^@/, ""),
);

/** Regex alternation (escaped, non-capturing) matching any mentor handle name. */
export const MENTOR_HANDLE_ALTERNATION = `(?:${MENTOR_HANDLE_NAMES.map(escapeRegExp).join("|")})`;
