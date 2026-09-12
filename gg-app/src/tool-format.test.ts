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
