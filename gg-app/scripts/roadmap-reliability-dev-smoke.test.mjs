import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");
import {
  advanceFixtureRevision,
  bindFixturePhase,
  commitFixtureCompletion,
  createRoadmapReliabilityFixtureServer,
  createRoadmapReliabilityFixtureState,
  fixtureDiagnostics,
  parseRoadmapReliabilitySmokeArguments,
  previewFixtureCompletion,
  seedRoadmapReliabilityFixture,
} from "./roadmap-reliability-dev-smoke.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-roadmap-reliability-test-"));
  const state = createRoadmapReliabilityFixtureState({ root, project: join(root, "project") });
  const sessionA = { sessionId: "session-a", createdAt: 1 };
  const sessionB = { sessionId: "session-b", createdAt: 2 };
  state.sessions.set(sessionA.sessionId, sessionA);
  state.sessions.set(sessionB.sessionId, sessionB);
  return { root, state, sessionA, sessionB };
}

function bindingRequest(state, action, expectedPreviousSession = null) {
  return {
    version: 1,
    action,
    phaseId: "roadmap-reliability-phase",
    expectedProjectKey: state.projectKey,
    expectedRevision: state.revision,
    expectedPreviousSession,
    operationId: `${action}-${state.revision}`,
    confirmRebind: action === "rebind-current",
  };
}

test("isolates identity and transfers authority without arbitrary destinations", () => {
  const { root, state, sessionA, sessionB } = fixture();
  try {
    assert.equal(seedRoadmapReliabilityFixture(state).status, "seeded");
    const bound = bindFixturePhase(
      state,
      sessionA.sessionId,
      bindingRequest(state, "bind-current"),
    );
    assert.equal(bound.status, "committed");
    assert.equal(fixtureDiagnostics(state, sessionA.sessionId).consistency, "consistent");
    assert.equal(
      fixtureDiagnostics(state, sessionB.sessionId).consistency,
      "bound-to-other-session",
    );

    const rebound = bindFixturePhase(
      state,
      sessionB.sessionId,
      bindingRequest(state, "rebind-current", bound.session),
    );
    assert.equal(rebound.status, "committed");
    assert.equal(rebound.session.sessionId, sessionB.sessionId);
    assert.equal(
      fixtureDiagnostics(state, sessionA.sessionId).consistency,
      "bound-to-other-session",
    );
    assert.equal(fixtureDiagnostics(state, sessionB.sessionId).consistency, "consistent");
    assert.equal(state.scheduler.attempts, 2);
    assert.equal(state.scheduler.outcome, "committed-after-retry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a raced approval preview and commits refreshed evidence once", () => {
  const { root, state, sessionA } = fixture();
  try {
    seedRoadmapReliabilityFixture(state);
    bindFixturePhase(state, sessionA.sessionId, bindingRequest(state, "bind-current"));
    const first = previewFixtureCompletion(
      state,
      sessionA.sessionId,
      { expectedRevision: state.revision },
      () => "nonce-stale",
    );
    assert.equal(first.status, "ready");

    advanceFixtureRevision(state);
    assert.deepEqual(commitFixtureCompletion(state, first.checkpoint.nonce), {
      status: "stale-revision",
      revision: state.revision,
    });

    const refreshed = previewFixtureCompletion(
      state,
      sessionA.sessionId,
      { expectedRevision: state.revision },
      () => "nonce-current",
    );
    assert.equal(refreshed.status, "ready");
    assert.equal(commitFixtureCompletion(state, refreshed.checkpoint.nonce).status, "committed");
    assert.equal(state.approvals, 1);
    assert.equal(
      commitFixtureCompletion(state, refreshed.checkpoint.nonce).status,
      "nonce-not-found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serves stale manual approval outcomes with their typed HTTP status", async () => {
  const { root, state, sessionA } = fixture();
  const fixtureServer = createRoadmapReliabilityFixtureServer({
    state,
    auditFile: join(root, "audit.jsonl"),
    fixtureToken: "fixture-token",
    launchToken: "launch-token",
  });
  try {
    seedRoadmapReliabilityFixture(state);
    bindFixturePhase(state, sessionA.sessionId, bindingRequest(state, "bind-current"));
    const preview = previewFixtureCompletion(
      state,
      sessionA.sessionId,
      { expectedRevision: state.revision },
      () => "nonce-stale",
    );
    advanceFixtureRevision(state);
    await new Promise((resolveListen) =>
      fixtureServer.server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = fixtureServer.server.address();
    assert.ok(address && typeof address !== "string");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/notes/roadmap/completion-approval/commit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fixture-token": "fixture-token",
          "x-gg-session": sessionA.sessionId,
        },
        body: JSON.stringify({ nonce: preview.checkpoint.nonce }),
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { status: "stale-revision", revision: state.revision });
  } finally {
    await new Promise((resolveClose) => fixtureServer.server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture APIs and daemon routes require separate credentials", async () => {
  const { root, state } = fixture();
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
    assert.equal((await fetch(`${origin}/notes`)).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/fixture/seed`, {
          method: "POST",
          headers: { "x-fixture-token": "wrong" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${origin}/fixture/seed`, {
          method: "POST",
          headers: { "x-fixture-token": "fixture-token" },
        })
      ).status,
      200,
    );
  } finally {
    await new Promise((resolveClose) => fixtureServer.server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts only the isolated Local Fork identity and known evidence arguments", () => {
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
