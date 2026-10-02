// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitHubCI } from "./agent";

vi.mock("./agent", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
import { openUrl } from "./agent";
import { CIIndicator } from "./CIIndicator";

const running: GitHubCI = {
  key: "repo:commit:123.1",
  url: "https://github.com/owner/repo/actions/runs/123",
  total: 6,
  completed: 4,
  failed: 0,
  active: true,
  conclusion: null,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CIIndicator", () => {
  it("hides absent CI and old completed history", () => {
    const { rerender } = render(<CIIndicator />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CIIndicator ci={{ ...running, active: false, conclusion: "success" }} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CIIndicator ci={{ ...running, active: false, conclusion: "failure", failed: 1 }} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows job progress and opens the run", () => {
    render(<CIIndicator ci={running} />);
    fireEvent.click(screen.getByText("CI 4/6"));
    expect(openUrl).toHaveBeenCalledWith(running.url);
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("running");
    expect(screen.queryByLabelText("Dismiss CI failure")).toBeNull();
  });

  it("shows queued CI before jobs are created", () => {
    render(<CIIndicator ci={{ ...running, total: 0, completed: 0 }} />);
    expect(screen.getByText("CI queued")).toBeDefined();
  });

  it("shows success for ten seconds, without resetting on identical poll updates", () => {
    vi.useFakeTimers();
    const { rerender } = render(<CIIndicator ci={running} />);
    const passed: GitHubCI = { ...running, active: false, completed: 6, conclusion: "success" };
    rerender(<CIIndicator ci={passed} />);
    expect(screen.getByText("CI 6/6 passed")).toBeDefined();
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("passed");
    act(() => vi.advanceTimersByTime(9000));
    rerender(<CIIndicator ci={{ ...passed }} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CIIndicator ci={{ ...passed }} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps failures until dismissed and shows a rerun again", () => {
    vi.useFakeTimers();
    const { rerender } = render(<CIIndicator ci={running} />);
    const failure: GitHubCI = { ...running, failed: 1, active: false, conclusion: "failure" };
    rerender(<CIIndicator ci={failure} />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("failed");
    fireEvent.click(screen.getByLabelText("Dismiss CI failure"));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CIIndicator ci={{ ...failure }} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CIIndicator ci={{ ...running, key: "repo:commit:123.2" }} />);
    expect(screen.getByText("CI 4/6")).toBeDefined();
  });

  it("shows failed jobs in red while other jobs keep running", () => {
    render(<CIIndicator ci={{ ...running, failed: 1 }} />);
    expect(screen.getByText("CI 4/6 failed")).toBeDefined();
    expect(screen.queryByLabelText("Dismiss CI failure")).toBeNull();
  });

  it("hides the previous commit and never marks unavailable updates as passing", () => {
    const { rerender } = render(<CIIndicator ci={running} />);
    rerender(<CIIndicator ci={{ ...running, stale: true }} />);
    expect(screen.getByText("CI unavailable")).toBeDefined();
    rerender(<CIIndicator ci={null} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <CIIndicator ci={{ ...running, key: "new-commit", active: false, conclusion: "success" }} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shimmers only while running; pass and fail render static colored text", () => {
    const { rerender, container } = render(<CIIndicator ci={running} />);
    expect(container.querySelector(".shimmer-text")).not.toBeNull();
    rerender(
      <CIIndicator ci={{ ...running, active: false, completed: 6, conclusion: "success" }} />,
    );
    expect(container.querySelector(".shimmer-text")).toBeNull();
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("passed");
    rerender(<CIIndicator ci={{ ...running, failed: 1, active: false, conclusion: "failure" }} />);
    expect(container.querySelector(".shimmer-text")).toBeNull();
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("failed");
    // A job failing mid-run drops the shimmer immediately.
    rerender(<CIIndicator ci={{ ...running, failed: 1 }} />);
    expect(container.querySelector(".shimmer-text")).toBeNull();
  });

  it("does not paint a cancelled run green", () => {
    vi.useFakeTimers();
    const { rerender } = render(<CIIndicator ci={running} />);
    rerender(<CIIndicator ci={{ ...running, active: false, conclusion: "cancelled" }} />);
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("stopped");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
