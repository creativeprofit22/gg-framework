import { describe, expect, it } from "vitest";
import { isPromptSubmissionRejection } from "./desktop-session-ux.js";

describe("isPromptSubmissionRejection", () => {
  it.each([
    "invalid_programmatic_selection",
    "programmatic_execution_busy",
    "programmatic_execution_plan_mode",
    "command_input_not_allowed",
    "session_mutation_in_progress",
    "workflow_busy",
  ])("accepts the definite pre-execution code %s", (code) => {
    expect(isPromptSubmissionRejection({ category: "rejected", code, message: "Not sent." })).toBe(
      true,
    );
  });

  it.each([
    ["unlisted code", { category: "rejected", code: "session_busy", message: "Busy." }],
    ["unknown category", { category: "unknown", code: "workflow_busy", message: "Busy." }],
    ["empty message", { category: "rejected", code: "session_mutation_in_progress", message: " " }],
    ["control characters", { category: "rejected", code: "workflow_busy", message: "a\nb" }],
    [
      "oversized message",
      { category: "rejected", code: "workflow_busy", message: "x".repeat(257) },
    ],
    ["string failure", "session_mutation_in_progress"],
  ])("rejects %s", (_label, value) => {
    expect(isPromptSubmissionRejection(value)).toBe(false);
  });
});
