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
const localForkIdentity = "com.ggcoder.local-fork";
const fixtureMode = "GG_CROSS_PANE_FIXTURE_MODE";

function canonicalPath(value) {
  const normalized = resolve(value).replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
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

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sessionState(sessionId, session) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: session.cwd,
    sessionId,
    sessionPath: null,
    messageCount: 0,
    mode: "code",
    chatAgent: "general",
    running: session.running,
    runState: session.running ? "running" : "idle",
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

function createFixtureServer({ auditFile, launchToken }) {
  const sessions = new Map();
  let nextSession = 1;
  let sequence = 0;
  const audit = (entry) =>
    appendFileSync(
      auditFile,
      `${JSON.stringify({ sequence: ++sequence, timestamp: Date.now(), ...entry })}\n`,
    );
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers["x-gg-token"] !== launchToken) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await readBody(request);
        const cwd = canonicalPath(typeof body.cwd === "string" ? body.cwd : process.cwd());
        const sessionId = `cross-pane-session-${nextSession++}`;
        sessions.set(sessionId, { cwd, running: false });
        audit({ action: "session-created", sessionId, cwd });
        json(response, 200, { sessionId });
        return;
      }
      const headerSession = request.headers["x-gg-session"];
      const sessionId =
        typeof headerSession === "string" ? headerSession : url.searchParams.get("session");
      const session = sessionId ? sessions.get(sessionId) : null;
      if (!sessionId || !session) {
        json(response, 401, { error: "unknown fixture session" });
        return;
      }
      audit({
        action: "session-request",
        method: request.method,
        path: url.pathname,
        sessionId,
        cwd: session.cwd,
      });
      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ sessionId, type: "ready", data: sessionState(sessionId, session) })}\n\n`,
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        json(response, 200, sessionState(sessionId, session));
        return;
      }
      if (request.method === "POST" && url.pathname === "/prompt") {
        await readBody(request);
        session.running = true;
        audit({ action: "prompt-held", sessionId, cwd: session.cwd });
        json(response, 202, { queued: false, count: 0 });
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
      if (request.method === "DELETE" && url.pathname === "/session") {
        sessions.delete(sessionId);
        audit({ action: "session-disposed", sessionId, cwd: session.cwd });
        json(response, 200, { ok: true });
        return;
      }
      json(response, 200, {});
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

function safeEnvironment(paths, values) {
  const environment = sanitizedSmokeEnvironment(process.env, paths, values);
  for (const key of Object.keys(environment)) {
    if (
      /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS)(?:$|_)/i.test(
        key,
      )
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function parseArguments(args) {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 2 || values[0] !== "--identity" || values[1] !== localForkIdentity) {
    throw new Error(`Usage: --identity ${localForkIdentity}`);
  }
  return { identity: values[1] };
}

export async function runCrossPaneProjectIsolationSmoke({ identity }) {
  if (process.platform !== "win32") throw new Error("Cross-pane developer smoke requires Windows");
  if (identity !== localForkIdentity)
    throw new Error("Only the Local Fork identity may run this smoke");

  const root = mkdtempSync(join(tmpdir(), "gg-cross-pane-projects-"));
  const projectsRoot = join(root, "projects");
  const projectA = join(projectsRoot, "project-a");
  const projectB = join(projectsRoot, "project-b");
  const projectC = join(projectsRoot, "project-c");
  const paths = createIsolatedProfile(root, projectA);
  mkdirSync(projectB, { recursive: true });
  const agentDir = join(paths.home, ".gg");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "gg-app.json"), `${JSON.stringify({ projectsRoot }, null, 2)}\n`);
  const auditFile = join(paths.audit, "cross-pane-project-isolation.jsonl");
  const devLog = join(paths.audit, "tauri-dev.log");
  const portReservation = await reserveHeldTcpPort();
  const cdpPort = portReservation.port;
  await portReservation.release();
  const environment = safeEnvironment(paths, {
    GG_SIDECAR_PATH: fileURLToPath(import.meta.url),
    [fixtureMode]: "sidecar",
    GG_CROSS_PANE_FIXTURE_AUDIT: auditFile,
    GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort),
    GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
    GG_APP_DEV_SMOKE_WINDOW: "minimized",
    GG_APP_CWD: projectA,
    COREPACK_HOME:
      process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node", "corepack"),
    COREPACK_DEFAULT_TO_LATEST: "0",
    CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup"),
  });
  const logFd = openSync(devLog, "a");
  let child;
  let client;
  let processIdentities = [];
  let failure;
  try {
    child = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "pnpm exec tauri dev --config src-tauri/tauri.local.conf.json"],
      { cwd: appDir, env: environment, windowsHide: true, stdio: ["ignore", logFd, logFd] },
    );
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    if (!Number.isInteger(child.pid)) throw new Error("Tauri dev did not expose a process id");
    await waitFor(
      "fixture sidecar",
      () => readAudit(auditFile).find((entry) => entry.action === "fixture-listening"),
      { timeoutMs: 300_000 },
    );
    client = await connectToDevWebview(cdpPort, waitFor, (target) =>
      String(target.url).startsWith("http://localhost:1420"),
    );
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await waitFor("developer app", () =>
      client.evaluate(
        `location.origin === "http://localhost:1420" && document.readyState === "complete"`,
      ),
    );
    await waitFor("initial workspace", () =>
      client.evaluate(`Boolean(localStorage.getItem("gg-workspace-layout-recursive:main"))`),
    );
    await client.evaluate(`(() => {
      localStorage.setItem("gg-workspace-layout-recursive:main", JSON.stringify({
        version: 9,
        root: { type: "split", direction: "horizontal", size: { type: "ratio", value: 0.5 }, first: { type: "leaf", paneId: "primary" }, second: { type: "leaf", paneId: "pane-b" } },
        focusedPaneId: "primary",
        panes: {
          primary: { kind: "agent", mode: "code", cwd: ${JSON.stringify(projectA)}, sessionPath: null },
          "pane-b": { kind: "agent", mode: "code", cwd: ${JSON.stringify(projectB)}, sessionPath: null }
        }
      }));
      location.reload();
      return true;
    })()`);
    await waitFor("isolated A and B panes", () =>
      client.evaluate(`(() => {
        const normalize = (value) => value.replaceAll("\\\\", "/").toLowerCase();
        const a = normalize(document.querySelector("#workspace-pane-primary .chat-head-cwd")?.title ?? "");
        const b = normalize(document.querySelector("#workspace-pane-pane-b .chat-head-cwd")?.title ?? "");
        return a.startsWith(${JSON.stringify(canonicalPath(projectA))}) && b.startsWith(${JSON.stringify(canonicalPath(projectB))});
      })()`),
    );
    const initialSessions = await waitFor("A and B daemon sessions", () => {
      const entries = readAudit(auditFile).filter((entry) => entry.action === "session-created");
      const a = entries.findLast((entry) => entry.cwd === canonicalPath(projectA));
      const b = entries.findLast((entry) => entry.cwd === canonicalPath(projectB));
      return a && b ? { a: a.sessionId, b: b.sessionId } : null;
    });
    await client.evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_prompt", { paneId: "primary", text: "hold", attachments: [], meta: null })`,
    );
    await waitFor("held A prompt", () =>
      readAudit(auditFile).find(
        (entry) => entry.action === "prompt-held" && entry.sessionId === initialSessions.a,
      ),
    );
    await client.evaluate(`(() => {
      const pane = document.querySelector("#workspace-pane-pane-b");
      const back = pane?.querySelector('button[aria-label="Back to this project\\'s sessions"]');
      if (!back) throw new Error("Missing pane B project picker button");
      back.click();
      return true;
    })()`);
    await waitFor("pane B project picker", () =>
      client.evaluate(
        `Boolean([...document.querySelectorAll("#workspace-pane-pane-b button")].find((button) => button.textContent?.trim() === "+ New project"))`,
      ),
    );
    await client.evaluate(`(() => {
      const pane = document.querySelector("#workspace-pane-pane-b");
      [...pane.querySelectorAll("button")].find((button) => button.textContent?.trim() === "+ New project").click();
      return true;
    })()`);
    await waitFor("new project modal", () =>
      client.evaluate(
        `document.querySelector('.modal[role="dialog"] .modal-title')?.textContent?.trim() === "New project"`,
      ),
    );
    await client.evaluate(`(() => {
      const modal = document.querySelector('.modal[role="dialog"]');
      const input = modal.querySelector('input[placeholder="my-project"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "Project C");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      [...modal.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create").click();
      return true;
    })()`);
    const sessionC = await waitFor("project C daemon session", () =>
      readAudit(auditFile)
        .filter((entry) => entry.action === "session-created")
        .findLast((entry) => entry.cwd === canonicalPath(projectC)),
    );
    await waitFor("isolated displayed cwd", () =>
      client.evaluate(`(() => {
        const normalize = (value) => value.replaceAll("\\\\", "/").toLowerCase();
        const a = normalize(document.querySelector("#workspace-pane-primary .chat-head-cwd")?.title ?? "");
        const c = normalize(document.querySelector("#workspace-pane-pane-b .chat-head-cwd")?.title ?? "");
        return a.startsWith(${JSON.stringify(canonicalPath(projectA))}) && c.startsWith(${JSON.stringify(canonicalPath(projectC))});
      })()`),
    );
    const states = await client.evaluate(`Promise.all([
      window.__TAURI_INTERNALS__.invoke("agent_state", { paneId: "primary" }),
      window.__TAURI_INTERNALS__.invoke("agent_state", { paneId: "pane-b" })
    ]).then(([primary, secondary]) => ({ primary, secondary }))`);
    if (
      canonicalPath(states.primary.cwd) !== canonicalPath(projectA) ||
      states.primary.sessionId !== initialSessions.a ||
      states.primary.running !== true
    ) {
      throw new Error(`Primary pane lost A identity: ${JSON.stringify(states.primary)}`);
    }
    if (
      canonicalPath(states.secondary.cwd) !== canonicalPath(projectC) ||
      states.secondary.sessionId !== sessionC.sessionId
    ) {
      throw new Error(`Secondary pane did not bind C: ${JSON.stringify(states.secondary)}`);
    }
    const audit = readAudit(auditFile);
    const stateRequests = audit.filter(
      (entry) => entry.action === "session-request" && entry.path === "/state",
    );
    if (
      !stateRequests.some(
        (entry) => entry.sessionId === initialSessions.a && entry.cwd === canonicalPath(projectA),
      )
    ) {
      throw new Error("Primary state request was not routed through A's session");
    }
    if (
      audit.some(
        (entry) => entry.sessionId === initialSessions.a && entry.cwd === canonicalPath(projectC),
      )
    ) {
      throw new Error("A request was routed with C's session target");
    }
    if (
      !audit.some((entry) => entry.path === "/events" && entry.sessionId === initialSessions.a) ||
      !audit.some((entry) => entry.path === "/events" && entry.sessionId === sessionC.sessionId)
    ) {
      throw new Error("Pane-targeted event bridges were not established for A and C");
    }
    process.stdout.write(
      `CROSS-PANE PROJECT ISOLATION DEV SMOKE PASS: ${JSON.stringify({ primary: initialSessions.a, secondary: sessionC.sessionId })}\n`,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      client?.close();
      if (Number.isInteger(child?.pid)) {
        processIdentities = processTreeSnapshot(await readProcessTable(), child.pid).identities;
        await terminateProcessTree(child.pid);
      }
      const survivors = processIdentities.length
        ? survivingProcessIds(processIdentities, await readProcessTable())
        : [];
      if (survivors.length)
        throw new Error(`Fixture processes survived cleanup: ${survivors.join(", ")}`);
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
    closeSync(logFd);
    if (!failure) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  if (failure) {
    throw new Error(
      `${failure instanceof Error ? failure.message : String(failure)}\nFixture retained at ${root}\n${readFileSync(devLog, "utf8").slice(-4_000)}`,
    );
  }
}

async function runFixtureSidecar() {
  const auditFile = process.env.GG_CROSS_PANE_FIXTURE_AUDIT;
  const launchToken = process.env.GG_APP_TOKEN;
  if (!auditFile || !launchToken) throw new Error("Cross-pane fixture environment is incomplete");
  const fixture = createFixtureServer({ auditFile, launchToken });
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
      runCrossPaneProjectIsolationSmoke(parseArguments(process.argv.slice(2))).catch((error) => {
        console.error(
          `CROSS-PANE PROJECT ISOLATION DEV SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
