import { sha256 as hash } from "../tauri-package/paths.js";
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