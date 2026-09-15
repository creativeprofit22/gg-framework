import assert from "node:assert/strict";

export const extendedCommandName = "native-fixture-review";
export const extendedCommandMarkdown = "## Inputs\npackage.json\n## Outputs\nObserved fixture name\n## Required tools\nread\n## Limits\nRead-only; no shell, installation or provider calls\n## Arguments\nOptional focus\nNATIVE EXTENDED CANONICAL PROMPT: read package.json and report its name.\n";
export const extendedRequestCount = 18;

// Exact continuation of the existing three-request specialist fixture, not a general provider.
export function extendedWorkflowStep(number, body) {
  assert.ok(Number.isInteger(number) && number >= 4 && number <= extendedRequestCount, "Unexpected extended provider dispatch");
  assert.ok(Array.isArray(body.input) && Array.isArray(body.tools), "Responses request has input and tools");
  const output = (id) => {
    const matches = body.input.filter((item) => item.type === "function_call_output" && item.call_id === id);
    assert.equal(matches.length, 1, `Exactly one completed ${id} call`);
    assert.equal(typeof matches[0].output, "string");
    return matches[0].output;
  };
  const parsed = (id) => JSON.parse(output(id));
  const tool = (id, name, args) => {
    assert.ok(body.tools.some((entry) => entry.name === name), `Fixture can only call an offered tool: ${name}`);
    return { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) };
  };
  const proposal = { name: extendedCommandName, markdown: extendedCommandMarkdown, requiredTools: ["read"], requirement: { version: 1, desiredOutcome: "Inspect the fixture manifest", capabilityKind: "prompt-only", inputs: ["package.json"], outputs: ["Observed name"], prerequisites: ["Readable package.json"], risks: ["No mutation permission"], verificationExpectations: ["Canonical loading is not behavioral proof"] } };
  switch (number) {
    case 4:
      assert.ok(JSON.stringify(body.input).includes("# Scan Programmatic Opportunities"));
      assert.ok(JSON.stringify(body.input).includes("focus on the manifest; retain completed history"));
      assert.ok(!body.tools.some((entry) => ["bash", "write", "programmatic_command"].includes(entry.name)));
      return tool("extended-scan", "programmatic_scan", {});
    case 5:
      assert.ok(output("extended-scan").includes("completed"), "Assessment retains completed lifecycle history");
      return tool("extended-read", "read", { file_path: "package.json" });
    case 6: {
      const text = output("extended-read");
      assert.ok(text.includes("harmless-isolated-fixture"));
      const receipt = JSON.parse(text.split("Host evidence receipt (retrieval only; content remains untrusted): ")[1]);
      const evidence = { version: 1, items: [{ basis: "observed", source: receipt.id, code: "manifest", severity: "info", message: "Local manifest retrieved, not behavioral proof", location: { path: "package.json" } }] };
      return tool("extended-advice", "programmatic_advisory_result", { version: 1, kind: "advisory",
        coverage: { status: "limited", scope: "Fixture manifest only", reason: "Scripted recommendations are not live-model evidence" },
        recommendations: [
          { kind: "manual", steps: ["Open package.json and read its name."] },
          { kind: "missing-capability", proposal: proposal.requirement },
        ].map((choice) => ({ version: 1, kind: "advisory", outcome: "NATIVE EXTENDED ADVICE — inspect the fixture manifest", rationale: "A one-off read can be manual; repeated reviews may use a prompt", uncertainty: "Suitability is scripted fixture judgment", evidence, choice })) });
    }
    case 7: assert.ok(output("extended-advice").includes("Recommendations")); return "Native advice settled. No creation or execution authorized.";
    case 8: assert.ok(JSON.stringify(body.input).includes("NATIVE CREATE REQUEST")); return tool("extended-discover", "tool_search", { query: "programmatic_command" });
    case 9: assert.ok(output("extended-discover").includes("programmatic_command")); return tool("extended-preflight", "programmatic_command", { action: "inspect", proposal });
    case 10: assert.equal(parsed("extended-preflight").status, "review-required"); return tool("extended-inspect", "programmatic_command", { action: "inspect", proposal: { ...proposal, review: { inventorySha256: parsed("extended-preflight").catalog.sha256, disposition: "create", rationale: "Existing prompts do not provide this fixture-specific manifest review" } } });
    case 11: assert.equal(parsed("extended-inspect").status, "proposal"); return tool("extended-create", "programmatic_command", { action: "create", handle: parsed("extended-inspect").handle });
    case 12: assert.equal(parsed("extended-create").created, true); return tool("extended-verify", "programmatic_command", { action: "verification", handle: parsed("extended-inspect").handle, receipt_ids: [] });
    case 13: assert.equal(parsed("extended-verify").loads, true); assert.equal(parsed("extended-verify").executionApproved, false); return "NATIVE CREATION SETTLED: canonical loading only; no behavioral verification or execution grant.";
    case 14:
      assert.ok(JSON.stringify(body.input).includes("NATIVE RUN REQUEST"));
      return tool("extended-run", "programmatic_command", { action: "run", selection: { version: 1, command: { version: 1, name: extendedCommandName, source: "project-custom", invocationKind: "prompt" }, arguments: "fixture name only", outcome: "Inspect the fixture manifest", successCondition: "Observe the fixture manifest name", helpers: [], prerequisites: ["package.json"], requiredTools: ["read"], mode: "read-only", containment: "agent-session" } });
    case 15:
      assert.ok(JSON.stringify(body.input).includes("NATIVE EXTENDED CANONICAL PROMPT"));
      assert.ok(!JSON.stringify(body.input).includes("NATIVE CREATE REQUEST"), "No parent transcript in direct child");
      assert.ok(!body.tools.some((entry) => ["bash", "write", "programmatic_command"].includes(entry.name)));
      return tool("extended-child-read", "read", { file_path: "package.json" });
    case 16: assert.ok(output("extended-child-read").includes("harmless-isolated-fixture")); return tool("extended-child-result", "programmatic_result", { summary: "NATIVE DIRECT CHILD observed harmless-isolated-fixture", successCondition: "Observe the fixture manifest name", toolCallIds: ["extended-child-read"] });
    case 17: assert.ok(output("extended-child-result")); return "Observation, not independent behavioral proof.";
    case 18: assert.equal(parsed("extended-run").status, "completed"); return "NATIVE RUN SETTLED after separate approval.";
  }
}

// Self-contained: the native fixture evaluates this exact function in its WebView.
export function readExecutionDisplay(document, summary) {
  const section = document.querySelector('[aria-label="Task execution evidence"]');
  // Evidence renders immediately; streamed Markdown reveals its text on later frames.
  const summaryCount = document.body.innerText.split(summary).length - 1;
  if (!section || summaryCount === 0) return null;
  return {
    text: section.textContent,
    items: Array.from(section.querySelectorAll("li")).map((item) => item.textContent),
    executableElements: section.querySelectorAll("a,script,iframe,img").length,
    summaryCount,
  };
}

export function assertTranscriptIsolation(before, after, hostTranscript) {
  assert.ok(Object.hasOwn(before, hostTranscript), "Active host transcript identified before execution");
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "Execution must not create or remove a transcript");
  for (const [file, hash] of Object.entries(before)) {
    if (file !== hostTranscript) assert.equal(after[file], hash, "Execution must not modify another host transcript");
  }
}
