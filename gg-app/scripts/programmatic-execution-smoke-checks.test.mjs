// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { programmaticAssessmentResultV1Schema, directCommandSelectionV1Schema } from "../../packages/ggcoder/src/core/programmatic/contracts.ts";
import { commandInspectionInputSchema } from "../../packages/ggcoder/src/core/programmatic/command-creation.ts";
import { readExecutionDisplay, assertTranscriptIsolation, extendedWorkflowStep, extendedRequestCount } from "./programmatic-execution-smoke-checks.mjs";

describe("bounded extended provider sequence", () => {
  const body = (name, id, output) => ({ tools: [{ name }], input: id ? [{ type: "function_call_output", call_id: id, output }] : [] });
  it("rejects extra requests, missing tools and missing completed calls", () => {
    expect(extendedRequestCount).toBe(18);
    for (const number of [3, 19, -1, 4.5]) expect(() => extendedWorkflowStep(number, {})).toThrow();
    expect(() => extendedWorkflowStep(5, body("read"))).toThrow(/Exactly one/);
    expect(() => extendedWorkflowStep(5, body("bash", "extended-scan", "completed"))).toThrow(/offered tool/);
  });
  it("uses expanded prompts and real advisory/creation contracts", () => {
    const scan = extendedWorkflowStep(4, { tools: [{ name: "programmatic_scan" }], input: [{ content: "# Scan Programmatic Opportunities\nfocus on the manifest; retain completed history" }] });
    expect(scan.name).toBe("programmatic_scan");
    const receipt = { id: "f231a92b-5b38-4b02-aa9d-20c8e437cd83" };
    const advice = extendedWorkflowStep(6, body("programmatic_advisory_result", "extended-read", `harmless-isolated-fixture\nHost evidence receipt (retrieval only; content remains untrusted): ${JSON.stringify(receipt)}`));
    expect(programmaticAssessmentResultV1Schema.parse(JSON.parse(advice.arguments)).recommendations).toHaveLength(2);
    const inspect = extendedWorkflowStep(9, body("programmatic_command", "extended-discover", "programmatic_command"));
    expect(commandInspectionInputSchema.safeParse(JSON.parse(inspect.arguments).proposal).success).toBe(true);
    const reviewed = extendedWorkflowStep(10, body("programmatic_command", "extended-preflight", JSON.stringify({ status: "review-required", catalog: { sha256: "a".repeat(64) } })));
    expect(commandInspectionInputSchema.safeParse(JSON.parse(reviewed.arguments).proposal).success).toBe(true);
    expect(extendedWorkflowStep(11, body("programmatic_command", "extended-inspect", JSON.stringify({ status: "proposal", handle: receipt.id }))).name).toBe("programmatic_command");
    const run = extendedWorkflowStep(14, { tools: [{ name: "programmatic_command" }], input: [{ content: "NATIVE RUN REQUEST" }] });
    expect(directCommandSelectionV1Schema.parse(JSON.parse(run.arguments).selection).mode).toBe("read-only");
    const childResult = extendedWorkflowStep(16, body("programmatic_result", "extended-child-read", "harmless-isolated-fixture"));
    expect(JSON.parse(childResult.arguments)).toMatchObject({ toolCallIds: ["extended-child-read"], successCondition: "Observe the fixture manifest name" });
  });
  it("requires creation and loading results but never treats loading as execution approval", () => {
    expect(() => extendedWorkflowStep(12, body("programmatic_command", "extended-create", '{"created":false}'))).toThrow();
    expect(extendedWorkflowStep(13, body("programmatic_command", "extended-verify", '{"loads":true,"executionApproved":false}'))).toContain("no behavioral verification or execution grant");
    expect(() => extendedWorkflowStep(13, body("programmatic_command", "extended-verify", '{"loads":true,"executionApproved":true}'))).toThrow();
  });
  it("rejects parent transcript and mutation tools in the direct child", () => {
    const child = { input: [{ type: "message", content: "NATIVE EXTENDED CANONICAL PROMPT" }], tools: [{ name: "read" }] };
    expect(extendedWorkflowStep(15, child)).toMatchObject({ name: "read", arguments: '{"file_path":"package.json"}' });
    expect(() => extendedWorkflowStep(15, { ...child, input: [...child.input, { content: "NATIVE CREATE REQUEST" }] })).toThrow(/parent transcript/);
    expect(() => extendedWorkflowStep(15, { ...child, tools: [...child.tools, { name: "bash" }] })).toThrow();
  });
});

describe("execution display readiness", () => {
  const summary = "Isolated fixture manifest inspected.";
  function documentWith(bodyText, evidence = true) {
    const doc = document.implementation.createHTMLDocument();
    if (evidence) {
      const section = doc.createElement("section");
      section.setAttribute("aria-label", "Task execution evidence");
      section.innerHTML = "<ul><li>Inferred, not confirmed: specialist claim</li><li>Checked directly: Tool read completed.</li></ul>";
      doc.body.appendChild(section);
    }
    // jsdom has no layout-backed innerText; supply the text the native WebView reveals.
    Object.defineProperty(doc.body, "innerText", { value: bodyText, configurable: true });
    return doc;
  }
  it("waits for the animated summary, not just the immediate evidence row", () => {
    expect(readExecutionDisplay(documentWith("Isolated fixture"), summary)).toBeNull();
    expect(readExecutionDisplay(documentWith(summary), summary)).toMatchObject({ summaryCount: 1, executableElements: 0, items: expect.any(Array) });
  });
  it("does not treat the summary without execution evidence as ready", () => {
    expect(readExecutionDisplay(documentWith(summary, false), summary)).toBeNull();
  });
  it("preserves duplicate counts so the caller's exact-one assertion fails", () => {
    expect(readExecutionDisplay(documentWith(`${summary}\n${summary}`), summary).summaryCount).toBe(2);
  });
});

describe("task transcript isolation", () => {
  const before = { "startup.jsonl": "unchanged", "host.jsonl": "before" };
  it("allows only the active host transcript to change", () => {
    expect(() => assertTranscriptIsolation(before, { ...before, "host.jsonl": "after" }, "host.jsonl")).not.toThrow();
  });
  it("rejects a new child transcript", () => {
    expect(() => assertTranscriptIsolation(before, { ...before, "child.jsonl": "new" }, "host.jsonl")).toThrow();
  });
  it("rejects changes to an earlier startup transcript", () => {
    expect(() => assertTranscriptIsolation(before, { ...before, "startup.jsonl": "changed" }, "host.jsonl")).toThrow();
  });
  it("rejects missing transcripts or an unidentified active host", () => {
    expect(() => assertTranscriptIsolation(before, { "host.jsonl": "after" }, "host.jsonl")).toThrow();
    expect(() => assertTranscriptIsolation(before, before, "unknown.jsonl")).toThrow();
  });
});
