import { CLIENT_RESERVED_SLASH_COMMAND_IDENTITIES, type SlashCommandListing, type SlashCommandsResponse } from "@kenkaiiii/gg-core";
import { discoverCommands, type CommandDiscoveryOptions } from "./core/command-discovery.js";

export const WORKSPACE_ACTIONS: SlashCommandListing[] = [
  {
    name: "programmatic-run",
    aliases: [],
    description: "Approve and run one selected opportunity in an isolated session",
    input: { text: "optional", references: "none", attachments: "none" },
    source: "built-in",
  },
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

export const DESKTOP_COMMAND_DISCOVERY_OPTIONS = {
  workspaceActions: WORKSPACE_ACTIONS,
  reservedCommandIdentities: CLIENT_RESERVED_SLASH_COMMAND_IDENTITIES,
} satisfies CommandDiscoveryOptions;

export async function appSidecarCodeCommandsResponse(cwd: string): Promise<SlashCommandsResponse> {
  const discovery = await discoverCommands(cwd, DESKTOP_COMMAND_DISCOVERY_OPTIONS);
  return { commands: discovery.entries.map((entry) => entry.listing) };
}
