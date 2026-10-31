// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VerifyPlanStatus } from "@kenkaiiii/gg-core/verify-plan";
import { VerifyPlanNotice, formatVerifyPlanArgv } from "./VerifyPlanNotice";

afterEach(cleanup);

const SHA = "c".repeat(64);
const pending: VerifyPlanStatus = {
  state: "needs-approval",
  reason: "plan command is not approved yet, so it is not run",
  argv: ["node", "scripts/verify plan.mjs", "--json"],
  cwd: "/work/repo",
  descriptorSha256: SHA,
};

describe("formatVerifyPlanArgv", () => {
  it("quotes only arguments that would be ambiguous", () => {
    expect(formatVerifyPlanArgv(["node", "a b", 'q"', "x"])).toBe('node "a b" "q\\"" x');
  });
});

describe("VerifyPlanNotice", () => {
  it("shows the exact command and cwd, and approves only the shown hash", async () => {
    const approveVerifyPlan = vi.fn(async () => ({
      ok: true as const,
      status: { state: "plan" as const, reason: null },
    }));
    render(
      <VerifyPlanNotice
        client={{ getVerifyPlanStatus: vi.fn(async () => pending), approveVerifyPlan }}
        refreshKey={0}
      />,
    );
    expect(await screen.findByText('node "scripts/verify plan.mjs" --json')).toBeTruthy();
    expect(screen.getByText("/work/repo").textContent).toBe("/work/repo");
    expect(approveVerifyPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(approveVerifyPlan).toHaveBeenCalledWith(SHA));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
  });

  it("says nothing ran when the descriptor changed before approval", async () => {
    const changed: VerifyPlanStatus = {
      ...pending,
      argv: ["node", "other.mjs"],
      descriptorSha256: "d".repeat(64),
    };
    render(
      <VerifyPlanNotice
        client={{
          getVerifyPlanStatus: vi.fn(async () => pending),
          approveVerifyPlan: vi.fn(async () => ({
            ok: false as const,
            reason: "changed" as const,
            status: changed,
          })),
        }}
        refreshKey={0}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /changed after you saw it, so nothing ran/,
    );
    expect(screen.getByText("node other.mjs")).toBeTruthy();
  });

  it("shows why a present plan fell back, and stays quiet without a descriptor", async () => {
    const { rerender } = render(
      <VerifyPlanNotice
        client={{
          getVerifyPlanStatus: vi.fn(async () => ({
            state: "heuristics" as const,
            reason: "plan command failed (exit 3)",
            descriptorPresent: true,
          })),
        }}
        refreshKey={0}
      />,
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /check command didn't work.*built-in checks/,
    );
    expect(screen.getByText("plan command failed (exit 3)")).toBeTruthy();
    const missing = vi.fn(async () => ({
      state: "heuristics" as const,
      reason: "no .gg/verify-plan.json descriptor",
      descriptorPresent: false,
    }));
    rerender(<VerifyPlanNotice client={{ getVerifyPlanStatus: missing }} refreshKey={1} />);
    await waitFor(() => expect(missing).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("hides the request for this view on Don't allow, running nothing", async () => {
    const approve = vi.fn();
    render(
      <VerifyPlanNotice
        client={{ getVerifyPlanStatus: vi.fn(async () => pending), approveVerifyPlan: approve }}
        refreshKey={0}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Don't allow" }));
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(approve).not.toHaveBeenCalled();
  });
});
