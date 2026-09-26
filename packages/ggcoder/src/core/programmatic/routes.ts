import path from "node:path";
import { sha256 as hash, canonicalRepositoryRoot, containedPath, stableJson } from "../tauri-package/paths.js";
import { discoverCommands, type CommandDiscoveryOptions } from "../command-discovery.js";
import { commandLocalStat, observeCommandSources, readCommandText } from "./command-creation.js";
import { directCommandSelectionV1Schema, directExecutionSnapshotV1Schema, type DirectCommandSelection, type DirectExecutionPolicy, type DirectExecutionSnapshot } from "./contracts.js";
import { loadCustomCommands, type CustomCommand } from "../custom-commands.js";
import { getPromptCommand, type PromptCommand } from "../prompt-commands.js";
import type {
  AvailableCommandV1,
  ConfigurationFingerprintV1,
  DiscoveredOpportunityV1,
  RouteArgumentV1,
  RouteResolutionV1,
  SpecialistCommand,
  UnavailableCommandV1,
} from "./contracts.js";
import {
  PROGRAMMATIC_CONTRACT_VERSION,
  PROGRAMMATIC_MACHINE_LOCAL_WARNING,
  routeResolutionV1Schema,
  specialistCommandSchema,
} from "./contracts.js";
import { compareText } from "../tauri-package/paths.js";

type SpecialistOwner = AvailableCommandV1["source"];
type SpecialistDefinition = Readonly<{
  command: SpecialistCommand;
  owner: SpecialistOwner;
  portability: AvailableCommandV1["portability"];
  mutates: boolean;
  arguments: (opportunity: DiscoveredOpportunityV1) => RouteArgumentV1[];
}>;

function scopedArguments(opportunity: DiscoveredOpportunityV1): RouteArgumentV1[] {
  return [
    { name: "detector-id", value: opportunity.identity.detectorId },
    { name: "representative-case", value: opportunity.representativeCase },
  ];
}

function tauriArguments(opportunity: DiscoveredOpportunityV1): RouteArgumentV1[] {
  const packageManifest = opportunity.identity.path ?? opportunity.representativeCase;
  const separator = packageManifest.lastIndexOf("/");
  return [{ name: "app-root", value: separator === -1 ? "." : packageManifest.slice(0, separator) }];
}

export const SPECIALIST_ROUTES = Object.freeze([
  Object.freeze({
    command: "setup-tauri-package",
    owner: "built-in",
    portability: "bundled",
    mutates: true,
    arguments: tauriArguments,
  }),
  Object.freeze({
    command: "research",
    owner: "global-custom",
    portability: "machine-local",
    mutates: false,
    arguments: scopedArguments,
  }),
  Object.freeze({
    command: "setup-sweep",
    owner: "global-custom",
    portability: "machine-local",
    mutates: true,
    arguments: scopedArguments,
  }),
] as const satisfies readonly SpecialistDefinition[]);

function unavailable(
  reason: UnavailableCommandV1["reason"],
  definition?: SpecialistDefinition,
  source?: UnavailableCommandV1["source"],
): UnavailableCommandV1 {
  return {
    status: "unavailable",
    reason,
    ...(source === undefined ? {} : { source }),
    ...(definition === undefined
      ? {}
      : definition.portability === "machine-local"
        ? {
            portability: definition.portability,
            portabilityWarning: PROGRAMMATIC_MACHINE_LOCAL_WARNING,
          }
        : { portability: definition.portability }),
  };
}

function registryEntry(command: string): SpecialistDefinition | UnavailableCommandV1 {
  const entries = SPECIALIST_ROUTES.filter((entry) => entry.command === command);
  if (entries.length === 0) return unavailable("unsupported");
  const entry = entries[0]!;
  if (
    entries.length !== 1 ||
    (entry.owner === "built-in") !== (entry.portability === "bundled")
  ) {
    return unavailable("ambiguous", entry);
  }
  return entry;
}

function available(definition: SpecialistDefinition): AvailableCommandV1 {
  return definition.portability === "bundled"
    ? { status: "available", source: "built-in", portability: "bundled" }
    : {
        status: "available",
        source: "global-custom",
        portability: "machine-local",
        portabilityWarning: PROGRAMMATIC_MACHINE_LOCAL_WARNING,
      };
}

export function resolveSpecialistAvailability(
  command: string,
  customCommands: readonly CustomCommand[],
  builtInCommand: PromptCommand | undefined,
): AvailableCommandV1 | UnavailableCommandV1 {
  const definition = registryEntry(command);
  if ("status" in definition) return definition;
  if (builtInCommand !== undefined) {
    return definition.owner === "built-in"
      ? available(definition)
      : unavailable("wrong-owner", definition, "built-in");
  }

  const customMatches = customCommands.filter(({ name }) => name === command);
  if (customMatches.length === 0) return unavailable("missing", definition);
  if (customMatches.length !== 1) return unavailable("ambiguous", definition);
  const custom = customMatches[0]!;
  if (custom.scope !== "global" || definition.owner !== "global-custom") {
    return unavailable(
      "wrong-owner",
      definition,
      custom.scope === "global" ? "global-custom" : undefined,
    );
  }
  return available(definition);
}

function observedEvidencePaths(opportunity: DiscoveredOpportunityV1): string[] {
  return [
    ...new Set(
      opportunity.evidence.items.flatMap(({ basis, location }) =>
        basis === "observed" && location !== undefined ? [location.path] : [],
      ),
    ),
  ].sort(compareText);
}

export function resolveOpportunityRoute(
  opportunity: DiscoveredOpportunityV1,
  configurationFingerprint: ConfigurationFingerprintV1,
  customCommands: readonly CustomCommand[],
  builtInCommand: PromptCommand | undefined,
): RouteResolutionV1 {
  if (opportunity.route.status === "unroutable") {
    return routeResolutionV1Schema.parse({
      version: PROGRAMMATIC_CONTRACT_VERSION,
      status: "unroutable",
      opportunityId: opportunity.identity.id,
      availability: unavailable("unsupported"),
      reason: "GG has no supported task tool for this opportunity. It can be reviewed but not started here.",
    });
  }

  const command = specialistCommandSchema.safeParse(opportunity.route.specialistCommand);
  if (!command.success) {
    return routeResolutionV1Schema.parse({
      version: PROGRAMMATIC_CONTRACT_VERSION,
      status: "unroutable",
      opportunityId: opportunity.identity.id,
      availability: unavailable("unsupported"),
      reason: "This opportunity needs a tool that GG does not support.",
    });
  }
  const definition = registryEntry(command.data);
  const availability = resolveSpecialistAvailability(
    command.data,
    customCommands,
    builtInCommand,
  );
  if ("status" in definition) {
    return routeResolutionV1Schema.parse({
      version: PROGRAMMATIC_CONTRACT_VERSION,
      status: "unroutable",
      opportunityId: opportunity.identity.id,
      candidateCommand: command.data,
      availability: definition,
      reason: `Specialist /${command.data} is unavailable: ${definition.reason}.`,
    });
  }
  if (availability.status === "unavailable") {
    return routeResolutionV1Schema.parse({
      version: PROGRAMMATIC_CONTRACT_VERSION,
      status: "unroutable",
      opportunityId: opportunity.identity.id,
      candidateCommand: command.data,
      availability,
      reason: `Specialist /${command.data} is unavailable: ${availability.reason}.`,
    });
  }

  const route = routeResolutionV1Schema.safeParse({
    version: PROGRAMMATIC_CONTRACT_VERSION,
    status: "routable",
    opportunityId: opportunity.identity.id,
    configurationFingerprint,
    specialistCommand: command.data,
    arguments: definition.arguments(opportunity).sort((left, right) =>
      compareText(left.name, right.name),
    ),
    evidencePaths: observedEvidencePaths(opportunity),
    scopePaths: [...new Set([...opportunity.inputPaths, ...opportunity.mutationPaths])].sort(compareText),
    successCondition: opportunity.verification,
    mutates: definition.mutates,
    reason: opportunity.expectedOutput,
    availability,
  });
  if (route.success) return route.data;
  const failure = unavailable("ambiguous", definition);
  return routeResolutionV1Schema.parse({
    version: PROGRAMMATIC_CONTRACT_VERSION,
    status: "unroutable",
    opportunityId: opportunity.identity.id,
    candidateCommand: command.data,
    availability: failure,
    reason: "GG could not determine safe instructions for this task. It cannot start here.",
  });
}

/** Ephemeral host snapshot; never persist command bodies in lifecycle or scan results. */
export type ResolvedSpecialist = Readonly<{
  route: Extract<RouteResolutionV1, { status: "routable" }>;
  command: Readonly<{ name: SpecialistCommand; prompt: string }>;
  owner: string;
  sha256: string;
}>;

async function loadSpecialistInputs(cwd: string) {
  return {
    customs: await loadCustomCommands(cwd),
    builtIns: new Map(SPECIALIST_ROUTES.map(({ command }) => [command, getPromptCommand(command)] as const)),
  };
}

export async function resolveProgrammaticSpecialist(
  cwd: string,
  opportunity: DiscoveredOpportunityV1,
  fingerprint: ConfigurationFingerprintV1,
): Promise<ResolvedSpecialist | RouteResolutionV1> {
  const { customs, builtIns } = await loadSpecialistInputs(cwd);
  const builtin = opportunity.route.status === "routable"
    ? builtIns.get(opportunity.route.specialistCommand)
    : undefined;
  const route = resolveOpportunityRoute(opportunity, fingerprint, customs, builtin);
  if (route.status !== "routable") return route;
  const custom = customs.find(({ name }) => name === route.specialistCommand);
  const prompt = builtin?.prompt ?? custom?.prompt;
  if (!prompt?.trim()) throw new Error("Specialist command body is unavailable.");
  const owner = builtin ? "built-in" : custom!.filePath;
  const command = Object.freeze({ name: route.specialistCommand, prompt });
  const sha256 = hash(JSON.stringify({ route, owner, command }));
  return Object.freeze({ route, command, owner, sha256 });
}

export interface ResolvedDirectCommand {
  command: Readonly<{ name: string; prompt: string }>;
  snapshot: DirectExecutionSnapshot;
  sha256: string;
  preview: string;
}

async function executionFileIdentity(absolute: string) {
  const stat = await commandLocalStat(absolute);
  if (!stat) throw new Error("Reviewed file or owner is unavailable.");
  const ancestors = [];
  for (let parent = path.dirname(absolute); ; parent = path.dirname(parent)) {
    const owner = await commandLocalStat(parent);
    if (!owner?.isDirectory()) throw new Error("Reviewed owner is unavailable.");
    ancestors.push({ path: parent, dev: owner.dev, ino: owner.ino, birthtime: owner.birthtimeMs });
    if (parent === path.dirname(parent)) break;
  }
  return hash(stableJson({ path: absolute, dev: stat.dev, ino: stat.ino, size: stat.size,
    mtime: stat.mtimeMs, ctime: stat.ctimeMs, birthtime: stat.birthtimeMs, ancestors }));
}

/** Exact-content direct selection; discovery decides ownership, never a supplied path. */
export async function resolveDirectCommand(
  cwd: string, input: DirectCommandSelection, policy: DirectExecutionPolicy,
  signal: AbortSignal, options: CommandDiscoveryOptions = {},
): Promise<ResolvedDirectCommand> {
  const selection = directCommandSelectionV1Schema.parse(input);
  signal.throwIfAborted();
  if (selection.containment !== "agent-session") throw new Error("OS confinement is unsupported. Use a separately approved confined workflow.");
  if (selection.command.invocationKind !== "prompt") throw new Error("Workspace actions cannot run here. Use their ordinary approved workflow.");
  if (!(await commandLocalStat(cwd))?.isDirectory()) throw new Error("Project owner is unavailable or linked.");
  const root = await canonicalRepositoryRoot(cwd);
  const repositorySha256 = hash(stableJson({ root, dev: (await commandLocalStat(root))!.dev, ino: (await commandLocalStat(root))!.ino }));
  const sources = await observeCommandSources(root, signal);
  const discovery = await discoverCommands(root, options);
  signal.throwIfAborted();
  const entry = discovery.resolve(selection.command.name);
  if (!entry || !discovery.entries.includes(entry) || entry.listing.name !== selection.command.name ||
    entry.listing.origin !== selection.command.source || entry.listing.invocationKind !== "prompt")
    throw new Error("The canonical command or selected owner is unavailable. Refresh discovery and review the current command.");
  const name = entry.listing.name.toLowerCase();
  const aliases = new Set([name, ...entry.listing.aliases.map((alias) => alias.toLowerCase())]);
  const competing = discovery.entries.filter((candidate) => candidate !== entry &&
    [candidate.listing.name, ...candidate.listing.aliases].some((identity) => aliases.has(identity.toLowerCase())));
  if (competing.length) throw new Error("Ambiguous command name or alias. Resolve collisions before execution.");
  let raw: string;
  let prompt: string;
  let ownerSha256: string;
  let sourceIdentitySha256: string;
  if (entry.custom) {
    const chosen = sources.sources.find((source) => path.resolve(source.filePath) === path.resolve(entry.custom!.filePath));
    if (!chosen || chosen.name !== entry.listing.name || chosen.prompt !== entry.custom.prompt || !chosen.filename.endsWith(".md"))
      throw new Error("Command source changed or is unsupported. Refresh and review again.");
    const collisions = sources.sources.filter((source) => source.scope === chosen.scope &&
      [source.name, source.filename.replace(/\.md$/i, "")].some((identity) => aliases.has(identity.toLowerCase())));
    if (collisions.length !== 1 || collisions[0] !== chosen)
      throw new Error("Ambiguous same-owner name, filename or case collision. Rename conflicting commands first.");
    const identity = await executionFileIdentity(chosen.filePath);
    raw = await readCommandText(chosen.filePath, signal);
    if (raw !== chosen.raw || identity !== await executionFileIdentity(chosen.filePath))
      throw new Error("Command changed while being reviewed.");
    prompt = chosen.prompt;
    ownerSha256 = hash(stableJson({ root, source: selection.command.source, path: path.resolve(chosen.filePath) }));
    sourceIdentitySha256 = hash(stableJson({ identity, directory: await executionFileIdentity(chosen.directory) }));
  } else if (entry.prompt) {
    // Built-ins are host prompt objects, not local Markdown files.
    raw = stableJson(entry.prompt);
    prompt = entry.prompt.prompt;
    ownerSha256 = hash(`built-in:${entry.prompt.name}`);
    sourceIdentitySha256 = hash(raw);
  } else throw new Error("The command needs an unsupported host action.");
  if (!prompt.trim()) throw new Error("The command prompt is empty.");
  let bytes = Buffer.byteLength(raw);
  if (bytes > 128_000) throw new Error("Command exceeds the review file limit.");
  const previews: { path: string; content: string }[] = [];
  const readFiles = async (paths: string[]) => {
    const files = [];
    for (const relative of paths) {
      signal.throwIfAborted();
      const absolute = containedPath(root, relative);
      const identitySha256 = await executionFileIdentity(absolute);
      const content = await readCommandText(absolute, signal);
      if (identitySha256 !== await executionFileIdentity(absolute)) throw new Error("Declared file changed during review.");
      bytes += Buffer.byteLength(content);
      if (bytes > 512_000) throw new Error("Declared files exceed the aggregate review limit.");
      previews.push({ path: relative, content });
      files.push({ path: relative, sha256: hash(content), identitySha256, bytes: Buffer.byteLength(content) });
    }
    return files;
  };
  const helpers = await readFiles(selection.helpers);
  const prerequisites = await readFiles(selection.prerequisites);
  const catalogOwners = [];
  for (const directory of sources.directories) {
    const stat = await commandLocalStat(directory);
    catalogOwners.push([directory, stat ? await executionFileIdentity(directory) : null]);
  }
  sourceIdentitySha256 = hash(stableJson({ sourceIdentitySha256, catalogOwners, catalog: sources.fingerprint }));
  const snapshot = directExecutionSnapshotV1Schema.parse({
    version: 1, selection, policy, repositorySha256, rawMarkdownSha256: hash(raw), sourceIdentitySha256,
    command: { version: 1, command: selection.command, capabilityKind: helpers.length ? "script-backed" : "prompt-only",
      ownerSha256, bodySha256: hash(prompt), helpers: helpers.map(({ path, sha256 }) => ({ path, sha256 })) },
    helpers, prerequisites,
  });
  const preview = JSON.stringify({ selection, policy, command: raw, files: previews });
  if (Buffer.byteLength(preview) > 64_000) throw new Error("Full review exceeds 64 KB. Reduce declared content; execution content is never truncated.");
  signal.throwIfAborted();
  return { command: Object.freeze({ name: selection.command.name, prompt }), snapshot, sha256: hash(stableJson(snapshot)), preview };
}

export async function resolveProgrammaticRoutes(
  cwd: string,
  opportunities: readonly DiscoveredOpportunityV1[],
  configurationFingerprint: ConfigurationFingerprintV1,
): Promise<RouteResolutionV1[]> {
  const { customs: customCommands, builtIns } = await loadSpecialistInputs(cwd);
  return opportunities.map((opportunity) =>
    resolveOpportunityRoute(
      opportunity,
      configurationFingerprint,
      customCommands,
      opportunity.route.status === "routable"
        ? builtIns.get(opportunity.route.specialistCommand)
        : undefined,
    ),
  );
}