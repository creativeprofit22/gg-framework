import type { SlashCommandListing, SlashCommandsResponse } from "@kenkaiiii/gg-core";
import { discoverCommands } from "./core/command-discovery.js";

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

export async function appSidecarCodeCommandsResponse(cwd: string): Promise<SlashCommandsResponse> {
  const discovery = await discoverCommands(cwd, { workspaceActions: WORKSPACE_ACTIONS });
  return { commands: discovery.entries.map((entry) => entry.listing) };
}
