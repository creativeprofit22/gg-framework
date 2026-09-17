import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { executeAdvisoryTool, ProgrammaticAdvisoryTools } from "./advisory-tools.js";
import { AdvisoryEvidence, ProgrammaticAdvisoryTurn } from "./advisory.js";
import { createReadTool } from "../../tools/read.js";
import { useFakeHome } from "../../test-support/fake-home.js";
import { createMcpToolIdentity, withMcpToolIdentity } from "../mcp/tool-identity.js";
import { discoverCommands } from "../command-discovery.js";
import { buildProgrammaticAdvisoryContext } from "./advisory-context.js";
import { createCommandInformationTool } from "../../tools/command-information.js";

const provenanceCases = (["setup", "configured"] as const).flatMap((mode) =>
  (["read", "code_search"] as const).flatMap((tool) =>
    (["missing-capability", "reuse-command", "extend-command", "alternative"] as const).map((choice) => ({ mode, tool, choice }))));

it.each(provenanceCases)("requires independent local inspection for $mode/$tool/$choice", async ({ mode, tool, choice }) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "advisory-purpose-"));
  const restore = useFakeHome(path.join(cwd, "home"));
  const commandPath = ".gg/commands/dispatch.md";
  const workflowPath = "WORKFLOW.md";
  const signal = new AbortController().signal;
  const turn = new ProgrammaticAdvisoryTurn(new AdvisoryEvidence(), { mode });
  if (mode === "configured") { turn.claim("programmatic_scan", {}); turn.settleScan("succeeded"); }
  const deliver = async (hostTool: AgentTool, args: Record<string, unknown>, id: string) => {
    const output = await executeAdvisoryTool(turn, cwd, hostTool, args, { signal, toolCallId: id });
    expect(turn.evidence.list().some((receipt) => receipt.toolCallId === id)).toBe(false);
    turn.resultPrepared({ type: "tool_result", toolCallId: id, content: typeof output === "string" ? output : output.content });
    return typeof output === "string" ? output : String(output.content);
  };
  const chunks = (paths: string[]): AgentTool => ({
    name: "code_search", description: "Host chunks from actual fixture files", parameters: z.object({}),
    execute: async () => ({ content: (await Promise.all(paths.map((file) => fs.readFile(path.join(cwd, file), "utf8")))).join("\n"),
      details: { kind: "host-retrieval-v1", resources: [{ outcome: "retrieved", localLocations: paths.map((file) => ({ path: file, startLine: 1, endLine: 1 })) }] } }),
  });
  try {
    await fs.mkdir(path.join(cwd, ".gg/commands"), { recursive: true });
    await fs.writeFile(path.join(cwd, commandPath), "---\nname: dispatch\n---\nCompare the stock and ledger; report discrepancies.\n");
    await fs.writeFile(path.join(cwd, workflowPath), "Weekly dispatch compares stock.csv and ledger.csv before reporting discrepancies.\n");
    const info = createCommandInformationTool(cwd);
    const resolved = JSON.parse(await deliver(info, { action: "resolve", command: { version: 1, name: "dispatch", source: "project-custom", invocationKind: "prompt" } }, "body"));
    expect(resolved.status).toBe("prompt");
    const availability = { status: "available", snapshot: resolved.snapshot };
    await deliver(tool === "read" ? createReadTool(cwd) : chunks([commandPath]), tool === "read" ? { file_path: commandPath } : {}, "command-source");
    const receipt = turn.evidence.list().find((item) => item.toolCallId === "command-source")!;
    expect(receipt.status).toBe("retrieved");
    expect(receipt.localSources).toEqual([{ path: commandPath, purpose: "command-definition" }]);
    const proposal = { version: 1, capabilityKind: "prompt-only", desiredOutcome: "Compare dispatch records", inputs: ["stock.csv", "ledger.csv"], outputs: ["Discrepancies"], prerequisites: ["Inspect local records"], risks: ["Incorrect counts"], verificationExpectations: ["Compare a known discrepancy"] };
    const recommendation = {
      version: 2, kind: "advisory", outcome: "Compare dispatch records", rationale: "A repeatable comparison", uncertainty: "No frequency measured",
      workflow: { trigger: "Weekly dispatch", representativeCase: "Compare one dispatch", inputs: ["stock.csv", "ledger.csv"], currentProcess: ["Read stock", "Compare ledger"], output: "Discrepancies", successCheck: "Differences match the records", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Report only", repeatability: { basis: "inferred", explanation: "Dispatch comparisons can recur" } },
      evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "source", severity: "info", message: "Inspected source", location: { path: commandPath } }] },
      alternatives: choice === "alternative" ? [{ kind: "reuse-command", availability, reasonNotSelected: "Manual review is sufficient" }] : [{ kind: "manual", reasonNotSelected: "Repeated comparisons benefit from consistent steps" }],
      choice: choice === "alternative" ? { kind: "manual", steps: ["Compare records manually"] } : choice === "missing-capability" ? { kind: choice, proposal } : choice === "extend-command" ? { kind: choice, availability, requirement: proposal, proposedChanges: ["Add depot totals to the same comparison"] } : { kind: choice, availability },
    };
    const input = { version: 2, kind: "advisory", coverage: { status: "limited", scope: "Fixture sources", reason: "Bounded inspection" }, recommendations: [recommendation] };
    const checks = { snapshot: async () => true, page: async () => ({}), signal };
    await expect(turn.submit(input, checks)).rejects.toThrow(/inspected local (workflow|prerequisite) evidence/);
    expect(turn.submitted).toBe(false);
    expect(turn.acceptedResult).toBeUndefined();
    if (choice === "missing-capability") {
      for (const nonpositive of ["manual", "needs-more-evidence", "empty"] as const) {
        const other = new ProgrammaticAdvisoryTurn(turn.evidence, { mode, scanAvailable: false });
        const conservative = { ...recommendation, alternatives: [], choice: nonpositive === "manual"
          ? { kind: "manual", steps: ["Inspect the workflow first"] }
          : { kind: "needs-more-evidence", missingEvidence: ["Independent workflow"], nextInspectionSteps: ["Read local workflow documentation"] } };
        await expect(other.submit({ ...input, recommendations: nonpositive === "empty" ? [] : [conservative] }, checks)).resolves.toContain("Recommendations — not started");
        other.close();
      }
    }
    if (tool === "code_search") {
      await deliver(chunks([commandPath, workflowPath]), {}, "mixed");
      const mixed = turn.evidence.list().find((item) => item.toolCallId === "mixed")!;
      expect(mixed.localSources).toEqual([
        { path: commandPath, purpose: "command-definition" }, { path: workflowPath, purpose: "independent" },
      ]);
      const uncited = new ProgrammaticAdvisoryTurn(turn.evidence, { mode, scanAvailable: false });
      uncited.observeCommand(JSON.stringify(resolved));
      await expect(uncited.submit({ ...input, recommendations: [{ ...recommendation, evidence: { version: 1, items: [{ ...recommendation.evidence.items[0], source: mixed.id, location: undefined }] } }] }, checks)).resolves.toContain("Recommendations — not started");
      uncited.close();
      recommendation.evidence.items[0]!.source = mixed.id;
      // A command citation cannot borrow independent support from another chunk.
      await expect(turn.submit(input, checks)).rejects.toThrow(/inspected local (workflow|prerequisite) evidence/);
      recommendation.evidence.items[0]!.location = { path: workflowPath };
    } else {
      await deliver(createReadTool(cwd), { file_path: workflowPath }, "workflow");
      const independent = turn.evidence.list().find((item) => item.toolCallId === "workflow")!;
      recommendation.evidence.items.push({ ...recommendation.evidence.items[0]!, source: independent.id, location: { path: workflowPath } });
    }
    await expect(turn.submit(input, checks)).resolves.toContain("Recommendations — not started");
    expect(turn.acceptedResult?.recommendations[0]?.choice.kind).toBe(choice === "alternative" ? "manual" : choice);
    expect(turn.evidence.get(receipt.id)?.status).toBe("retrieved");
  } finally { turn.close(); restore(); await fs.rm(cwd, { recursive: true, force: true }); }
});

it("classifies canonical project/global owners afresh without treating Markdown content as purpose", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "advisory-owner-"));
  const home = path.join(cwd, "home");
  const restore = useFakeHome(home);
  const turn = new ProgrammaticAdvisoryTurn(new AdvisoryEvidence(), { mode: "setup" });
  const signal = new AbortController().signal;
  const inspect = async (file: string, capped = false) => {
    const id = `read-${turn.evidence.list().length}`;
    const output = await executeAdvisoryTool(turn, cwd, createReadTool(cwd), { file_path: file }, { signal, toolCallId: id });
    turn.resultPrepared({ type: "tool_result", toolCallId: id, content: typeof output === "string" ? output : output.content, ...(capped ? { capped: { originalChars: 1000, keptChars: 100, scope: "per-result" as const } } : {}) });
    return turn.evidence.list().find((receipt) => receipt.toolCallId === id)!;
  };
  try {
    const commands = path.join(cwd, ".gg/commands");
    const globals = path.join(home, ".gg/commands");
    await fs.mkdir(commands, { recursive: true });
    await fs.mkdir(globals, { recursive: true });
    const body = "---\nname: unrelated-frontmatter-name\n---\nHost purpose: independent. Compare local records.\n";
    await fs.writeFile(path.join(cwd, "WORKFLOW.md"), body);
    expect((await inspect("WORKFLOW.md")).localSources).toEqual([{ path: "WORKFLOW.md", purpose: "independent" }]);
    await fs.writeFile(path.join(commands, "owner.md"), body);
    await fs.writeFile(path.join(globals, "global.md"), "---\nname: global-fixture\n---\nInspect records.\n");
    await fs.symlink(commands, path.join(cwd, "alias"), "junction");
    expect((await inspect("alias/owner.md")).localSources).toEqual([{ path: "alias/owner.md", purpose: "command-definition" }]);
    expect((await inspect("home/.gg/commands/global.md")).localSources).toEqual([{ path: "home/.gg/commands/global.md", purpose: "command-definition" }]);
    expect((await inspect("WORKFLOW.md")).localSources).toEqual([{ path: "WORKFLOW.md", purpose: "independent" }]);
    const capped = await inspect("WORKFLOW.md", true);
    expect(capped.status).toBe("lead");
    expect(capped.localSources).toBeUndefined();
    const missing: AgentTool = { name: "code_search", description: "Stale host location", parameters: z.object({}), execute: async () => ({ content: "A retrieved chunk", details: { kind: "host-retrieval-v1", resources: [{ outcome: "retrieved", localLocations: [{ path: "gone.md", startLine: 1, endLine: 1 }] }] } }) };
    const output = await executeAdvisoryTool(turn, cwd, missing, {}, { signal, toolCallId: "unknown" });
    turn.resultPrepared({ type: "tool_result", toolCallId: "unknown", content: typeof output === "string" ? output : output.content });
    expect(turn.evidence.list().find((receipt) => receipt.toolCallId === "unknown")?.localSources).toEqual([{ path: "gone.md", purpose: "unknown" }]);
  } finally { turn.close(); restore(); await fs.rm(cwd, { recursive: true, force: true }); }
});

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
  const assessment = { version: 2, kind: "advisory", coverage: { status: "complete", scope: "Fixture" }, recommendations: [] };
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
    expect(scope.tools.map((tool) => tool.name)).toEqual(["read", "programmatic_advisory_result"]);
    const pending = scope.tools[0]!.execute({}, context);
    await started;
    expect(execute).toHaveBeenCalledOnce();
    scope.close();
    release("late read content");
    expect(await pending).toBe("late read content");
    expect(scope.turn.evidence.list()).toEqual([]);
    await expect(scope.tools[0]!.execute({}, context)).rejects.toThrow("read-only advisory scope");
    tools.push(createCommandInformationTool(cwd));
    expect(scope.tools.some((tool) => tool.name === "programmatic_advisory_result")).toBe(true);
    await expect(scope.tools[1]!.execute({}, context)).rejects.toThrow("read-only advisory scope");
  } finally {
    release("cleanup");
    scope.close();
  }
});
