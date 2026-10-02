import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeSlashCommandArgumentHint,
  normalizeSlashCommandCollection,
  normalizeSlashCommandEffect,
  normalizeSlashCommandGroup,
  SLASH_COMMAND_PROBLEM_FILE_MAX_LENGTH,
  SLASH_COMMAND_PROBLEMS_MAX,
  type SlashCommandEffect,
  type SlashCommandGroup,
  type SlashCommandProblem,
} from "@kenkaiiii/gg-core";
import { getAppPaths } from "../config.js";
import { stripBom } from "../utils/text.js";
import { parseFrontmatter } from "./frontmatter.js";

export type CustomCommandScope = "global" | "project";

/** Arguments stay appended data; there is no template-substitution language. */
export function appendCommandArguments(prompt: string, args: string): string {
  return args ? `${prompt}\n\n## User Instructions\n\n${args}` : prompt;
}

export interface CustomCommand {
  name: string;
  description: string;
  prompt: string;
  filePath: string;
  scope: CustomCommandScope;
  /** Normalized `argument-hint` frontmatter; shown in menus only, never sent to the model. */
  argumentHint?: string;
  /** Normalized `collection` frontmatter; only marked commands appear in the desktop palette. */
  collection?: string;
  /** Normalized `group` frontmatter; places the command in the desktop palette. */
  group?: SlashCommandGroup;
  /** Normalized `effect` frontmatter; shown as a badge in the desktop palette. */
  effect?: SlashCommandEffect;
}

export interface CustomCommandCatalog {
  commands: CustomCommand[];
  /** Files that exist but could not be read, or whose header could not be parsed. */
  problems: SlashCommandProblem[];
}

/** Mirrors the shared contract's problem `file` rule; one bad entry would reject the whole listing. */
function isReportableProblemFile(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= SLASH_COMMAND_PROBLEM_FILE_MAX_LENGTH &&
    !/[\\/]/.test(file) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/.test(file)
  );
}

/** The single builder for problem reports; returns null when the file name cannot be reported safely. */
export function commandProblem(
  filePath: string,
  scope: CustomCommandScope,
  reason: SlashCommandProblem["reason"],
): SlashCommandProblem | null {
  const file = path.basename(filePath);
  if (!isReportableProblemFile(file)) return null;
  return { file, scope, reason };
}

/** Deduplicate, order deterministically, and bound problem reports for the listing contract. */
export function boundCommandProblems(problems: readonly SlashCommandProblem[]): SlashCommandProblem[] {
  const unique = new Map<string, SlashCommandProblem>();
  for (const problem of problems) {
    if (!isReportableProblemFile(problem.file)) continue;
    unique.set(`${problem.scope}\u0000${problem.file}\u0000${problem.reason}`, problem);
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
    )
    .slice(0, SLASH_COMMAND_PROBLEMS_MAX);
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

function commandDirsForHome(home: string | undefined): string[] {
  if (!home) return [];
  const dirs = [path.join(home, ".gg", "commands")];
  const wslMount = windowsHomeToWslMount(home);
  if (wslMount) dirs.push(path.join(wslMount, ".gg", "commands"));
  return dirs;
}

/** Shared by loading and pre-deduplication creation collision checks. */
export function getGlobalCommandDirs(): string[] {
  return [
    ...new Set([
      path.join(getAppPaths().agentDir, "commands"),
      ...commandDirsForHome(process.env.HOME),
      ...commandDirsForHome(process.env.USERPROFILE),
    ]),
  ];
}

async function loadCommandsFromDir(
  commandsDir: string,
  scope: CustomCommandScope,
): Promise<CustomCommandCatalog> {
  let files: string[];
  try {
    files = await fs.readdir(commandsDir);
  } catch {
    // A missing commands folder is normal, not a problem to report.
    return { commands: [], problems: [] };
  }

  const commands: CustomCommand[] = [];
  const problems: SlashCommandProblem[] = [];
  const report = (filePath: string, reason: SlashCommandProblem["reason"]) => {
    const problem = commandProblem(filePath, scope, reason);
    if (problem) problems.push(problem);
  };
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(commandsDir, file);

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      // A BOM before `---` would otherwise silently kill frontmatter parsing.
      const text = stripBom(raw);
      const { fields, body, hasFrontmatter } = parseFrontmatter(text);
      // An opened but never-closed header still loads (as before), but its
      // description/group/effect are lost, so surface it as broken.
      if (!hasFrontmatter && /^---[ \t]*\r?\n/.test(text)) report(filePath, "malformed-frontmatter");
      const argumentHint = normalizeSlashCommandArgumentHint(fields["argument-hint"]);
      const collection = normalizeSlashCommandCollection(fields["collection"]);
      const group = normalizeSlashCommandGroup(fields["group"]);
      const effect = normalizeSlashCommandEffect(fields["effect"]);
      commands.push({
        name: fields.name || path.basename(file, ".md"),
        description: fields.description || `Custom command from ${commandsDir}/${file}`,
        prompt: body,
        filePath,
        scope,
        ...(argumentHint ? { argumentHint } : {}),
        ...(collection ? { collection } : {}),
        ...(group ? { group } : {}),
        ...(effect ? { effect } : {}),
      });
    } catch {
      // Unreadable files cannot become commands; report them instead of hiding them.
      report(filePath, "unreadable");
    }
  }

  return { commands, problems };
}

/** Load global and project custom commands (project wins) plus per-file problems. */
export async function loadCustomCommandCatalog(cwd: string): Promise<CustomCommandCatalog> {
  const [globalGroups, project] = await Promise.all([
    Promise.all(getGlobalCommandDirs().map((dir) => loadCommandsFromDir(dir, "global"))),
    loadCommandsFromDir(path.join(cwd, ".gg", "commands"), "project"),
  ]);

  const commandsByName = new Map<string, CustomCommand>();
  for (const command of globalGroups.flatMap((group) => group.commands)) {
    if (!commandsByName.has(command.name)) commandsByName.set(command.name, command);
  }
  for (const command of project.commands) commandsByName.set(command.name, command);
  return {
    commands: [...commandsByName.values()],
    problems: boundCommandProblems([
      ...project.problems,
      ...globalGroups.flatMap((group) => group.problems),
    ]),
  };
}

/** Load global and project custom commands, with project commands taking precedence. */
export async function loadCustomCommands(cwd: string): Promise<CustomCommand[]> {
  return (await loadCustomCommandCatalog(cwd)).commands;
}
