import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarPlanHandoff,
  type ApprovedPlanConsumptionIdentity,
} from "./app-sidecar-plan-handoff.js";
import type { PersistedPlanReviewCheckpoint } from "./app-sidecar-plan-gate.js";

const checkpoint: PersistedPlanReviewCheckpoint = {
  version: 1,
  checkpointId: "checkpoint-1",
  generation: 3,
  planPath: "/caller/plan.md",
  content: "# Approved plan",
  contentHash: "hash",
  state: "human-approved",
  reviewStatus: "ready",
  actor: "user",
  timestamp: "2026-08-10T12:00:00.000Z",
  feedback: null,
};

type Consumption = ApprovedPlanConsumptionIdentity & { content: string };

function committed(state: Consumption["state"] = "approval-committed"): Consumption {
  return {
    checkpointId: checkpoint.checkpointId,
    generation: checkpoint.generation,
    state,
    content: checkpoint.content,
  };
}

describe("AppSidecarPlanHandoff", () => {
  it("retries after failure following human approval without requiring another approval", async () => {
    let consumption: Consumption | null = null;
    const approve = vi.fn().mockResolvedValue({ status: "committed", checkpoint });
    const commitApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error("fresh session commit failed"))
      .mockImplementationOnce(async () => (consumption = committed()));
    const scheduled: Array<() => void> = [];
    const handoff = new AppSidecarPlanHandoff<Consumption>({
      approve,
      commitApproval,
      currentConsumption: () => consumption,
      launchImplementation: vi.fn(),
      schedule: (callback) => scheduled.push(callback),
    });

    await expect(handoff.accept(checkpoint.checkpointId, checkpoint.generation)).rejects.toThrow(
      "fresh session commit failed",
    );
    await expect(
      handoff.accept(checkpoint.checkpointId, checkpoint.generation),
    ).resolves.toMatchObject({
      status: "committed",
    });

    expect(approve).toHaveBeenCalledTimes(2);
    expect(commitApproval).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(1);
  });

  it("recovers a human-approved checkpoint whose consumption commit never finished", async () => {
    let consumption: Consumption | null = null;
    const commitApproval = vi.fn(async () => (consumption = committed()));
    const scheduled: Array<() => void> = [];
    const handoff = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn().mockResolvedValue({ status: "committed", checkpoint }),
      commitApproval,
      currentConsumption: () => consumption,
      launchImplementation: vi.fn(),
      schedule: (callback) => scheduled.push(callback),
    });

    await expect(handoff.recoverApproved(checkpoint)).resolves.toBe(true);
    expect(commitApproval).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
  });

  it("does not launch implementation for a completed plan-only approval", async () => {
    const launchImplementation = vi.fn();
    const schedule = vi.fn();
    const handoff = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn().mockResolvedValue({ status: "committed", checkpoint }),
      commitApproval: vi.fn().mockResolvedValue(committed("completed")),
      currentConsumption: () => null,
      launchImplementation,
      schedule,
    });

    await expect(
      handoff.accept(checkpoint.checkpointId, checkpoint.generation),
    ).resolves.toMatchObject({
      status: "committed",
    });
    expect(schedule).not.toHaveBeenCalled();
    expect(launchImplementation).not.toHaveBeenCalled();
  });

  it("does not replay recovery over an existing or completed consumption", async () => {
    const existing = committed("completed");
    const commitApproval = vi.fn();
    const handoff = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn(),
      commitApproval,
      currentConsumption: () => existing,
      launchImplementation: vi.fn(),
    });

    await expect(handoff.recoverApproved(checkpoint)).resolves.toBe(false);
    expect(commitApproval).not.toHaveBeenCalled();
  });

  it("recovers an ordinary non-Roadmap approval after restart before the queued prompt", async () => {
    let consumption: Consumption | null = null;
    const firstQueue: Array<() => void> = [];
    const commitApproval = vi.fn(async () => (consumption = committed()));
    const firstLaunch = vi.fn();
    const first = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn().mockResolvedValue({ status: "committed", checkpoint }),
      commitApproval,
      currentConsumption: () => consumption,
      launchImplementation: firstLaunch,
      schedule: (callback) => firstQueue.push(callback),
    });
    await first.accept(checkpoint.checkpointId, checkpoint.generation);
    expect(firstQueue).toHaveLength(1);

    // Simulate process loss: its queued callback is discarded. The durable
    // implementation-session record is the only state given to the replacement.
    const restartQueue: Array<() => void> = [];
    const restartLaunch = vi.fn(async () => {
      consumption = committed("implementation-prompt-started");
    });
    const restarted = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn(),
      commitApproval: vi.fn(),
      currentConsumption: () => consumption,
      launchImplementation: restartLaunch,
      schedule: (callback) => restartQueue.push(callback),
    });

    expect(restarted.resumePending()).toBe(true);
    restartQueue.shift()?.();
    await vi.waitFor(() => expect(restartLaunch).toHaveBeenCalledTimes(1));
    expect(firstLaunch).not.toHaveBeenCalled();
  });

  it("serializes concurrent acceptance retries into one implementation session", async () => {
    let consumption: Consumption | null = null;
    const commitApproval = vi.fn(async () => {
      await Promise.resolve();
      return (consumption = committed());
    });
    const handoff = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn().mockResolvedValue({ status: "committed", checkpoint }),
      commitApproval,
      currentConsumption: () => consumption,
      launchImplementation: vi.fn(),
    });

    await Promise.all([
      handoff.accept(checkpoint.checkpointId, checkpoint.generation),
      handoff.accept(checkpoint.checkpointId, checkpoint.generation),
    ]);
    expect(commitApproval).toHaveBeenCalledTimes(1);
  });

  it("deduplicates acceptance retries before the implementation callback starts", async () => {
    let consumption: Consumption | null = committed();
    const scheduled: Array<() => void> = [];
    const launchImplementation = vi.fn(async () => {
      consumption = committed("implementation-prompt-started");
    });
    const handoff = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn(),
      commitApproval: vi.fn(),
      currentConsumption: () => consumption,
      launchImplementation,
      schedule: (callback) => scheduled.push(callback),
    });

    await handoff.accept(checkpoint.checkpointId, checkpoint.generation);
    await handoff.accept(checkpoint.checkpointId, checkpoint.generation);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(launchImplementation).toHaveBeenCalledTimes(1));
  });

  it("does not replay a prompt already marked started", () => {
    const launchImplementation = vi.fn();
    const handoff = new AppSidecarPlanHandoff<Consumption>({
      approve: vi.fn(),
      commitApproval: vi.fn(),
      currentConsumption: () => committed("implementation-prompt-started"),
      launchImplementation,
    });

    expect(handoff.resumePending()).toBe(false);
    expect(launchImplementation).not.toHaveBeenCalled();
  });
});
