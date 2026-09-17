import { randomUUID } from "node:crypto";
import { replaceBoundedFile } from "./storage.js";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { withFileLock } from "@kenkaiiii/gg-core";
import type { ProgrammaticChatConfiguration } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type {
  ConfigurationFingerprintV1,
  ConfigurationSnapshot,
  ProgrammaticProfileEnvelopeV1,
  ProgrammaticProfileEnvelopeV2,
  ProgrammaticProfileEnvelopeV3,
  RecommendationHistoryPolicyV1,
  InventoryEntryV1,
  ProgrammaticProfileV1,
  RouteResolutionV1,
} from "./contracts.js";
import {
  configurationFingerprintV1Schema,
  PROGRAMMATIC_CONTRACT_VERSION,
  programmaticProfileEnvelopeV1Schema,
  programmaticProfileV1Schema,
  recommendationHistoryPolicyV1Schema,
} from "./contracts.js";
import {
  buildProgrammaticInventory,
  compareConfigurationSnapshots,
  validateProfileConfigurationBaseline,
  type ConfigurationDrift,
  type ProgrammaticInventoryResult,
  PROGRAMMATIC_PROFILE_PATH,
  type InventorySummaryV1,
  type InventoryOperations,
} from "./inventory.js";
import { discoverProgrammaticOpportunities } from "./opportunities.js";
import { resolveProgrammaticRoutes } from "./routes.js";
import {
  canonicalJson,
  canonicalRepositoryRoot,
  compareText,
  containedPath,
  rejectLinks,
  stableJson,
  sha256,
} from "../tauri-package/paths.js";

export interface ProgrammaticProfileRouteV1 {
  opportunityId: string;
  detectorId: string;
  resolution: RouteResolutionV1;
}

export interface ProgrammaticProfileProposalV1 {
  version: typeof PROGRAMMATIC_CONTRACT_VERSION;
  inventory: InventorySummaryV1;
  configurationFingerprint: ConfigurationFingerprintV1;
  profile: ProgrammaticProfileV1;
  routes: ProgrammaticProfileRouteV1[];
  exclusions: string[];
  configurationInputs: InventoryEntryV1[];
  configurationSnapshot: ConfigurationSnapshot;
  operation: "initial" | "refresh" | "current" | "history-upgrade";
  historyPolicy?: RecommendationHistoryPolicyV1;
  expectedRecoveryDigest?: string | null;
  expectedPriorProfileDigest: string | null;
  drift: ConfigurationDrift | null;
  baselineUnavailable: boolean;
  configuration: ProgrammaticChatConfiguration;
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
  signal?: AbortSignal;
  operations?: Partial<ProgrammaticProfileOperations>;
  expectedPriorProfileDigest?: string | null;
  /** Present only following review of the exact expanded policy and recovery expectation. */
  historyPolicy?: RecommendationHistoryPolicyV1;
  expectedRecoveryDigest?: string | null;
  onPreMutation?: (repositoryPath: string) => Promise<void> | void;
  onCommitted?: (repositoryPath: string) => Promise<void> | void;
  /** Host-owned live authorization check; never supplied by tool arguments. */
  validateBeforeCommit?: () => Promise<void> | void;
}

export type PersistProgrammaticProfileResult =
  | { ok: false; changed: true; error: "post-commit-failed"; detail: string }
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
  assessment: ProgrammaticSetupAssessment,
): Promise<ProgrammaticProfileProposalV1> {
  if (assessment.status === "unreadable" || !assessment.inventory) {
    throw new Error(assessment.diagnostic ?? "Configuration cannot be assessed");
  }
  const inventory = assessment.inventory;
  const metadata = {
    version: PROGRAMMATIC_CONTRACT_VERSION,
    inventory: inventory.summary,
    configurationFingerprint: inventory.inventory.configurationFingerprint,
    exclusions: inventory.configurationSnapshot.exclusions,
    configurationInputs: inventory.configurationInputs,
    configurationSnapshot: inventory.configurationSnapshot,
    expectedPriorProfileDigest: assessment.priorProfileDigest,
    drift: assessment.drift,
    baselineUnavailable: assessment.baselineUnavailable,
    configuration: projectProgrammaticConfiguration(assessment),
  };
  if (assessment.status === "current" && assessment.stored) {
    return {
      ...metadata,
      operation: "current",
      profile: assessment.stored.envelope.profile,
      routes: [],
    };
  }
  const discovery = discoverProgrammaticOpportunities(inventory.inventory);
  const resolvedRoutes = await resolveProgrammaticRoutes(
    repositoryRoot,
    discovery.opportunities,
    inventory.inventory.configurationFingerprint,
  );
  const routes = discovery.opportunities.map((opportunity, index) => ({
    opportunityId: opportunity.identity.id,
    detectorId: opportunity.identity.detectorId,
    resolution: resolvedRoutes[index]!,
  }));
  const scanners = new Map<string, ProgrammaticProfileV1["scanners"][number]>();

  for (const { detectorId, resolution } of routes) {
    if (resolution.status !== "routable") continue;
    const scanner = {
      version: PROGRAMMATIC_CONTRACT_VERSION,
      id: detectorId,
      specialistCommand: resolution.specialistCommand,
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
    ...metadata,
    operation: assessment.status === "missing" ? "initial" : "refresh",
    profile,
    routes,
  };
}

export async function buildProgrammaticProfileProposal(
  repositoryRoot: string,
  options: { offerHistory?: boolean } = {},
): Promise<ProgrammaticProfileProposalV1> {
  const assessment = await assessProgrammaticSetup(repositoryRoot);
  const proposal = await buildProfileProposal(repositoryRoot, assessment);
  if (!options.offerHistory) return proposal;
  const policy = assessment.stored?.envelope.version === 3 ? assessment.stored.envelope.historyPolicy : { version: 1 as const, enabled: true };
  const recovery = await readExistingProfile(containedPath(await canonicalRepositoryRoot(repositoryRoot), PROGRAMMATIC_PREVIOUS_PROFILE_PATH), localOperations);
  if (recovery) validateStoredProfileBytes(recovery);
  return { ...proposal, historyPolicy: policy, expectedRecoveryDigest: recovery ? sha256(recovery) : null,
    operation: proposal.operation === "current" && assessment.stored?.envelope.version !== 3 ? "history-upgrade" : proposal.operation };
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
    if (stat.size > 16 * 1024 * 1024) throw new Error("Stored setup exceeds the byte limit");
    const bytes = await operations.readFile(profilePath);
    if (bytes.length > 16 * 1024 * 1024) throw new Error("Stored setup exceeds the byte limit");
    return bytes;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export const PROGRAMMATIC_PREVIOUS_PROFILE_PATH = ".gg/programmatic/profile.previous.json";
const previousProfileTemporary = ".gg/programmatic/.profile.previous.tmp";
function validateStoredProfileBytes(bytes: Buffer) {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  return (value as { version?: unknown } | null)?.version === 1
    ? programmaticProfileEnvelopeV1Schema.parse(value) : validateProfileConfigurationBaseline(value);
}
export interface StoredProgrammaticProfile {
  envelope: ProgrammaticProfileEnvelopeV1 | ProgrammaticProfileEnvelopeV2 | ProgrammaticProfileEnvelopeV3;
  bytes: Buffer;
}

export async function loadApprovedProgrammaticProfile(
  repositoryRoot: string,
  overrides: Partial<ProgrammaticProfileOperations> = {},
): Promise<StoredProgrammaticProfile | null> {
  const operations = { ...localOperations, ...overrides };
  const root = await canonicalRepositoryRoot(repositoryRoot);
  for (const directory of [".gg", ".gg/programmatic"]) {
    try {
      const stat = await operations.lstat(containedPath(root, directory));
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Unsafe stored setup directory");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH, true);
  const bytes = await readExistingProfile(
    containedPath(root, PROGRAMMATIC_PROFILE_PATH),
    operations,
  );
  if (!bytes) return null;
  await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH);
  const envelope = validateStoredProfileBytes(bytes);
  return { envelope, bytes };
}

export interface ProgrammaticSetupAssessment {
  status: "missing" | "current" | "refresh-required" | "unreadable";
  stored: StoredProgrammaticProfile | null;
  priorProfileDigest: string | null;
  inventory: ProgrammaticInventoryResult | null;
  drift: ConfigurationDrift | null;
  baselineUnavailable: boolean;
  diagnostic: string | null;
}

export async function assessProgrammaticSetup(
  repositoryRoot: string,
  options: {
    inventory?: ProgrammaticInventoryResult;
    inventoryOperations?: Partial<InventoryOperations>;
    managedTemporaryPath?: string;
    operations?: Partial<ProgrammaticProfileOperations>;
  } = {},
): Promise<ProgrammaticSetupAssessment> {
  let stored: StoredProgrammaticProfile | null = null;
  let inventory: ProgrammaticInventoryResult | null = null;
  try {
    stored = await loadApprovedProgrammaticProfile(repositoryRoot, options.operations);
    inventory =
      options.inventory ??
      (await buildProgrammaticInventory(repositoryRoot, {
        managedTemporaryPath: options.managedTemporaryPath,
        operations: options.inventoryOperations,
      }));
    const common = {
      stored,
      inventory,
      priorProfileDigest: stored ? sha256(stored.bytes) : null,
      diagnostic: null,
    };
    if (!stored) return { ...common, status: "missing", drift: null, baselineUnavailable: false };
    if (stored.envelope.version === 1) {
      return { ...common, status: "refresh-required", drift: null, baselineUnavailable: true };
    }
    const drift = compareConfigurationSnapshots(
      stored.envelope.configurationSnapshot,
      inventory.configurationSnapshot,
    );
    const changed =
      drift.files.length > 0 ||
      drift.policy !== null ||
      drift.schema !== null ||
      drift.exclusions !== null;
    return {
      ...common,
      status: changed ? "refresh-required" : "current",
      drift,
      baselineUnavailable: false,
    };
  } catch {
    // Do not expose parser payloads, file contents or machine paths in report projections.
    return {
      status: "unreadable",
      stored,
      inventory,
      priorProfileDigest: stored ? sha256(stored.bytes) : null,
      drift: null,
      baselineUnavailable: false,
      diagnostic:
        "Stored setup or configuration is unreadable, unsafe, malformed or unsupported. Repair is required before approval or scanning.",
    };
  }
}

export function projectProgrammaticConfiguration(assessment: ProgrammaticSetupAssessment): ProgrammaticChatConfiguration {
  return {
    status: assessment.status,
    currentFingerprint: assessment.inventory?.inventory.configurationFingerprint.sha256 ?? null,
    refreshAvailable: assessment.status === "refresh-required",
    baselineUnavailable: assessment.baselineUnavailable,
    diagnostic: assessment.diagnostic,
    drift: assessment.drift,
  };
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
  options.signal?.throwIfAborted();
  const fingerprint = configurationFingerprintV1Schema.parse(approvedConfigurationFingerprint);
  const profile = programmaticProfileV1Schema.parse(approvedProfile);
  const approvedPolicy = options.historyPolicy === undefined ? undefined : recommendationHistoryPolicyV1Schema.parse(options.historyPolicy);
  if (approvedPolicy && options.expectedRecoveryDigest === undefined) throw new Error("History policy requires an inspected recovery expectation.");
  if (options.expectedRecoveryDigest != null && !/^[a-f0-9]{64}$/.test(options.expectedRecoveryDigest)) throw new Error("Invalid recovery digest.");
  const expectedPriorDigest = options.expectedPriorProfileDigest ?? null;
  if (expectedPriorDigest !== null && !/^[a-f0-9]{64}$/.test(expectedPriorDigest)) {
    throw new Error("Invalid prior-profile digest");
  }
  const operations = { ...localOperations, ...options.operations };
  const root = await canonicalRepositoryRoot(repositoryRoot);
  options.signal?.throwIfAborted();
  const initial = await assessProgrammaticSetup(root, { operations });
  options.signal?.throwIfAborted();
  if (initial.status === "unreadable" || !initial.inventory) throw new Error(initial.diagnostic!);
  if (!sameValue(fingerprint, initial.inventory.inventory.configurationFingerprint)) {
    return staleResult(fingerprint, initial.inventory.inventory.configurationFingerprint);
  }
  const profileDirectory = containedPath(root, ".gg/programmatic");
  const destination = containedPath(root, PROGRAMMATIC_PROFILE_PATH);
  await ensureDirectory(containedPath(root, ".gg"), operations);
  await ensureDirectory(profileDirectory, operations);
  await rejectLinks(root, ".gg/programmatic");
  return withFileLock(destination, async () => {
    options.signal?.throwIfAborted();
    const temporaryName = `.profile-${process.pid}-${randomUUID()}.tmp`;
    const temporary = path.join(profileDirectory, temporaryName);
    const managedTemporaryPath = `.gg/programmatic/${temporaryName}`;
    const assess = () => assessProgrammaticSetup(root, { operations, managedTemporaryPath });
    const current = await assess();
    options.signal?.throwIfAborted();
    const proposal = await buildProfileProposal(root, current);
    options.signal?.throwIfAborted();
    if (!sameValue(fingerprint, proposal.configurationFingerprint)) {
      return staleResult(fingerprint, proposal.configurationFingerprint);
    }
    if (!sameValue(profile, proposal.profile)) return mismatchResult(proposal.profile, profile);
    const historyPolicy = approvedPolicy ?? (current.stored?.envelope.version === 3 ? current.stored.envelope.historyPolicy : undefined);
    const envelope = validateProfileConfigurationBaseline({
      version: historyPolicy ? 3 : 2,
      ...(historyPolicy ? { historyPolicy } : {}),
      configurationFingerprint: fingerprint,
      profile,
      configurationSnapshot: proposal.configurationSnapshot,
    });
    const result = (changed: boolean): PersistProgrammaticProfileResult => ({
      ok: true,
      changed,
      path: PROGRAMMATIC_PROFILE_PATH,
      configurationFingerprint: fingerprint,
    });
    // Replays of the exact committed result are harmless, even after a competing identical approval.
    if (current.status === "current" && sameValue(current.stored?.envelope, envelope))
      return result(false);
    if (current.priorProfileDigest !== expectedPriorDigest)
      throw new Error("Stored setup changed since review; review setup again");
    const upgrading = Boolean(approvedPolicy && current.stored && current.stored.envelope.version !== 3);
    const recoveryPath = containedPath(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH);
    const checkRecovery = async () => {
      await rejectLinks(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH, true);
      const existing = await readExistingProfile(recoveryPath, operations);
      if (existing) validateStoredProfileBytes(existing);
      if ((existing ? sha256(existing) : null) !== options.expectedRecoveryDigest)
        throw new Error("Profile recovery file changed since review.");
      if (upgrading && existing && !existing.equals(current.stored!.bytes)) throw new Error("Conflicting profile recovery bytes; refusing to overwrite.");
      return existing;
    };
    if (approvedPolicy) await checkRecovery();
    const bytes = Buffer.from(canonicalJson(envelope), "utf8");
    let committed = false;
    const failures: unknown[] = [];
    const commit = async (): Promise<PersistProgrammaticProfileResult> => {
      await operations.writeFile(temporary, bytes, { flag: "wx" });
      const validateTemporary = async () => {
        await rejectLinks(root, managedTemporaryPath);
        const temporaryBytes = await operations.readFile(temporary);
        const validated = validateProfileConfigurationBaseline(
          JSON.parse(temporaryBytes.toString("utf8")) as unknown,
        );
        if (!temporaryBytes.equals(bytes) || canonicalJson(validated) !== bytes.toString("utf8")) {
          throw new Error("Temporary profile validation failed");
        }
      };
      await validateTemporary();
      options.signal?.throwIfAborted();
      await options.onPreMutation?.(PROGRAMMATIC_PROFILE_PATH);
      options.signal?.throwIfAborted();
      // Callbacks are mutation boundaries too: recheck configuration, profile bytes and temp contents.
      const finalAssessment = await assess();
      const finalProposal = await buildProfileProposal(root, finalAssessment);
      if (!sameValue(fingerprint, finalProposal.configurationFingerprint)) {
        return staleResult(fingerprint, finalProposal.configurationFingerprint);
      }
      if (!sameValue(profile, finalProposal.profile))
        return mismatchResult(finalProposal.profile, profile);
      if (finalAssessment.priorProfileDigest !== expectedPriorDigest)
        throw new Error("Stored setup changed before commit; review setup again");
      await rejectLinks(root, ".gg/programmatic");
      await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH, true);
      await validateTemporary();
      await options.validateBeforeCommit?.();
      options.signal?.throwIfAborted();
      if (approvedPolicy) await checkRecovery();
      if (upgrading) {
        const priorBytes = current.stored!.bytes;
        await rejectLinks(root, previousProfileTemporary, true);
        await replaceBoundedFile(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH, previousProfileTemporary,
          current.stored!.envelope, operations, { signal: options.signal,
            onPreFileMutation: options.onPreMutation, onFileMutated: options.onCommitted },
          { parse: (value) => validateStoredProfileBytes(Buffer.from(JSON.stringify(value))) },
          16 * 1024 * 1024, async (publish) => {
            await checkRecovery();
            await options.validateBeforeCommit?.();
            const prior = await readExistingProfile(destination, operations);
            if (!prior?.equals(priorBytes)) throw new Error("Profile changed before recovery replacement.");
            await publish();
          }, "Profile recovery", priorBytes);
        // No cross-file transaction: old profile remains authoritative until its rename.
        const recovered = await readExistingProfile(recoveryPath, operations);
        const prior = await readExistingProfile(destination, operations);
        if (!recovered?.equals(priorBytes) || !prior?.equals(priorBytes)) throw new Error("Profile or recovery changed before commit.");
        const afterRecovery = await assess();
        if (afterRecovery.status === "unreadable" || afterRecovery.priorProfileDigest !== expectedPriorDigest ||
          !sameValue(fingerprint, afterRecovery.inventory?.inventory.configurationFingerprint))
          throw new Error("Configuration changed during profile recovery; review again.");
        await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH);
        await rejectLinks(root, PROGRAMMATIC_PREVIOUS_PROFILE_PATH);
        await validateTemporary();
        await options.validateBeforeCommit?.();
        options.signal?.throwIfAborted();
      }
      await operations.rename(temporary, destination);
      committed = true;
      await options.onCommitted?.(PROGRAMMATIC_PROFILE_PATH);
      return result(true);
    };
    let receipt: PersistProgrammaticProfileResult | undefined;
    try {
      receipt = await commit();
    } catch (error) {
      // An injected/filesystem rename can report failure after publishing the destination.
      const actual = await readExistingProfile(destination, operations).catch(() => null);
      if (actual?.equals(bytes)) committed = true;
      failures.push(error);
    }
    try {
      await operations.rm(temporary, { force: true });
    } catch (error) {
      failures.push(error);
    }
    // Preserve the first pre-commit failure, including cleanup failures after a validation receipt.
    if (!committed && failures.length > 0) throw failures[0];
    if (failures.length > 0) {
      return {
        ok: false,
        changed: true,
        error: "post-commit-failed",
        detail:
          "Setup was committed, but its notification or temporary cleanup failed. Read back setup before retrying.",
      };
    }
    return receipt!;
  });
}
