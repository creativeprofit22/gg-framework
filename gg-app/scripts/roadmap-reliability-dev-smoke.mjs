import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  connectToDevWebview,
  createIsolatedProfile,
  reserveHeldTcpPort,
  sanitizedSmokeEnvironment,
} from "./phase-25-windows-smoke-helpers.mjs";
import {
  processTreeSnapshot,
  readProcessTable,
  survivingProcessIds,
  terminateProcessTree,
} from "./workspace-shell-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repositoryRoot = resolve(appDir, "..");
const fixturePhaseId = "roadmap-reliability-phase";
const localForkIdentity = "com.ggcoder.local-fork";
const defaultScreenshot = resolve(
  repositoryRoot,
  ".gg",
  "screenshots",
  "roadmap-reliability-repair.png",
);
const defaultOutcome = resolve(
  repositoryRoot,
  ".gg",
  "evidence",
  "roadmap-reliability-dev-smoke.json",
);
const fixtureMode = "GG_ROADMAP_RELIABILITY_FIXTURE_MODE";

function canonicalProjectKey(cwd) {
  const normalized = resolve(cwd).replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function sessionLink(state, sessionId) {
  return { sessionId, sessionPath: join(state.root, "sessions", `${sessionId}.jsonl`) };
}

function fixturePhase() {
  return {
    id: fixturePhaseId,
    title: "Roadmap reliability fixture",
    goal: "Verify identity, phase authority, and immediate Done",
    doneWhen: ["The isolated developer-app path passes"],
    order: 0,
    status: "in-progress",
    sourcePrompt: "Synthetic local fixture only",
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: "2026-08-27T20:00:00.000Z",
    updatedAt: "2026-08-27T20:02:00.000Z",
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  };
}

function fixtureDocument() {
  return {
    version: 3,
    reference: "Synthetic Roadmap reliability fixture",
    currentFocus: "Verify the native authority path",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: "2026-08-27T20:02:00.000Z",
    legacyImportedAt: null,
    phases: [
      fixturePhase(),
      {
        ...fixturePhase(),
        id: "unrelated-phase",
        title: "Unrelated pending phase",
        order: 1,
        status: "not-started",
      },
    ],
    references: [],
  };
}

export function createRoadmapReliabilityFixtureState({
  root,
  project,
  identity = localForkIdentity,
}) {
  return {
    root: resolve(root),
    project: resolve(project),
    projectKey: canonicalProjectKey(project),
    identity,
    revision: 1,
    document: fixtureDocument(),
    seeded: false,
    sessions: new Map(),
    nextSession: 1,
    runtime: null,
    statusUpdates: 0,
    broadcasts: [],
  };
}

function snapshot(state) {
  return {
    projectKey: state.projectKey,
    revision: state.revision,
    document: structuredClone(state.document),
  };
}

function currentPhase(state) {
  return state.document.phases[0];
}

// Use production status, persistence, and lease boundaries; only the transport is a fixture.
async function fixtureRuntime(state) {
  if (!state.runtime) {
    state.runtime = (async () => {
      const runtimeRoot = new URL("../../packages/ggcoder/dist/", import.meta.url);
      const [notes, leases, binding, host, reconciliation, status] = await Promise.all([
        import(new URL("project-notes-repository.js", runtimeRoot)),
        import(new URL("roadmap-phase-lease-repository.js", runtimeRoot)),
        import(new URL("app-sidecar-phase-binding.js", runtimeRoot)),
        import(new URL("app-sidecar-roadmap-tool-host.js", runtimeRoot)),
        import(new URL("app-sidecar-roadmap-reconciliation.js", runtimeRoot)),
        import(new URL("tools/roadmap-status.js", runtimeRoot)),
      ]);
      const repository = new notes.ProjectNotesRepository(state.root);
      state.notesPaths = repository.paths(state.project);
      return {
        repository,
        binding: binding.createAppSidecarPhaseBindingService({
          repository,
          leaseRepository: new leases.RoadmapPhaseLeaseRepository(state.root),
          daemonInstanceId: "fixture-daemon",
          processId: process.pid,
          processStartToken: "fixture-process",
        }),
        Host: host.AppSidecarRoadmapToolHost,
        reconciliations: new reconciliation.AppSidecarRoadmapReconciliationCoordinator(),
        params: status.RoadmapStatusParams,
      };
    })();
  }
  return state.runtime;
}

export async function readFixtureRepository(state) {
  const { repository } = await fixtureRuntime(state);
  const loaded = await repository.load(state.project);
  if (loaded.status !== "ok") throw new Error(`Fixture repository read: ${loaded.status}`);
  state.document = loaded.snapshot.document;
  state.revision = loaded.snapshot.revision;
  state.projectKey = loaded.snapshot.projectKey;
  return loaded.snapshot;
}

export async function seedRoadmapReliabilityFixture(state) {
  if (state.seeded) return { status: "duplicate", snapshot: await readFixtureRepository(state) };
  const { repository } = await fixtureRuntime(state);
  const result = await repository.migrate(state.project, state.document);
  if (result.status !== "ok") throw new Error(`Fixture seed: ${JSON.stringify(result)}`);
  await readFixtureRepository(state);
  state.seeded = true;
  return { status: "seeded", snapshot: snapshot(state) };
}

function codingSession(state, sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error("Unknown fixture session");
  return {
    getState: () => ({ cwd: state.project, ...sessionLink(state, sessionId) }),
    getMessages: () => [],
    getActivePhaseContext: () => session.context,
    setActivePhaseContext: async (context) => {
      session.context = context;
    },
    getRoadmapPhaseLeaseMarker: () => session.marker,
    setRoadmapPhaseLeaseMarker: async (marker) => {
      session.marker = marker;
    },
    getPhaseLeaseRunState: () => "idle",
  };
}

export async function bindFixturePhase(state, sessionId, request) {
  const { binding } = await fixtureRuntime(state);
  const outcome = await binding.bind(request, codingSession(state, sessionId));
  await readFixtureRepository(state);
  return outcome;
}

export async function mutateFixturePhaseLease(state, sessionId, request) {
  const { binding } = await fixtureRuntime(state);
  const outcome = await binding.lease(request, codingSession(state, sessionId));
  await readFixtureRepository(state);
  return outcome;
}

export async function advanceFixtureRevision(state) {
  const { repository } = await fixtureRuntime(state);
  const current = await readFixtureRepository(state);
  const document = structuredClone(current.document);
  document.reference = `Synthetic harmless revision ${current.revision + 1}`;
  const result = await repository.save(state.project, current.revision, document);
  if (result.status !== "ok") throw new Error(`Fixture revision: ${result.status}`);
  await readFixtureRepository(state);
  return { status: "advanced", revision: state.revision };
}

export function fixtureDoneRequest(state, updateId = randomUUID()) {
  return {
    update_id: updateId,
    phase_id: fixturePhaseId,
    expected_revision: state.revision,
    progress: "Completed the isolated immediate-Done scenario",
    evidence: ["Disposable fixture: owner transfer and stale status rejection checked"],
    verification: { result: "passed", reason: null },
    verification_bindings: null,
    proposed_references: null,
    transition: "done",
    blocker: null,
    required_external_action: null,
  };
}

export async function executeFixtureStatus(state, sessionId, request, broadcast = () => {}) {
  const runtime = await fixtureRuntime(state);
  const session = codingSession(state, sessionId);
  const host = new runtime.Host({
    cwd: state.project,
    repository: runtime.repository,
    durableExecution: true,
    reconciliations: runtime.reconciliations,
    projectAutopilot: { isEnabled: () => false },
    resolvePlanProgress: () => null,
    broadcastNotesSnapshot: (committed) => {
      state.broadcasts.push(structuredClone(committed));
      broadcast(committed);
    },
    mutateStatusWithLeaseFence: (phaseId, operation) =>
      runtime.binding.withStatusLease(session, phaseId, operation),
  });
  const tool = host
    .createSessionTools("coding", () => session)
    .find((item) => item.name === "roadmap_status");
  if (!tool) throw new Error("Runtime did not register roadmap_status");
  const result = JSON.parse(
    String(
      await tool.execute(runtime.params.parse(request), {
        signal: new AbortController().signal,
        toolCallId: randomUUID(),
      }),
    ),
  );
  await readFixtureRepository(state);
  if (result.result === "committed") state.statusUpdates += 1;
  return result;
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function fixtureSessionState(state, sessionId) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: state.project,
    sessionId,
    sessionPath: sessionLink(state, sessionId).sessionPath,
    messageCount: 0,
    mode: "code",
    chatAgent: "general",
    running: false,
    runState: "idle",
    ready: true,
    planMode: false,
    thinkingLevel: null,
    supportedThinkingLevels: [],
    supportsVideo: false,
    autopilot: false,
    kenRunning: false,
    kenIsThinking: false,
    kenThinkingStartTs: null,
    kenThinkingAccumMs: 0,
    kenTokens: 0,
    contextWindow: 200000,
    gitBranch: null,
    isGitRepo: false,
    gitDirtyFileCount: 0,
    tasks: [],
  };
}

export function fixtureDiagnostics(state, sessionId) {
  const phase = currentPhase(state);
  const current = sessionLink(state, sessionId);
  const consistency = !phase.session
    ? "unbound"
    : phase.session.sessionId === sessionId
      ? "consistent"
      : "bound-to-other-session";
  if (!state.notesPaths) throw new Error("Fixture repository is not initialized");
  return {
    version: 1,
    applicationIdentity: state.identity,
    daemonOwner: "node-sidecar",
    agentDataRoot: join(state.root, "agent"),
    canonicalCwd: state.projectKey,
    projectKey: state.projectKey,
    projectNotesStore: {
      primaryPath: state.notesPaths.primary,
      backupPath: state.notesPaths.backup,
    },
    logicalSessionId: sessionId,
    currentSession: current,
    activePhaseContext: { phaseId: phase.id, projectKey: state.projectKey, session: current },
    persistedPhaseBinding: phase.session
      ? { phaseId: phase.id, projectKey: state.projectKey, session: structuredClone(phase.session) }
      : null,
    consistency,
  };
}

export function createRoadmapReliabilityFixtureServer({
  state,
  auditFile,
  fixtureToken,
  launchToken,
}) {
  let sequence = 0;
  const clients = new Map();
  const audit = (entry) =>
    appendFileSync(
      auditFile,
      `${JSON.stringify({ sequence: ++sequence, timestamp: Date.now(), pid: process.pid, ...entry })}\n`,
    );
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/fixture/")) {
        if (request.headers["x-fixture-token"] !== fixtureToken) {
          json(response, 401, { status: "unauthorized" });
          return;
        }
        const body = await readBody(request);
        if (request.method === "POST" && url.pathname === "/fixture/seed") {
          const result = await seedRoadmapReliabilityFixture(state);
          audit({ action: "seed", status: result.status });
          json(response, 200, result);
          return;
        }
        if (request.method === "POST" && url.pathname === "/fixture/advance") {
          const result = await advanceFixtureRevision(state);
          audit({ action: "harmless-revision", revision: result.revision });
          json(response, 200, result);
          return;
        }
        if (request.method === "POST" && url.pathname === "/fixture/status") {
          if (!state.sessions.has(body.sessionId)) {
            json(response, 401, { status: "unknown-session" });
            return;
          }
          const result = await executeFixtureStatus(
            state,
            body.sessionId,
            body.request,
            (committed) => {
              for (const [sessionId, responses] of clients) {
                for (const stream of responses) {
                  stream.write(
                    `data: ${JSON.stringify({ sessionId, type: "notes_change", data: committed })}\n\n`,
                  );
                  audit({ action: "notes-change", sessionId, revision: committed.revision });
                }
              }
            },
          );
          audit({
            action: "status-update",
            sessionId: body.sessionId,
            status: result.result,
            revision: state.revision,
          });
          json(
            response,
            result.result === "committed" || result.result === "duplicate" ? 200 : 409,
            result,
          );
          return;
        }
        if (request.method === "GET" && url.pathname === "/fixture/state") {
          await readFixtureRepository(state);
          json(response, 200, {
            revision: state.revision,
            phase: currentPhase(state),
            phases: state.document.phases,
            tasks: state.document.tasks,
            sessions: [...state.sessions.keys()],
            statusUpdates: state.statusUpdates,
          });
          return;
        }
        const fixtureSession = request.headers["x-gg-session"];
        if (url.pathname === "/fixture/bind" || url.pathname === "/fixture/diagnostics") {
          if (typeof fixtureSession !== "string" || !state.sessions.has(fixtureSession)) {
            json(response, 401, { status: "unknown-session" });
            return;
          }
          if (request.method === "POST" && url.pathname === "/fixture/bind") {
            const result = await bindFixturePhase(state, fixtureSession, body);
            audit({
              action: "phase-binding",
              sessionId: fixtureSession,
              status: result.status,
              revision: state.revision,
            });
            json(response, 200, result);
            return;
          }
          if (request.method === "GET" && url.pathname === "/fixture/diagnostics") {
            json(response, 200, fixtureDiagnostics(state, fixtureSession));
            return;
          }
        }
        json(response, 404, { status: "not-found" });
        return;
      }
      if (!launchToken || request.headers["x-gg-token"] !== launchToken) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/session") {
        while (!state.seeded) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        const body = await readBody(request);
        const restored =
          typeof body.sessionPath === "string"
            ? [...state.sessions.keys()].find(
                (candidate) => sessionLink(state, candidate).sessionPath === body.sessionPath,
              )
            : undefined;
        const sessionId = restored ?? `reliability-session-${state.nextSession++}`;
        state.sessions.set(sessionId, state.sessions.get(sessionId) ?? { clients: new Set() });
        clients.set(sessionId, clients.get(sessionId) ?? new Set());
        audit({ action: restored ? "restored-session" : "authenticated-session", sessionId });
        json(response, 200, { sessionId });
        return;
      }
      const headerSession = request.headers["x-gg-session"];
      const sessionId =
        typeof headerSession === "string" ? headerSession : url.searchParams.get("session");
      if (!sessionId || !state.sessions.has(sessionId)) {
        json(response, 401, { error: "unknown fixture session" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ sessionId, type: "ready", data: fixtureSessionState(state, sessionId) })}\n\n`,
        );
        clients.get(sessionId)?.add(response);
        request.once("close", () => clients.get(sessionId)?.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        json(response, 200, fixtureSessionState(state, sessionId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/notes") {
        await readFixtureRepository(state);
        audit({ action: "notes-read", sessionId, revision: state.revision });
        json(response, 200, {
          status: "ok",
          snapshot: snapshot(state),
          recoveredFromBackup: false,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/notes/diagnostics") {
        const result = fixtureDiagnostics(state, sessionId);
        audit({ action: "diagnostics", sessionId, consistency: result.consistency });
        json(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/notes/roadmap/phase-binding") {
        const body = await readBody(request);
        const leaseRequest = body.version === 2;
        const result = leaseRequest
          ? await mutateFixturePhaseLease(state, sessionId, body)
          : await bindFixturePhase(state, sessionId, body);
        audit({
          action: leaseRequest ? "phase-lease" : "phase-binding",
          sessionId,
          status: result.status,
          revision: state.revision,
        });
        json(response, 200, result);
        return;
      }
      // Inactive optional services, matching the daemon's current GET contracts.
      if (request.method === "GET" && url.pathname === "/serve") {
        json(response, 200, { running: false, configured: false });
        return;
      }
      if (request.method === "GET" && url.pathname === "/steroids") {
        json(response, 200, { installed: false, connected: false });
        return;
      }
      if (request.method === "GET" && url.pathname === "/radio") {
        json(response, 200, { stations: [], current: null, volume: 0 });
        return;
      }
      if (request.method === "GET" && url.pathname === "/roadmap/phase-drafts/pending") {
        json(response, 200, { status: "ok", draft: null });
        return;
      }
      if (request.method === "GET" && url.pathname === "/history") {
        json(response, 200, { history: [] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/models") {
        json(response, 200, { models: [] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/commands") {
        json(response, 200, { commands: [] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        json(response, 200, { tasks: [] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/progress") {
        json(response, 200, { xp: 0, level: 1, rank: "Newcomer", nextLevelXp: 100 });
        return;
      }
      if (request.method === "POST" && url.pathname === "/reminders/reserve") {
        json(response, 200, { status: "none" });
        return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/session")) {
        state.sessions.delete(sessionId);
        json(response, 200, { ok: true });
        return;
      }
      audit({ action: "unexpected-route", method: request.method, path: url.pathname });
      json(response, 404, { status: "not-found" });
    } catch (error) {
      audit({
        action: "fixture-error",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) json(response, 500, { error: "fixture request failed" });
      else response.end();
    }
  });
  return { server, audit };
}

function readAudit(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(label, check, { timeoutMs = 120_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
  );
}

async function fixtureFetch(port, fixtureToken, path, init = {}, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-fixture-token": fixtureToken,
      ...init.headers,
    },
  });
  const body = await response.json();
  if (response.status !== expectedStatus)
    throw new Error(`Fixture ${path} failed: ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function sessionFetch(port, fixtureToken, sessionId, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-fixture-token": fixtureToken,
      "x-gg-session": sessionId,
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Session fixture ${path} failed: ${response.status}`);
  return body;
}

function clickByTextExpression(text, rootExpression = "document") {
  return `(() => {
    const root = ${rootExpression};
    const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error(${JSON.stringify(`Missing button: ${text}`)});
    button.click();
    return true;
  })()`;
}

async function openFixturePhase(client, paneIndex) {
  if (!(await client.evaluate("Boolean(document.querySelector('.notes-modal'))"))) {
    await waitFor("enabled Notes button", () =>
      client.evaluate(`(() => {
        const pane = document.querySelectorAll(".agent-pane")[${paneIndex}];
        const button = [...(pane?.querySelectorAll("button") ?? [])].find((candidate) => candidate.getAttribute("aria-label")?.startsWith("Notes"));
        return Boolean(button && !button.disabled);
      })()`),
    );
    await client.evaluate(`(() => {
      const pane = document.querySelectorAll(".agent-pane")[${paneIndex}];
      const button = [...pane.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label")?.startsWith("Notes"));
      button.click();
      return true;
    })()`);
  }
  await waitFor("Notes dialog", () =>
    client.evaluate("Boolean(document.querySelector('.notes-modal'))"),
  );
  await client.evaluate(`document.querySelector("#notes-tab-roadmap").click()`);
  await waitFor("fixture Roadmap phase", () =>
    client.evaluate(
      `Boolean(document.querySelector('[aria-label="Inspect phase: Roadmap reliability fixture"]'))`,
    ),
  );
  await client.evaluate(
    `document.querySelector('[aria-label="Inspect phase: Roadmap reliability fixture"]').click()`,
  );
  await waitFor("fixture phase detail", () =>
    client.evaluate("Boolean(document.querySelector('.notes-phase-detail'))"),
  );
}

async function captureScreenshot(client, path) {
  mkdirSync(dirname(path), { recursive: true });
  const result = await client.send("Page.captureScreenshot", { format: "png" });
  if (!result.data) throw new Error("CDP returned no screenshot data");
  writeFileSync(path, Buffer.from(result.data, "base64"));
}

function safeEnvironment(paths, values) {
  const environment = sanitizedSmokeEnvironment(process.env, paths, values);
  for (const key of Object.keys(environment)) {
    if (
      key !== "GG_ROADMAP_RELIABILITY_FIXTURE_TOKEN" &&
      /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS)(?:$|_)/i.test(
        key,
      )
    ) {
      delete environment[key];
    }
  }
  return environment;
}

export function parseRoadmapReliabilitySmokeArguments(args) {
  const parsed = { identity: null, screenshot: defaultScreenshot, outcome: defaultOutcome };
  const names = { "--identity": "identity", "--screenshot": "screenshot", "--outcome": "outcome" };
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]];
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--"))
      throw new Error(`Invalid smoke argument: ${args[index] ?? "<missing>"}`);
    parsed[key] = value;
  }
  if (parsed.identity !== localForkIdentity)
    throw new Error(`--identity must be ${localForkIdentity}`);
  parsed.screenshot = resolve(parsed.screenshot);
  parsed.outcome = resolve(parsed.outcome);
  return parsed;
}

export function validateRoadmapReliabilityAudit(entries) {
  const sessions = entries.filter((entry) => entry.action === "authenticated-session");
  const bindings = entries.filter((entry) => entry.action === "phase-binding");
  const leases = entries.filter((entry) => entry.action === "phase-lease");
  const commits = entries.filter((entry) => entry.action === "status-update");
  if (
    entries.some((entry) => entry.action === "unexpected-route" || entry.action === "fixture-error")
  ) {
    throw new Error("Fixture encountered an unsupported route or runtime error");
  }
  if (!entries.some((entry) => entry.action === "notes-change")) {
    throw new Error("Immediate Done did not broadcast notes_change");
  }
  if (sessions.length < 2) throw new Error("Fixture did not create two pane sessions");
  if (bindings.map((entry) => entry.status).join(",") !== "committed") {
    throw new Error("Fixture did not bind the initial phase exactly once");
  }
  if (leases.map((entry) => entry.status).join(",") !== "inspected,acquired") {
    throw new Error("Fixture did not inspect then take over the phase lease exactly once");
  }
  if (
    commits.map((entry) => entry.status).join(",") !== "phase-lease-lost,stale-revision,committed"
  ) {
    throw new Error("Fixture did not reject competing and stale status updates before one commit");
  }
  return {
    sessions: sessions.slice(-2).map((entry) => entry.sessionId),
    bindings,
    leases,
    commits,
  };
}

export async function runRoadmapReliabilityDevSmoke(options) {
  if (process.platform !== "win32")
    throw new Error("Roadmap reliability developer smoke requires Windows");
  if (options.identity !== localForkIdentity)
    throw new Error("Only the Local Fork identity may run this smoke");
  const root = mkdtempSync(join(tmpdir(), "gg-roadmap-reliability-"));
  const paths = createIsolatedProfile(root);
  const fixtureToken = randomUUID();
  const auditFile = join(paths.audit, "roadmap-reliability.jsonl");
  const devLog = join(paths.audit, "tauri-dev.log");
  const portReservation = await reserveHeldTcpPort();
  const cdpPort = portReservation.port;
  await portReservation.release();
  const environment = safeEnvironment(paths, {
    GG_SIDECAR_PATH: fileURLToPath(import.meta.url),
    [fixtureMode]: "sidecar",
    GG_ROADMAP_RELIABILITY_FIXTURE_TOKEN: fixtureToken,
    GG_ROADMAP_RELIABILITY_FIXTURE_ROOT: root,
    GG_ROADMAP_RELIABILITY_FIXTURE_AUDIT: auditFile,
    GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort),
    GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
    GG_APP_DEV_SMOKE_WINDOW: "visible",
    GG_APP_CWD: paths.project,
    COREPACK_HOME:
      process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node", "corepack"),
    COREPACK_DEFAULT_TO_LATEST: "0",
    CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup"),
  });
  mkdirSync(dirname(options.outcome), { recursive: true });
  const logFd = openSync(devLog, "a");
  let child;
  let client;
  let observedIdentities = [];
  let failure;
  let failureAudit = [];
  let failureLogTail = "";
  let result;
  try {
    child = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "pnpm exec tauri dev --config src-tauri/tauri.local.conf.json"],
      {
        cwd: appDir,
        env: environment,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    if (!Number.isInteger(child.pid)) throw new Error("Tauri dev did not expose a process id");
    const unexpectedExit = new Promise((_, rejectExit) => {
      child.once("exit", (code, signal) => {
        let tail = "";
        try {
          tail = readFileSync(devLog, "utf8").slice(-4_000);
        } catch {
          tail = "";
        }
        rejectExit(
          new Error(
            `Tauri dev exited before fixture startup: code=${code} signal=${signal}\n${tail}`,
          ),
        );
      });
    });
    const listening = await Promise.race([
      waitFor(
        "fixture sidecar",
        () => readAudit(auditFile).find((entry) => entry.action === "fixture-listening"),
        { timeoutMs: 300_000 },
      ),
      unexpectedExit,
    ]);
    const sidecarPort = listening.port;
    await fixtureFetch(sidecarPort, fixtureToken, "/fixture/seed", { method: "POST", body: "{}" });
    client = await connectToDevWebview(cdpPort, waitFor, (candidate) =>
      String(candidate.url).startsWith("http://localhost:1420"),
    );
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Page.bringToFront");
    await waitFor("developer app document", () =>
      client.evaluate(
        `location.origin === "http://localhost:1420" && document.readyState === "complete"`,
      ),
    );
    const initialDocument = await waitFor("initial developer app body", () =>
      client.evaluate(
        `document.body?.childElementCount ? ({ paneCount: document.querySelectorAll(".agent-pane").length, text: document.body.innerText.slice(0, 500), buttons: [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()).slice(0, 30), html: document.body.innerHTML.slice(0, 500) }) : null`,
      ),
    );
    if (initialDocument.paneCount > 1) {
      throw new Error(`Unexpected developer app DOM: ${JSON.stringify(initialDocument)}`);
    }
    await waitFor("initial workspace persistence", () =>
      client.evaluate(`Boolean(localStorage.getItem("gg-workspace-layout-recursive:main"))`),
    );
    await client.evaluate(`(() => {
      const layout = {
        version: 9,
        root: { type: "split", direction: "horizontal", size: { type: "ratio", value: 0.5 }, first: { type: "leaf", paneId: "primary" }, second: { type: "leaf", paneId: "pane-b" } },
        focusedPaneId: "primary",
        panes: {
          "primary": { kind: "agent", mode: "code", cwd: ${JSON.stringify(paths.project)}, sessionPath: null },
          "pane-b": { kind: "agent", mode: "code", cwd: ${JSON.stringify(paths.project)}, sessionPath: null }
        }
      };
      localStorage.setItem("gg-workspace-layout-recursive:main", JSON.stringify(layout));
      location.reload();
      return true;
    })()`);
    await waitFor("two rendered panes", () =>
      client.evaluate(`document.querySelectorAll(".agent-pane").length === 2`),
    );
    const paneSessions = await waitFor("two authenticated panes", () => {
      const entries = readAudit(auditFile).filter(
        (entry) => entry.action === "authenticated-session",
      );
      return entries.length >= 2 ? entries.slice(-2).map((entry) => entry.sessionId) : null;
    });
    const [sessionA, sessionB] = paneSessions;
    const seeded = await fixtureFetch(sidecarPort, fixtureToken, "/fixture/state");
    const bound = await sessionFetch(sidecarPort, fixtureToken, sessionA, "/fixture/bind", {
      method: "POST",
      body: JSON.stringify({
        version: 1,
        action: "bind-current",
        phaseId: fixturePhaseId,
        expectedProjectKey: canonicalProjectKey(paths.project),
        expectedRevision: seeded.revision,
        operationId: "fixture-bind-a",
      }),
    });
    if (bound.status !== "committed") throw new Error(`Pane A bind failed: ${bound.status}`);
    await client.evaluate(`(() => {
      const key = "gg-workspace-layout-recursive:main";
      const layout = JSON.parse(localStorage.getItem(key));
      layout.panes.primary.sessionPath = ${JSON.stringify(sessionLink({ root }, sessionA).sessionPath)};
      layout.panes["pane-b"].sessionPath = ${JSON.stringify(sessionLink({ root }, sessionB).sessionPath)};
      localStorage.setItem(key, JSON.stringify(layout));
      location.reload();
      return true;
    })()`);
    await waitFor("restored panes", () =>
      client.evaluate(`document.querySelectorAll(".agent-pane").length === 2`),
    );
    await openFixturePhase(client, 1);
    await client.evaluate(
      clickByTextExpression("More", "document.querySelector('.notes-phase-detail')"),
    );
    const displayed = await waitFor("displayed Local Fork diagnostics", () =>
      client.evaluate(`(() => {
        const section = document.querySelector('.notes-storage-diagnostics');
        if (!section || !section.textContent.includes(${JSON.stringify(localForkIdentity)})) return null;
        return section.textContent;
      })()`),
    );
    await client.evaluate(
      clickByTextExpression("Overview", "document.querySelector('.notes-phase-detail')"),
    );
    await waitFor("phase writer action", () =>
      client.evaluate(
        `Boolean([...document.querySelectorAll('.notes-phase-detail button')].find((button) => button.textContent?.trim() === "Inspect phase writer"))`,
      ),
    );
    await client.evaluate(
      clickByTextExpression(
        "Inspect phase writer",
        "document.querySelector('.notes-phase-detail')",
      ),
    );
    await waitFor("rebind confirmation", () =>
      client.evaluate("Boolean(document.querySelector('[aria-label=\"Confirm phase rebind\"]'))"),
    );
    await client.evaluate(
      clickByTextExpression(
        "Confirm safe takeover",
        "document.querySelector('.notes-phase-detail')",
      ),
    );
    await waitFor("rebind completion", async () => {
      const state = await fixtureFetch(sidecarPort, fixtureToken, "/fixture/state");
      return state.phase.session?.sessionId === sessionB && state.revision === bound.revision + 1;
    });
    const staleA = await sessionFetch(sidecarPort, fixtureToken, sessionA, "/fixture/diagnostics");
    if (staleA.consistency !== "bound-to-other-session")
      throw new Error("Pane A remained authoritative after rebind");
    await waitFor("rebound Notes refresh", async () => {
      const state = await fixtureFetch(sidecarPort, fixtureToken, "/fixture/state");
      return state.phase.session?.sessionId === sessionB && state.revision;
    });
    await client.evaluate("location.reload(); true");
    await waitFor("reloaded rebound panes", () =>
      client.evaluate(`document.querySelectorAll(".agent-pane").length === 2`),
    );
    await openFixturePhase(client, 1);
    const beforeDone = await fixtureFetch(sidecarPort, fixtureToken, "/fixture/state");
    const unrelatedBefore = beforeDone.phases.find((phase) => phase.id === "unrelated-phase");
    const submit = (sessionId, request, expectedStatus) =>
      fixtureFetch(
        sidecarPort,
        fixtureToken,
        "/fixture/status",
        { method: "POST", body: JSON.stringify({ sessionId, request }) },
        expectedStatus,
      );
    const competing = await submit(sessionA, fixtureDoneRequest(beforeDone), 409);
    if (competing.result !== "phase-lease-lost")
      throw new Error("Competing runner was not rejected");
    const staleRequest = fixtureDoneRequest(beforeDone);
    await fixtureFetch(sidecarPort, fixtureToken, "/fixture/advance", {
      method: "POST",
      body: "{}",
    });
    const stale = await submit(sessionB, staleRequest, 409);
    if (stale.result !== "stale-revision") throw new Error("Stale status was not rejected");
    const refreshed = await fixtureFetch(sidecarPort, fixtureToken, "/fixture/state");
    if (refreshed.phase.status !== "in-progress" || refreshed.statusUpdates !== 0) {
      throw new Error("Rejected status update mutated the phase");
    }
    const committed = await submit(sessionB, fixtureDoneRequest(refreshed), 200);
    if (committed.result !== "committed" || committed.statusOutcome !== "applied") {
      throw new Error(`Immediate Done failed: ${JSON.stringify(committed)}`);
    }
    const doneVisible = `document.querySelector('#notes-phase-overview-${fixturePhaseId}')?.textContent === 'Done'`;
    // Do not reload: this observation must come from the production host's notes_change.
    await waitFor("immediate Done rendered from notes_change", () => client.evaluate(doneVisible));
    await captureScreenshot(client, options.screenshot);
    const finalState = await fixtureFetch(sidecarPort, fixtureToken, "/fixture/state");
    if (
      finalState.phase.status !== "done" ||
      finalState.statusUpdates !== 1 ||
      finalState.phases.length !== 2 ||
      finalState.tasks.length !== 0 ||
      JSON.stringify(finalState.sessions) !== JSON.stringify(beforeDone.sessions) ||
      JSON.stringify(finalState.phases.find((phase) => phase.id === "unrelated-phase")) !==
        JSON.stringify(unrelatedBefore) ||
      finalState.phase.roadmapEvents.some((event) => event.type === "manual-completion-approval")
    ) {
      throw new Error("Immediate Done changed unrelated work or required manual approval");
    }
    await client.evaluate("location.reload(); true");
    await waitFor("restarted panes", () =>
      client.evaluate(`document.querySelectorAll('.agent-pane').length === 2`),
    );
    await openFixturePhase(client, 1);
    await waitFor("Done preserved after restart/read", () => client.evaluate(doneVisible));
    const audit = readAudit(auditFile);
    const validation = validateRoadmapReliabilityAudit(audit);
    const tree = processTreeSnapshot(await readProcessTable(), child.pid);
    observedIdentities = tree.identities;
    result = {
      status: "passed",
      identity: options.identity,
      project: canonicalProjectKey(paths.project),
      diagnosticsDisplayed: displayed.includes(localForkIdentity),
      paneSessions: validation.sessions,
      stalePaneConsistency: staleA.consistency,
      competingRunnerRejected: competing.result === "phase-lease-lost",
      staleStatusRejected: stale.result === "stale-revision",
      statusUpdates: finalState.statusUpdates,
      immediateDoneRendered: true,
      webviewReloadPreserved: true,
      unrelatedPhaseUnchanged: true,
      fixtureAudit: audit,
      finalSnapshot: finalState,
      packagedRuntimeVerified: false,
      installerVerified: false,
      screenshot: options.screenshot,
      fixturePids: observedIdentities.map(({ pid }) => pid),
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      client?.close();
      if (Number.isInteger(child?.pid)) await terminateProcessTree(child.pid);
      const survivors = observedIdentities.length
        ? survivingProcessIds(observedIdentities, await readProcessTable())
        : [];
      if (survivors.length)
        throw new Error(`Fixture processes survived cleanup: ${survivors.join(", ")}`);
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
    closeSync(logFd);
    if (failure) {
      failureAudit = readAudit(auditFile).slice(-40);
      try {
        failureLogTail = readFileSync(devLog, "utf8").slice(-4_000);
      } catch {
        failureLogTail = "";
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  const outcome =
    !failure && result
      ? result
      : {
          status: "failed",
          identity: options.identity,
          error: failure instanceof Error ? failure.message : String(failure),
          fixtureAudit: failureAudit,
          developerLogTail: failureLogTail,
        };
  writeFileSync(options.outcome, `${JSON.stringify(outcome, null, 2)}\n`);
  if (failure) throw failure;
  process.stdout.write(`ROADMAP RELIABILITY DEV SMOKE PASS: ${options.outcome}\n`);
  return outcome;
}

async function runFixtureSidecar() {
  const root = process.env.GG_ROADMAP_RELIABILITY_FIXTURE_ROOT;
  const project = process.env.GG_APP_CWD;
  const auditFile = process.env.GG_ROADMAP_RELIABILITY_FIXTURE_AUDIT;
  const fixtureToken = process.env.GG_ROADMAP_RELIABILITY_FIXTURE_TOKEN;
  const launchToken = process.env.GG_APP_TOKEN;
  if (!root || !project || !auditFile || !fixtureToken || !launchToken) {
    throw new Error("Roadmap reliability fixture environment is incomplete");
  }
  const state = createRoadmapReliabilityFixtureState({ root, project });
  await seedRoadmapReliabilityFixture(state);
  const fixture = createRoadmapReliabilityFixtureServer({
    state,
    auditFile,
    fixtureToken,
    launchToken,
  });
  fixture.server.listen(Number(process.env.GG_APP_PORT ?? 0), "127.0.0.1", () => {
    const address = fixture.server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture sidecar did not bind a port");
    fixture.audit({ action: "fixture-listening", port: address.port });
    process.stdout.write(`GG_APP_LISTENING ${address.port}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => fixture.server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env[fixtureMode] === "sidecar") {
    runFixtureSidecar().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  } else {
    try {
      const options = parseRoadmapReliabilitySmokeArguments(process.argv.slice(2));
      runRoadmapReliabilityDevSmoke(options).catch((error) => {
        console.error(
          `ROADMAP RELIABILITY DEV SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
