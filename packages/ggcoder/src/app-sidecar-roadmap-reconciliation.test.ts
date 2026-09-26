import { describe, expect, it } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";

describe("AppSidecarRoadmapReconciliationCoordinator", () => {
  it("rejects same-project launch/status overlap and exposes the owner", () => {
    const coordinator = new AppSidecarRoadmapReconciliationCoordinator(() => "operation-1");
    const lease = coordinator.tryAcquire("C:\\Work\\Project", "phase-start");

    expect(lease).toMatchObject({ operationId: "operation-1", kind: "phase-start" });
    expect(coordinator.tryAcquire("c:/work/./project", "status-update")).toBeNull();
    expect(coordinator.tryAcquire("c:/work/project", "implementation-checkpoint")).toBeNull();
    expect(coordinator.tryAcquire("c:/work/project", "phase-create")).toBeNull();
    expect(coordinator.owner("c:/WORK/project")).toMatchObject({
      operationId: "operation-1",
      kind: "phase-start",
    });
  });

  it("serializes phase creation with every same-project reconciliation kind", () => {
    const coordinator = new AppSidecarRoadmapReconciliationCoordinator(() => "phase-create-1");
    const lease = coordinator.tryAcquire("/work/project", "phase-create");

    expect(lease).toMatchObject({ kind: "phase-create", operationId: "phase-create-1" });
    expect(coordinator.tryAcquire("/work/project", "phase-start")).toBeNull();
    expect(coordinator.tryAcquire("/work/project", "status-update")).toBeNull();
    expect(coordinator.tryAcquire("/work/project", "implementation-checkpoint")).toBeNull();
    expect(coordinator.tryAcquire("/work/project", "phase-create")).toBeNull();
    lease!.release();
    expect(coordinator.tryAcquire("/work/project", "phase-create")).not.toBeNull();
  });

  it("allows different projects in parallel", () => {
    let sequence = 0;
    const coordinator = new AppSidecarRoadmapReconciliationCoordinator(
      () => `operation-${++sequence}`,
    );
    expect(coordinator.tryAcquire("/work/one", "phase-start")).not.toBeNull();
    expect(coordinator.tryAcquire("/work/two", "status-update")).not.toBeNull();
  });

  it("releases idempotently and recovers after a failed operation", () => {
    let sequence = 0;
    const coordinator = new AppSidecarRoadmapReconciliationCoordinator(
      () => `operation-${++sequence}`,
    );
    const first = coordinator.tryAcquire("/work/project", "status-update")!;
    try {
      throw new Error("storage failed");
    } catch {
      first.release();
    } finally {
      first.release();
    }

    expect(coordinator.owner("/work/project")).toBeUndefined();
    expect(coordinator.tryAcquire("/work/project", "implementation-checkpoint")).toMatchObject({
      operationId: "operation-2",
      kind: "implementation-checkpoint",
    });
  });
});
