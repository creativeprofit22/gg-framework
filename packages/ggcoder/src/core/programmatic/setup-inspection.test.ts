import { expect, it } from "vitest";
import { z } from "zod";
import { ProgrammaticSetupInspection, guardSetupInspectionTools } from "./setup-inspection.js";
import { createMcpToolIdentity, withMcpToolIdentity } from "../mcp/tool-identity.js";

it("new assessment scope rejects MCP aliases, arbitrary discovery and stale registrations", async () => {
  const scope = new ProgrammaticSetupInspection(true);
  const read = { name: "read", description: "Fixture", parameters: z.object({}), execute: async () => "read" };
  const identity = createMcpToolIdentity("fixture", "read");
  const mcp = withMcpToolIdentity({ ...read, name: identity.providerName }, identity);
  mcp.name = "read";
  const tools = [read, mcp];
  const guarded = guardSetupInspectionTools(scope, () => tools);
  expect(guarded).toHaveLength(1);
  expect(() => scope.claim(mcp, {})).toThrow("inspect-only");
  for (const name of ["tool_search", "programmatic_scan", "bash", "write", "edit", "programmatic_command_create", "programmatic_execute"])
    expect(scope.allows(name)).toBe(false);
  tools.splice(0, 1);
  expect(() => guarded[0]!.execute({}, { signal: new AbortController().signal, toolCallId: "stale" })).toThrow("registration changed");
  scope.close();
  expect(scope.allows("read")).toBe(false);
});

it("keeps legacy setup installation narrow until step 5 explicitly adopts the new owner", () => {
  const scope = new ProgrammaticSetupInspection();
  expect(scope.allows("read")).toBe(false);
  expect(scope.allows("programmatic_profile")).toBe(true);
});
