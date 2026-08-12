import type { SlashCommand } from "../agent";

const ROADMAP_COMMAND_ORDER = ["compare", "trace", "parity", "ship"] as const;

export interface RoadmapCommandAction {
  canonicalName: (typeof ROADMAP_COMMAND_ORDER)[number];
  label: string;
  invocation: string;
}

function normalizeName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLocaleLowerCase();
}

/** Resolve only commands present in the sidecar-hydrated catalog. */
export function resolveRoadmapCommandActions(
  commands: readonly SlashCommand[],
): RoadmapCommandAction[] {
  const seenCommands = new Set<string>();
  const actions: RoadmapCommandAction[] = [];
  for (const canonicalName of ROADMAP_COMMAND_ORDER) {
    const command = commands.find((candidate) =>
      [candidate.name, ...candidate.aliases].some(
        (name) => normalizeName(name) === canonicalName,
      ),
    );
    if (!command) continue;
    const commandKey = normalizeName(command.name);
    if (!commandKey || seenCommands.has(commandKey)) continue;
    seenCommands.add(commandKey);
    actions.push({
      canonicalName,
      label: `Run /${canonicalName}`,
      invocation: `/${command.name.replace(/^\/+/, "")}`,
    });
  }
  return actions;
}
