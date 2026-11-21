import { describe, expect, it } from "vitest";
import { serverScopeLabel } from "./mcp.js";

describe("serverScopeLabel", () => {
  it("labels the built-in server as built-in, not its storage scope", () => {
    expect(serverScopeLabel({ scope: "global", builtin: true })).toBe("built-in");
  });

  it("uses the scope for configured servers", () => {
    expect(serverScopeLabel({ scope: "project" })).toBe("project");
  });
});
