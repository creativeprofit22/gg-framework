import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalProjectKey, withFileLock, type NotesPhaseStatus } from "@kenkaiiii/gg-core";
import {
  isPhaseLease,
  isPhaseLeaseOutcome,
  type PhaseLeaseHolderV1,
  type PhaseLeaseOutcome,
  type PhaseLeaseRequestV2,
  type PhaseLeaseTokenV1,
  type PhaseLeaseV1,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import { projectNotesHash } from "./project-notes-repository.js";

const STORE_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_OPERATIONS = 256;
export const PHASE_LEASE_TTL_MS = 120_000;
export const PHASE_LEASE_RENEW_INTERVAL_MS = 30_000;

export type PhaseLeaseLiveness = "alive" | "dead" | "unknown";

export interface RoadmapPhaseLeaseHolderV1 extends PhaseLeaseHolderV1 {
  processStartToken: string;
}

export interface RoadmapPhaseLeasePredecessorProofV1 {
  daemonInstanceId: string;
  processId: number;
  processStartToken: string;
  terminatedAt: string;
}

interface StoredPhaseLeaseV1 extends Omit<PhaseLeaseV1, "holder"> {
  holder: RoadmapPhaseLeaseHolderV1;
}

export interface PhaseLeasePaths {
  directory: string;
  primary: string;
  backup: string;
  lock: string;
}

export interface PhaseLeaseContext {
  projectKey: string;
  roadmapRevision: number;
  phaseId: string;
  phaseStatus: NotesPhaseStatus;
  planId: string | null;
}

export interface PhaseLeaseExecutionInput {
  cwd: string;
  request: PhaseLeaseRequestV2;
  holder: RoadmapPhaseLeaseHolderV1;
  context: PhaseLeaseContext;
  runState?: "idle" | "running";
}

interface StoredOperation {
  operationId: string;
  payloadHash: string;
  outcome: PhaseLeaseOutcome;
}

interface StoredPhaseLeasesV1 {
  storeVersion: 1;
  projectKey: string;
  leaseRevision: number;
  nextFence: number;
  leases: Record<string, StoredPhaseLeaseV1>;
  operations: StoredOperation[];
}

export type PhaseLeaseFenceOutcome<T> =
  | { status: "executed"; value: T }
  | { status: "phase-lease-lost"; currentLease: PhaseLeaseV1 | null }
  | { status: "corrupt" };

export type PhaseLeaseFenceInput = {
  cwd: string;
  phaseId: string;
  holder: RoadmapPhaseLeaseHolderV1;
} & { [key in "token"]: PhaseLeaseTokenV1 };

export interface PhaseLeaseRepositoryOptions {
  now?: () => Date;
  createId?: () => string;
  processLiveness?: (holder: RoadmapPhaseLeaseHolderV1) => Promise<PhaseLeaseLiveness>;
  lock?: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
}

export class RoadmapPhaseLeaseRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly processLiveness: (
    holder: RoadmapPhaseLeaseHolderV1,
  ) => Promise<PhaseLeaseLiveness>;
  private readonly lock: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly agentDir: string,
    options: PhaseLeaseRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.processLiveness = options.processLiveness ?? defaultProcessLiveness;
    this.lock = options.lock ?? withFileLock;
  }

  paths(cwd: string): PhaseLeasePaths {
    const directory = path.join(this.agentDir, "project-notes");
    const base = path.join(directory, `${projectNotesHash(canonicalProjectKey(cwd))}.phase-leases`);
    return {
      directory,
      primary: `${base}.json`,
      backup: `${base}.backup.json`,
      lock: `${base}.lock`,
    };
  }

  async withFence<T>(
    input: PhaseLeaseFenceInput,
    operation: () => Promise<T>,
  ): Promise<PhaseLeaseFenceOutcome<T>> {
    const paths = this.paths(input.cwd);
    await ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const loaded = await readStoredState(paths, canonicalProjectKey(input.cwd));
      if (loaded.status === "corrupt") return { status: "corrupt" };
      const current = loaded.state.leases[input.phaseId] ?? null;
      if (
        !current ||
        current.leaseId !== input.token.leaseId ||
        current.fence !== input.token.fence ||
        !sameHolder(current.holder, input.holder) ||
        Date.parse(current.expiresAt) <= this.now().getTime()
      ) {
        return { status: "phase-lease-lost", currentLease: toPublicLease(current) };
      }
      return { status: "executed", value: await operation() };
    });
  }

  async execute(input: PhaseLeaseExecutionInput): Promise<PhaseLeaseOutcome> {
    return this.executeInternal(input, null);
  }

  async reconcileTakeover(
    input: PhaseLeaseExecutionInput,
    predecessorProof: RoadmapPhaseLeasePredecessorProofV1,
  ): Promise<PhaseLeaseOutcome> {
    if (input.request.action !== "takeover") {
      throw new Error("supervised predecessor proof requires a takeover request");
    }
    return this.executeInternal(input, predecessorProof);
  }

  private async executeInternal(
    input: PhaseLeaseExecutionInput,
    predecessorProof: RoadmapPhaseLeasePredecessorProofV1 | null,
  ): Promise<PhaseLeaseOutcome> {
    const { request, context } = input;
    if (request.phaseId !== context.phaseId) return { status: "phase-not-found" };
    if (
      canonicalProjectKey(request.expectedProjectKey) !== canonicalProjectKey(context.projectKey)
    ) {
      return {
        status: "project-mismatch",
        roadmapRevision: context.roadmapRevision,
        currentProjectKey: context.projectKey,
      };
    }
    // Runner admission rejects terminal phases in the binding service. The lease
    // itself also fences explicit status updates and idempotent retries on Done.
    if (request.action !== "release" && request.planId !== context.planId) {
      return { status: "plan-mismatch" };
    }

    const projectKey = canonicalProjectKey(context.projectKey);
    const paths = this.paths(input.cwd);
    await ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const loaded = await readStoredState(paths, projectKey);
      if (loaded.status === "corrupt") {
        return { status: "corrupt", primary: loaded.primary, backup: loaded.backup };
      }
      const state = loaded.state;
      if (request.action === "inspect") {
        if (request.expectedRevision !== context.roadmapRevision) {
          return {
            status: "stale-revision",
            roadmapRevision: context.roadmapRevision,
            leaseRevision: state.leaseRevision,
          };
        }
        return leaseOutcome("inspected", context, state, state.leases[request.phaseId] ?? null);
      }

      const payloadHash = operationPayloadHash(input, predecessorProof);
      const prior = state.operations.find(
        (operation) => operation.operationId === request.operationId,
      );
      if (prior) {
        return prior.payloadHash === payloadHash
          ? duplicateOutcome(prior.outcome)
          : {
              status: "operation-conflict",
              roadmapRevision: context.roadmapRevision,
              leaseRevision: state.leaseRevision,
            };
      }
      if (request.expectedRevision !== context.roadmapRevision) {
        return {
          status: "stale-revision",
          roadmapRevision: context.roadmapRevision,
          leaseRevision: state.leaseRevision,
        };
      }

      const outcome = await this.applyMutation(state, input, predecessorProof);
      if (!isCommittedOutcome(outcome)) return outcome;
      const storedOutcome = structuredClone(outcome);
      state.operations.push({
        operationId: request.operationId,
        payloadHash,
        outcome: storedOutcome,
      });
      if (state.operations.length > MAX_OPERATIONS) {
        state.operations.splice(0, state.operations.length - MAX_OPERATIONS);
      }
      await writeStoredState(paths, state, loaded.persistedState);
      return outcome;
    });
  }

  private async applyMutation(
    state: StoredPhaseLeasesV1,
    input: PhaseLeaseExecutionInput,
    predecessorProof: RoadmapPhaseLeasePredecessorProofV1 | null,
  ): Promise<PhaseLeaseOutcome> {
    const { request, context, holder } = input;
    const current = state.leases[request.phaseId] ?? null;
    if (request.action === "renew" || request.action === "release") {
      if (!current || !tokenMatches(request, current) || !sameHolder(current.holder, holder)) {
        return leaseFailure("phase-lease-lost", context, state, current);
      }
      if (request.action === "release") {
        if ((input.runState ?? current.runState) === "running") {
          return leaseFailure("phase-lease-held", context, state, current);
        }
        delete state.leases[request.phaseId];
        state.leaseRevision += 1;
        return leaseOutcome("released", context, state, null);
      }
      const now = this.now();
      const renewed = {
        ...current,
        holder: { ...holder },
        runState: input.runState ?? current.runState,
        renewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PHASE_LEASE_TTL_MS).toISOString(),
        operationId: request.operationId,
      } satisfies StoredPhaseLeaseV1;
      state.leases[request.phaseId] = renewed;
      state.leaseRevision += 1;
      return leaseOutcome("renewed", context, state, renewed);
    }

    if (request.action === "acquire") {
      if (current) {
        const replace = await this.canReplaceExpired(current);
        if (replace !== "replace") return leaseFailure(replace, context, state, current);
      }
      return this.acquire(state, input);
    }

    if (!current || !tokenMatches(request, current)) {
      return leaseFailure("phase-lease-lost", context, state, current);
    }
    const takeover = await this.canTakeover(current, holder, predecessorProof);
    if (takeover !== "replace") return leaseFailure(takeover, context, state, current);
    return this.acquire(state, input);
  }

  private acquire(state: StoredPhaseLeasesV1, input: PhaseLeaseExecutionInput): PhaseLeaseOutcome {
    const now = this.now();
    const fence = state.nextFence;
    state.nextFence += 1;
    state.leaseRevision += 1;
    const lease: StoredPhaseLeaseV1 = {
      version: 1,
      projectKey: canonicalProjectKey(input.context.projectKey),
      phaseId: input.request.phaseId,
      planId: input.request.planId,
      leaseId: this.createId(),
      fence,
      holder: { ...input.holder },
      runState: input.runState ?? "idle",
      acquiredAt: now.toISOString(),
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PHASE_LEASE_TTL_MS).toISOString(),
      operationId: input.request.operationId,
    };
    state.leases[input.request.phaseId] = lease;
    return leaseOutcome("acquired", input.context, state, lease);
  }

  private async canReplaceExpired(
    current: StoredPhaseLeaseV1,
  ): Promise<"replace" | "phase-lease-held" | "lease-owner-unreachable"> {
    const liveness = await this.processLiveness(current.holder);
    if (liveness === "dead") return "replace";
    if (Date.parse(current.expiresAt) > this.now().getTime()) return "phase-lease-held";
    return liveness === "unknown" ? "lease-owner-unreachable" : "phase-lease-held";
  }

  private async canTakeover(
    current: StoredPhaseLeaseV1,
    destination: RoadmapPhaseLeaseHolderV1,
    proof: RoadmapPhaseLeasePredecessorProofV1 | null,
  ): Promise<"replace" | "phase-lease-held" | "lease-owner-unreachable"> {
    if (proofMatches(proof, current.holder, this.now().getTime())) return "replace";
    if (current.holder.daemonInstanceId === destination.daemonInstanceId) {
      return current.runState === "idle" ? "replace" : "phase-lease-held";
    }
    return this.canReplaceExpired(current);
  }
}

async function defaultProcessLiveness(
  holder: RoadmapPhaseLeaseHolderV1,
): Promise<PhaseLeaseLiveness> {
  try {
    process.kill(holder.processId, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

function leaseOutcome(
  status: "inspected" | "acquired" | "renewed" | "released",
  context: PhaseLeaseContext,
  state: StoredPhaseLeasesV1,
  lease: StoredPhaseLeaseV1 | null,
): PhaseLeaseOutcome {
  return {
    status,
    roadmapRevision: context.roadmapRevision,
    leaseRevision: state.leaseRevision,
    phaseId: context.phaseId,
    lease: toPublicLease(lease),
  };
}

function toPublicLease(lease: StoredPhaseLeaseV1 | null): PhaseLeaseV1 | null {
  return lease === null ? null : { ...lease, holder: toPublicHolder(lease.holder) };
}

function toPublicHolder(holder: RoadmapPhaseLeaseHolderV1): PhaseLeaseHolderV1 {
  return {
    daemonInstanceId: holder.daemonInstanceId,
    sessionId: holder.sessionId,
    sessionPath: holder.sessionPath,
    processId: holder.processId,
  };
}

function isRoadmapPhaseLeaseHolder(value: unknown): value is RoadmapPhaseLeaseHolderV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "daemonInstanceId",
      "sessionId",
      "sessionPath",
      "processId",
      "processStartToken",
    ]) &&
    isBoundedInternalString(value.daemonInstanceId) &&
    isBoundedInternalString(value.sessionId) &&
    (value.sessionPath === null ||
      (typeof value.sessionPath === "string" &&
        value.sessionPath.length > 0 &&
        value.sessionPath.length <= 4096)) &&
    isPositiveInteger(value.processId) &&
    isBoundedInternalString(value.processStartToken)
  );
}

export function isRoadmapPhaseLeasePredecessorProofV1(
  value: unknown,
): value is RoadmapPhaseLeasePredecessorProofV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["daemonInstanceId", "processId", "processStartToken", "terminatedAt"]) &&
    isBoundedInternalString(value.daemonInstanceId) &&
    isPositiveInteger(value.processId) &&
    isBoundedInternalString(value.processStartToken) &&
    typeof value.terminatedAt === "string" &&
    Number.isFinite(Date.parse(value.terminatedAt))
  );
}

function isBoundedInternalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function leaseFailure(
  status: "phase-lease-held" | "phase-lease-lost" | "lease-owner-unreachable",
  context: PhaseLeaseContext,
  state: StoredPhaseLeasesV1,
  currentLease: StoredPhaseLeaseV1 | null,
): PhaseLeaseOutcome {
  return {
    status,
    roadmapRevision: context.roadmapRevision,
    leaseRevision: state.leaseRevision,
    currentLease: toPublicLease(currentLease),
  };
}

function duplicateOutcome(outcome: PhaseLeaseOutcome): PhaseLeaseOutcome {
  if (
    outcome.status === "acquired" ||
    outcome.status === "renewed" ||
    outcome.status === "released" ||
    outcome.status === "inspected"
  ) {
    return { ...outcome, status: "duplicate" };
  }
  return outcome;
}

function isCommittedOutcome(outcome: PhaseLeaseOutcome): boolean {
  return (
    outcome.status === "acquired" || outcome.status === "renewed" || outcome.status === "released"
  );
}

function tokenMatches(request: PhaseLeaseRequestV2, lease: StoredPhaseLeaseV1): boolean {
  return request.lease?.leaseId === lease.leaseId && request.lease.fence === lease.fence;
}

function sameHolder(left: RoadmapPhaseLeaseHolderV1, right: RoadmapPhaseLeaseHolderV1): boolean {
  return (
    left.daemonInstanceId === right.daemonInstanceId &&
    left.sessionId === right.sessionId &&
    left.sessionPath === right.sessionPath &&
    left.processId === right.processId &&
    left.processStartToken === right.processStartToken
  );
}

function proofMatches(
  proof: RoadmapPhaseLeasePredecessorProofV1 | null,
  holder: RoadmapPhaseLeaseHolderV1,
  now: number,
): boolean {
  return (
    proof !== null &&
    proof.daemonInstanceId === holder.daemonInstanceId &&
    proof.processId === holder.processId &&
    proof.processStartToken === holder.processStartToken &&
    Date.parse(proof.terminatedAt) <= now
  );
}

function operationPayloadHash(
  input: PhaseLeaseExecutionInput,
  predecessorProof: RoadmapPhaseLeasePredecessorProofV1 | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        request: input.request,
        holder: input.holder,
        runState: input.runState ?? null,
        predecessorProof,
      }),
    )
    .digest("hex");
}

function emptyState(projectKey: string): StoredPhaseLeasesV1 {
  return {
    storeVersion: 1,
    projectKey,
    leaseRevision: 0,
    nextFence: 1,
    leases: {},
    operations: [],
  };
}

type LoadedState =
  | { status: "ok"; state: StoredPhaseLeasesV1; persistedState: StoredPhaseLeasesV1 | null }
  | {
      status: "corrupt";
      primary: "malformed-json" | "invalid-envelope" | null;
      backup: "malformed-json" | "invalid-envelope" | null;
    };

async function readStoredState(paths: PhaseLeasePaths, projectKey: string): Promise<LoadedState> {
  const [primary, backup] = await Promise.all([
    readCandidate(paths.primary, projectKey),
    readCandidate(paths.backup, projectKey),
  ]);
  if (primary.status === "valid") {
    return { status: "ok", state: structuredClone(primary.state), persistedState: primary.state };
  }
  if (backup.status === "valid") {
    return { status: "ok", state: structuredClone(backup.state), persistedState: backup.state };
  }
  if (primary.status === "missing" && backup.status === "missing") {
    return { status: "ok", state: emptyState(projectKey), persistedState: null };
  }
  return {
    status: "corrupt",
    primary: primary.status === "invalid" ? primary.reason : null,
    backup: backup.status === "invalid" ? backup.reason : null,
  };
}

type Candidate =
  | { status: "missing" }
  | { status: "invalid"; reason: "malformed-json" | "invalid-envelope" }
  | { status: "valid"; state: StoredPhaseLeasesV1 };

async function readCandidate(filePath: string, projectKey: string): Promise<Candidate> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", reason: "invalid-envelope" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid", reason: "malformed-json" };
  }
  return isStoredState(value, projectKey)
    ? { status: "valid", state: value }
    : { status: "invalid", reason: "invalid-envelope" };
}

function isStoredState(value: unknown, projectKey: string): value is StoredPhaseLeasesV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "storeVersion",
      "projectKey",
      "leaseRevision",
      "nextFence",
      "leases",
      "operations",
    ])
  )
    return false;
  if (
    value.storeVersion !== STORE_VERSION ||
    value.projectKey !== projectKey ||
    !isNonNegativeInteger(value.leaseRevision) ||
    !isPositiveInteger(value.nextFence) ||
    !isRecord(value.leases) ||
    !Array.isArray(value.operations)
  )
    return false;
  for (const [phaseId, lease] of Object.entries(value.leases)) {
    if (
      !isStoredPhaseLease(lease) ||
      lease.phaseId !== phaseId ||
      lease.projectKey !== projectKey ||
      lease.fence >= (value.nextFence as number)
    )
      return false;
  }
  const operationIds = new Set<string>();
  for (const operation of value.operations) {
    if (
      !isRecord(operation) ||
      !hasExactKeys(operation, ["operationId", "payloadHash", "outcome"]) ||
      typeof operation.operationId !== "string" ||
      operationIds.has(operation.operationId) ||
      typeof operation.payloadHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(operation.payloadHash) ||
      !isPhaseLeaseOutcome(operation.outcome)
    )
      return false;
    operationIds.add(operation.operationId);
  }
  return true;
}

function isStoredPhaseLease(value: unknown): value is StoredPhaseLeaseV1 {
  if (!isRecord(value) || !isRoadmapPhaseLeaseHolder(value.holder)) return false;
  return isPhaseLease({ ...value, holder: toPublicHolder(value.holder) });
}

async function writeStoredState(
  paths: PhaseLeasePaths,
  state: StoredPhaseLeasesV1,
  previous: StoredPhaseLeasesV1 | null,
): Promise<void> {
  if (previous) await atomicWrite(paths.backup, previous);
  else await atomicWrite(paths.backup, emptyState(state.projectKey));
  await atomicWrite(paths.primary, state);
}

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  await fs.chmod(directory, DIRECTORY_MODE).catch(ignoreUnsupportedMode);
}

async function atomicWrite(destination: string, value: StoredPhaseLeasesV1): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    await fs.chmod(temporary, FILE_MODE).catch(ignoreUnsupportedMode);
    const handle = await fs.open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
    await fs.chmod(destination, FILE_MODE).catch(ignoreUnsupportedMode);
    await syncDirectory(path.dirname(destination));
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !new Set(["EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"]).has(code))
      throw error;
  }
}

function ignoreUnsupportedMode(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EINVAL") throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
