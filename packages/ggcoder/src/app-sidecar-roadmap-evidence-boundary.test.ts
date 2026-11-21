import { describe, expect, it } from "vitest";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const report = {
  update_id: "honest-report",
  phase_id: "phase-1",
  expected_revision: 1,
  progress: "Reviewed current code and documented remaining gaps",
};
describe("author reports, not execution certificates", () => {
  it("accepts audits and partial progress without a verification result", () => {
    expect(
      RoadmapStatusParams.parse({ ...report, transition: "in-progress" }).verification,
    ).toBeNull();
  });
  it("accepts one supporting report without any execution IDs", () => {
    expect(
      RoadmapStatusParams.safeParse({
        ...report,
        transition: "done",
        verification: { result: "passed" },
        evidence: ["Inspected required documentation"],
      }).success,
    ).toBe(true);
  });
  it("never relabels a failed report passed or accepts it as Done", () => {
    const failed = {
      ...report,
      verification: { result: "failed", reason: "One requirement is still failing" },
      evidence: ["One requirement is still failing"],
    };
    expect(
      RoadmapStatusParams.parse({ ...failed, transition: "in-progress" }).verification?.result,
    ).toBe("failed");
    expect(RoadmapStatusParams.safeParse({ ...failed, transition: "done" }).success).toBe(false);
  });
  it("keeps legacy bindings bounded without granting them completion authority", () => {
    const binding = { criterion_id: "a".repeat(64), execution_id: "shared-check" };
    const done = {
      ...report,
      transition: "done",
      verification: { result: "passed" },
      evidence: ["One check covers related requirements"],
    };
    expect(
      RoadmapStatusParams.safeParse({ ...done, verification_bindings: [binding, binding] }).success,
    ).toBe(true);
    expect(
      RoadmapStatusParams.safeParse({
        ...done,
        verification_bindings: Array.from({ length: 21 }, () => binding),
      }).success,
    ).toBe(false);
  });
});
