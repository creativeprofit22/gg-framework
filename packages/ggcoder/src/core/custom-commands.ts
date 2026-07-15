import fs from "node:fs/promises";
import path from "node:path";
import { getAppPaths } from "../config.js";
import { parseSkillFile } from "./skills.js";

export type CustomCommandScope = "global" | "project";

export interface CustomCommand {
  name: string;
  description: string;
  prompt: string;
  filePath: string;
  scope: CustomCommandScope;
}

function windowsHomeToWslMount(home: string): string | null {
  if (process.platform === "win32") return null;
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(home);
  const drive = match?.[1]?.toLowerCase();
  if (!drive) return null;
  const rest = (match?.[2] ?? "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
  return `/mnt/${drive}${rest ? `/${rest}` : ""}`;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function commandDirsForHome(home: string | undefined): string[] {
  if (!home) return [];
  const dirs = [path.join(home, ".gg", "commands")];
  const wslMount = windowsHomeToWslMount(home);
  if (wslMount) dirs.push(path.join(wslMount, ".gg", "commands"));
  return dirs;
}

function getGlobalCommandDirs(): string[] {
  return uniquePaths([
    path.join(getAppPaths().agentDir, "commands"),
    ...commandDirsForHome(process.env.HOME),
    ...commandDirsForHome(process.env.USERPROFILE),
  ]);
}

async function loadCommandsFromDir(
  commandsDir: string,
  scope: CustomCommandScope,
): Promise<CustomCommand[]> {
  let files: string[];
  try {
    files = await fs.readdir(commandsDir);
  } catch {
    return [];
  }

  const commands: CustomCommand[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(commandsDir, file);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = parseSkillFile(raw, scope);
      commands.push({
        name: parsed.name || path.basename(file, ".md"),
        description: parsed.description || `Custom command from ${commandsDir}/${file}`,
        prompt: parsed.content,
        filePath,
        scope,
      });
    } catch {
      // Skip unreadable files
    }
  }
  return commands;
}

/** Load global and project custom commands, with project commands taking precedence. */
export async function loadCustomCommands(cwd: string): Promise<CustomCommand[]> {
  const [globalGroups, projectCommands] = await Promise.all([
    Promise.all(getGlobalCommandDirs().map((dir) => loadCommandsFromDir(dir, "global"))),
    loadCommandsFromDir(path.join(cwd, ".gg", "commands"), "project"),
  ]);

  const commandsByName = new Map<string, CustomCommand>();
  for (const command of globalGroups.flat()) {
    if (!commandsByName.has(command.name)) commandsByName.set(command.name, command);
  }
  for (const command of projectCommands) commandsByName.set(command.name, command);
  return [...commandsByName.values()];
}
