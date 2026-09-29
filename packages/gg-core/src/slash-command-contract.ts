/** Client-owned identities reserve names without implying backend execution handlers. */
export const CLIENT_OWNED_SLASH_COMMANDS = Object.freeze({
  schedule: Object.freeze({ name: "schedule", aliases: Object.freeze(["sched"]) }),
});

export const CLIENT_RESERVED_SLASH_COMMAND_IDENTITIES: readonly string[] = Object.freeze(
  Object.values(CLIENT_OWNED_SLASH_COMMANDS).flatMap(({ name, aliases }) => [name, ...aliases]),
);

/** Line /steroids prints before its candidate table; the desktop app collapses the table that follows it. */
export const STEROIDS_COLLAPSIBLE_TABLE_MARKER = "<!-- gg:collapsible-table -->";

/** Listing field limits measured in UTF-16 code units, matching string.length. */
export const SLASH_COMMAND_NAME_MAX_LENGTH = 100;
export const SLASH_COMMAND_DESCRIPTION_MAX_LENGTH = 4_000;
/** Author-declared `argument-hint` frontmatter, shown as muted menu text. */
export const SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH = 200;

/** Collapse whitespace, reject control characters, and bound length; empty → undefined. */
export function normalizeSlashCommandArgumentHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(collapsed)) return undefined;
  return collapsed.length > SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH
    ? `${collapsed.slice(0, SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH - 1)}…`
    : collapsed;
}

/** Programmatic focus uses UTF-16 code units, not Unicode code points. */
export const PROGRAMMATIC_FOCUS_MAX_LENGTH = 4_000;
export const PROGRAMMATIC_FOCUS_GUIDANCE =
  "Use an optional focus of at most 4,000 characters without control characters (newlines and tabs are allowed).";

/** Validates stored focus as-is; callers trim and omit empty optional input first. */
export function isValidProgrammaticFocus(value: string): boolean {
  if (value.length > PROGRAMMATIC_FOCUS_MAX_LENGTH || value.trim().length === 0) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) {
      return false;
    }
  }
  return true;
}

export const SLASH_COMMAND_INPUT_MODES = ["none", "optional"] as const;

export type SlashCommandInputMode = (typeof SLASH_COMMAND_INPUT_MODES)[number];
export type SlashCommandSource = "built-in" | "custom";

export interface SlashCommandInputPolicy {
  text: SlashCommandInputMode;
  references: SlashCommandInputMode;
  attachments: SlashCommandInputMode;
}

export const SLASH_COMMAND_INPUT_ALL: Readonly<SlashCommandInputPolicy> = Object.freeze({
  text: "optional",
  references: "optional",
  attachments: "optional",
});

export const SLASH_COMMAND_INPUT_NONE: Readonly<SlashCommandInputPolicy> = Object.freeze({
  text: "none",
  references: "none",
  attachments: "none",
});

export interface SlashCommandListing {
  name: string;
  aliases: string[];
  description: string;
  input: SlashCommandInputPolicy;
  source: SlashCommandSource;
  usage?: string;
  /** Placeholder describing accepted arguments, e.g. `[path or recent — optional]`. */
  argumentHint?: string;
  origin?: "built-in" | "project-custom" | "global-custom";
  invocationKind?: "prompt" | "workspace-action";
}

export interface SlashCommandsResponse {
  commands: SlashCommandListing[];
}

export function isSlashCommandInputPolicy(value: unknown): value is SlashCommandInputPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  return (
    SLASH_COMMAND_INPUT_MODES.includes(policy.text as SlashCommandInputMode) &&
    SLASH_COMMAND_INPUT_MODES.includes(policy.references as SlashCommandInputMode) &&
    SLASH_COMMAND_INPUT_MODES.includes(policy.attachments as SlashCommandInputMode)
  );
}

export function isSlashCommandsResponse(value: unknown): value is SlashCommandsResponse {
  if (!value || typeof value !== "object") return false;
  const commands = (value as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return false;

  return commands.every((command) => {
    if (!command || typeof command !== "object") return false;
    const item = command as Record<string, unknown>;
    return (
      typeof item.name === "string" &&
      item.name.length > 0 &&
      item.name.length <= SLASH_COMMAND_NAME_MAX_LENGTH &&
      Array.isArray(item.aliases) &&
      item.aliases.length <= 50 &&
      item.aliases.every(
        (alias) => typeof alias === "string" && alias.length > 0 && alias.length <= SLASH_COMMAND_NAME_MAX_LENGTH,
      ) &&
      typeof item.description === "string" &&
      item.description.length <= SLASH_COMMAND_DESCRIPTION_MAX_LENGTH &&
      isSlashCommandInputPolicy(item.input) &&
      (item.source === "built-in" || item.source === "custom") &&
      (item.usage === undefined ||
        (typeof item.usage === "string" && item.usage.length <= 4_000)) &&
      (item.argumentHint === undefined ||
        (typeof item.argumentHint === "string" &&
          item.argumentHint.length <= SLASH_COMMAND_ARGUMENT_HINT_MAX_LENGTH)) &&
      (item.origin === undefined ||
        (item.source === "built-in" && item.origin === "built-in") ||
        (item.source === "custom" &&
          (item.origin === "project-custom" || item.origin === "global-custom"))) &&
      (item.invocationKind === undefined ||
        item.invocationKind === "prompt" ||
        (item.invocationKind === "workspace-action" && item.source === "built-in"))
    );
  });
}
