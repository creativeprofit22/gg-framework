import { lstat, readFile, writeFile, rename, rm, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { RECOMMENDATION_HISTORY_PAGE_SIZE, type RecommendationHistoryRequest, type RecommendationReview } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import type { ProgrammaticChatResponse } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import { withFileLock } from "@kenkaiiii/gg-core";
import { canonicalJson, canonicalRepositoryRoot, containedPath, rejectLinks, sha256 } from "../tauri-package/paths.js";
import { PROGRAMMATIC_PROFILE_PATH } from "./inventory.js";
import { loadApprovedProgrammaticProfile, type ProgrammaticProfileOperations } from "./profile.js";
import { RECOMMENDATION_LIMITS, recommendationHistoryV1Schema, type RecommendationHistoryV1 } from "./recommendation-contracts.js";
import { emptyRecommendationHistory, recommendationSummary, recommendationDetail, decideRecommendation, confirmRecommendationCorrespondence } from "./recommendations.js";
import { ProgrammaticFilePostCommitError, readBoundedCandidate, replaceBoundedFile, type ProgrammaticStorageOperations } from "./storage.js";

/** Called under the profile lock immediately before each history commit. */
export async function requireRecommendationHistoryPolicy(root: string, expectedDigest: string,
  operations: Partial<ProgrammaticProfileOperations> = {}): Promise<void> {
  const stored = await loadApprovedProgrammaticProfile(root, operations);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || !stored || stored.envelope.version !== 3 ||
    !stored.envelope.historyPolicy.enabled || sha256(stored.bytes) !== expectedDigest)
    throw new Error("Recommendation history is not approved under the current profile.");
}

export const RECOMMENDATION_HISTORY_PATH = ".gg/programmatic/recommendations.json";
export const RECOMMENDATION_PREVIOUS_PATH = ".gg/programmatic/recommendations.previous.json";
const temporaryPath = ".gg/programmatic/.recommendations.tmp";
const previousTemporaryPath = ".gg/programmatic/.recommendations.previous.tmp";
const local: ProgrammaticStorageOperations = { lstat, readFile, writeFile, rename, rm };
export type RecommendationHistoryRead =
  | { status: "missing" }
  | { status: "ready" | "recovered"; history: RecommendationHistoryV1 }
  | { status: "unavailable"; reason: string };
export interface RecommendationHistoryOptions {
  assertCurrent?: () => void;
  operations?: Partial<ProgrammaticStorageOperations>;
  signal?: AbortSignal;
  onPreFileMutation?: (repositoryPath: string) => Promise<void> | void;
  onFileMutated?: (repositoryPath: string) => Promise<void> | void;
}
async function readCandidate(root: string, file: string, operations: ProgrammaticStorageOperations) {
  await rejectLinks(root, file, true);
  let unsupported = false;
  const candidate = await readBoundedCandidate(containedPath(root, file), operations, { parse(input: unknown) {
    if (input && typeof input === "object" && "version" in input && input.version !== 1) unsupported = true;
    return recommendationHistoryV1Schema.parse(input);
  } }, RECOMMENDATION_LIMITS.bytes);
  if (unsupported) throw new Error("Unsupported recommendation history version; refusing fallback or replacement.");
  return candidate;
}
async function load(root: string, operations: ProgrammaticStorageOperations): Promise<RecommendationHistoryRead> {
  const primary = await readCandidate(root, RECOMMENDATION_HISTORY_PATH, operations);
  if (primary.status === "valid") return { status: "ready", history: primary.state };
  const previous = await readCandidate(root, RECOMMENDATION_PREVIOUS_PATH, operations);
  if (previous.status === "valid") return { status: "recovered", history: previous.state };
  if (primary.status === "missing" && previous.status === "missing") return { status: "missing" };
  return { status: "unavailable", reason: "Recommendation history is invalid; no valid previous revision is available." };
}
export async function readRecommendationHistory(cwd: string, options: RecommendationHistoryOptions = {}): Promise<RecommendationHistoryRead> {
  try {
    options.signal?.throwIfAborted();
    return await load(await canonicalRepositoryRoot(cwd), { ...local, ...options.operations });
  } catch {
    return { status: "unavailable", reason: "Recommendation history could not be read (unsafe path, unsupported version, cancellation or I/O failure)." };
  }
}

/** Profile then history lock, never held across provider calls or human review.
 * authorize must re-read approved policy AND its expected digest; no cached permission.
 * No repair: recovered data is read-only until a separately authorized recovery.
 */
export async function updateRecommendationHistory(cwd: string,
  authorize: (root: string, operations: ProgrammaticStorageOperations) => Promise<void>,
  update: (history: RecommendationHistoryV1) => RecommendationHistoryV1,
  options: RecommendationHistoryOptions = {},
): Promise<{ history: RecommendationHistoryV1; changed: boolean }> {
  const root = await canonicalRepositoryRoot(cwd), operations = { ...local, ...options.operations };
  options.signal?.throwIfAborted();
  await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH);
  await rejectLinks(root, RECOMMENDATION_HISTORY_PATH, true);
  return withFileLock(containedPath(root, PROGRAMMATIC_PROFILE_PATH), async () => {
    await authorize(root, operations);
    return withFileLock(containedPath(root, RECOMMENDATION_HISTORY_PATH), async () => {
      options.signal?.throwIfAborted();
      const loaded = await load(root, operations);
      if (loaded.status === "unavailable" || loaded.status === "recovered") throw new Error("History requires separately authorized recovery; refusing to replace it.");
      const before = loaded.status === "ready" ? loaded.history : emptyRecommendationHistory();
      const beforeBytes = canonicalJson(before);
      const next = recommendationHistoryV1Schema.parse(update(recommendationHistoryV1Schema.parse(before)));
      const nextBytes = canonicalJson(next);
      if (nextBytes === beforeBytes) return { history: before, changed: false };
      if (next.revision !== before.revision + 1) throw new Error("History revision must advance exactly once.");
      if (Buffer.byteLength(nextBytes, "utf8") > RECOMMENDATION_LIMITS.bytes) throw new Error("History byte capacity exceeded.");
      const revalidate = async () => {
        options.signal?.throwIfAborted();
        await rejectLinks(root, PROGRAMMATIC_PROFILE_PATH);
        await authorize(root, operations);
        const current = await load(root, operations);
        if (current.status !== loaded.status || (current.status === "ready" && canonicalJson(current.history) !== beforeBytes))
          throw new Error("History changed before replacement; read before retry.");
      };
      const replace = async (file: string, temporary: string, history: RecommendationHistoryV1) => {
        await rejectLinks(root, temporary, true);
        await rejectLinks(root, file, true);
        await replaceBoundedFile(root, file, temporary, history, operations, options, recommendationHistoryV1Schema,
          RECOMMENDATION_LIMITS.bytes, async (commit) => {
            await revalidate();
            await rejectLinks(root, temporary);
            await rejectLinks(root, file, true);
            options.signal?.throwIfAborted();
            await commit();
          }, "Recommendation history");
      };
      if (loaded.status === "ready") {
        // A future previous file is not permission to downgrade it either.
        await readCandidate(root, RECOMMENDATION_PREVIOUS_PATH, operations);
        await replace(RECOMMENDATION_PREVIOUS_PATH, previousTemporaryPath, before);
      }
      try {
        await replace(RECOMMENDATION_HISTORY_PATH, temporaryPath, next);
      } catch (error) {
        // A filesystem adapter may throw after performing rename. Observe instead of claiming rollback.
        const current = await readRecommendationHistory(root, { operations });
        if (current.status === "ready" && canonicalJson(current.history) === nextBytes)
          throw new ProgrammaticFilePostCommitError(RECOMMENDATION_HISTORY_PATH, error, "History is present; acknowledgement failed. Read before retry.");
        throw error;
      }
      return { history: next, changed: true };
    });
  });
}
export function recommendationCommitUnknown(error: unknown): boolean {
  return error instanceof ProgrammaticFilePostCommitError && error.repositoryPath === RECOMMENDATION_HISTORY_PATH;
}

/** One host review per authenticated adapter. The adapter owns live mode/run authorization. */
export class RecommendationHistoryReview {
  private historyReview?: { reviewId: string; owner: string; project: string; profileDigest: string; historyRevision: number;
    request: Extract<RecommendationHistoryRequest, { action: "history-inspect-decision" | "history-inspect-correspondence" }> };
  reset(): void { this.historyReview = undefined; }
  setOwner(owner: string): void { if (this.historyReview && this.historyReview.owner !== owner) this.reset(); }
  private async projectIdentity(cwd: string): Promise<string> {
    const root = await realpath(cwd), info = await stat(root);
    if (!info.isDirectory()) throw new Error("Project directory unavailable.");
    return sha256(JSON.stringify({ root, dev: info.dev, ino: info.ino }));
  }
  async handle(input: RecommendationHistoryRequest, cwd: string,
    owner: string, current: () => boolean): Promise<ProgrammaticChatResponse> {
    const action = input.action;
    const pending = action === "history-apply" ? this.historyReview : undefined;
    if (action === "history-apply") this.historyReview = undefined;
    const profile = await loadApprovedProgrammaticProfile(cwd);
    const enabled = profile?.envelope.version === 3 && profile.envelope.historyPolicy.enabled;
    const loaded = enabled ? await readRecommendationHistory(cwd) : { status: "disabled" as const };
    if (action === "history-report") {
      const history = loaded.status === "ready" || loaded.status === "recovered" ? loaded.history : undefined;
      const offset = Math.min(input.offset, history?.candidates.length ?? 0);
      return { version: 1, action, ok: true, report: { version: 1, status: loaded.status, revision: history?.revision ?? 0,
        total: history?.candidates.length ?? 0, offset,
        candidates: history?.candidates.slice(offset, offset + RECOMMENDATION_HISTORY_PAGE_SIZE).map((candidate) => recommendationSummary(history, candidate)) ?? [],
        ...(loaded.status === "recovered" ? { warning: "Previous history is available read-only; no automatic repair was performed." }
          : loaded.status === "unavailable" ? { warning: loaded.reason } : {}),
      } };
    }
    if (action === "history-detail") return { version: 1, action, ok: true,
      detail: loaded.status === "ready" || loaded.status === "recovered" ? recommendationDetail(loaded.history, input.candidateId, input.offset) : null };
    if (!enabled || loaded.status !== "ready" || !profile || !current()) throw new Error("Approved current history unavailable.");
    const history = loaded.history, profileDigest = sha256(profile.bytes), project = await this.projectIdentity(cwd);
    const apply = (history: RecommendationHistoryV1, request: NonNullable<typeof this.historyReview>["request"]) =>
      request.action === "history-inspect-decision" ? decideRecommendation(history, request, new Date().toISOString())
        : confirmRecommendationCorrespondence(history, { canonicalId: request.candidateId, canonicalRevision: request.expectedRevision,
          retainedId: request.otherId, retainedRevision: request.otherExpectedRevision }, new Date().toISOString());
    if (action === "history-apply") {
      if (!pending || pending.reviewId !== input.reviewId || pending.owner !== owner || pending.project !== project ||
        pending.profileDigest !== profileDigest || pending.historyRevision !== history.revision) throw new Error("History review expired.");
      const saved = await updateRecommendationHistory(cwd, async (root) => {
        if (!current()) throw new Error("History mutation is not permitted.");
        if (await this.projectIdentity(root) !== pending.project) throw new Error("Project was replaced.");
        await requireRecommendationHistoryPolicy(root, pending.profileDigest);
        if (!current()) throw new Error("History review owner changed.");
      }, (latest) => {
        if (latest.revision !== pending.historyRevision) throw new Error("History changed; inspect again.");
        return apply(latest, pending.request);
      }, { assertCurrent: () => { if (!current()) throw new Error("History review owner changed before rename."); } });
      return { version: 1, action, ok: true, changed: saved.changed };
    }
    this.historyReview = undefined;
    apply(history, input);
    const ids = [input.candidateId, ...(input.action === "history-inspect-correspondence" ? [input.otherId] : [])];
    const review: RecommendationReview = { version: 1, reviewId: randomUUID(), historyRevision: history.revision,
      operation: input.action === "history-inspect-decision" ? input.decision : "correspondence",
      candidates: ids.map((id) => recommendationSummary(history, history.candidates.find((candidate) => candidate.id === id)!)),
      details: ids.map((id) => {
        const candidate = history.candidates.find((candidate) => candidate.id === id)!;
        return JSON.stringify({ observation: history.observations.find((observation) => observation.id === candidate.observationIds.at(-1)),
          decision: history.decisions.find((decision) => decision.id === candidate.decisionIds.at(-1)) });
      }),
      warning: "This changes recommendation history only. Completion is user-declared, not verified. Correspondence is your confirmation, not model similarity. No command is created, run or approved.",
    };
    if (!current()) throw new Error("History review owner changed.");
    this.historyReview = { reviewId: review.reviewId, owner, project, profileDigest, historyRevision: history.revision, request: structuredClone(input) };
    return { version: 1, action, ok: true, review };
  }
}
