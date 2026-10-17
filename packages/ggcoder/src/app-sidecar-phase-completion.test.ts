import { describe, expect, it } from "vitest";
import { AppSidecarPhaseImplementationPlanTracker } from "./app-sidecar-phase-completion.js";
const session = { sessionId: "session", sessionPath: "/sessions/session.jsonl" };

describe("optional phase progress widget", () => {
  it("retains partial progress after prompt cleanup without requiring all steps", () => {
    const tracker = new AppSidecarPhaseImplementationPlanTracker();
    expect(
      tracker.resolve({ phaseId: "phase", session, current: { total: 3, completed: [1, 2] } }),
    ).toEqual({ total: 3, completed: [1, 2] });
    expect(
      tracker.resolve({ phaseId: "phase", session, current: { total: 0, completed: [] } }),
    ).toEqual({ total: 3, completed: [1, 2] });
  });
  it("keeps phases isolated and clears retained state", () => {
    const tracker = new AppSidecarPhaseImplementationPlanTracker();
    tracker.resolve({ phaseId: "first", session, current: { total: 3, completed: [1] } });
    expect(
      tracker.resolve({ phaseId: "second", session, current: { total: 0, completed: [] } }),
    ).toBeNull();
    tracker.clear();
    expect(
      tracker.resolve({ phaseId: "first", session, current: { total: 0, completed: [] } }),
    ).toBeNull();
  });
});
