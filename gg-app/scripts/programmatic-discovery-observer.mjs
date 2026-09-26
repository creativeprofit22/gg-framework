import assert from "node:assert/strict";

// Fixture-only non-pausing CDP logpoints. No replacement of Tauri invoke, responses,
// application state or owner checks; capture only the bounded discovery handoff.
export async function observeDiscoveryHandoff(client) {
  await client.send("Debugger.enable");
  await client.evaluate("window.fixtureDiscoveryTrace = []");
  const probes = [
    ["/src/agent.ts", 'const after = await call("agent_pane_status")', 'request.action === "review-candidate"', '{ boundary: "ipc", response, nativeGeneration: before.generation }'],
    ["/src/AgentPane.tsx", 'const response = await client.programmatic(active)', 'active.action === "review-candidate"', '{ boundary: "pane", response, generation, epoch, current: current() }'],
    ["/src/programmatic-discovery-state.ts", 'const candidate = response.candidateReview.candidate', 'true', '{ boundary: "reducer", response, generation: state.generation, epoch: state.epoch, selection: state.selection, candidateStale: state.candidateStale, candidateDetail: state.candidateDetail }'],
  ];
  const breakpoints = [];
  for (const [path, needle, guard, value] of probes) {
    const source = await client.evaluate(`fetch(${JSON.stringify(path)}).then(r => r.text())`);
    const lines = source.split("\n");
    const matches = lines.flatMap((line, index) => line.includes(needle) ? [index] : []);
    assert.equal(matches.length, 1, `One current transformed observation site: ${path}`);
    const { breakpointId, locations } = await client.send("Debugger.setBreakpointByUrl", {
      urlRegex: `${path.replaceAll(".", "\\.")}(?:\\?.*)?$`, lineNumber: matches[0] + (path === "/src/AgentPane.tsx" ? 1 : 0),
      condition: `(${guard}) && window.fixtureDiscoveryTrace.length < 20 && (window.fixtureDiscoveryTrace.push(JSON.parse(JSON.stringify(${value}))), false)`,
    });
    assert.ok(locations.length > 0, `Loaded native observation site: ${path}`);
    breakpoints.push(breakpointId);
  }
  return async () => {
    for (const breakpointId of breakpoints) await client.send("Debugger.removeBreakpoint", { breakpointId });
    await client.send("Debugger.disable");
  };
}

export function assertDiscoveryHandoff({ host, http, trace, summary }) {
  assert.equal(http.status, 200);
  assert.equal(http.body.ok, true);
  assert.deepEqual(http.body.candidateReview, host.candidateReview);
  assert.equal(host.target.identity, host.now.identity);
  assert.equal(host.epoch, host.currentEpoch);
  const ipc = trace.find((entry) => entry.boundary === "ipc");
  const pane = trace.find((entry) => entry.boundary === "pane");
  const reducer = trace.find((entry) => entry.boundary === "reducer");
  assert.ok(ipc && pane && reducer, "HTTP/IPC/pane/reducer observations required");
  for (const entry of [ipc, pane, reducer]) assert.deepEqual(entry.response, http.body);
  assert.equal(pane.current, true);
  assert.equal(pane.generation, reducer.generation);
  assert.equal(pane.epoch, reducer.epoch);
  assert.equal(reducer.candidateStale, false);
  assert.deepEqual(reducer.selection, { source: "current", id: host.candidateReview.candidate.candidateId });
  assert.deepEqual(reducer.candidateDetail, host.candidateReview.candidate);
  assert.deepEqual(summary, { status: host.candidateReview.status, summary: host.candidateReview.summary, count: 1 });
}

export function readDiscoverySummary(doc, review) {
  if (!review || !["prepared", "reinspection-required"].includes(review.status) ||
    typeof review.summary !== "string" || !review.summary.trim()) throw new Error("Missing host review summary");
  const section = doc.querySelector('[aria-label="Selected opportunity"]');
  if (!section) return null;
  const count = Array.from(section.querySelectorAll("p")).filter((p) => p.textContent === review.summary).length;
  return count ? { status: review.status, summary: review.summary, count } : null;
}
