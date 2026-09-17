import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { isProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { AdvisoryReceipt } from "./advisory.js";
import { ProgrammaticAssessmentCoordinator } from "./assessment.js";
import { discoverCommands } from "../command-discovery.js";
import { buildProgrammaticAdvisoryContext } from "./advisory-context.js";

const result = { version: 2, kind: "advisory", coverage: { status: "complete", scope: "Fixture" }, recommendations: [] };
const toolContext = () => ({ signal: new AbortController().signal, toolCallId: "fixture" });
async function coordinator(mode: "setup" | "configured", tools: AgentTool[] = []) {
  const discovery = await discoverCommands(process.cwd(), { readReadiness: async () => "missing" });
  return new ProgrammaticAssessmentCoordinator(process.cwd(), buildProgrammaticAdvisoryContext({ version: 1 }, discovery), () => tools, { mode });
}
const tool = (name: string, output = "{}"): AgentTool => ({ name, description: name, parameters: z.object({}), execute: vi.fn(async () => output) });

it.each(["retrieved", "lead", "failed", "cancelled"] as const)("attributes external evidence to the exact delivered receipt, not the first %s URL match", async (status) => {
  const owner = await coordinator("setup");
  const url = "https://example.com/repo", later = "2026-09-16T00:00:01.000Z";
  const outcome = await owner.run(new AbortController().signal, async (scope) => {
    const receipt = (id: string, state: AdvisoryReceipt["status"], revision: string, path: string, retrievedAt: string): AdvisoryReceipt => ({
      id, status: state, tool: "research_corpus", toolCallId: id, retrievedAt,
      external: { tool: "steroids", toolCallId: id, sourceUri: url, revision, path },
    });
    scope.turn.evidence.retain(receipt("first", status, "revision-one", "src/first.ts", "2026-09-16T00:00:00.000Z"));
    scope.turn.evidence.retain(receipt("other-file", "retrieved", "revision-two", "src/first.ts", later));
    if (status !== "retrieved") scope.turn.evidence.retain(receipt("not-delivered", status, "revision-two", "src/second.ts", later));
    scope.turn.evidence.retain(receipt("matched", "retrieved", "revision-two", "src/second.ts", later));
    const citation = { kind: "external-reference", basis: "observed", inspectedUrl: url, revision: "revision-two", location: { path: "src/second.ts" }, claim: "External source" };
    const recommendation = { version: 2, kind: "advisory", outcome: "Review source", rationale: "Compare source", uncertainty: "Not verified",
      workflow: { trigger: "Source changes", representativeCase: "New entry", inputs: ["Source"], currentProcess: ["Read source"], output: "Report",
        successCheck: "Compare entries", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read only",
        repeatability: { basis: "inferred", explanation: "Source changes" } },
      choice: { kind: "manual", steps: ["Review separately"] }, alternatives: [], evidence: { version: 1, items: [citation, { ...citation, basis: "assumed" }] } };
    const submit = scope.tools.find((item) => item.name === "programmatic_advisory_result")!;
    await submit.execute({ ...result, recommendations: [recommendation] }, toolContext());
  });
  expect(outcome.assessment.status).toBe("completed");
  expect(outcome.assessment.observations).toEqual([{ basis: "observed", message: "External source", evidenceSources: ["matched"] }]);
  expect(outcome.captured?.observations[0]!.evidence[0]).toEqual({ basis: "observed", summary: "External source", retrievedAt: later,
    status: "delivered", freshness: "not-revalidated", external: { url, revision: "revision-two", location: { path: "src/second.ts" } } });
  expect(outcome.captured?.observations[0]!.evidence[1]).toMatchObject({ basis: "assumed", status: "lead" });
  expect(outcome.assessment.discovery?.candidates[0]).toMatchObject({ choice: "manual", nextStep: { available: false },
    evidence: [{ basis: "observed" }, { basis: "assumed" }] });
  expect(outcome.discoveryRecords?.[0]?.recommendation.choice.kind).toBe("manual");
  expect(JSON.stringify(outcome.assessment)).not.toContain("recommendation\":");
  expect(isProgrammaticAssessment(outcome.assessment)).toBe(true);
});

it("setup intersects local read/catalog/result and exact inspect-only profile; never grants mutation or discovery", async () => {
  const names = ["read", "find", "grep", "ls", "code_search", "code_nav", "command_information", "programmatic_profile", "programmatic_scan", "bash", "write", "edit", "tool_search", "web_fetch", "research_corpus", "programmatic_command_create"];
  const owner = await coordinator("setup", names.map((name) => tool(name)));
  expect(owner.scope.tools.map((item) => item.name).sort()).toEqual([...names.slice(0, 8), "programmatic_advisory_result"].sort());
  const profile = owner.scope.tools.find((item) => item.name === "programmatic_profile")!;
  await expect(profile.execute({ action: "generate" }, toolContext())).rejects.toThrow("inspect-only");
  await expect(profile.execute({ action: "inspect", mode: "configured" }, toolContext())).rejects.toThrow("inspect-only");
  await profile.execute({ action: "inspect" }, toolContext());
  await expect(profile.execute({ action: "inspect" }, toolContext())).rejects.toThrow("already inspected");
  expect(() => owner.scope.turn.claim("programmatic_scan", {})).toThrow("read-only");
  const outcome = await owner.run(new AbortController().signal);
  expect(outcome.assessment).toMatchObject({ mode: "setup", status: "unavailable", deterministic: { status: "not-run", reason: "setup" } });
  expect(isProgrammaticAssessment(outcome.assessment)).toBe(true);
  await expect(profile.execute({ action: "inspect" }, toolContext())).rejects.toThrow("read-only");
});

it.each(["setup", "configured"] as const)("%s can accept bounded advice without unavailable scan/catalog prerequisites and rejects mode spoofing", async (mode) => {
  const owner = await coordinator(mode);
  const outcome = await owner.run(new AbortController().signal, async (scope) => {
    const submit = scope.tools.find((item) => item.name === "programmatic_advisory_result")!;
    await expect(submit.execute({ ...result, mode: "configured" }, toolContext())).rejects.toThrow();
    await submit.execute(result, toolContext());
  });
  expect(outcome.assessment.status).toBe("completed");
  expect(outcome.assessment.deterministic.status).toBe(mode === "setup" ? "not-run" : "unavailable");
  expect(outcome.advice).toContain("No supported recommendation");
  expect(outcome.assessment.discovery?.candidates).toEqual([]);
  expect(outcome.discoveryRecords).toEqual([]);
  expect(isProgrammaticAssessment(outcome.assessment)).toBe(true);
});

it.each(["succeeded", "failed", "denied", "cancelled"] as const)("projects independent %s scan facts and enforces no retry", async (state) => {
  const scan = tool("programmatic_scan", JSON.stringify({ ok: state === "succeeded" }));
  const owner = await coordinator("configured", [scan]);
  const outcome = await owner.run(new AbortController().signal, async (scope) => {
    const scanner = scope.tools.find((item) => item.name === "programmatic_scan")!;
    const submit = scope.tools.find((item) => item.name === "programmatic_advisory_result")!;
    await expect(submit.execute(result, toolContext())).rejects.toThrow("scan attempt must settle");
    if (state === "denied" || state === "cancelled") {
      scope.turn.claim("programmatic_scan", {});
      scope.turn.settleScan(state);
      await expect(submit.execute(result, toolContext())).rejects.toThrow("denied or cancelled");
    } else {
      await scanner.execute({}, toolContext());
      await submit.execute(result, toolContext());
    }
    await expect(scanner.execute({}, toolContext())).rejects.toThrow("one unchanged");
    return { scanCounts: { enabledCount: 0, applicableCount: 0 } };
  });
  expect(outcome.assessment.deterministic.status).toBe(state);
  expect(outcome.assessment.status).toBe(state === "cancelled" ? "cancelled" : state === "denied" ? "incomplete" : "completed");
  expect(scan.execute).toHaveBeenCalledTimes(state === "denied" || state === "cancelled" ? 0 : 1);
  expect(isProgrammaticAssessment(outcome.assessment)).toBe(true);
});

it("projects control-free bounded text accepted by the browser contract without weakening advisory validation", async () => {
  const owner = await coordinator("setup");
  const controls = Array.from({ length: 160 }, (_, code) => code)
    .filter((code) => (code < 32 && ![9, 10, 13].includes(code)) || code >= 127)
    .map((code) => String.fromCharCode(code)).join("");
  const outcome = await owner.run(new AbortController().signal, async (scope) => {
    scope.turn.limitations.add(`Before${controls}After\tline\nnext\rend`);
    scope.turn.limitations.add(controls);
    scope.turn.limitations.add("x".repeat(4_001));
    const submit = scope.tools.find((item) => item.name === "programmatic_advisory_result")!;
    await expect(submit.execute({
      ...result, coverage: { status: "limited", scope: "Fixture", reason: `Bounded${controls} evidence` },
    }, toolContext())).rejects.toThrow("control characters");
    await submit.execute({
      ...result, coverage: { status: "limited", scope: "Fixture", reason: "Bounded evidence" },
    }, toolContext());
  });
  expect(outcome.assessment.status).toBe("completed");
  expect(outcome.assessment.limitations).toContain("BeforeAfter\tline\nnext\rend");
  expect(outcome.assessment.limitations).toContain("Unspecified limitation.");
  expect(outcome.assessment.limitations).toContain("x".repeat(4_000));
  expect(outcome.assessment.coverage.find((item) => item.scope === "catalog")?.summary).toContain("Bounded evidence");
  expect(isProgrammaticAssessment(outcome.assessment)).toBe(true);
});

it("host-disabled registered scan remains unavailable while advice is permitted", async () => {
  const scan = tool("programmatic_scan");
  const discovery = await discoverCommands(process.cwd(), { readReadiness: async () => "missing" });
  const owner = new ProgrammaticAssessmentCoordinator(process.cwd(), buildProgrammaticAdvisoryContext({ version: 1 }, discovery), () => [scan], { mode: "configured", scanAvailable: false });
  expect(owner.scope.tools.some((item) => item.name === "programmatic_scan")).toBe(false);
  const outcome = await owner.run(new AbortController().signal, async (scope) => {
    await scope.tools.find((item) => item.name === "programmatic_advisory_result")!.execute(result, toolContext());
  });
  expect(outcome.assessment).toMatchObject({ status: "completed", deterministic: { status: "unavailable" } });
  expect(scan.execute).not.toHaveBeenCalled();
  expect(isProgrammaticAssessment(outcome.assessment)).toBe(true);
});

it("cancellation stops the operation and closes scope without a callback or retry; ordinary provider failure is incomplete", async () => {
  const cancelled = await coordinator("setup");
  const controller = new AbortController(); controller.abort();
  const run = vi.fn();
  expect((await cancelled.run(controller.signal, run)).assessment.status).toBe("cancelled");
  expect(run).not.toHaveBeenCalled();
  await expect(cancelled.run(controller.signal, run)).rejects.toThrow("once-only");
  const failed = await coordinator("setup");
  const outcome = await failed.run(new AbortController().signal, async () => { throw new Error("secret"); });
  expect(outcome.assessment.status).toBe("incomplete");
  expect(outcome.assessment.discovery).toBeUndefined();
  expect(outcome.discoveryRecords).toBeUndefined();
  expect(JSON.stringify(outcome)).not.toContain("secret");
  expect(failed.scope.turn.active).toBe(false);
});
