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
      Array.isArray(item.aliases) &&
      item.aliases.every((alias) => typeof alias === "string") &&
      typeof item.description === "string" &&
      isSlashCommandInputPolicy(item.input) &&
      (item.source === "built-in" || item.source === "custom") &&
      (item.usage === undefined || typeof item.usage === "string")
    );
  });
}
