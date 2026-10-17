// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlanDecisionNotice, describePlanDecision, type PlanDecision } from "./PlanDecisionNotice";

afterEach(cleanup);

describe("describePlanDecision", () => {
  it.each<[PlanDecision, RegExp]>([
    ["accepted", /plan|building/i],
    ["feedback", /feedback|notes|plan/i],
    ["rejected", /rejected|shelved/i],
  ])("gives %s a stable line", (decision, pattern) => {
    const line = describePlanDecision(decision, "42");
    expect(line).toMatch(pattern);
    expect(describePlanDecision(decision, "42")).toBe(line);
  });
});

describe("PlanDecisionNotice", () => {
  it("shimmers with a working critter once accepted", () => {
    const { container } = render(<PlanDecisionNotice decision="accepted" variantKey="7" />);
    expect(container.querySelector(".shimmer-text")).not.toBeNull();
    expect(container.querySelector(".subagents-critter-working")).not.toBeNull();
  });

  it("stands still when rejected", () => {
    const { container } = render(<PlanDecisionNotice decision="rejected" variantKey="7" />);
    expect(container.querySelector(".shimmer-text")).toBeNull();
    expect(container.querySelector(".subagents-critter-stopped")).not.toBeNull();
  });
});
