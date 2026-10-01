import { describe, expect, it } from "vitest";
import { describeActionFailure, describeOpenFailure } from "./open-failure";

describe("describeOpenFailure with a session name", () => {
  it.each([
    [
      "pane 'p2' generation 4 was superseded",
      "Couldn’t open “Fix the login bug”. Please try again.",
      "pane 'p2' generation 4 was superseded",
    ],
    [
      "pane 'primary' failed to start: Not signed in.",
      "Couldn’t open “Fix the login bug”: Not signed in.",
      null,
    ],
    [
      "pane 'primary' did not start in time",
      "“Fix the login bug” took too long to start. Please try again.",
      "pane 'primary' did not start in time",
    ],
    ["project path missing", "Couldn’t open “Fix the login bug”: project path missing", null],
  ])("names the session for %j", (message, summary, detail) => {
    expect(describeOpenFailure(message, "Fix the login bug")).toEqual({ summary, detail });
  });

  it("truncates a long name to 60 characters with an ellipsis", () => {
    const long = "a".repeat(80);
    const { summary } = describeOpenFailure("", long);
    const quoted = /“(.*)”/.exec(summary)?.[1] ?? "";
    expect(quoted).toHaveLength(60);
    expect(quoted.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in the name", () => {
    expect(describeOpenFailure("", "  two\n  lines ").summary).toBe(
      "Couldn’t open “two lines”. Please try again.",
    );
  });

  it("falls back to 'this session' for a blank name", () => {
    expect(describeOpenFailure("", "   ").summary).toBe(
      "Couldn’t open this session. Please try again.",
    );
  });
});

describe("describeActionFailure", () => {
  it("keeps the raw reason under Details", () => {
    expect(describeActionFailure("add that projects folder", new Error("EACCES: denied"))).toEqual({
      summary: "Couldn’t add that projects folder. Please try again.",
      detail: "EACCES: denied",
    });
  });

  it("accepts non-Error reasons and drops an empty detail", () => {
    expect(describeActionFailure("load chats", "offline").detail).toBe("offline");
    expect(describeActionFailure("load chats", undefined)).toEqual({
      summary: "Couldn’t load chats. Please try again.",
      detail: null,
    });
  });
});
