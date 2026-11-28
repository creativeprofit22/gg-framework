import { describe, expect, it, vi } from "vitest";
import type { VerifyPlanStatus } from "@kenkaiiii/gg-core/verify-plan";
import {
  parseVerifyPlanApproveBody,
  runVerifyPlanApproveRequest,
  runVerifyPlanStatusRequest,
  type VerifyPlanSession,
} from "./app-sidecar-verify-plan.js";

const SHA = "b".repeat(64);
const pending: VerifyPlanStatus = {
  state: "needs-approval",
  reason: "plan command is not approved yet, so it is not run",
  argv: ["node", "plan.mjs"],
  cwd: "/repo",
  descriptorSha256: SHA,
};

function session(overrides: Partial<VerifyPlanSession> = {}): VerifyPlanSession {
  return {
    getVerifyPlanStatus: vi.fn(async () => pending),
    approveVerifyPlan: vi.fn(async () => ({
      ok: true as const,
      status: { state: "plan" as const, reason: null },
    })),
    ...overrides,
  };
}

describe("app sidecar verify-plan routes", () => {
  it("reports the session's status, or 503 before the first load", async () => {
    await expect(runVerifyPlanStatusRequest(session())).resolves.toEqual({
      status: 200,
      body: pending,
    });
    await expect(
      runVerifyPlanStatusRequest(session({ getVerifyPlanStatus: vi.fn(async () => null) })),
    ).resolves.toMatchObject({ status: 503 });
  });

  it("approves only a well-formed hash and passes it through unchanged", async () => {
    expect(parseVerifyPlanApproveBody({ descriptorSha256: SHA })).toBe(SHA);
    expect(parseVerifyPlanApproveBody({ descriptorSha256: SHA.toUpperCase() })).toBeNull();
    expect(parseVerifyPlanApproveBody({})).toBeNull();
    const target = session();
    await expect(runVerifyPlanApproveRequest(target, { descriptorSha256: "x" })).resolves.toEqual({
      status: 400,
      body: { error: "descriptorSha256 must be 64 lowercase hex chars" },
    });
    expect(target.approveVerifyPlan).not.toHaveBeenCalled();
    await expect(runVerifyPlanApproveRequest(target, { descriptorSha256: SHA })).resolves.toEqual({
      status: 200,
      body: { ok: true, status: { state: "plan", reason: null } },
    });
    expect(target.approveVerifyPlan).toHaveBeenCalledWith(SHA);
  });

  it("returns a changed descriptor as an outcome and a save failure as 500", async () => {
    const changed = session({
      approveVerifyPlan: vi.fn(async () => ({
        ok: false as const,
        reason: "changed" as const,
        status: pending,
      })),
    });
    await expect(runVerifyPlanApproveRequest(changed, { descriptorSha256: SHA })).resolves.toEqual({
      status: 200,
      body: { ok: false, reason: "changed", status: pending },
    });
    const failing = session({
      approveVerifyPlan: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    await expect(runVerifyPlanApproveRequest(failing, { descriptorSha256: SHA })).resolves.toEqual({
      status: 500,
      body: { error: "Could not save the approval: disk full" },
    });
  });
});
