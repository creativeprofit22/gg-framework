import {
  isValidProgrammaticFocus,
  PROGRAMMATIC_FOCUS_GUIDANCE,
} from "@kenkaiiii/gg-core/slash-command-contract";
import type { SlashCommand } from "./agent";
import { parseReferencedFiles } from "./ReferencedFiles";

export function slashCommandForInput(
  input: string,
  commands: SlashCommand[],
): { command: SlashCommand; args: string } | null {
  const match = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return null;
  const command = commands.find(
    (candidate) => candidate.name === match[1] || candidate.aliases.includes(match[1]!),
  );
  return command ? { command, args: match[2]?.trim() ?? "" } : null;
}

export function noInputSlashSubmissionError(
  input: string,
  commands: SlashCommand[],
  attachmentCount: number,
  referencedFileCount: number,
): string | null {
  const match = slashCommandForInput(input, commands);
  if (!match) return null;
  const blocked = [
    match.args && match.command.input.text === "none" ? "additional text" : null,
    match.command.input.references === "none" &&
    (referencedFileCount > 0 || parseReferencedFiles(input.trim()).files.length > 0)
      ? "file references"
      : null,
    attachmentCount > 0 && match.command.input.attachments === "none" ? "attachments" : null,
  ].filter((kind): kind is string => kind !== null);
  if (blocked.length > 0)
    return `/${match.command.name} does not accept ${blocked.join(", ")}. Remove them and send the command again.`;
  if (
    match.command.source === "built-in" &&
    match.command.name === "programmatic" &&
    match.args &&
    !isValidProgrammaticFocus(match.args)
  )
    return PROGRAMMATIC_FOCUS_GUIDANCE;
  return null;
}
