import { createHash, randomUUID } from "node:crypto";
import type { PendingPlanReview } from "@kenkaiiii/gg-core";

export type { PendingPlanReview } from "@kenkaiiii/gg-core";
export const MAX_PLAN_GATE_CONTENT_BYTES = 512 * 1024;

export type PlanReviewState =
  | "pending-review"
  | "revision-requested"
  | "human-approved"
  | "superseded";
export type PlanReviewActor = "gg-coder" | "ken-autopilot" | "user";
export type PlanReviewStatus = "unreviewed" | "ready";

export interface PersistedPlanReviewCheckpoint {
  version: 1;
  checkpointId: string;
  generation: number;
  planPath: string;
  content: string;
  contentHash: string;
  state: PlanReviewState;
  reviewStatus: PlanReviewStatus;
  actor: PlanReviewActor;
  timestamp: string;
  feedback: string | null;
}

export interface PlanGateMarker {
  kind: string;
  data: Record<string, unknown>;
}

export type PlanGateTransitionResult =
  | { status: "committed"; checkpoint: PersistedPlanReviewCheckpoint }
  | { status: "conflict"; checkpoint: PersistedPlanReviewCheckpoint | null };

const STATES = new Set<PlanReviewState>([
  "pending-review",
  "revision-requested",
  "human-approved",
  "superseded",
]);
const ACTORS = new Set<PlanReviewActor>(["gg-coder", "ken-autopilot", "user"]);
const REVIEW_STATUSES = new Set<PlanReviewStatus>(["unreviewed", "ready"]);
const EXACT_KEYS = [
  "version",
  "checkpointId",
  "generation",
  "planPath",
  "content",
  "contentHash",
  "state",
  "reviewStatus",
  "actor",
  "timestamp",
  "feedback",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCheckpoint(value: unknown): PersistedPlanReviewCheckpoint | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== EXACT_KEYS.length || !EXACT_KEYS.every((key) => keys.includes(key))) {
    return null;
  }
  if (
    value.version !== 1 ||
    typeof value.checkpointId !== "string" ||
    !value.checkpointId.trim() ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.planPath !== "string" ||
    typeof value.content !== "string" ||
    Buffer.byteLength(value.content, "utf8") > MAX_PLAN_GATE_CONTENT_BYTES ||
    typeof value.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentHash) ||
    !STATES.has(value.state as PlanReviewState) ||
    !REVIEW_STATUSES.has(value.reviewStatus as PlanReviewStatus) ||
    !ACTORS.has(value.actor as PlanReviewActor) ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    (value.feedback !== null && typeof value.feedback !== "string")
  ) {
    return null;
  }
  if (hashPlanContent(value.content) !== value.contentHash) return null;
  return value as unknown as PersistedPlanReviewCheckpoint;
}

export function hashPlanContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const PLAN_STATUS_FIELD = /^(\s*(?:[-*]\s*)?\*\*Status:\*\*\s*)Draft(\s*)$/gim;
const DRAFT_PLAN_STATUS_FIELD = /^(\s*(?:[-*]\s*)?\*\*Status:\*\*\s*)Draft\s*$/im;
const APPROVED_PLAN_MARKER = "<!-- gg-plan-status: approved -->";
const PLAN_ONLY_BOUNDARY_FIELD =
  /^\s*(?:[-*]\s*)?\*\*Plan-only boundary:\*\*\s*Yes(?:\s*[—-].*)?$/im;

/** Render the immutable reviewed bytes as an explicitly approved artifact.
 * The checkpoint retains the original content/hash; only the approved copy gets
 * approval metadata, so a copied Draft label can never contradict the durable gate. */
export function approvedPlanArtifactContent(content: string): string {
  const normalized = content.replace(PLAN_STATUS_FIELD, "$1Approved$2");
  if (normalized.includes(APPROVED_PLAN_MARKER)) return normalized;
  return `${APPROVED_PLAN_MARKER}\n${normalized}`;
}

export function isApprovedPlanArtifact(content: string): boolean {
  return content.includes(APPROVED_PLAN_MARKER) && !DRAFT_PLAN_STATUS_FIELD.test(content);
}

export function hasPlanOnlyBoundary(content: string): boolean {
  return PLAN_ONLY_BOUNDARY_FIELD.test(content);
}

export async function syncApprovedPlanSnapshotForDurability(
  sync: () => Promise<void>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    await sync();
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException | null;
    if (platform === "win32" && fsError?.code === "EPERM" && fsError.syscall === "fsync") {
      return;
    }
    throw error;
  }
}

/** Reduce append-only markers by generation, then marker order within that generation. */
export function reducePlanGateMarkers(
  markers: readonly PlanGateMarker[],
): PersistedPlanReviewCheckpoint | null {
  let current: PersistedPlanReviewCheckpoint | null = null;
  for (const marker of markers) {
    if (marker.kind !== "plan_gate") continue;
    const checkpoint = parseCheckpoint(marker.data);
    if (!checkpoint) continue;
    if (
      current === null ||
      checkpoint.generation > current.generation ||
      (checkpoint.generation === current.generation &&
        checkpoint.checkpointId === current.checkpointId)
    ) {
      current = checkpoint;
    }
  }
  return current;
}

export function planGateConflictCode(
  checkpoint: PersistedPlanReviewCheckpoint | null,
): "plan-approval-required" | "plan-revision-pending" | null {
  if (checkpoint?.state === "pending-review") return "plan-approval-required";
  if (checkpoint?.state === "revision-requested") return "plan-revision-pending";
  return null;
}

export function pendingPlanReview(
  checkpoint: PersistedPlanReviewCheckpoint | null,
): PendingPlanReview | null {
  if (
    checkpoint === null ||
    (checkpoint.state !== "pending-review" && checkpoint.state !== "revision-requested")
  ) {
    return null;
  }
  return {
    checkpointId: checkpoint.checkpointId,
    generation: checkpoint.generation,
    planPath: checkpoint.planPath,
    content: checkpoint.content,
    contentHash: checkpoint.contentHash,
    state: checkpoint.state,
    reviewStatus: checkpoint.reviewStatus,
    feedback: checkpoint.feedback,
  };
}

export class AppSidecarPlanGate {
  private currentCheckpoint: PersistedPlanReviewCheckpoint | null;
  private transitionQueue: Promise<void> = Promise.resolve();

  constructor(
    markers: readonly PlanGateMarker[],
    private readonly persist: (checkpoint: PersistedPlanReviewCheckpoint) => Promise<void>,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.currentCheckpoint = reducePlanGateMarkers(markers);
  }

  current(): PersistedPlanReviewCheckpoint | null {
    return this.currentCheckpoint ? structuredClone(this.currentCheckpoint) : null;
  }

  pending(): PendingPlanReview | null {
    return pendingPlanReview(this.currentCheckpoint);
  }

  async submit(planPath: string, content: string): Promise<PersistedPlanReviewCheckpoint> {
    if (Buffer.byteLength(content, "utf8") > MAX_PLAN_GATE_CONTENT_BYTES) {
      throw new Error(`Plan snapshot exceeds ${MAX_PLAN_GATE_CONTENT_BYTES} bytes.`);
    }
    return this.exclusive(async () => {
      const previous = this.currentCheckpoint;
      const checkpoint: PersistedPlanReviewCheckpoint = {
        version: 1,
        checkpointId: this.createId(),
        generation: (previous?.generation ?? 0) + 1,
        planPath,
        content,
        contentHash: hashPlanContent(content),
        state: "pending-review",
        reviewStatus: "unreviewed",
        actor: "gg-coder",
        timestamp: this.now(),
        feedback: null,
      };
      await this.persist(checkpoint);
      this.currentCheckpoint = checkpoint;
      if (
        previous &&
        (previous.state === "pending-review" || previous.state === "revision-requested")
      ) {
        await this.persist({
          ...previous,
          state: "superseded",
          actor: "gg-coder",
          timestamp: this.now(),
        });
      }
      return structuredClone(checkpoint);
    });
  }

  markReady(checkpointId: string, generation: number): Promise<PlanGateTransitionResult> {
    return this.transition(checkpointId, generation, ["pending-review"], (checkpoint) => ({
      ...checkpoint,
      reviewStatus: "ready",
      actor: "ken-autopilot",
      timestamp: this.now(),
    }));
  }

  requestRevision(
    checkpointId: string,
    generation: number,
    actor: "user" | "ken-autopilot",
    feedback: string,
  ): Promise<PlanGateTransitionResult> {
    const normalizedFeedback = feedback.trim();
    return this.exclusive(async () => {
      const checkpoint = this.currentCheckpoint;
      if (!normalizedFeedback) {
        return {
          status: "conflict",
          checkpoint: checkpoint ? structuredClone(checkpoint) : null,
        };
      }
      if (
        checkpoint?.checkpointId === checkpointId &&
        checkpoint.generation === generation &&
        checkpoint.state === "revision-requested" &&
        checkpoint.feedback?.trim() === normalizedFeedback
      ) {
        return { status: "committed", checkpoint: structuredClone(checkpoint) };
      }
      if (
        !checkpoint ||
        checkpoint.checkpointId !== checkpointId ||
        checkpoint.generation !== generation ||
        checkpoint.state !== "pending-review"
      ) {
        return {
          status: "conflict",
          checkpoint: checkpoint ? structuredClone(checkpoint) : null,
        };
      }
      const revised: PersistedPlanReviewCheckpoint = {
        ...checkpoint,
        state: "revision-requested",
        actor,
        timestamp: this.now(),
        feedback: normalizedFeedback,
      };
      await this.persist(revised);
      this.currentCheckpoint = revised;
      return { status: "committed", checkpoint: structuredClone(revised) };
    });
  }

  approve(checkpointId: string, generation: number): Promise<PlanGateTransitionResult> {
    return this.exclusive(async () => {
      const checkpoint = this.currentCheckpoint;
      if (
        checkpoint?.checkpointId === checkpointId &&
        checkpoint.generation === generation &&
        checkpoint.state === "human-approved"
      ) {
        return { status: "committed", checkpoint: structuredClone(checkpoint) };
      }
      if (
        !checkpoint ||
        checkpoint.checkpointId !== checkpointId ||
        checkpoint.generation !== generation ||
        checkpoint.state !== "pending-review"
      ) {
        return {
          status: "conflict",
          checkpoint: checkpoint ? structuredClone(checkpoint) : null,
        };
      }
      const approved: PersistedPlanReviewCheckpoint = {
        ...checkpoint,
        state: "human-approved",
        actor: "user",
        timestamp: this.now(),
      };
      await this.persist(approved);
      this.currentCheckpoint = approved;
      return { status: "committed", checkpoint: structuredClone(approved) };
    });
  }

  private transition(
    checkpointId: string,
    generation: number,
    expectedStates: readonly PlanReviewState[],
    update: (checkpoint: PersistedPlanReviewCheckpoint) => PersistedPlanReviewCheckpoint,
  ): Promise<PlanGateTransitionResult> {
    return this.exclusive(async () => {
      const checkpoint = this.currentCheckpoint;
      if (
        !checkpoint ||
        checkpoint.checkpointId !== checkpointId ||
        checkpoint.generation !== generation ||
        !expectedStates.includes(checkpoint.state)
      ) {
        return {
          status: "conflict",
          checkpoint: checkpoint ? structuredClone(checkpoint) : null,
        };
      }
      const next = update(checkpoint);
      await this.persist(next);
      this.currentCheckpoint = next;
      return { status: "committed", checkpoint: structuredClone(next) };
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionQueue;
    let release!: () => void;
    this.transitionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
