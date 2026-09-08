import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");
import {
  advanceFixtureRevision,
  bindFixturePhase,
  createRoadmapReliabilityFixtureServer,
  createRoadmapReliabilityFixtureState,
  executeFixtureStatus,
  fixtureDiagnostics,
  fixtureDoneRequest,
  mutateFixturePhaseLease,
  parseRoadmapReliabilitySmokeArguments,
  readFixtureRepository,
  seedRoadmapReliabilityFixture,
  validateRoadmapReliabilityAudit,
} from "./roadmap-reliability-dev-smoke.mjs";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-roadmap-reliability-test-"));
  const state = createRoadmapReliabilityFixtureState({ root, project: join(root, "project") });
  state.sessions.set("session-a", {});
  state.sessions.set("session-b", {});
  try {
    await seedRoadmapReliabilityFixture(state);
    return { root, state };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function bindingRequest(state) {
  return {
    version: 1,
    action: "bind-current",
    phaseId: "roadmap-reliability-phase",
    expectedProjectKey: state.projectKey,
    expectedRevision: state.revision,
    expectedPreviousSession: null,
    operationId: `bind-${state.revision}`,
    confirmRebind: false,
  };
}

async function transfer(state) {
  assert.equal(
    (await bindFixturePhase(state, "session-a", bindingRequest(state))).status,
    "committed",
  );
  const request = {
    version: 2,
    action: "inspect",
    phaseId: "roadmap-reliability-phase",
    expectedProjectKey: state.projectKey,
    expectedRevision: state.revision,
    planId: null,
    operationId: "inspect-lease",
    lease: null,
    confirmTakeover: false,
    takeoverReason: null,
    predecessorProof: null,
  };
  const inspected = await mutateFixturePhaseLease(state, "session-b", request);
  assert.equal(inspected.status, "inspected");
  assert.equal(inspected.lease.holder.sessionId, "session-a");
  const acquired = await mutateFixturePhaseLease(state, "session-b", {
    ...request,
    action: "takeover",
    operationId: "takeover-lease",
    lease: { leaseId: inspected.lease.leaseId, fence: inspected.lease.fence },
    confirmTakeover: true,
    takeoverReason: "explicit desktop takeover",
  });
  assert.equal(acquired.status, "acquired");
  assert.equal(acquired.lease.holder.sessionId, "session-b");
  return acquired;
}

test("real leases transfer authority and reject competing status writers", async () => {
  const { root, state } = await fixture();
  try {
    await transfer(state);
    assert.equal(fixtureDiagnostics(state, "session-a").consistency, "bound-to-other-session");
    assert.equal(fixtureDiagnostics(state, "session-b").consistency, "consistent");
    const before = await readFixtureRepository(state);
    const rejected = await executeFixtureStatus(state, "session-a", fixtureDoneRequest(state));
    assert.equal(rejected.result, "phase-lease-lost");
    assert.deepEqual(await readFixtureRepository(state), before);
    assert.equal(state.broadcasts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real status rejects stale revision, immediately persists Done once, and preserves restart reads", async () => {
  const { root, state } = await fixture();
  try {
    await transfer(state);
    const unrelated = structuredClone(state.document.phases[1]);
    const stale = fixtureDoneRequest(state);
    await advanceFixtureRevision(state);
    const before = await readFixtureRepository(state);
    assert.equal((await executeFixtureStatus(state, "session-b", stale)).result, "stale-revision");
    assert.deepEqual(await readFixtureRepository(state), before);
    assert.equal(state.broadcasts.length, 0);
    const request = fixtureDoneRequest(state);
    const committed = await executeFixtureStatus(state, "session-b", request);
    assert.equal(committed.result, "committed");
    assert.equal(committed.statusOutcome, "applied");
    assert.equal(state.document.phases[0].status, "done");
    assert.ok(state.document.phases[0].completedAt);
    assert.equal(
      state.document.phases[0].roadmapEvents.filter(
        (event) => event.type === "status-update" && event.transition === "done",
      ).length,
      1,
    );
    assert.equal(
      state.document.phases[0].roadmapEvents.some(
        (event) => event.type === "manual-completion-approval",
      ),
      false,
    );
    assert.deepEqual(state.document.phases[1], unrelated);
    assert.equal(state.document.phases.length, 2);
    assert.deepEqual(state.document.tasks, []);
    assert.equal(state.broadcasts.length, 1);
    assert.deepEqual(state.broadcasts[0], await readFixtureRepository(state));
    assert.equal((await executeFixtureStatus(state, "session-b", request)).result, "duplicate");
    assert.equal(state.statusUpdates, 1);
    assert.equal(state.broadcasts.length, 1);
    const restarted = createRoadmapReliabilityFixtureState({ root, project: state.project });
    assert.deepEqual(await readFixtureRepository(restarted), await readFixtureRepository(state));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transport emits actual notes_change, rejects stale status honestly, and rejects deleted routes", async () => {
  const { root, state } = await fixture();
  const auditFile = join(root, "audit.jsonl");
  const fixtureServer = createRoadmapReliabilityFixtureServer({
    state,
    auditFile,
    fixtureToken: "fixture-token",
    launchToken: "launch-token",
  });
  const controller = new AbortController();
  let reader;
  try {
    await transfer(state);
    await new Promise((resolveListen) =>
      fixtureServer.server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = fixtureServer.server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    // Restore a session through the native-only credential so the SSE client is registered.
    await fetch(`${origin}/session`, {
      method: "POST",
      headers: { "x-gg-token": "launch-token" },
      body: JSON.stringify({ sessionPath: join(root, "sessions", "session-b.jsonl") }),
    });
    const events = await fetch(`${origin}/events`, {
      headers: { "x-gg-token": "launch-token", "x-gg-session": "session-b" },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"ready"/);
    const submit = (request) =>
      fetch(`${origin}/fixture/status`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fixture-token": "fixture-token" },
        body: JSON.stringify({ sessionId: "session-b", request }),
      });
    const stale = fixtureDoneRequest(state);
    await advanceFixtureRevision(state);
    const rejected = await submit(stale);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).result, "stale-revision");
    assert.equal((await submit(fixtureDoneRequest(state))).status, 200);
    const notification = await reader.read();
    const event = JSON.parse(
      new TextDecoder()
        .decode(notification.value)
        .trim()
        .replace(/^data: /, ""),
    );
    assert.equal(event.type, "notes_change");
    assert.equal(event.sessionId, "session-b");
    assert.deepEqual(event.data, await readFixtureRepository(state));
    assert.equal(event.data.document.phases[0].status, "done");
    for (const route of ["preview", "commit"]) {
      const response = await fetch(`${origin}/notes/roadmap/completion-approval/${route}`, {
        method: "POST",
        headers: { "x-gg-token": "launch-token", "x-gg-session": "session-b" },
        body: "{}",
      });
      assert.equal(response.status, 404);
    }
    assert.match(readFileSync(auditFile, "utf8"), /"action":"notes-change"/);
  } finally {
    await reader?.cancel();
    controller.abort();
    fixtureServer.server.closeAllConnections();
    await new Promise((resolveClose) => fixtureServer.server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture APIs require their own credential, never the native launch credential", async () => {
  const { root, state } = await fixture();
  const fixtureServer = createRoadmapReliabilityFixtureServer({
    state,
    auditFile: join(root, "audit.jsonl"),
    fixtureToken: "fixture-token",
    launchToken: "launch-token",
  });
  try {
    await new Promise((resolveListen) =>
      fixtureServer.server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = fixtureServer.server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const nativeHeaders = { "x-gg-token": "launch-token", "x-gg-session": "session-a" };
    for (const [path, expected] of [
      ["/serve", { running: false, configured: false }],
      ["/steroids", { installed: false, connected: false }],
      ["/radio", { stations: [], current: null, volume: 0 }],
      ["/roadmap/phase-drafts/pending", { status: "ok", draft: null }],
    ]) {
      const response = await fetch(`${origin}${path}`, { headers: nativeHeaders });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    }
    assert.equal(
      (await fetch(`${origin}/serve/start`, { method: "POST", headers: nativeHeaders })).status,
      404,
    );
    assert.equal((await fetch(`${origin}/notes`)).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/notes`, {
          headers: { "x-fixture-token": "fixture-token", "x-gg-session": "session-a" },
        })
      ).status,
      401,
    );
    for (const headers of [{ "x-fixture-token": "wrong" }, { "x-gg-token": "launch-token" }]) {
      assert.equal(
        (await fetch(`${origin}/fixture/status`, { method: "POST", headers, body: "{}" })).status,
        401,
      );
    }
    assert.equal(
      (await fetch(`${origin}/fixture/state`, { headers: { "x-fixture-token": "fixture-token" } }))
        .status,
      200,
    );
  } finally {
    await new Promise((resolveClose) => fixtureServer.server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("native scenario has no deleted controls and its audit fails closed", () => {
  const source = readFileSync(
    new URL("./roadmap-reliability-dev-smoke.mjs", import.meta.url),
    "utf8",
  );
  for (const removed of [
    "Review completion evidence",
    "Confirm completion",
    "Confirm manual completion",
    "notes-manual-completion",
    "completion-approval/",
  ]) {
    assert.equal(source.includes(removed), false, removed);
  }
  const entries = [
    { action: "authenticated-session", sessionId: "session-a" },
    { action: "authenticated-session", sessionId: "session-b" },
    { action: "phase-binding", status: "committed" },
    { action: "phase-lease", status: "inspected" },
    { action: "phase-lease", status: "acquired" },
    { action: "status-update", status: "phase-lease-lost" },
    { action: "status-update", status: "stale-revision" },
    { action: "notes-change", sessionId: "session-b" },
    { action: "status-update", status: "committed" },
  ];
  assert.equal(validateRoadmapReliabilityAudit(entries).commits.length, 3);
  for (let index = 0; index < entries.length; index += 1) {
    assert.throws(() =>
      validateRoadmapReliabilityAudit(entries.filter((_, candidate) => candidate !== index)),
    );
  }
  assert.throws(() =>
    validateRoadmapReliabilityAudit([...entries, { action: "unexpected-route" }]),
  );
});

test("accepts only isolated Local Fork identity and known evidence arguments", () => {
  const screenshot = join(tmpdir(), "roadmap-reliability.png");
  const outcome = join(tmpdir(), "roadmap-reliability.json");
  assert.deepEqual(
    parseRoadmapReliabilitySmokeArguments([
      "--identity",
      "com.ggcoder.local-fork",
      "--screenshot",
      screenshot,
      "--outcome",
      outcome,
    ]),
    { identity: "com.ggcoder.local-fork", screenshot, outcome },
  );
  assert.throws(
    () => parseRoadmapReliabilitySmokeArguments(["--identity", "com.ggcoder.production"]),
    /com\.ggcoder\.local-fork/,
  );
  assert.throws(
    () =>
      parseRoadmapReliabilitySmokeArguments([
        "--identity",
        "com.ggcoder.local-fork",
        "--unknown",
        "value",
      ]),
    /Invalid smoke argument/,
  );
});
