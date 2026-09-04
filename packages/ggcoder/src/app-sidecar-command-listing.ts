import {
  SLASH_COMMAND_INPUT_ALL,
  type SlashCommandListing,
  type SlashCommandsResponse,
} from "@kenkaiiii/gg-core";
import { loadCustomCommands } from "./core/custom-commands.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";

const WORKSPACE_ACTIONS: SlashCommandListing[] = [
  {
    name: "add-dir",
    aliases: ["adddir"],
    description: "Add another project folder to this workspace",
    input: { text: "optional", references: "none", attachments: "none" },
    source: "built-in",
  },
  {
    name: "remove-dir",
    aliases: ["removedir"],
    description: "Remove an added project folder from this workspace",
    input: { text: "optional", references: "none", attachments: "none" },
    source: "built-in",
  },
];

export async function appSidecarCodeCommandsResponse(cwd: string): Promise<SlashCommandsResponse> {
  const builtins: SlashCommandListing[] = PROMPT_COMMANDS.map((command) => ({
    name: command.name,
    aliases: command.aliases,
    description: command.description,
    input: { ...(command.input ?? SLASH_COMMAND_INPUT_ALL) },
    source: "built-in",
  }));
  const custom: SlashCommandListing[] = (await loadCustomCommands(cwd))
    .filter(
      (command) =>
        !PROMPT_COMMANDS.some((builtin) => builtin.name === command.name) &&
        !WORKSPACE_ACTIONS.some((action) => action.name === command.name),
    )
    .map((command) => ({
      name: command.name,
      aliases: [],
      description: command.description,
      input: { ...SLASH_COMMAND_INPUT_ALL },
      source: "custom",
    }));

  return { commands: [...WORKSPACE_ACTIONS, ...builtins, ...custom] };
}
