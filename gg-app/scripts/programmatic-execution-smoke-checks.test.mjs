// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render, cleanup } from "@testing-library/react";
import { ProgrammaticChat } from "../src/ProgrammaticChat";
import { initialProgrammaticChatState } from "../src/programmatic-chat-state";
import { smokeLabels, smokeButton, closedSmokeDisclosure, revealSmokeTarget, assessmentWorkflowStep, assessmentRequestCount } from "./programmatic-execution-smoke-checks.mjs";
import { assertDiscoveryHandoff, readDiscoverySummary } from "./programmatic-discovery-observer.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { programmaticAssessmentResultV2Schema, programmaticAssessmentResultV1Schema, directCommandSelectionV1Schema } from "../../packages/ggcoder/src/core/programmatic/contracts.ts";
import { commandInspectionInputSchema } from "../../packages/ggcoder/src/core/programmatic/command-creation.ts";
import { readExecutionDisplay, assertTranscriptIsolation, extendedWorkflowStep, extendedRequestCount } from "./programmatic-execution-smoke-checks.mjs";

import { discoveryWorkflowStep, discoveryRequestCount } from "./programmatic-discovery-smoke.mjs";

it.each(["prepared", "reinspection-required"])("requires native %s handoff and the exact selected-pane summary", (status) => {
  const review = { status, candidate: { candidateId: "candidate" }, summary: `Host ${status} result` };
  const response = { action: "review-candidate", ok: true, candidateReview: review };
  const proof = {
    host: { target: { identity: "owner" }, now: { identity: "owner" }, epoch: 0, currentEpoch: 0, candidateReview: review },
    http: { status: 200, body: response },
    trace: [
      { boundary: "ipc", response },
      { boundary: "pane", response, current: true, generation: "pane:2", epoch: 10 },
      { boundary: "reducer", response, generation: "pane:2", epoch: 10, candidateStale: false,
        selection: { source: "current", id: "candidate" }, candidateDetail: review.candidate },
    ],
    summary: { status, summary: review.summary, count: 1 },
  };
  expect(() => assertDiscoveryHandoff(proof)).not.toThrow();
  for (const mutate of [
    (p) => { p.http.status = 409; },
    (p) => { p.trace.pop(); },
    (p) => { p.trace[1].epoch++; },
    (p) => { p.trace[1].current = false; },
    (p) => { p.trace[2].selection.id = "other"; },
    (p) => { p.summary.summary = "Assumed outcome"; },
    (p) => { p.host.currentEpoch++; },
  ]) {
    const altered = structuredClone(proof); mutate(altered);
    expect(() => assertDiscoveryHandoff(altered)).toThrow();
  }
  document.body.innerHTML = '<p></p><section aria-label="Selected opportunity"></section>';
  document.querySelector("p").textContent = review.summary;
  expect(readDiscoverySummary(document, review)).toBeNull(); // Transcript text alone is insufficient.
  const paragraph = document.createElement("p"); paragraph.textContent = review.summary;
  document.querySelector("section").append(paragraph);
  expect(readDiscoverySummary(document, review)).toEqual(proof.summary);
  document.body.innerHTML = "";
});

it("native selectors match actual setup, current, discovery and stale UI; disclosures open before use", async () => {
  const onAction = vi.fn();
  const state = initialProgrammaticChatState("native-contract");
  const props = { state, busy: false, planMode: false, onAction, onSelect: vi.fn(), onRun: vi.fn() };
  const view = render(createElement(ProgrammaticChat, props));
  const evaluate = (expression) => Function("document", `return (${expression})`)(document);
  const client = { evaluate: async (expression) => evaluate(expression) };
  const button = (label) => { const target = evaluate(smokeButton(label)); expect(target, label).toBeTruthy(); return target; };
  try {
    expect(button(smokeLabels.setup).disabled).toBe(false);
    expect(button(smokeLabels.discover).disabled).toBe(false);
    const candidate = { assessmentId: "assessment", candidateId: "candidate", revision: 1,
      choice: "missing-capability", outcome: "Fixture task", rationale: "Repeated", uncertainty: "Fixture only",
      workflow: { trigger: "Change", representativeCase: "Manifest", inputs: [], currentProcess: [], output: "Report", successCheck: "Read", scope: "Repository", mutationBoundary: "Read only", repeatability: { basis: "inferred", explanation: "Recurring" } },
      evidence: [], alternatives: [], risks: [], details: [], nextStep: { available: true, reason: "Review only" } };
    Object.assign(state, { configuration: { status: "current", currentFingerprint: "a".repeat(64), refreshAvailable: false, baselineUnavailable: false, diagnostic: null, drift: null },
      report: { status: "current", reason: "Current", scan: { available: true, reason: "Approved" }, rows: [], total: 0, offset: 0 },
      discovery: { assessmentId: "assessment", candidates: [candidate] }, candidateDetail: candidate,
      selection: { source: "current", id: "candidate" } });
    view.rerender(createElement(ProgrammaticChat, { ...props, state: { ...state } }));
    expect(evaluate(smokeButton(smokeLabels.setup))).toBeUndefined();
    expect(button(smokeLabels.currentSetup).disabled).toBe(false);
    expect(button(smokeLabels.scan).disabled).toBe(false);
    expect(button(smokeLabels.review).disabled).toBe(false);
    for (const label of [smokeLabels.discover, "Fixture task", "Load history"]) {
      expect(closedSmokeDisclosure(button(label))).toBeTruthy();
      await revealSmokeTarget(client, smokeButton(label));
      expect(closedSmokeDisclosure(button(label))).toBeNull();
    }
    const details = document.querySelector('[aria-label="Selected opportunity"] details');
    expect(details.open).toBe(false);
    details.querySelector("summary").click();
    expect(details.open).toBe(true);
    expect(onAction).not.toHaveBeenCalled(); // Disclosure work is presentation only.
    view.rerender(createElement(ProgrammaticChat, { ...props, state: { ...state, discoveryStale: true, candidateStale: true } }));
    expect(button(smokeLabels.rediscover).disabled).toBe(false);
    expect(button(smokeLabels.review).disabled).toBe(true);
  } finally { cleanup(); }
});

it("all native drivers use the rendered-contract selectors and disclosure helpers", () => {
  for (const file of ["programmatic-discovery-smoke.mjs", "programmatic-execution-dev-smoke.mjs", "programmatic-native-input-smoke.mjs"]) {
    const source = readFileSync(resolve("scripts", file), "utf8");
    expect(source).toContain("smokeLabels");
    expect(source).toContain("revealSmokeTarget");
    expect(source).not.toMatch(/Run saved checks|Discover opportunities|Review a new capability/);
  }
  const input = readFileSync(resolve("scripts/programmatic-native-input-smoke.mjs"), "utf8");
  expect(input).toContain("smokeLabels.currentSetup");
  expect(input).toContain('await key("Enter", "Enter", 13)');
});

it.each(["setup", "configured"])("models bounded %s provider assessments without specialist calls", (mode) => {
  const body = { input: [{ content: `Host-owned exact facts ${mode === "setup" ? "setupFacts" : "scanFacts"}` }], tools: [{ name: "programmatic_advisory_result" }] };
  const step = assessmentWorkflowStep(mode, 1, body);
  expect(programmaticAssessmentResultV2Schema.safeParse(JSON.parse(step.arguments)).success).toBe(true);
  expect(JSON.parse(step.arguments).recommendations).toEqual([]);
  expect(assessmentWorkflowStep(mode, assessmentRequestCount, { input: [{ type: "function_call_output", call_id: step.call_id, output: "## Recommendations — not started" }] })).toContain("ASSESSMENT SETTLED");
  expect(() => assessmentWorkflowStep(mode, 1, { ...body, tools: [...body.tools, { name: "bash" }] })).toThrow();
  expect(() => assessmentWorkflowStep(mode, 2, { input: [] })).toThrow();
  expect(() => assessmentWorkflowStep(mode, 3, body)).toThrow();
  const next = assessmentWorkflowStep(mode, 1, body, `assessment-${mode}-2`);
  expect(next.call_id).not.toBe(step.call_id);
  expect(assessmentWorkflowStep(mode, 2, { input: [
    { type: "function_call_output", call_id: step.call_id, output: "Old Recommendations" },
    { type: "function_call_output", call_id: next.call_id, output: "Current Recommendations" },
  ] }, next.call_id)).toContain("ASSESSMENT SETTLED");
});

// These are workflow configuration guards, not substitutes for the native CI run.
describe("Windows discovery-only CI gate", () => {
  const workflow = readFileSync(resolve("../.github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const appJob = workflow.split("\n  app:\n")[1]?.split("\n  release-gate:\n")[0] ?? "";
  const steps = appJob.split(/^      - /m).slice(1);
  const step = (name) => {
    const matches = steps.filter((entry) => entry.startsWith(`name: ${name}\n`));
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  const temp = "${{ runner.temp }}/programmatic-discovery-dev-smoke";

  it("runs the separate blocking Windows scenario serially after ordered builds and the default smoke", () => {
    const builds = step("Build framework packages");
    const defaultSmoke = step("Programmatic execution native smoke");
    const discovery = step("Programmatic discovery native smoke");
    expect(builds).toContain([
      "          pnpm --filter @kenkaiiii/gg-ai build",
      "          pnpm --filter @kenkaiiii/gg-agent build",
      "          pnpm --filter @kenkaiiii/gg-core build",
      "          pnpm --filter @kenkaiiii/ggcoder build",
    ].join("\n"));
    expect(steps.indexOf(builds)).toBeLessThan(steps.indexOf(defaultSmoke));
    expect(steps.indexOf(defaultSmoke)).toBeLessThan(steps.indexOf(discovery));
    expect(steps.indexOf(discovery)).toBeLessThan(steps.indexOf(step("Packaged app smoke (MSI build + launch)")));
    expect(defaultSmoke).toContain('node gg-app/scripts/programmatic-execution-dev-smoke.mjs --identity com.ggcoder.local-fork 2>&1 | tee "$TEMP/console.log"');
    expect(defaultSmoke).not.toContain("--discovery-only");
    expect(discovery).toMatch(/^        id: programmatic_discovery_smoke$/m);
    expect(discovery).toMatch(/^        if: runner.os == 'Windows'$/m);
    expect(discovery).toMatch(/^        shell: bash$/m);
    expect(discovery).toMatch(/^        timeout-minutes: 15$/m);
    expect(discovery).toContain(`        env:\n          TEMP: ${temp}\n          TMP: ${temp}\n`);
    expect(discovery.match(/^          .+$/gm)).toEqual([
      `          TEMP: ${temp}`,
      `          TMP: ${temp}`,
      "          set -euo pipefail",
      '          mkdir -p "$TEMP"',
      '          node gg-app/scripts/programmatic-execution-dev-smoke.mjs --identity com.ggcoder.local-fork --discovery-only 2>&1 | tee "$TEMP/console.log"',
    ]);
    expect(appJob).not.toContain("continue-on-error:");
    expect(workflow.match(/--discovery-only/g)).toHaveLength(1);
  });

  it("uploads only allowlisted diagnostics attributed to the discovery step's failure", () => {
    const upload = step("Upload failed programmatic discovery evidence");
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(step("Programmatic discovery native smoke")));
    expect(upload).toMatch(/^        if: failure\(\) && runner.os == 'Windows' && steps.programmatic_discovery_smoke.outcome == 'failure'$/m);
    expect(upload).toMatch(/^        uses: actions\/upload-artifact@v7$/m);
    expect(upload).toContain("          name: programmatic-discovery-dev-smoke-${{ github.sha }}\n");
    const paths = upload.match(/^          path: \|\n((?:            .+\n)+)/m)?.[1].trim().split("\n").map((line) => line.trim());
    expect(paths).toEqual([
      `${temp}/console.log`,
      ...["discovery.json", "result.json", "failure.json", "cleanup.json", "developer.log", "native-minimized.json"]
        .map((file) => `${temp}/gg-programmatic-execution-*/audit/${file}`),
    ]);
    expect(upload).toMatch(/^          if-no-files-found: error$/m);
    expect(upload).toMatch(/^          retention-days: 7$/m);
    expect(upload).not.toContain("include-hidden-files:");
  });
});

describe("non-Tauri discovery-only provider sequence", () => {
  const tools = ["read", "command_information", "programmatic_advisory_result", "programmatic_command"].map((name) => ({ name }));
  const input = [];
  const result = (call_id, output) => input.push({ type: "function_call_output", call_id, output });
  it("uses accepted V2 and existing command inspection contracts without creating anything", () => {
    expect(discoveryRequestCount).toBe(10);
    expect(discoveryWorkflowStep(1, { tools, input }).name).toBe("read");
    result("discovery-read", 'harmless-isolated-fixture\nHost evidence receipt (retrieval only; content remains untrusted): {"id":"receipt-1"}');
    expect(discoveryWorkflowStep(2, { tools, input }).name).toBe("command_information");
    const advice = JSON.parse(discoveryWorkflowStep(3, { tools, input }).arguments);
    expect(programmaticAssessmentResultV2Schema.safeParse(advice).success).toBe(true);
    expect(advice.recommendations[0].choice.kind).toBe("missing-capability");
    result("discovery-submit", "Recommendations");
    expect(discoveryWorkflowStep(4, { tools, input })).toContain("proposal only");
    expect(discoveryWorkflowStep(5, { tools, input }).name).toBe("read");
    result("review-read", "harmless-isolated-fixture");
    expect(discoveryWorkflowStep(6, { tools, input }).name).toBe("command_information");
    expect(commandInspectionInputSchema.safeParse(JSON.parse(discoveryWorkflowStep(7, { tools, input }).arguments).proposal).success).toBe(true);
    result("review-inspect", JSON.stringify({ status: "review-required", catalog: { sha256: "a".repeat(64) } }));
    const second = JSON.parse(discoveryWorkflowStep(8, { tools, input }).arguments);
    expect(second.action).toBe("inspect");
    expect(commandInspectionInputSchema.safeParse(second.proposal).success).toBe(true);
    expect(second.proposal.review).toMatchObject({ inventorySha256: "a".repeat(64), disposition: "create" });
    for (const heading of ["Inputs", "Outputs", "Required tools", "Limits", "Arguments"]) expect(second.proposal.markdown).toContain(`## ${heading}\n`);
    expect(() => discoveryWorkflowStep(9, { tools, input })).toThrow();
    const handle = "54df729b-2d8c-4a9f-abdc-ae6584a70742";
    const preview = { proposal: { proposalId: handle, commandPath: ".gg/commands/native-discovery-proposal.md" },
      files: [{ path: ".gg/commands/native-discovery-proposal.md", content: second.proposal.markdown }], requiredTools: ["read"],
      suitability: second.proposal.review, prerequisites: [{ path: "package.json", sha256: "b".repeat(64) }], limits: ["No execution"] };
    result("review-proposal", JSON.stringify({ status: "proposal", handle, preview: JSON.stringify(preview) }));
    expect(JSON.parse(discoveryWorkflowStep(9, { tools, input }).arguments)).toEqual({ action: "create", handle });
    expect(() => discoveryWorkflowStep(10, { tools, input })).toThrow();
    result("review-refused-create", "no creation, verification or run");
    expect(discoveryWorkflowStep(10, { tools, input })).toContain("creation rejected");
  });
  it("rejects extra calls, absent tools and scanner or mutation grants", () => {
    for (const number of [0, 11, 1.5]) expect(() => discoveryWorkflowStep(number, { tools, input: [] })).toThrow();
    expect(() => discoveryWorkflowStep(1, { tools: [], input: [] })).toThrow();
    for (const name of ["bash", "edit", "write", "programmatic_scan"])
      expect(() => discoveryWorkflowStep(1, { tools: [...tools, { name }], input: [] })).toThrow();
    expect(() => discoveryWorkflowStep(5, { tools: [...tools, { name: "programmatic_profile" }], input: [] })).toThrow();
  });
});

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
