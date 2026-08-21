// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveToolPanel, type LiveToolEntry } from "./LiveToolPanel";
import { theme } from "./theme";

afterEach(cleanup);

const entries: LiveToolEntry[] = [
  {
    toolCallId: "success-call",
    name: "mcp__id__success",
    displayName: "fixture / success",
    args: {},
    status: "done",
    isError: false,
    result: "ok",
  },
  {
    toolCallId: "thrown-call",
    name: "mcp__id__thrown",
    displayName: "fixture / thrown",
    args: {},
    status: "done",
    isError: true,
    result: "transport exploded",
  },
  {
    toolCallId: "reported-call",
    name: "mcp__id__reported",
    displayName: "fixture / reported",
    args: {},
    status: "done",
    isError: true,
    result: "server rejected the call",
  },
];

describe("LiveToolPanel completion status", () => {
  it("shows success, thrown failure, and MCP isError failure with accessible status text", () => {
    render(<LiveToolPanel entries={entries} />);

    const completedDot = screen.getByTitle("Completed");
    const failedDots = screen.getAllByTitle("Failed");
    const expectedSuccess = document.createElement("span");
    expectedSuccess.style.color = theme.success;
    const expectedError = document.createElement("span");
    expectedError.style.color = theme.error;
    expect(completedDot.style.color).toBe(expectedSuccess.style.color);
    expect(failedDots).toHaveLength(2);
    expect(failedDots.every((dot) => dot.style.color === expectedError.style.color)).toBe(true);

    expect(screen.getByText("Completed:").classList.contains("visually-hidden")).toBe(true);
    const failedText = screen.getAllByText("Failed:");
    expect(failedText).toHaveLength(2);
    expect(failedText.every((text) => text.classList.contains("visually-hidden"))).toBe(true);
    expect(screen.getByText("fixture / success")).toBeTruthy();
    expect(screen.getByText("fixture / thrown")).toBeTruthy();
    expect(screen.getByText("fixture / reported")).toBeTruthy();
  });
});
