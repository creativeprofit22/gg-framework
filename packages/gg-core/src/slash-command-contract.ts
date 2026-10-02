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

/**
 * Optional `collection` frontmatter: marks a custom command as part of a
 * command collection. Only marked commands appear in the desktop palette.
 */
export const SLASH_COMMAND_COLLECTION_MAX_LENGTH = 40;
const SLASH_COMMAND_COLLECTION_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isSlashCommandCollection(value: string): boolean {
  return (
    value.length <= SLASH_COMMAND_COLLECTION_MAX_LENGTH &&
    SLASH_COMMAND_COLLECTION_PATTERN.test(value)
  );
}

/** Trim and lowercase; values outside `[a-z0-9][a-z0-9-]{0,39}` → undefined. */
export function normalizeSlashCommandCollection(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isSlashCommandCollection(normalized) ? normalized : undefined;
}

/** Optional `group` frontmatter: where a custom command sits in the desktop palette. */
export const SLASH_COMMAND_GROUPS = ["everyday", "specialist", "setup"] as const;
export type SlashCommandGroup = (typeof SLASH_COMMAND_GROUPS)[number];

/** Optional `effect` frontmatter: what running a custom command does to the project. */
export const SLASH_COMMAND_EFFECTS = ["reads", "plans", "edits"] as const;
export type SlashCommandEffect = (typeof SLASH_COMMAND_EFFECTS)[number];

function normalizeEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return values.find((candidate) => candidate === normalized);
}

/** Trim and lowercase; anything outside {@link SLASH_COMMAND_GROUPS} → undefined. */
export function normalizeSlashCommandGroup(value: unknown): SlashCommandGroup | undefined {
  return normalizeEnum(SLASH_COMMAND_GROUPS, value);
}

/** Trim and lowercase; anything outside {@link SLASH_COMMAND_EFFECTS} → undefined. */
export function normalizeSlashCommandEffect(value: unknown): SlashCommandEffect | undefined {
  return normalizeEnum(SLASH_COMMAND_EFFECTS, value);
}

/**
 * Custom command files that exist but could not become commands (or lost their
 * header), reported so the desktop can show them instead of silently hiding them.
 */
export const SLASH_COMMAND_PROBLEM_REASONS = [
  "unreadable",
  "malformed-frontmatter",
  "invalid-name",
] as const;
export type SlashCommandProblemReason = (typeof SLASH_COMMAND_PROBLEM_REASONS)[number];
export const SLASH_COMMAND_PROBLEMS_MAX = 100;
export const SLASH_COMMAND_PROBLEM_FILE_MAX_LENGTH = 255;

export interface SlashCommandProblem {
  /** File name only, never a full path. */
  file: string;
  scope: "project" | "global";
  reason: SlashCommandProblemReason;
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
  /** Normalized collection marker; only custom commands may declare one. */
  collection?: string;
  /** Palette group from frontmatter; only custom commands may declare one. */
  group?: SlashCommandGroup;
  /** What the command does to the project; only custom commands may declare one. */
  effect?: SlashCommandEffect;
  origin?: "built-in" | "project-custom" | "global-custom";
  invocationKind?: "prompt" | "workspace-action";
}

export interface SlashCommandsResponse {
  commands: SlashCommandListing[];
  /** Absent from older daemons; treat absence as "none reported". */
  problems?: SlashCommandProblem[];
}

function isSlashCommandProblem(value: unknown): value is SlashCommandProblem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.file === "string" &&
    item.file.length > 0 &&
    item.file.length <= SLASH_COMMAND_PROBLEM_FILE_MAX_LENGTH &&
    !/[\\/]/.test(item.file) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/.test(item.file) &&
    (item.scope === "project" || item.scope === "global") &&
    SLASH_COMMAND_PROBLEM_REASONS.includes(item.reason as SlashCommandProblemReason)
  );
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
  const problems = (value as { problems?: unknown }).problems;
  if (
    problems !== undefined &&
    !(
      Array.isArray(problems) &&
      problems.length <= SLASH_COMMAND_PROBLEMS_MAX &&
      problems.every(isSlashCommandProblem)
    )
  )
    return false;

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
        (alias) =>
          typeof alias === "string" &&
          alias.length > 0 &&
          alias.length <= SLASH_COMMAND_NAME_MAX_LENGTH,
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
      (item.collection === undefined ||
        (item.source === "custom" &&
          typeof item.collection === "string" &&
          isSlashCommandCollection(item.collection))) &&
      (item.group === undefined ||
        (item.source === "custom" &&
          SLASH_COMMAND_GROUPS.includes(item.group as SlashCommandGroup))) &&
      (item.effect === undefined ||
        (item.source === "custom" &&
          SLASH_COMMAND_EFFECTS.includes(item.effect as SlashCommandEffect))) &&
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
