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
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function commandDirsForHome(home: string | undefined): string[] {
  if (!home) return [];
  const dirs = [path.join(home, ".gg", "commands")];
  const wslMount = windowsHomeToWslMount(home);
  if (wslMount) dirs.push(path.join(wslMount, ".gg", "commands"));
  return dirs;
}

function getGlobalCommandDirs(): string[] {
  const primary = path.join(getAppPaths().agentDir, "commands");
  return uniquePaths([
    primary,
    ...commandDirsForHome(process.env.HOME),
    ...commandDirsForHome(process.env.USERPROFILE),
  ]);
}

async function loadCommandsFromDir(
  commandsDir: string,
  scope: CustomCommandScope,
): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];

  let files: string[];
  try {
    files = await fs.readdir(commandsDir);
  } catch {
    return commands;
  }

  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(commandsDir, file);

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = parseSkillFile(raw, scope);
      const name = parsed.name || path.basename(file, ".md");
      commands.push({
        name,
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

/**
 * Load custom slash commands from global ~/.gg/commands/*.md and
 * {cwd}/.gg/commands/*.md. Each .md file becomes a slash command.
 * Frontmatter provides name/description, and the body becomes the prompt
 * injected into the agent. Project commands take precedence over global
 * commands with the same name.
 */
export async function loadCustomCommands(cwd: string): Promise<CustomCommand[]> {
  const globalCommandDirs = getGlobalCommandDirs();
  const projectCommandsDir = path.join(cwd, ".gg", "commands");
  const [globalCommandGroups, projectCommands] = await Promise.all([
    Promise.all(globalCommandDirs.map((dir) => loadCommandsFromDir(dir, "global"))),
    loadCommandsFromDir(projectCommandsDir, "project"),
  ]);

  const commandsByName = new Map<string, CustomCommand>();
  for (const command of globalCommandGroups.flat()) {
    if (!commandsByName.has(command.name)) commandsByName.set(command.name, command);
  }
  for (const command of projectCommands) commandsByName.set(command.name, command);
  return [...commandsByName.values()];
}
