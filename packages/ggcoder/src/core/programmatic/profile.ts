import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type {
  ConfigurationFingerprintV1,
  InventoryEntryV1,
  OpportunityRouteV1,
  ProgrammaticProfileV1,
} from "./contracts.js";
import {
  configurationFingerprintV1Schema,
  PROGRAMMATIC_CONTRACT_VERSION,
  programmaticProfileV1Schema,
} from "./contracts.js";
import {
  buildProgrammaticInventory,
  PROGRAMMATIC_INVENTORY_EXCLUSIONS,
  PROGRAMMATIC_PROFILE_PATH,
  type InventorySummaryV1,
} from "./inventory.js";
import { discoverProgrammaticOpportunities } from "./opportunities.js";
import {
  canonicalJson,
  canonicalRepositoryRoot,
  compareText,
  containedPath,
  rejectLinks,
  stableJson,
} from "../tauri-package/paths.js";

export interface ProgrammaticProfileRouteV1 {
  opportunityId: string;
  detectorId: string;
  route: OpportunityRouteV1;
}

export interface ProgrammaticProfileProposalV1 {
  version: typeof PROGRAMMATIC_CONTRACT_VERSION;
  inventory: InventorySummaryV1;
  configurationFingerprint: ConfigurationFingerprintV1;
  profile: ProgrammaticProfileV1;
  routes: ProgrammaticProfileRouteV1[];
  exclusions: string[];
  configurationInputs: InventoryEntryV1[];
}

export interface ProgrammaticProfileOperations {
  lstat(filePath: string): Promise<Stats>;
  mkdir(directoryPath: string): Promise<unknown>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, bytes: Uint8Array, options: { flag: "wx" }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<unknown>;
}

export interface PersistProgrammaticProfileOptions {
  operations?: Partial<ProgrammaticProfileOperations>;
  onPreMutation?: (repositoryPath: string) => Promise<void> | void;
  onCommitted?: (repositoryPath: string) => Promise<void> | void;
}

export type PersistProgrammaticProfileResult =
  | {
      ok: true;
      changed: boolean;
      path: typeof PROGRAMMATIC_PROFILE_PATH;
      configurationFingerprint: ConfigurationFingerprintV1;
    }
  | {
      ok: false;
      changed: false;
      error: "stale-proposal";
      expected: ConfigurationFingerprintV1;
      actual: ConfigurationFingerprintV1;
    }
  | {
      ok: false;
      changed: false;
      error: "proposal-mismatch";
      expected: ProgrammaticProfileV1;
      actual: ProgrammaticProfileV1;
    };

const localOperations: ProgrammaticProfileOperations = {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
};

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

async function buildProfileProposal(
  repositoryRoot: string,
  managedTemporaryPath?: string,
): Promise<ProgrammaticProfileProposalV1> {
  const inventory = await buildProgrammaticInventory(repositoryRoot, { managedTemporaryPath });
  const discovery = discoverProgrammaticOpportunities(inventory.inventory);
  const scanners = new Map<string, ProgrammaticProfileV1["scanners"][number]>();

  for (const opportunity of discovery.opportunities) {
    if (opportunity.route.status !== "routable") continue;
    const scanner = {
      version: PROGRAMMATIC_CONTRACT_VERSION,
      id: opportunity.identity.detectorId,
      specialistCommand: opportunity.route.specialistCommand,
    } as const;
    const existing = scanners.get(scanner.id);
    if (existing && existing.specialistCommand !== scanner.specialistCommand) {
      throw new Error(`Conflicting specialist routes for detector: ${scanner.id}`);
    }
    scanners.set(scanner.id, scanner);
  }

  const profile = programmaticProfileV1Schema.parse({
    version: PROGRAMMATIC_CONTRACT_VERSION,
    scanners: [...scanners.values()].sort((left, right) => compareText(left.id, right.id)),
  });
  return {
    version: PROGRAMMATIC_CONTRACT_VERSION,
    inventory: inventory.summary,
    configurationFingerprint: inventory.inventory.configurationFingerprint,
    profile,
    routes: discovery.opportunities.map((opportunity) => ({
      opportunityId: opportunity.identity.id,
      detectorId: opportunity.identity.detectorId,
      route: opportunity.route,
    })),
    exclusions: [...PROGRAMMATIC_INVENTORY_EXCLUSIONS],
    configurationInputs: inventory.configurationInputs,
  };
}

export async function buildProgrammaticProfileProposal(
  repositoryRoot: string,
): Promise<ProgrammaticProfileProposalV1> {
  return buildProfileProposal(repositoryRoot);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function ensureDirectory(
  directoryPath: string,
  operations: ProgrammaticProfileOperations,
): Promise<void> {
  try {
    const stat = await operations.lstat(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Profile ancestor is not a safe directory: ${directoryPath}`);
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    await operations.mkdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await operations.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Profile ancestor is not a safe directory: ${directoryPath}`);
  }
}

async function readExistingProfile(
  profilePath: string,
  operations: ProgrammaticProfileOperations,
): Promise<Buffer | null> {
  try {
    const stat = await operations.lstat(profilePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Profile destination is not a safe file: ${profilePath}`);
    }
    return await operations.readFile(profilePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function staleResult(
  expected: ConfigurationFingerprintV1,
  actual: ConfigurationFingerprintV1,
): PersistProgrammaticProfileResult {
  return { ok: false, changed: false, error: "stale-proposal", expected, actual };
}

function mismatchResult(
  expected: ProgrammaticProfileV1,
  actual: ProgrammaticProfileV1,
): PersistProgrammaticProfileResult {
  return { ok: false, changed: false, error: "proposal-mismatch", expected, actual };
}

export async function persistProgrammaticProfile(
  repositoryRoot: string,
  approvedConfigurationFingerprint: ConfigurationFingerprintV1,
  approvedProfile: ProgrammaticProfileV1,
  options: PersistProgrammaticProfileOptions = {},
): Promise<PersistProgrammaticProfileResult> {
  const fingerprint = configurationFingerprintV1Schema.parse(approvedConfigurationFingerprint);
  const profile = programmaticProfileV1Schema.parse(approvedProfile);
  const initial = await buildProgrammaticProfileProposal(repositoryRoot);
  if (!sameValue(fingerprint, initial.configurationFingerprint)) {
    return staleResult(fingerprint, initial.configurationFingerprint);
  }
  if (!sameValue(profile, initial.profile)) return mismatchResult(initial.profile, profile);

  const operations = { ...localOperations, ...options.operations };
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const ggDirectory = containedPath(root, ".gg");
  const profileDirectory = containedPath(root, ".gg/programmatic");
  const destination = containedPath(root, PROGRAMMATIC_PROFILE_PATH);
  await ensureDirectory(ggDirectory, operations);
  await ensureDirectory(profileDirectory, operations);
  await rejectLinks(root, ".gg/programmatic");

  const bytes = Buffer.from(canonicalJson(profile), "utf8");
  const existing = await readExistingProfile(destination, operations);
  if (existing?.equals(bytes)) {
    return {
      ok: true,
      changed: false,
      path: PROGRAMMATIC_PROFILE_PATH,
      configurationFingerprint: initial.configurationFingerprint,
    };
  }

  const temporaryName = `.profile-${process.pid}-${randomUUID()}.tmp`;
  const temporary = path.join(profileDirectory, temporaryName);
  try {
    await operations.writeFile(temporary, bytes, { flag: "wx" });
    const temporaryBytes = await operations.readFile(temporary);
    const validatedTemporary = programmaticProfileV1Schema.parse(
      JSON.parse(temporaryBytes.toString("utf8")) as unknown,
    );
    if (
      !temporaryBytes.equals(bytes) ||
      canonicalJson(validatedTemporary) !== bytes.toString("utf8")
    ) {
      throw new Error("Temporary profile validation failed");
    }
    const current = await buildProfileProposal(root, `.gg/programmatic/${temporaryName}`);
    if (!sameValue(fingerprint, current.configurationFingerprint)) {
      return staleResult(fingerprint, current.configurationFingerprint);
    }
    if (!sameValue(profile, current.profile)) return mismatchResult(current.profile, profile);
    await rejectLinks(root, ".gg/programmatic");
    await options.onPreMutation?.(PROGRAMMATIC_PROFILE_PATH);
    await operations.rename(temporary, destination);
    await options.onCommitted?.(PROGRAMMATIC_PROFILE_PATH);
  } finally {
    await operations.rm(temporary, { force: true });
  }

  return {
    ok: true,
    changed: true,
    path: PROGRAMMATIC_PROFILE_PATH,
    configurationFingerprint: fingerprint,
  };
}
