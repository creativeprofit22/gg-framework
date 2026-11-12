import { CLIENT_OWNED_SLASH_COMMANDS } from "@kenkaiiii/gg-core/slash-command-contract";
import type { SlashCommand } from "./agent";

// `/schedule` lives in the webview, not the sidecar's command registry: it
// registers a recurring timer instead of prompting the agent. Declared here so
// the menu can still discover it alongside the real slash commands.
const SCHEDULE_COMMAND: SlashCommand = {
  name: CLIENT_OWNED_SLASH_COMMANDS.schedule.name,
  aliases: [...CLIENT_OWNED_SLASH_COMMANDS.schedule.aliases],
  description: "Run a prompt on a repeating schedule — <prompt> | 15m | [times]",
  input: { text: "optional", references: "optional", attachments: "optional" },
  source: "built-in",
};

// Commit lives in the top-right button, not the slash menu.
const COMMIT_NAMES: readonly string[] = ["commit", "setup-commit"];

/** Commands offered by the slash menu: the sidecar list plus `/schedule`, minus commit. */
export function menuCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return [SCHEDULE_COMMAND, ...commands].filter((c) => !COMMIT_NAMES.includes(c.name));
}

/**
 * Commands the Ctrl/Cmd+K palette offers: only those whose file declares a
 * `collection` marker. Everything else stays in the ordinary slash menu.
 */
export function paletteCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((c) => c.collection !== undefined);
}

/** Palette sections in display order; collection commands without a `group` fall back to "other". */
export const PALETTE_GROUPS = ["everyday", "specialist", "setup", "other"] as const;
export type PaletteGroupKey = (typeof PALETTE_GROUPS)[number];

export const PALETTE_GROUP_LABELS: Readonly<Record<PaletteGroupKey, string>> = {
  everyday: "Everyday",
  specialist: "Specialist",
  setup: "Setup",
  other: "Other",
};

export interface PaletteGroup {
  key: PaletteGroupKey;
  label: string;
  commands: SlashCommand[];
}

export type CommandScope = "project" | "global" | "built-in";

/** Where a command comes from, for its scope label. */
export function commandScope(command: SlashCommand): CommandScope {
  if (command.origin === "project-custom") return "project";
  if (command.origin === "global-custom") return "global";
  if (command.source === "custom") return "global";
  return "built-in";
}

const SCOPE_RANK: Readonly<Record<CommandScope, number>> = { project: 0, global: 1, "built-in": 2 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every command, grouped Everyday → Specialist → Setup → Other. Nothing is
 * hidden: commands without a `group` land in Other. Within a group, project
 * commands come first, then global, then built-in, each alphabetical. Empty
 * groups are omitted.
 */
export function paletteGroups(commands: readonly SlashCommand[]): PaletteGroup[] {
  const byGroup = new Map<PaletteGroupKey, SlashCommand[]>(PALETTE_GROUPS.map((key) => [key, []]));
  for (const command of commands) byGroup.get(command.group ?? "other")?.push(command);
  return PALETTE_GROUPS.flatMap((key) => {
    const group = byGroup.get(key) ?? [];
    if (group.length === 0) return [];
    return [
      {
        key,
        label: PALETTE_GROUP_LABELS[key],
        commands: [...group].sort(
          (a, b) =>
            SCOPE_RANK[commandScope(a)] - SCOPE_RANK[commandScope(b)] ||
            compareText(a.name, b.name),
        ),
      },
    ];
  });
}
