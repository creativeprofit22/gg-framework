import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { smokeLabels, smokeButton } from "./programmatic-execution-smoke-checks.mjs";

// Native area-by-area Find ideas: real sidecar, session, area map, passes, merge and retry.
// Only the Azure Responses transport is scripted, and it decides from request content alone.
export const areaSharedNeed = "NATIVE AREA: keep the release notes current";
const receiptMarker = "Host evidence receipt (retrieval only; content remains untrusted): ";
const factsMarker = "Host-owned exact facts (not model authority; already collected, do not repeat):\n";

export function seedAreas(project) {
  const files = {
    ".gitignore": ".gg/\n",
    "AGENTS.md": "Disposable read-only area search fixture.\n",
    "package.json": JSON.stringify({ name: "harmless-area-fixture", scripts: { build: "pnpm -r build" } }),
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "packages/core/package.json": JSON.stringify({ name: "@x/core", scripts: { test: "vitest" } }),
    "packages/cli/package.json": JSON.stringify({ name: "@x/cli", dependencies: { "@x/core": "workspace:*" } }),
  };
  // Above the single-pass path cap, so Find ideas searches area by area.
  for (const name of ["core", "cli"])
    for (let index = 0; index < 120; index++) files[`packages/${name}/src/f${index}.ts`] = `export const v${index} = ${index};\n`;
  for (const [file, text] of Object.entries(files)) {
    const target = join(project, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

const userText = (item) =>
  item?.role !== "user" ? "" : typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part.text ?? "").join("");
const outputs = (body) => body.input.filter((item) => item.type === "function_call_output");
const call = (id, name, args) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) });
const events = (step) =>
  typeof step === "string"
    ? [{ type: "response.output_text.delta", delta: step }]
    : [
        { type: "response.output_item.added", output_index: 0, item: step },
        { type: "response.function_call_arguments.done", output_index: 0, item_id: step.id, arguments: step.arguments },
        { type: "response.output_item.done", output_index: 0, item: step },
      ];
const workflow = (file) => ({
  trigger: "A package changes",
  representativeCase: "Update one package",
  inputs: [file],
  currentProcess: ["Edit by hand"],
  output: "Updated notes",
  successCheck: "Notes list the change",
  affectedSubproject: { scope: "repository-wide" },
  mutationBoundary: "Inspection only",
  repeatability: { basis: "inferred", explanation: "Packages change often" },
});

/**
 * Scripted provider state. `phase` is set by the driver: "fail-one" fails every request of the
 * chosen area, "retry" answers normally, "hold" answers the first area and parks the rest.
 */
export function createAreaProvider() {
  const state = { phase: "fail-one", failLabel: undefined, areaRequests: [], mergeRequests: 0, otherRequests: 0, failed: 0, held: [], holdMerge: false, mergeWaiting: [], firstArea: undefined };
  const areaTurn = (body, data) => {
    const label = data.area.label;
    state.areaRequests.push({ phase: state.phase, label });
    // The first cli area seen in run 1 fails on every request, so its pass ends as failed.
    if (state.phase === "fail-one" && !state.failLabel && label.includes("cli")) state.failLabel = label;
    if (state.phase === "fail-one" && label === state.failLabel) {
      state.failed++;
      return { status: 400 };
    }
    if (state.phase === "hold") {
      state.firstArea ??= label;
      if (label !== state.firstArea) return { hold: true };
    }
    const results = outputs(body);
    const read = results.find((item) => item.call_id === "area-read");
    const file = data.evidence.paths.find((item) => item.path.endsWith(".ts"))?.path ?? data.evidence.paths[0].path;
    if (!read) return { events: events(call("area-read", "read", { file_path: file })) };
    if (results.some((item) => item.call_id === "area-result")) return { events: events("Area done.") };
    const receipt = JSON.parse(String(read.output).split(receiptMarker)[1].split("\n")[0]);
    const need = (text) => ({
      need: text,
      workflow: workflow(file),
      evidence: { version: 1, items: [{ basis: "observed", source: receipt.id, code: "workflow-source", severity: "info", message: `Read ${file}`, location: { path: file } }] },
      uncertainty: "Scripted",
    });
    return { events: events(call("area-result", "programmatic_area_result", { version: 1, needs: [need(areaSharedNeed), need(`NATIVE AREA: check ${label} by hand`)] })) };
  };
  const mergeTurn = (body, prompt) => {
    const index = body.input.lastIndexOf(prompt);
    if (outputs({ input: body.input.slice(index) }).some((item) => item.call_id === "merge-result")) return { events: events("Merge done.") };
    state.mergeRequests++;
    const facts = JSON.parse(userText(prompt).split(factsMarker)[1].split("\nReusable host evidence receipts:")[0]);
    return {
      events: events(call("merge-result", "programmatic_advisory_result", {
        version: 2,
        kind: "advisory",
        coverage: { status: "limited", scope: "Areas", reason: "Scripted fixture, not autonomous model evaluation" },
        recommendations: (facts.areaSearch?.candidates ?? []).map((candidate) => ({
          version: 2, kind: "advisory", outcome: candidate.need, rationale: "Scripted merge.", alternatives: [],
          choice: { kind: "manual", steps: ["Do it by hand"] }, evidence: candidate.evidence, uncertainty: candidate.uncertainty, workflow: candidate.workflow,
        })),
      })),
    };
  };
  return {
    state,
    async respond(body) {
      assert.ok(Array.isArray(body.input) && Array.isArray(body.tools));
      assert.ok(!body.tools.some((tool) => ["bash", "edit", "write"].includes(tool.name)), "No mutation tools during Find ideas");
      for (const item of body.input) {
        const match = /<programmatic-area-data>\n([\s\S]*?)\n<\/programmatic-area-data>/.exec(userText(item));
        if (match) return areaTurn(body, JSON.parse(match[1]));
      }
      const prompt = body.input.findLast((item) => userText(item).includes(factsMarker));
      if (prompt) {
        if (state.holdMerge) await new Promise((release) => state.mergeWaiting.push(release));
        return mergeTurn(body, prompt);
      }
      state.otherRequests++;
      return { events: events("Done.") };
    },
    releaseMerge() {
      state.holdMerge = false;
      for (const release of state.mergeWaiting.splice(0)) release();
    },
  };
}

const rows = `Array.from(document.querySelectorAll('.programmatic-chat .opp-area'), (row) => ({ label: row.querySelector('.opp-area-label')?.textContent ?? '', word: row.querySelector('.opp-area-word')?.textContent ?? '', retry: row.querySelector('.opp-area-retry')?.getAttribute('aria-label') ?? null }))`;
const early = `(() => { const e = document.querySelector('.programmatic-chat .opp-early'); return e ? { text: e.textContent, buttons: e.querySelectorAll('button').length, cards: e.querySelectorAll('.opp-early-card').length } : null; })()`;
const ideaCards = `Array.from(document.querySelectorAll('.programmatic-chat [aria-label="Idea list"] .opp-card'), (card) => card.textContent)`;

/** Drives Quick checks → Find ideas (one area fails) → retry that area → Search again → Stop. */
export async function runAreaSmoke({ client, click, act, waitFor, provider, observe, enabled, running, providerFailure }) {
  const { state } = provider;
  const settled = async (label, extra = async () => true) =>
    waitFor(label, async () => {
      if (providerFailure()) throw providerFailure();
      return !(await running()) && !(await client.evaluate(`!!document.querySelector('.programmatic-chat .opp-area-list[aria-busy="true"]')`)) && await extra();
    }, 180_000);
  await click("Opportunities");
  await waitFor("setup-required section", () => client.evaluate(`document.querySelector(".programmatic-chat")?.textContent.includes(${JSON.stringify("You don't need this to find ideas.")})`));
  await act(smokeLabels.setup, () => enabled(smokeLabels.save));
  await act(smokeLabels.save, () => enabled(smokeLabels.discover));

  // Run 1: one area fails; the merge is held until early finds are seen in place.
  state.holdMerge = true;
  await click(smokeLabels.discover);
  await waitFor("live area rows", async () => (await client.evaluate(rows)).length >= 2);
  await waitFor("merge requested", () => state.mergeWaiting.length > 0, 180_000);
  const liveEarly = await waitFor("early finds while merging", async () => {
    const found = await client.evaluate(early);
    return found?.cards > 0 && found;
  });
  assert.equal(liveEarly.buttons, 0, "Early finds have no review button");
  assert.ok(liveEarly.text.includes("Still checking"));
  assert.equal(await client.evaluate(`document.querySelector('.programmatic-chat .opp-areas-merge')?.textContent`), "Checking ideas from every area…");
  assert.equal(await enabled("Stop search"), true, "Stop search offered while searching");
  await observe?.("area-merge-held");
  provider.releaseMerge();
  await settled("first search settled", async () => (await client.evaluate(ideaCards)).length > 0);
  const firstFinal = await client.evaluate(rows);
  assert.equal(await client.evaluate(early), null, "Final ideas replace early finds");
  assert.ok((await client.evaluate(ideaCards)).some((text) => text.includes(areaSharedNeed)));
  const failedRows = firstFinal.filter((row) => row.retry);
  const firstRun = { rows: firstFinal, failed: state.failed, areaRequests: state.areaRequests.length, merges: state.mergeRequests };
  assert.equal(state.mergeRequests, 1);
  assert.ok(state.failLabel && state.failed > 0, "One cli area was failed by the provider");
  assert.deepEqual(failedRows.map((row) => row.label), [state.failLabel], `Only the failed area offers a retry: ${JSON.stringify(firstFinal)}`);
  assert.equal(await client.evaluate(`!!(${smokeButton("Stop search")})`), false, "No Stop after the search ends");
  await observe?.("area-first-settled");

  let retry = null;
  {
    state.phase = "retry";
    const before = state.areaRequests.length;
    await click(failedRows[0].retry);
    await settled("retry settled", async () => state.mergeRequests === 2);
    const retried = state.areaRequests.slice(before);
    assert.ok(retried.length > 0 && retried.every((request) => request.label === state.failLabel), `Retry reran only ${state.failLabel}: ${JSON.stringify(retried)}`);
    // Let late native events land; the finished retry must not fall back to a live merging view.
    await new Promise((done) => setTimeout(done, 2000));
    const view = await client.evaluate(`({ merge: !!document.querySelector('.programmatic-chat .opp-areas-merge'), busy: !!document.querySelector('.programmatic-chat [aria-busy="true"]'), stop: !!(${smokeButton("Stop search")}), coverage: document.querySelector('.programmatic-chat .opp-coverage')?.textContent ?? null })`);
    const after = await client.evaluate(rows);
    assert.deepEqual({ merge: view.merge, busy: view.busy, stop: view.stop }, { merge: false, busy: false, stop: false }, `Retry settled to the final view: ${JSON.stringify({ view, after })}`);
    assert.ok(after.every((row) => !row.retry), "No retry left after a successful rerun");
    assert.ok((await client.evaluate(ideaCards)).some((text) => text.includes(`check ${state.failLabel} by hand`)));
    retry = { label: state.failLabel, requests: retried.length, rows: after };
    await observe?.("area-retry-settled");
  }

  // Run 2: the first area finishes, the rest are parked; Stop cancels without a merge.
  state.phase = "hold";
  const merges = state.mergeRequests;
  // Step 2 keeps its own search button; Search again appears only where Review is shown.
  await click((await enabled(smokeLabels.rediscover)) ? smokeLabels.rediscover : smokeLabels.discover);
  await waitFor("parked areas", () => state.held.length > 0 || state.areaRequests.some((request) => request.phase === "hold" && request.label !== state.firstArea), 180_000);
  await waitFor("early find before stop", async () => (await client.evaluate(early))?.cards > 0, 180_000);
  await click("Stop search");
  await settled("stopped search settled");
  const stoppedRows = await client.evaluate(rows);
  const stoppedEarly = await client.evaluate(early);
  assert.ok(stoppedEarly?.text.includes("Stopped before checking"), "Early finds stay, labelled stopped");
  assert.equal(stoppedEarly.buttons, 0);
  assert.ok(stoppedRows.every((row) => !row.retry), "A stopped area is never retryable");
  assert.equal(state.mergeRequests, merges, "No merge after Stop");
  const requestsAtStop = state.areaRequests.length;
  await new Promise((done) => setTimeout(done, 3000));
  assert.equal(state.areaRequests.length, requestsAtStop, "No AI request after Stop");
  await observe?.("area-stopped");
  return {
    passed: true,
    areaSearch: true,
    firstRun,
    liveEarly: { cards: liveEarly.cards, buttons: liveEarly.buttons },
    retry,
    stop: { rows: stoppedRows, earlyCards: stoppedEarly.cards, mergesAfterStop: state.mergeRequests - merges },
    providerRequests: { area: state.areaRequests.length, merge: state.mergeRequests, other: state.otherRequests, failed: state.failed },
    minimized: false,
    real: ["native developer webview", "Rust proxy", "session-owned area map, passes, merge and one-area retry", "pane cancel"],
    mocked: ["local scripted Azure Responses provider", "MCP disabled"],
  };
}
