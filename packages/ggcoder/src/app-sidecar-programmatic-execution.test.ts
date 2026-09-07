import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { RunLifecycle } from "./core/run-lifecycle.js";
import { createRunEndPayload } from "@kenkaiiii/gg-core/desktop-session-ux";
import type { ProgrammaticExecutionOutcome } from "./core/programmatic/execution.js";
import { executionResultV1Schema } from "./core/programmatic/contracts.js";
import { handleAppSidecarProgrammaticExecution, parseProgrammaticRunSelection, settleProgrammaticRun } from "./app-sidecar-programmatic-execution.js";

const text = `/programmatic-run ${"a".repeat(64)} ${"b".repeat(64)}`;
function outcome(status: ProgrammaticExecutionOutcome["status"]): ProgrammaticExecutionOutcome {
  if (status === "rejected") return { version: 1, status, reason: "approval-rejected" };
  return executionResultV1Schema.parse({
    version: 1, status, summary: "Bounded specialist summary.",
    route: {
      version: 1, status: "routable", opportunityId: "a".repeat(64),
      configurationFingerprint: { version: 1, sha256: "b".repeat(64) },
      specialistCommand: "setup-sweep", arguments: [], evidencePaths: ["package.json"], scopePaths: ["package.json"],
      successCondition: "Inspect the manifest.", mutates: true, reason: "Fixture route.",
      availability: { status: "available", source: "built-in", portability: "bundled" },
    },
    evidence: { version: 1, items: [{ basis: "observed", source: "programmatic-execution", code: "tool-completed", severity: "info", message: "Tool read completed (manifest)." }] },
  });
}
function host() {
  return {
    text, attachmentCount: 0, busy: false, automated: false, codeMode: true,
    claimStart: vi.fn(() => true), respond: vi.fn(),
    runAgent: vi.fn(async (_label: string, run: () => Promise<ProgrammaticExecutionOutcome>) => { await run(); }),
    execute: vi.fn(async () => outcome("succeeded")),
  };
}
describe("explicit single-opportunity app command", () => {
  it("keeps the app adapter out of lifecycle storage", async () => {
    const adapter = await readFile(new URL("./app-sidecar-programmatic-execution.ts", import.meta.url), "utf8");
    expect(adapter).toContain("options.claimStart()");
    expect(adapter).toContain("options.runAgent(");
    expect(adapter).not.toMatch(/new AgentSession|writeFile|rename|setTimeout|agentLoop|spawn\(/);
  });
  it("carries the specialist outcome into parent settlement", async () => {
    const sidecar = await readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    expect(sidecar).toContain("programmaticSettlement = settleProgrammaticRun(await run())");
    expect(sidecar).toContain("runSucceeded = programmaticSettlement?.succeeded ?? true");
    expect(sidecar).toContain("programmaticSettlement?.journalOutcome ??");
    expect(sidecar).toContain("...programmaticSettlement?.event,");
    expect(sidecar).toContain('runOutcome: cancelled ? "cancelled" : runSucceeded && !verificationProblem ? "succeeded" : "failed"');
    const execute = sidecar.slice(sidecar.indexOf("execute: async (selection)"), sidecar.indexOf("if (handledProgrammatic) return"));
    expect(execute).toContain("return result;");
    expect(execute).toContain("cancelQuestions: () => asks.cancelAll()");
  });
  it.each([
    ["succeeded", "completed", {}],
    ["failed", "failed", {}],
    ["blocked", "unverified", { unverified: true }],
    ["cancelled", "aborted", { cancelled: true }],
    ["rejected", "aborted", { cancelled: true }],
  ] as const)("settles structured %s in the parent journal and run_end", async (status, journalOutcome, flags) => {
    const options = host();
    const result = outcome(status);
    options.execute.mockResolvedValue(result);
    const journal = { started: vi.fn(), finished: vi.fn() };
    const lifecycle = new RunLifecycle(undefined, journal);
    const broadcast = vi.fn();
    options.runAgent.mockImplementation(async (_label, run) => {
      const { generation } = lifecycle.begin(() => {});
      const settlement = settleProgrammaticRun(await run())!;
      expect(settlement.succeeded).toBe(status === "succeeded");
      lifecycle.settle(generation, settlement.journalOutcome);
      broadcast("run_end", { ...settlement.event, ...createRunEndPayload(settlement.journalOutcome, lifecycle.state) });
    });
    await handleAppSidecarProgrammaticExecution(options);
    expect(journal.finished).toHaveBeenCalledExactlyOnceWith(1, journalOutcome);
    const { route: _route, ...bounded } = "route" in result ? result : { ...result, route: undefined };
    expect(broadcast).toHaveBeenCalledExactlyOnceWith("run_end", { ...flags, outcome: journalOutcome === "aborted" ? "cancelled" : journalOutcome, programmaticResult: bounded, runState: "idle" });
  });
  it.each(["succeeded", "failed", "blocked"] as const)("cancellation after a %s result still journals aborted", async (status) => {
    const journal = { started: vi.fn(), finished: vi.fn() };
    const lifecycle = new RunLifecycle(undefined, journal);
    const { generation } = lifecycle.begin(() => {});
    const settlement = settleProgrammaticRun(outcome(status))!;
    const cancellation = lifecycle.cancel(1000);
    expect(lifecycle.settle(generation, settlement.journalOutcome)).toEqual({ settled: true, cancelled: true });
    await cancellation;
    expect(journal.finished).toHaveBeenCalledExactlyOnceWith(generation, "aborted");
    expect(lifecycle.state).toBe("idle");
  });
  it("leaves ordinary void callbacks on the existing parent path", () => {
    expect(settleProgrammaticRun(undefined)).toBeUndefined();
  });
  it("dispatches exactly one selection after a synchronous run claim", async () => {
    const options = host();
    expect(await handleAppSidecarProgrammaticExecution(options)).toBe(true);
    expect(options.execute).toHaveBeenCalledExactlyOnceWith({ opportunityId: "a".repeat(64), configurationSha256: "b".repeat(64) });
    expect(options.claimStart.mock.invocationCallOrder[0]).toBeLessThan(options.execute.mock.invocationCallOrder[0]!);
  });
  it.each([`${text} extra`, `${text}\n${text}`, "/PROGRAMMATIC-RUN a b", "/programmatic-run research", "/programmatic-run"]) ("rejects invalid selection %s", (value) => {
    expect(parseProgrammaticRunSelection(value)).toBe("invalid");
  });
  it.each([{ busy: true }, { attachmentCount: 1 }, { automated: true }, { codeMode: false }])("rejects without dispatch: %o", async (override) => {
    const options = { ...host(), ...override };
    await handleAppSidecarProgrammaticExecution(options);
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.claimStart).not.toHaveBeenCalled();
  });
  it("does not reinterpret ordinary text or a second owner's claim", async () => {
    const options = host();
    options.text = "ordinary text";
    expect(await handleAppSidecarProgrammaticExecution(options)).toBe(false);
    options.text = text;
    options.claimStart.mockReturnValue(false);
    await handleAppSidecarProgrammaticExecution(options);
    expect(options.respond).toHaveBeenCalledWith(409, expect.anything());
    expect(options.execute).not.toHaveBeenCalled();
  });
});
