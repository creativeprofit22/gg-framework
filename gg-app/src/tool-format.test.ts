import { describe, expect, it } from "vitest";
import { buildToolLineParts } from "./tool-format";

describe("tool-call display identity", () => {
  it("renders an exact MCP source label instead of humanizing an opaque provider alias", () => {
    const parts = buildToolLineParts(
      "mcp__id__opaquehash",
      { query: "needle" },
      {
        done: false,
        displayName: "server name / tool:name",
      },
    );

    expect(parts[0]).toEqual({
      text: "server name / tool:name",
      bold: true,
      tone: "web",
    });
    expect(parts[parts.length - 1]).toEqual({ text: "…" });
    expect(parts.map((part) => part.text).join(" ")).not.toContain("Id opaquehash");
  });

  it("continues using the provider alias for tone and detail dispatch", () => {
    const parts = buildToolLineParts(
      "mcp__kencode-search__searchCode",
      { query: "provider-safe identity" },
      { done: false, displayName: "kencode-search / searchCode" },
    );

    expect(parts[0]).toEqual({
      text: "kencode-search / searchCode",
      bold: true,
      tone: "search",
    });
    expect(parts[1]).toEqual({ text: ' "provider-safe identity"' });
  });
});

describe("bash tool summary", () => {
  const summaryOf = (result: string, details?: unknown): string | undefined => {
    const parts = buildToolLineParts(
      "bash",
      { command: "pnpm build" },
      { done: true, result, details },
    );
    return parts.find((part) => part.dim)?.text;
  };

  it.each([
    {
      label: "backgrounded hand-off with task id",
      result: "Still running after 30s — moved to background task bg-7 …",
      details: { bashDiagnostics: { reason: "backgrounded", backgroundTaskId: "bg-7" } },
      expected: " · moved to background bg-7",
    },
    {
      label: "backgrounded hand-off without task id",
      result: "Still running after 30s",
      details: { bashDiagnostics: { reason: "backgrounded", backgroundTaskId: null } },
      expected: " · moved to background",
    },
    {
      label: "inactive stop",
      result: "Exit code: none\nNo output for 120s",
      details: { bashDiagnostics: { reason: "inactive", backgroundTaskId: null } },
      expected: " · stopped: no output",
    },
    {
      label: "normal exit with diagnostics",
      result: "Exit code: 0\nok",
      details: { bashDiagnostics: { reason: "completed", backgroundTaskId: null } },
      expected: " · exit 0",
    },
    {
      label: "normal exit without details",
      result: "Exit code: 2\nfailed",
      details: undefined,
      expected: " · exit 2",
    },
  ])("summarizes $label", ({ result, details, expected }) => {
    // Arrange/Act
    const summary = summaryOf(result, details);
    // Assert
    expect(summary).toBe(expected);
  });
});
