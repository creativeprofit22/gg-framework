import { describe, expect, it } from "vitest";
import { buildToolLineParts, getToolTone } from "./tool-format";

describe("roadmap_status tool presentation", () => {
  it("shows bounded phase detail while running", () => {
    const parts = buildToolLineParts(
      "roadmap_status",
      {
        phase_id: "phase-with-a-very-long-identifier-that-must-be-bounded-in-the-transcript",
        evidence: ["private test output"],
        proposed_references: [{ canonical_url: "https://example.com/private" }],
      },
      { done: false },
    );
    const text = parts.map((part) => part.text).join("");

    expect(text).toContain("Updating roadmap");
    expect(text.length).toBeLessThan(80);
    expect(text).not.toContain("private test output");
    expect(text).not.toContain("example.com");
    expect(getToolTone("roadmap_status")).toBe("state");
  });

  it("uses the completed verb without copying result content", () => {
    const parts = buildToolLineParts(
      "roadmap_status",
      { phase_id: "phase-23" },
      {
        done: true,
        result: JSON.stringify({ result: "committed", evidence: "do not display" }),
      },
    );

    expect(parts.map((part) => part.text).join("")).toBe("Updated roadmap phase-23");
  });
});
