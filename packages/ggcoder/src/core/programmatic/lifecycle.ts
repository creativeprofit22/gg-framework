import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { withFileLock } from "@kenkaiiii/gg-core";
import type {
  ConfigurationFingerprintV1,
  OpportunityDiscoveryResultV1,
  ProgrammaticLifecycleRecordV1,
  ProgrammaticLifecycleStateV1,
  ProgrammaticProfileEnvelopeV1,
  ProgrammaticScanSummaryV1,
} from "./contracts.js";
import {
  configurationFingerprintV1Schema,
  opportunityDiscoveryResultV1Schema,
  PROGRAMMATIC_CONTRACT_VERSION,
  PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT,
  programmaticLifecycleStateV1Schema,
  programmaticProfileEnvelopeV1Schema,
  programmaticScanSummaryV1Schema,
} from "./contracts.js";
import {
  buildProgrammaticInventory,
  PROGRAMMATIC_PROFILE_PATH,
  type InventoryOperations,
} from "./inventory.js";
import { discoverProgrammaticOpportunities } from "./opportunities.js";
import {
  canonicalJson,
  canonicalRepositoryRoot,
  compareText,
  containedPath,
  rejectLinks,
} from "../tauri-package/paths.js";

export const PROGRAMMATIC_STATE_PATH = ".gg/programmatic/state.json";
export const PROGRAMMATIC_PREVIOUS_STATE_PATH = ".gg/programmatic/state.previous.json";
const STATE_TEMPORARY_PATH = ".gg/programmatic/.state.tmp";
const PREVIOUS_STATE_TEMPORARY_PATH = ".gg/programmatic/.state.previous.tmp";

export interface ProgrammaticLifecycleOperations {
  lstat(filePath: string): Promise<Stats>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, bytes: Uint8Array, options: { flag: "wx" }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<unknown>;
}

export interface RunProgrammaticScanOptions {
  operations?: Partial<ProgrammaticLifecycleOperations>;
  inventoryOperations?: Partial<InventoryOperations>;
  onPreFileMutation?: (repositoryPath: string) => Promise<void> | void;
  onFileMutated?: (repositoryPath: string) => Promise<void> | void;
}

export type RunProgrammaticScanResult =
  | {
      ok: true;
      changed: boolean;
      recovered: boolean;
      path: typeof PROGRAMMATIC_STATE_PATH;
      configurationFingerprint: ConfigurationFingerprintV1;
      summary: ProgrammaticScanSummaryV1;
    }
  | {
      ok: false;
      changed: false;
      recovered: boolean;
      path: typeof PROGRAMMATIC_STATE_PATH;
      configurationFingerprint: ConfigurationFingerprintV1 | null;
      summary: ProgrammaticScanSummaryV1;
      error:
        | "profile-missing"
        | "profile-invalid"
        | "stale-configuration"
        | "scan-failed"
        | "state-corrupt"
        | "persistence-failed";
      detail: string;
    };

const localOperations: ProgrammaticLifecycleOperations = { lstat, readFile, writeFile, rename, rm };
const failedSummary = (): ProgrammaticScanSummaryV1 => ({
  new: 0,
  unchanged: 0,
  active: 0,
  completed: 0,
  dismissed: 0,
  disappeared: 0,
  failed: 1,
  unverified: 0,
});

function errorResult(
  error: RunProgrammaticScanResult extends infer Result
    ? Result extends { ok: false; error: infer Code }
      ? Code
      : never
    : never,
  detail: string,
  configurationFingerprint: ConfigurationFingerprintV1 | null = null,
  recovered = false,
): RunProgrammaticScanResult {
  return {
    ok: false,
    changed: false,
    recovered,
    path: PROGRAMMATIC_STATE_PATH,
    configurationFingerprint,
    summary: failedSummary(),
    error,
    detail,
  };
}

export function reconcileProgrammaticLifecycle(
  previous: ProgrammaticLifecycleStateV1 | null,
  discovery: OpportunityDiscoveryResultV1,
  fingerprint: ConfigurationFingerprintV1,
  unverifiedIds: readonly string[],
): { state: ProgrammaticLifecycleStateV1; summary: ProgrammaticScanSummaryV1 } {
  const validatedPrevious = previous === null ? null : programmaticLifecycleStateV1Schema.parse(previous);
  const validatedDiscovery = opportunityDiscoveryResultV1Schema.parse(discovery);
  const validatedFingerprint = configurationFingerprintV1Schema.parse(fingerprint);
  const currentIds = new Set(validatedDiscovery.opportunities.map(({ identity }) => identity.id));
  const unverified = new Set(unverifiedIds);
  if (unverified.size !== unverifiedIds.length || [...unverified].some((id) => !currentIds.has(id))) {
    throw new Error("Unverified opportunity IDs must be unique current opportunity IDs");
  }

  const previousById = new Map(
    validatedPrevious?.records.map((record) => [record.opportunity.identity.id, record]) ?? [],
  );
  const records: ProgrammaticLifecycleRecordV1[] = validatedDiscovery.opportunities.map((opportunity) => {
    const existing = previousById.get(opportunity.identity.id);
    previousById.delete(opportunity.identity.id);
    return {
      version: PROGRAMMATIC_CONTRACT_VERSION,
      opportunity,
      lifecycle: existing?.lifecycle ?? {
        version: PROGRAMMATIC_CONTRACT_VERSION,
        opportunity: opportunity.identity,
        state: "discovered" as const,
      },
      presence: "present" as const,
    };
  });
  records.push(
    ...[...previousById.values()].map((record) => ({ ...record, presence: "disappeared" as const })),
  );
  records.sort((left, right) =>
    compareText(left.opportunity.identity.id, right.opportunity.identity.id),
  );
  // simplification: overflow fails closed at 1,000 records; a later contract migration may archive history.
  if (records.length > PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT) {
    throw new Error(`Programmatic lifecycle record limit exceeded (${PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT})`);
  }

  const state = programmaticLifecycleStateV1Schema.parse({
    version: PROGRAMMATIC_CONTRACT_VERSION,
    configurationFingerprint: validatedFingerprint,
    records,
  });
  const present = state.records.filter((record) => record.presence === "present");
  const knownIds = new Set(validatedPrevious?.records.map(({ opportunity }) => opportunity.identity.id));
  const summary = programmaticScanSummaryV1Schema.parse({
    new: validatedDiscovery.opportunities.filter(({ identity }) => !knownIds.has(identity.id)).length,
    unchanged: validatedDiscovery.opportunities.filter(({ identity }) => knownIds.has(identity.id)).length,
    active: present.filter(({ lifecycle }) =>
      ["discovered", "queued", "running"].includes(lifecycle.state),
    ).length,
    completed: present.filter(({ lifecycle }) => lifecycle.state === "completed").length,
    dismissed: present.filter(({ lifecycle }) => lifecycle.state === "dismissed").length,
    disappeared: state.records.length - present.length,
    failed: 0,
    unverified: unverified.size,
  });
  return { state, summary };
}

type StateCandidate =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; state: ProgrammaticLifecycleStateV1; bytes: Buffer };

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readStateCandidate(
  absolutePath: string,
  operations: ProgrammaticLifecycleOperations,
): Promise<StateCandidate> {
  try {
    const stat = await operations.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid" };
    const raw = await operations.readFile(absolutePath);
    const state = programmaticLifecycleStateV1Schema.parse(
      JSON.parse(raw.toString("utf8")) as unknown,
    );
    return { status: "valid", state, bytes: Buffer.from(canonicalJson(state), "utf8") };
  } catch (error) {
    return isMissing(error) ? { status: "missing" } : { status: "invalid" };
  }
}

async function replaceStateFile(
  root: string,
  repositoryPath: string,
  temporaryRepositoryPath: string,
  state: ProgrammaticLifecycleStateV1,
  operations: ProgrammaticLifecycleOperations,
  options: RunProgrammaticScanOptions,
  revalidateCommit: () => Promise<void>,
): Promise<void> {
  const destination = containedPath(root, repositoryPath);
  const temporary = containedPath(root, temporaryRepositoryPath);
  const profilePath = containedPath(root, PROGRAMMATIC_PROFILE_PATH);
  const bytes = Buffer.from(canonicalJson(state), "utf8");
  await operations.rm(temporary, { force: true });
  try {
    await operations.writeFile(temporary, bytes, { flag: "wx" });
    const temporaryBytes = await operations.readFile(temporary);
    const validated = programmaticLifecycleStateV1Schema.parse(
      JSON.parse(temporaryBytes.toString("utf8")) as unknown,
    );
    if (!temporaryBytes.equals(bytes) || canonicalJson(validated) !== bytes.toString("utf8")) {
      throw new Error("Temporary lifecycle state validation failed");
    }
    await rejectLinks(root, repositoryPath, true);
    await options.onPreFileMutation?.(repositoryPath);
    await withFileLock(profilePath, async () => {
      await revalidateCommit();
      await operations.rename(temporary, destination);
    });
    await options.onFileMutated?.(repositoryPath);
  } finally {
    await operations.rm(temporary, { force: true });
  }
}

async function loadProfile(
  root: string,
  operations: ProgrammaticLifecycleOperations,
): Promise<
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; envelope: ProgrammaticProfileEnvelopeV1; bytes: Buffer }
> {
  const profilePath = containedPath(root, PROGRAMMATIC_PROFILE_PATH);
  try {
    await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH);
    const stat = await operations.lstat(profilePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid" };
    const bytes = await operations.readFile(profilePath);
    const envelope = programmaticProfileEnvelopeV1Schema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH);
    return { status: "valid", envelope, bytes };
  } catch (error) {
    return isMissing(error) ? { status: "missing" } : { status: "invalid" };
  }
}

class StaleConfigurationError extends Error {}

async function ensureProfileUnchanged(
  root: string,
  operations: ProgrammaticLifecycleOperations,
  expectedBytes: Buffer,
): Promise<void> {
  const current = await loadProfile(root, operations);
  if (current.status !== "valid" || !current.bytes.equals(expectedBytes)) {
    throw new StaleConfigurationError("Programmatic profile changed during scanning");
  }
}

async function ensureCommitInputsUnchanged(
  root: string,
  operations: ProgrammaticLifecycleOperations,
  inventoryOperations: Partial<InventoryOperations> | undefined,
  expectedProfileBytes: Buffer,
  expectedFingerprint: ConfigurationFingerprintV1,
): Promise<void> {
  await ensureProfileUnchanged(root, operations, expectedProfileBytes);

  const inventory = await buildProgrammaticInventory(root, { operations: inventoryOperations });
  const currentFingerprint = configurationFingerprintV1Schema.parse(
    inventory.inventory.configurationFingerprint,
  );
  if (
    currentFingerprint.version !== expectedFingerprint.version ||
    currentFingerprint.sha256 !== expectedFingerprint.sha256
  ) {
    throw new StaleConfigurationError("Programmatic configuration changed during scanning");
  }
}

export async function runProgrammaticScan(
  repositoryRoot: string,
  options: RunProgrammaticScanOptions = {},
): Promise<RunProgrammaticScanResult> {
  const operations = { ...localOperations, ...options.operations };
  let root: string;
  try {
    root = await canonicalRepositoryRoot(repositoryRoot);
    await rejectLinks(root, ".gg/programmatic");
  } catch {
    return errorResult("profile-invalid", "Programmatic profile is invalid or unsafe.");
  }

  const loadedProfile = await loadProfile(root, operations);
  if (loadedProfile.status === "missing") {
    return errorResult("profile-missing", "Programmatic profile is missing.");
  }
  if (loadedProfile.status === "invalid") {
    return errorResult("profile-invalid", "Programmatic profile is invalid or unsafe.");
  }

  let discovery: OpportunityDiscoveryResultV1;
  let fingerprint: ConfigurationFingerprintV1;
  let unverifiedIds: string[];
  try {
    const inventory = await buildProgrammaticInventory(root, {
      operations: options.inventoryOperations,
    });
    fingerprint = configurationFingerprintV1Schema.parse(inventory.inventory.configurationFingerprint);
    if (
      loadedProfile.envelope.configurationFingerprint.version !== fingerprint.version ||
      loadedProfile.envelope.configurationFingerprint.sha256 !== fingerprint.sha256
    ) {
      return errorResult(
        "stale-configuration",
        "Programmatic configuration changed after profile approval.",
        fingerprint,
      );
    }
    const discovered = discoverProgrammaticOpportunities(inventory.inventory);
    const configured = new Map(
      loadedProfile.envelope.profile.scanners.map((scanner) => [
        scanner.id,
        scanner.specialistCommand,
      ]),
    );
    discovery = opportunityDiscoveryResultV1Schema.parse({
      version: PROGRAMMATIC_CONTRACT_VERSION,
      opportunities: discovered.opportunities.filter(({ identity }) => configured.has(identity.detectorId)),
    });
    unverifiedIds = discovery.opportunities
      .filter((opportunity) => {
        const specialist = configured.get(opportunity.identity.detectorId);
        return (
          opportunity.route.status !== "routable" || opportunity.route.specialistCommand !== specialist
        );
      })
      .map(({ identity }) => identity.id);
  } catch {
    return errorResult("scan-failed", "Programmatic scan failed.");
  }

  const statePath = containedPath(root, PROGRAMMATIC_STATE_PATH);
  try {
    return await withFileLock(statePath, async () => {
      await rejectLinks(root, ".gg/programmatic");
      const revalidateProfile = () =>
        ensureProfileUnchanged(root, operations, loadedProfile.bytes);
      const revalidateCommit = () =>
        ensureCommitInputsUnchanged(
          root,
          operations,
          options.inventoryOperations,
          loadedProfile.bytes,
          fingerprint,
        );
      await revalidateProfile();
      await operations.rm(containedPath(root, STATE_TEMPORARY_PATH), { force: true });
      await operations.rm(containedPath(root, PREVIOUS_STATE_TEMPORARY_PATH), { force: true });
      const primary = await readStateCandidate(statePath, operations);
      const previousPath = containedPath(root, PROGRAMMATIC_PREVIOUS_STATE_PATH);
      let loaded: StateCandidate;
      let recovered = false;
      if (primary.status === "valid") {
        loaded = primary;
      } else {
        const previous = await readStateCandidate(previousPath, operations);
        if (previous.status === "valid") {
          loaded = previous;
          recovered = true;
        } else if (primary.status === "missing" && previous.status === "missing") {
          loaded = { status: "missing" };
        } else {
          return errorResult(
            "state-corrupt",
            "Lifecycle state is corrupt and no valid previous copy exists.",
            fingerprint,
          );
        }
      }

      const reconciled = reconcileProgrammaticLifecycle(
        loaded.status === "valid" ? loaded.state : null,
        discovery,
        fingerprint,
        unverifiedIds,
      );
      const nextBytes = Buffer.from(canonicalJson(reconciled.state), "utf8");
      const unchanged = loaded.status === "valid" && loaded.bytes.equals(nextBytes);
      if (unchanged && !recovered) {
        await revalidateProfile();
        return {
          ok: true,
          changed: false,
          recovered: false,
          path: PROGRAMMATIC_STATE_PATH,
          configurationFingerprint: fingerprint,
          summary: reconciled.summary,
        };
      }
      if (loaded.status === "valid" && primary.status === "valid") {
        const previous = await readStateCandidate(previousPath, operations);
        if (previous.status !== "valid" || !previous.bytes.equals(loaded.bytes)) {
          await replaceStateFile(
            root,
            PROGRAMMATIC_PREVIOUS_STATE_PATH,
            PREVIOUS_STATE_TEMPORARY_PATH,
            loaded.state,
            operations,
            options,
            revalidateCommit,
          );
        }
      }
      await replaceStateFile(
        root,
        PROGRAMMATIC_STATE_PATH,
        STATE_TEMPORARY_PATH,
        reconciled.state,
        operations,
        options,
        revalidateCommit,
      );
      return {
        ok: true,
        changed: true,
        recovered,
        path: PROGRAMMATIC_STATE_PATH,
        configurationFingerprint: fingerprint,
        summary: reconciled.summary,
      };
    });
  } catch (error) {
    if (error instanceof StaleConfigurationError) {
      return errorResult("stale-configuration", error.message, fingerprint);
    }
    return errorResult(
      "persistence-failed",
      "Lifecycle state could not be persisted.",
      fingerprint,
    );
  }
}
