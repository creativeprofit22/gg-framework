import { describe, expect, it } from "vitest";
import { MotionReviewGate, parseMotionVerdict } from "./motion-review-gate.js";

const ready = { status: "ready", findings: [] };
const revise = {
  status: "revise",
  findings: [
    {
      time: 1.2,
      criterion: "Opening action",
      problem: "Focal object never moves",
      correction: "Animate the planned handoff",
    },
  ],
};
const evidence = {
  artifactHash: "a".repeat(64),
  sourceHash: "b".repeat(64),
  images: 3,
  technical: true,
};

describe("Motion completion review", () => {
  it("leaves discussion and reading an old video alone", () => {
    const gate = new MotionReviewGate();
    expect(gate.armed).toBe(false);
    expect(gate.followUp()).toBeNull();
  });
  it("requires current rendered images and technical evidence", () => {
    const gate = new MotionReviewGate();
    gate.work();
    expect(gate.followUp()).toContain("motion_review");
    gate.submit({ ...evidence, images: 0 }, ready);
    expect(gate.status).toBe("unverified");
    gate.submit({ ...evidence, technical: false }, ready);
    expect(gate.status).toBe("unverified");
    gate.submit(evidence, ready);
    expect(gate.status).toBe("ready");
    expect(gate.followUp()).toBeNull();
  });
  it.each(["artifactHash", "sourceHash"] as const)("invalidates changed %s", (key) => {
    const gate = new MotionReviewGate();
    gate.work();
    gate.submit(evidence, ready);
    gate.validate({ ...evidence, [key]: "c".repeat(64) });
    expect(gate.status).not.toBe("ready");
    expect(gate.armed).toBe(true);
  });
  it("invalidates readiness after observed edits even if the old MP4 remains", () => {
    const gate = new MotionReviewGate();
    gate.submit(evidence, ready);
    gate.work();
    expect(gate.status).not.toBe("ready");
  });
  it("returns concrete findings then a bounded honest draft outcome", () => {
    const gate = new MotionReviewGate("standard");
    gate.work();
    gate.submit(evidence, revise);
    expect(gate.followUp()).toContain("Focal object never moves");
    expect(gate.followUp()).toContain("Focal object never moves");
    expect(gate.followUp()).toContain("draft");
    expect(gate.followUp()).toBeNull();
    expect(gate.status).not.toBe("ready");
  });
  it.each([
    null,
    {},
    { status: "ready", findings: revise.findings },
    { status: "ready", findings: [], score: 10 },
    { status: "unknown", findings: [] },
  ])("never passes malformed verdicts (%#)", (value) => {
    expect(parseMotionVerdict(value).status).toBe("unverified");
  });
  it("does not turn unsupported vision into a pass", () => {
    const gate = new MotionReviewGate();
    gate.work();
    gate.submit(evidence, { status: "unverified", findings: [] });
    expect(gate.status).toBe("unverified");
    expect(gate.followUp()).toContain("unverified");
  });
});
