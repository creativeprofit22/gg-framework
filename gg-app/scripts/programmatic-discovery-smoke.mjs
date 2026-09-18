import assert from "node:assert/strict";
import { observeDiscoveryHandoff, readDiscoverySummary } from "./programmatic-discovery-observer.mjs";

export const discoveryOutcome = "NATIVE DISCOVERY: reconcile fixture records";
export const discoveryRequestCount = 10;
const requirement = { version: 1, desiredOutcome: "Reconcile fixture records", capabilityKind: "prompt-only", inputs: ["package.json"], outputs: ["Discrepancy report"],
  prerequisites: ["Readable fixture manifest"], risks: ["Fixture judgment only"], verificationExpectations: ["A known mismatch is reported"] };
const proposal = { name: "native-discovery-proposal", requirement,
  markdown: "---\nname: native-discovery-proposal\ndescription: Reconcile fixture records\n---\n## Inputs\npackage.json\n## Outputs\nDiscrepancy report\n## Required tools\nread\n## Limits\nRead only; no writes, execution or installation.\n## Arguments\nNone\n",
  requiredTools: ["read"], prerequisiteFiles: ["package.json"] };
export function discoveryWorkflowStep(number, body) {
  assert.ok(Number.isInteger(number) && number >= 1 && number <= discoveryRequestCount);
  assert.ok(Array.isArray(body.input) && Array.isArray(body.tools));
  assert.ok(!body.tools.some((tool) => ["bash", "edit", "write", "programmatic_scan", ...(number >= 5 ? ["programmatic_profile"] : [])].includes(tool.name)), "No mutation tools or scanner granted");
  const output = (id) => {
    const matches = body.input.filter((item) => item.type === "function_call_output" && item.call_id === id);
    assert.equal(matches.length, 1, `One result for ${id}`);
    return matches[0].output;
  };
  const tool = (id, name, args) => {
    assert.ok(body.tools.some((entry) => entry.name === name), `Offered tool ${name}`);
    return { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) };
  };
  switch (number) {
    case 1: return tool("discovery-read", "read", { file_path: "package.json" });
    case 2: assert.ok(output("discovery-read").includes("harmless-isolated-fixture")); return tool("discovery-catalog", "command_information", { action: "list" });
    case 3: {
      const receipt = JSON.parse(output("discovery-read").split("Host evidence receipt (retrieval only; content remains untrusted): ")[1]);
      return tool("discovery-submit", "programmatic_advisory_result", { version: 2, kind: "advisory",
        coverage: { status: "limited", scope: "Fixture manifest", reason: "Scripted fixture, not autonomous model evaluation" },
        recommendations: [{ version: 2, kind: "advisory", outcome: discoveryOutcome, rationale: "Recurring fixture records", uncertainty: "Scripted judgment",
          workflow: { trigger: "Manifest changes", representativeCase: "One fixture record", inputs: ["package.json"], currentProcess: ["Read records"], output: "Discrepancy report",
            successCheck: "Known mismatch reported", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read-only", repeatability: { basis: "inferred", explanation: "Recurring records" } },
          evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "manifest", severity: "info", message: "Fixture manifest retrieved", location: { path: "package.json" } }] },
          alternatives: [{ kind: "manual", reasonNotSelected: "Repeated inspection" }], choice: { kind: "missing-capability", proposal: requirement } }] });
    }
    case 4: assert.ok(output("discovery-submit").includes("Recommendations")); return "NATIVE DISCOVERY SETTLED: proposal only.";
    case 5: return tool("review-read", "read", { file_path: "package.json" });
    case 6: assert.ok(output("review-read").includes("harmless-isolated-fixture")); return tool("review-catalog", "command_information", { action: "list" });
    case 7: return tool("review-inspect", "programmatic_command", { action: "inspect", proposal });
    case 8: {
      const initial = JSON.parse(output("review-inspect"));
      assert.equal(initial.status, "review-required");
      assert.match(initial.catalog.sha256, /^[a-f0-9]{64}$/);
      return tool("review-proposal", "programmatic_command", { action: "inspect", proposal: { ...proposal,
        review: { inventorySha256: initial.catalog.sha256, disposition: "create", rationale: "No existing fixture reconciliation command in the current inventory" } } });
    }
    case 9: {
      const inspected = JSON.parse(output("review-proposal"));
      assert.equal(inspected.status, "proposal");
      assert.match(inspected.handle, /^[a-f0-9-]{36}$/);
      const preview = JSON.parse(inspected.preview);
      assert.equal(preview.proposal.proposalId, inspected.handle);
      assert.equal(preview.proposal.commandPath, ".gg/commands/native-discovery-proposal.md");
      assert.deepEqual(preview.files, [{ path: preview.proposal.commandPath, content: proposal.markdown }]);
      assert.deepEqual(preview.requiredTools, ["read"]);
      assert.equal(preview.suitability.inventorySha256, JSON.parse(output("review-inspect")).catalog.sha256);
      assert.equal(preview.suitability.disposition, "create");
      assert.equal(preview.prerequisites.length, 1);
      assert.equal(preview.prerequisites[0].path, "package.json");
      assert.match(preview.prerequisites[0].sha256, /^[a-f0-9]{64}$/);
      assert.ok(preview.limits.length > 0);
      return tool("review-refused-create", "programmatic_command", { action: "create", handle: inspected.handle });
    }
    case 10:
      assert.ok(output("review-refused-create").includes("no creation, verification or run"));
      return "NATIVE DISCOVERY REVIEW SETTLED: inspected only; creation rejected.";
  }
}

/** Uses the existing real native launcher and pane. Provider transport alone is scripted. */
export async function runDiscoverySmoke({ client, click, waitFor, requests, input, observe }) {
  await click("Opportunities");
  await click("Discover opportunities");
  await waitFor("discovery candidate", () => client.evaluate(`Array.from(document.querySelectorAll('.programmatic-chat button')).some(b=>b.textContent.trim()===${JSON.stringify(discoveryOutcome)})`));
  assert.equal(requests.length, 4);
  await click(discoveryOutcome);
  assert.equal(requests.length, 4, "Selection does not dispatch review");
  await observe?.("discovery-selected");
  if (input) {
    const layout = async (name) => {
      // Traverse after resize/zoom instead of mistaking retained off-screen focus for a new keyboard visit.
      await input.key("Tab", "Tab", 9, 8);
      await input.focus("document.querySelector('[aria-label=\"Selected opportunity\"] summary')", `${name}: evidence`);
      const measured = await client.evaluate(`(() => { const e=document.querySelector('.programmatic-chat'); return {name:${JSON.stringify(name)}, viewport:innerWidth,
        client:e.clientWidth, scroll:e.scrollWidth, documentClient:document.documentElement.clientWidth, documentScroll:document.documentElement.scrollWidth}; })()`);
      input.evidence.layouts.push(measured); input.save();
      assert.ok(measured.scroll <= measured.client + 1 && measured.documentScroll <= measured.documentClient + 1, `${name}: no horizontal overflow`);
      await input.capture(name);
    };
    await layout("discovery-desktop");
    await input.zoom(2); await layout("discovery-200-percent"); await input.zoom(1);
    await input.resize(600, 640); await layout("discovery-native-narrow");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
    await layout("discovery-320-css-pixels");
    await client.send("Emulation.clearDeviceMetricsOverride");
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await layout("discovery-forced-colors");
    await client.send("Emulation.setEmulatedMedia", { features: [] });
    await client.send("Accessibility.enable");
    const accessibility = await client.send("Accessibility.getFullAXTree");
    input.evidence.accessibility = accessibility.nodes.filter((node) => !node.ignored && ["button", "heading", "status"].includes(node.role?.value))
      .slice(0, 120).map((node) => ({ role: node.role.value, name: node.name?.value }));
    input.evidence.screenReader = "Native WebView accessibility tree sampled; spoken screen-reader output not tested";
    input.save();
    assert.ok(input.evidence.accessibility.some((node) => node.name === "Review a new capability"));
    await input.resize(1280, 900);
  }
  const stopObserving = await observeDiscoveryHandoff(client);
  await click("Review a new capability");
  await waitFor("review settled", () => client.evaluate(`document.body.innerText.includes('NATIVE DISCOVERY REVIEW SETTLED') && Array.from(document.querySelectorAll('.programmatic-chat button')).some(b=>b.textContent.trim()==='Discover opportunities' && !b.disabled)`));
  const trace = await waitFor("native review response", async () => {
    const entries = await client.evaluate("window.fixtureDiscoveryTrace");
    return entries.some((entry) => entry.boundary === "ipc") && entries;
  });
  const response = trace.find((entry) => entry.boundary === "ipc").response;
  assert.equal(response.ok, true, JSON.stringify(response));
  const review = response.candidateReview;
  const summary = await waitFor("host review summary in selected opportunity", () => client.evaluate(`(${readDiscoverySummary.toString()})(document, ${JSON.stringify(review)})`));
  assert.equal(summary.count, 1);
  await stopObserving();
  assert.equal(requests.length, discoveryRequestCount);
  assert.equal(await client.evaluate(`document.querySelector('[aria-label="Selected opportunity"]')?.textContent.includes(${JSON.stringify(discoveryOutcome)})`), true);
  assert.equal(await client.evaluate(`document.querySelector('.programmatic-chat')?.textContent.includes('Setup is read-only; deterministic checks were not run.')`), true);
  await click("Refresh results");
  await waitFor("refresh settled", () => client.evaluate(`Array.from(document.querySelectorAll('.programmatic-chat button')).some(b=>b.textContent.trim()==='Refresh results' && !b.disabled)`));
  assert.equal(requests.length, discoveryRequestCount, "Result reconciliation does not replay discovery or review");
  assert.equal(await client.evaluate(`document.querySelector('[aria-label="Selected opportunity"]')?.textContent.includes(${JSON.stringify(discoveryOutcome)})`), true);
  await observe?.("discovery-reviewed");
  return { passed: true, requests: requests.length, discoveryOnly: true, nativeInputSmoke: !!input, minimized: false,
    real: ["native developer webview", "Rust proxy", "session-owned discovery and review", "canonical command inspection", "permission-denied creation"],
    mocked: ["local scripted Azure Responses provider", "MCP disabled"], selectedContextPreserved: true, detectorPatched: false, trace, summary };
}
