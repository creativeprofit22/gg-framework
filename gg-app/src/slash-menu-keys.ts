import { CLIENT_OWNED_SLASH_COMMANDS } from "@kenkaiiii/gg-core/slash-command-contract";
import type { SlashCommand } from "./agent";

export type SlashMenuKeyAction =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "complete"; command: SlashCommand }
  | { kind: "send"; command: SlashCommand; picker: boolean }
  | { kind: "dismiss" };

export interface SlashMenuKeyInput {
  key: string;
  shiftKey: boolean;
  /** Raw text after `/`, case preserved; the daemon resolves commands case-sensitively. */
  token: string;
  matches: readonly SlashCommand[];
  activeIndex: number;
}

const SCHEDULE_TOKENS: readonly string[] = [
  CLIENT_OWNED_SLASH_COMMANDS.schedule.name,
  ...CLIENT_OWNED_SLASH_COMMANDS.schedule.aliases,
];

/** Raw text after `/` while the draft is a single `/token`; null otherwise. */
export function slashTokenFor(input: string): string | null {
  return input.startsWith("/") && !input.includes(" ") ? input.slice(1) : null;
}

/** Lowercased text after `/` while the draft is a single `/token`; null otherwise. */
export function slashQueryFor(input: string): string | null {
  return slashTokenFor(input)?.toLowerCase() ?? null;
}

export function isExactSlashMatch(command: SlashCommand, query: string): boolean {
  const q = query.toLowerCase();
  return command.name.toLowerCase() === q || command.aliases.some((a) => a.toLowerCase() === q);
}

function isCaseExactSlashMatch(command: SlashCommand, token: string): boolean {
  return command.name === token || command.aliases.includes(token);
}

/** Folder commands open the native picker and send from there. */
export function opensFolderPicker(command: SlashCommand): boolean {
  return command.name === "add-dir" || command.name === "remove-dir";
}

/** Exact name/alias matches first so the default highlight is the typed command. */
export function orderSlashMatches(matches: readonly SlashCommand[], query: string): SlashCommand[] {
  const exact = matches.filter((c) => isExactSlashMatch(c, query));
  const rest = matches.filter((c) => !isExactSlashMatch(c, query));
  return [...exact, ...rest];
}

export function slashMenuKeyAction(input: SlashMenuKeyInput): SlashMenuKeyAction | null {
  const { key, shiftKey, token, matches, activeIndex } = input;
  if (matches.length === 0) return null;
  if (key === "ArrowDown") return { kind: "move", delta: 1 };
  if (key === "ArrowUp") return { kind: "move", delta: -1 };
  if (key === "Escape") return { kind: "dismiss" };
  const command = matches[activeIndex % matches.length];
  if (!command) return null;
  if (key === "Tab") return { kind: "complete", command };
  if (key !== "Enter" || shiftKey) return null;
  // `/schedule` has no bare form: sending it would run the raw text as a prompt.
  const bareSendable = !SCHEDULE_TOKENS.includes(command.name.toLowerCase());
  // A wrong-case token completes to the canonical name instead of sending text the daemon can't resolve.
  if (bareSendable && isCaseExactSlashMatch(command, token)) {
    return { kind: "send", command, picker: opensFolderPicker(command) };
  }
  return { kind: "complete", command };
}

export function slashOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

export interface SlashMenuInputAria {
  "aria-autocomplete": "list";
  "aria-haspopup": "listbox";
  "aria-controls": string | undefined;
  "aria-activedescendant": string | undefined;
  "data-slash-menu-open": "true" | "false";
}

/** Textarea attributes; aria-expanded is not allowed on a textbox, so the open state is a data attribute. */
export function slashMenuInputAria(input: {
  open: boolean;
  listId: string;
  activeIndex: number;
}): SlashMenuInputAria {
  const { open, listId, activeIndex } = input;
  return {
    "aria-autocomplete": "list",
    "aria-haspopup": "listbox",
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant": open ? slashOptionId(listId, activeIndex) : undefined,
    "data-slash-menu-open": open ? "true" : "false",
  };
}
