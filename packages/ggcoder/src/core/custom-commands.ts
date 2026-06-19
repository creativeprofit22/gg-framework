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
 * Load custom slash commands from ~/.gg/commands/*.md and {cwd}/.gg/commands/*.md.
 * Each .md file becomes a slash command. Frontmatter provides name/description,
 * and the body becomes the prompt injected into the agent. Project commands take
 * precedence over global commands with the same name.
 */
export async function loadCustomCommands(cwd: string): Promise<CustomCommand[]> {
  const globalCommandsDir = path.join(getAppPaths().agentDir, "commands");
  const projectCommandsDir = path.join(cwd, ".gg", "commands");
  const [globalCommands, projectCommands] = await Promise.all([
    loadCommandsFromDir(globalCommandsDir, "global"),
    loadCommandsFromDir(projectCommandsDir, "project"),
  ]);

  const commandsByName = new Map<string, CustomCommand>();
  for (const command of globalCommands) commandsByName.set(command.name, command);
  for (const command of projectCommands) commandsByName.set(command.name, command);
  return [...commandsByName.values()];
}
