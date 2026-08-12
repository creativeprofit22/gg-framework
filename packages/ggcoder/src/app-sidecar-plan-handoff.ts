import type {
  PersistedPlanReviewCheckpoint,
  PlanGateTransitionResult,
} from "./app-sidecar-plan-gate.js";

export interface ApprovedPlanConsumptionIdentity {
  checkpointId: string;
  generation: number;
  state: "approval-committed" | "implementation-prompt-started";
}

export type PlanHandoffAcceptResult =
  | { status: "committed"; checkpoint: PersistedPlanReviewCheckpoint | null }
  | { status: "conflict"; checkpoint: PersistedPlanReviewCheckpoint | null };

export interface AppSidecarPlanHandoffDependencies<
  Consumption extends ApprovedPlanConsumptionIdentity,
> {
  approve: (checkpointId: string, generation: number) => Promise<PlanGateTransitionResult>;
  commitApproval: (checkpoint: PersistedPlanReviewCheckpoint) => Promise<Consumption>;
  currentConsumption: () => Consumption | null;
  launchImplementation: (consumption: Consumption) => Promise<void>;
  schedule?: (callback: () => void) => void;
  onLaunchFailure?: (error: unknown, consumption: Consumption) => void;
}

function identityKey(value: ApprovedPlanConsumptionIdentity): string {
  return `${value.checkpointId}:${value.generation}`;
}

function matchesIdentity(
  value: { checkpointId: string; generation: number } | null,
  checkpointId: string,
  generation: number,
): boolean {
  return value?.checkpointId === checkpointId && value.generation === generation;
}

/**
 * Owns the retry/restart boundary between durable human approval and starting
 * its implementation prompt. Durable session state remains the source of truth;
 * this class only deduplicates launch callbacks within one sidecar process.
 */
export class AppSidecarPlanHandoff<Consumption extends ApprovedPlanConsumptionIdentity> {
  private readonly scheduled = new Set<string>();
  private readonly schedule: (callback: () => void) => void;
  private transitionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AppSidecarPlanHandoffDependencies<Consumption>) {
    this.schedule = deps.schedule ?? queueMicrotask;
  }

  accept(checkpointId: string, generation: number): Promise<PlanHandoffAcceptResult> {
    return this.exclusive(async () => {
      const existing = this.deps.currentConsumption();
      if (matchesIdentity(existing, checkpointId, generation)) {
        this.resume(existing!);
        return { status: "committed", checkpoint: null };
      }

      const approval = await this.deps.approve(checkpointId, generation);
      if (approval.status === "conflict") return approval;
      const consumption = await this.deps.commitApproval(approval.checkpoint);
      this.resume(consumption);
      return approval;
    });
  }

  resumePending(): boolean {
    const consumption = this.deps.currentConsumption();
    if (!consumption || consumption.state !== "approval-committed") return false;
    this.resume(consumption);
    return true;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(operation, operation);
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private resume(consumption: Consumption): void {
    if (consumption.state !== "approval-committed") return;
    const key = identityKey(consumption);
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    this.schedule(() => {
      void this.launchIfPending(key, consumption);
    });
  }

  private async launchIfPending(key: string, expected: Consumption): Promise<void> {
    try {
      const current = this.deps.currentConsumption();
      if (
        !matchesIdentity(current, expected.checkpointId, expected.generation) ||
        current?.state !== "approval-committed"
      ) {
        return;
      }
      await this.deps.launchImplementation(current as Consumption);
    } catch (error) {
      this.deps.onLaunchFailure?.(error, expected);
    } finally {
      this.scheduled.delete(key);
    }
  }
}
