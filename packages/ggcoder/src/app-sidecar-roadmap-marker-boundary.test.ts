import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("durable Roadmap marker boundary", () => {
  it("keeps live and restored [DONE:n] prose outside canonical checkpoint mutations", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const markerStart = source.indexOf("function recordApprovedPlanMarkers");
    const markerEnd = source.indexOf("function bindSessionEvents", markerStart);
    const markerPath = source.slice(markerStart, markerEnd);

    expect(source).toContain("recordApprovedPlanMarkers(text);");
    expect(source).toContain("recordApprovedPlanMarkers(data.text);");
    expect(markerPath).toContain("queueApprovedPlanProgressSync");
    expect(source).toContain('broadcast("plan_progress", planProgressPayload())');
    expect(markerPath).not.toContain("checkpointPhaseExecutionStep");
    expect(source).not.toContain("persistDurableApprovedPlanMarkers");
    expect(source).not.toContain("notesRepository.checkpointPhaseExecutionStep");
    // Run settlement no longer synthesizes canonical checkpoints from transcript markers.
    expect(source).not.toContain("currentPlanProgress:");
    expect(source).not.toContain("notesRepository.recordImplementationCheckpoint");
    expect(source).toMatch(
      /terminalPlanComplete = durableRoadmapExecution\s*\? await durableApprovedPlanComplete\(\)\s*: markerComplete/,
    );
  });
});
