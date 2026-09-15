import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { ProgrammaticAdvisoryTools } from "./advisory-tools.js";
import { createMcpToolIdentity, withMcpToolIdentity } from "../mcp/tool-identity.js";
import { discoverCommands } from "../command-discovery.js";
import { buildProgrammaticAdvisoryContext } from "./advisory-context.js";
import { createCommandInformationTool } from "../../tools/command-information.js";

it.each(["success", "failure", "cancelled"])("shares the terminal scan settlement gate for %s", async (outcome) => {
  const cwd = process.cwd();
  const discovery = await discoverCommands(cwd, { readReadiness: async () => "missing" });
  let release!: (output: string) => void;
  const held = new Promise<string>((resolve) => { release = resolve; });
  const execute = vi.fn(() => held);
  const tools: AgentTool[] = [{ name: "programmatic_scan", description: "Held scanner boundary", parameters: z.strictObject({}), execute }, createCommandInformationTool(cwd)];
  const scope = new ProgrammaticAdvisoryTools(cwd, buildProgrammaticAdvisoryContext({ version: 1 }, discovery), () => tools);
  const controller = new AbortController();
  const context = { signal: controller.signal, toolCallId: "terminal-scan" };
  const scan = scope.tools.find((tool) => tool.name === "programmatic_scan")!;
  const result = scope.tools.find((tool) => tool.name === "programmatic_advisory_result")!;
  const assessment = { version: 1, kind: "advisory", coverage: { status: "complete", scope: "Fixture" }, recommendations: [] };
  try {
    await expect(result.execute(assessment, context)).rejects.toThrow("scan attempt must settle");
    const pending = scan.execute({}, context);
    await expect(result.execute(assessment, context)).rejects.toThrow("scan attempt must settle");
    if (outcome === "cancelled") controller.abort();
    const output = JSON.stringify({ ok: outcome === "success", error: outcome === "failure" ? { code: "scan-failed" } : undefined });
    release(output);
    expect(await pending).toBe(output);
    const freshContext = { ...context, signal: new AbortController().signal };
    if (outcome === "cancelled") await expect(result.execute(assessment, freshContext)).rejects.toThrow("denied or cancelled");
    else {
      const advice = await result.execute(assessment, freshContext);
      expect(advice).toContain("Recommendations — not started");
      if (outcome === "failure") expect(advice).toContain("deterministic scan failed");
    }
    await expect(scan.execute({}, freshContext)).rejects.toThrow("one unchanged");
    expect(execute).toHaveBeenCalledExactlyOnceWith({}, context);
  } finally { release("cleanup"); scope.close(); }
});

it("intersects host registrations, excludes MCP even with a read-only name, and closes in-flight evidence", async () => {
  const cwd = process.cwd();
  const discovery = await discoverCommands(cwd, { readReadiness: async () => "missing" });
  let release!: (value: string) => void;
  const held = new Promise<string>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const execute = vi.fn(() => {
    markStarted();
    return held;
  });
  const read: AgentTool = {
    name: "read",
    description: "Held read",
    parameters: z.object({}),
    execute,
  };
  const identity = createMcpToolIdentity("fixture", "web_search");
  const mcp = withMcpToolIdentity({ ...read, name: identity.providerName }, identity);
  // A later host alias must not erase the attached MCP provenance.
  mcp.name = "web_search";
  const tools = [read, mcp];
  const scope = new ProgrammaticAdvisoryTools(
    cwd,
    buildProgrammaticAdvisoryContext({ version: 1 }, discovery),
    () => tools,
  );
  const context = { signal: new AbortController().signal, toolCallId: "held-read" };
  try {
    expect(scope.tools.map((tool) => tool.name)).toEqual(["read"]);
    const pending = scope.tools[0]!.execute({}, context);
    await started;
    expect(execute).toHaveBeenCalledOnce();
    scope.close();
    release("late read content");
    expect(await pending).toBe("late read content");
    expect(scope.turn.evidence.list()).toEqual([]);
    await expect(scope.tools[0]!.execute({}, context)).rejects.toThrow("read-only advisory scope");
    tools.push(createCommandInformationTool(cwd));
    expect(scope.tools.some((tool) => tool.name === "programmatic_advisory_result")).toBe(false);
  } finally {
    release("cleanup");
    scope.close();
  }
});
