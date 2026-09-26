import {
  SLASH_COMMAND_INPUT_ALL,
  SLASH_COMMAND_NAME_MAX_LENGTH,
  SLASH_COMMAND_DESCRIPTION_MAX_LENGTH,
  type SlashCommandListing,
} from "@kenkaiiii/gg-core";
import { loadCustomCommands, type CustomCommand } from "./custom-commands.js";
import { log } from "./logger.js";
import { PROMPT_COMMANDS, type PromptCommand } from "./prompt-commands.js";
import { programmaticCommandReferenceV1Schema } from "./programmatic/contracts.js";
import { assessProgrammaticSetup, loadApprovedProgrammaticProfile, type ProgrammaticSetupAssessment } from "./programmatic/profile.js";

export type ProgrammaticReadiness = ProgrammaticSetupAssessment["status"];

/** Share only concurrent work. Every later request checks the live approved baseline again. */
export function createProgrammaticReadinessReader(cwd: string): () => Promise<ProgrammaticReadiness> {
  let pending: Promise<ProgrammaticReadiness> | undefined;
  return () => {
    pending ??= (async (): Promise<ProgrammaticReadiness> => {
      try {
        try {
          if (!(await loadApprovedProgrammaticProfile(cwd))) return "missing";
        } catch {
          // Legacy and malformed profiles must retain the assessment's distinct guidance.
        }
        return (await assessProgrammaticSetup(cwd)).status;
      } catch {
        return "unreadable";
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

export function programmaticReadinessGuidance(status: ProgrammaticReadiness): string | null {
  switch (status) {
    case "current": return null;
    case "missing": return "Run /setup-programmatic, review the proposal and separately approve saving setup before /programmatic.";
    case "refresh-required": return "Run /setup-programmatic to review and separately approve a setup refresh or legacy upgrade before /programmatic. Saved reports remain inspectable.";
    case "unreadable": return "Stored setup or configuration is unreadable or unsafe. Run /setup-programmatic to inspect repair guidance; preserve existing files and saved reports. Nothing was rewritten.";
  }
}

export function registryCommandListings(commands: readonly { name: string; aliases: string[]; description: string; usage?: string }[]): SlashCommandListing[] {
  return commands.map((command) => ({
    name: command.name, aliases: command.aliases, description: command.description,
    ...(command.usage ? { usage: command.usage } : {}),
    input: { text: "optional", references: "none", attachments: "none" }, source: "built-in",
  }));
}

export interface CommandDiscoveryOptions {
  /** Host-owned namespace reservations only, not discoverable backend handlers. */
  reservedCommandIdentities?: readonly string[];
  /** Intercepted by the host before normal GG slash dispatch. */
  workspaceActions?: readonly SlashCommandListing[];
  workspaceCaseInsensitive?: boolean;
  /** Normal registry dispatch follows built-in and custom prompt resolution. */
  registryActions?: readonly SlashCommandListing[];
  getRegistryActions?: () => readonly SlashCommandListing[];
  readReadiness?: () => Promise<ProgrammaticReadiness>;
}

export interface DiscoveredCommand {
  listing: SlashCommandListing;
  /** Private owner/body data: never serialize this record into model context. */
  prompt?: PromptCommand;
  custom?: CustomCommand;
}

export interface CommandDiscovery {
  entries: DiscoveredCommand[];
  resolve(name: string): DiscoveredCommand | undefined;
}

/** Derived per request from the existing Markdown loader; no second parser or catalog store. */
export async function discoverCommands(
  cwd: string,
  options: CommandDiscoveryOptions = {},
): Promise<CommandDiscovery> {
  const readiness = await (options.readReadiness ?? createProgrammaticReadinessReader(cwd))();
  const entries: DiscoveredCommand[] = [];
  const claimed = new Set<string>();
  const resolved = new Map<string, DiscoveredCommand>();
  const workspaceClaims = new Set<string>();
  const isClaimed = (name: string) => claimed.has(name) || workspaceClaims.has(name.toLowerCase());
  const add = (entry: DiscoveredCommand) => {
    const { name, aliases } = entry.listing;
    if (isClaimed(name)) return;
    const availableAliases = aliases.filter((alias) => !isClaimed(alias));
    entry.listing = { ...entry.listing, aliases: availableAliases };
    for (const identity of [name, ...availableAliases]) {
      claimed.add(identity);
      resolved.set(identity, entry);
    }
    if (name !== "programmatic-run" && (name !== "programmatic" || readiness === "current"))
      entries.push(entry);
  };
  const action = (listing: SlashCommandListing): DiscoveredCommand => ({
    listing: { ...listing, origin: "built-in", invocationKind: "workspace-action" },
  });
  for (const item of options.workspaceActions ?? []) {
    add(action(item));
    if (options.workspaceCaseInsensitive)
      for (const name of [item.name, ...item.aliases]) workspaceClaims.add(name.toLowerCase());
  }
  for (const prompt of PROMPT_COMMANDS) {
    add({ prompt, listing: {
      name: prompt.name, aliases: [...prompt.aliases], description: prompt.description,
      input: { ...(prompt.input ?? SLASH_COMMAND_INPUT_ALL) }, source: "built-in",
      origin: "built-in", invocationKind: "prompt",
    } });
  }
  // The selection/approval helper is reserved even in hosts that do not advertise it.
  claimed.add("programmatic-run");
  for (const custom of await loadCustomCommands(cwd)) {
    if (!custom.name.length || custom.name.length > SLASH_COMMAND_NAME_MAX_LENGTH) {
      log("WARN", "command-discovery", "Skipping custom command with an unrepresentable identity", {
        scope: custom.scope,
        nameLength: String(custom.name.length),
      });
      continue;
    }
    add({ custom, listing: {
      name: custom.name, aliases: [],
      description: (custom.description.startsWith("Custom command from ")
        ? "Custom command" : custom.description).slice(0, SLASH_COMMAND_DESCRIPTION_MAX_LENGTH),
      input: { ...SLASH_COMMAND_INPUT_ALL }, source: "custom",
      origin: custom.scope === "project" ? "project-custom" : "global-custom",
      invocationKind: "prompt",
    } });
  }
  for (const item of options.getRegistryActions?.() ?? options.registryActions ?? []) {
    if (isClaimed(item.name)) {
      // A custom canonical name does not intercept the registry's other aliases.
      const aliases = item.aliases.filter((alias) => !isClaimed(alias));
      if (aliases.length) add(action({ ...item, name: aliases[0]!, aliases: aliases.slice(1) }));
    } else add(action(item));
  }
  return { entries, resolve: (name) => resolved.get(name) };
}

export interface AdvisoryCommandPage {
  entries: (SlashCommandListing & { bodyUnavailableReason?: string; metadataLimited?: boolean })[];
  offset: number;
  nextOffset: number | null;
  total: number;
  limitedCoverage: boolean;
}

/** Bounds include JSON escaping and the page envelope, measured in UTF-16 units. */
export function projectAdvisoryCommands(discovery: CommandDiscovery, offset = 0): AdvisoryCommandPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > discovery.entries.length)
    throw new Error("Invalid command page offset; list from offset 0 after command changes.");
  const page: AdvisoryCommandPage = {
    entries: [], offset, nextOffset: null, total: discovery.entries.length, limitedCoverage: offset > 0,
  };
  for (let index = offset; index < discovery.entries.length; index++) {
    const listing = discovery.entries[index]!.listing;
    const supported = programmaticCommandReferenceV1Schema.safeParse({
      version: 1, name: listing.name, source: listing.origin, invocationKind: listing.invocationKind,
    }).success;
    let row: AdvisoryCommandPage["entries"][number] = {
      name: listing.name, aliases: listing.aliases, description: listing.description.slice(0, SLASH_COMMAND_DESCRIPTION_MAX_LENGTH),
      input: listing.input, source: listing.source, origin: listing.origin, invocationKind: listing.invocationKind,
      ...(listing.usage ? { usage: listing.usage } : {}),
      ...(!supported ? { bodyUnavailableReason: "Identity is unsupported for advisory body lookup." } : {}),
    };
    // A single legal UI row can exceed a whole advisory page after JSON escaping.
    // Keep the executable identity intact, disclose omitted metadata, and always advance.
    if (JSON.stringify({ ...page, entries: [row] }).length > 31_900) {
      row = { ...row, aliases: [], description: "Metadata omitted to fit the advisory page limit.", usage: undefined, metadataLimited: true };
      page.limitedCoverage = true;
    }
    const candidate = { ...page, entries: [...page.entries, row], nextOffset: index + 1, limitedCoverage: true };
    if (page.entries.length >= 100 || JSON.stringify(candidate).length > 32_000) {
      page.nextOffset = index;
      page.limitedCoverage = true;
      break;
    }
    page.entries.push(row);
  }
  return page;
}
