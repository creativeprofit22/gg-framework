import { describe, expect, it, vi } from "vitest";
import { RoadmapBindParams, createRoadmapBindTool } from "./roadmap-bind.js";

describe("roadmap_bind tool", () => {
  it("maps bind-current without accepting a destination", async () => {
    const handle = vi.fn(async () => ({ status: "missing" as const }));
    const tool = createRoadmapBindTool(handle);

    await tool.execute({
      action: "bind-current",
      phase_id: "phase-1",
      expected_project_key: "c:/work/project",
      expected_revision: 4,
      operation_id: "operation-1",
    }, {} as never);

    expect(handle).toHaveBeenCalledWith({
      version: 1,
      action: "bind-current",
      phaseId: "phase-1",
      expectedProjectKey: "c:/work/project",
      expectedRevision: 4,
      expectedPreviousSession: null,
      operationId: "operation-1",
      confirmRebind: false,
    });
    expect(JSON.stringify(tool.rawInputSchema)).not.toContain("destination");
    expect(JSON.stringify(tool.rawInputSchema)).not.toContain("final_review");
  });

  it("requires exact previous identity and explicit rebind confirmation", async () => {
    expect(
      RoadmapBindParams.safeParse({
        action: "rebind-current",
        phase_id: "phase-1",
        expected_project_key: "c:/work/project",
        expected_revision: 4,
        expected_previous_session: {
          session_id: "session-a",
          session_path: "C:\\sessions\\a.jsonl",
        },
        operation_id: "operation-1",
        confirm_rebind: true,
      }).success,
    ).toBe(true);
    expect(
      RoadmapBindParams.safeParse({
        action: "rebind-current",
        phase_id: "phase-1",
        expected_project_key: "c:/work/project",
        expected_revision: 4,
        expected_previous_session: {
          session_id: "session-a",
          session_path: "C:\\sessions\\a.jsonl",
        },
        operation_id: "operation-1",
        confirm_rebind: false,
      }).success,
    ).toBe(false);
  });

  it("delegates inspect without mutation fields", async () => {
    const handle = vi.fn(async () => ({ status: "missing" as const }));
    const tool = createRoadmapBindTool(handle);

    await tool.execute({ action: "inspect" }, {} as never);

    expect(handle).toHaveBeenCalledWith({ action: "inspect" });
    expect(RoadmapBindParams.safeParse({ action: "inspect", phase_id: "phase-1" }).success).toBe(
      false,
    );
  });
});
