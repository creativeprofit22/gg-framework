// Replays the 2026-11-01 "/steroids" stall natively: a scripted agent drives the minimized
// developer app through the dev_app tool, against the real daemon and a scripted Azure provider.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(app, "..");
const identity = "com.ggcoder.local-fork";
const MARKER = "STEROIDS-REPLAY-FIXTURE";
const RESULT = "STEROIDS-REPLAY-RESULT";
const HOLD_MS = 2500;
const SECRET_KEY =
  /(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS|^AZURE_|^HOMEDRIVE$|^HOMEPATH$)/i;
const providerEnvironment = {
  AZURE_OPENAI_API_KEY: "fixture-not-a-credential",
  AZURE_OPENAI_BASE_URL: "https://dev-app-replay-provider.invalid/openai/v1/responses",
  AZURE_OPENAI_DEPLOYMENT: "fixture",
};
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}

function portAnswers(port, host) {
  return new Promise((done) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("timeout", () => (socket.destroy(), done(false)));
    socket.once("error", () => done(false));
  });
}

function freePort() {
  return new Promise((done, fail) => {
    const server = net.createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function processTable() {
  return new Promise((done, fail) =>
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + ' ' + $_.ParentProcessId }",
      ],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    ),
  );
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Scripted agent turns: one model call per step, mirroring what the 2026-11-01 agent needed to do.
function agentScript(port) {
  return [
    { label: "load dev_app", tool: "tool_search", args: { query: "dev_app" } },
    { label: "attach", tool: "dev_app", args: { action: "open", mode: "attach", port } },
    { label: "first snapshot", tool: "dev_app", args: { action: "snapshot" } },
    {
      label: "broken send (menu left open)",
      tool: "dev_app",
      args: { action: "act", kind: "send_prompt", text: "/steroids" },
      expectError: "menu_swallowed_key",
    },
    {
      label: "close the menu",
      tool: "dev_app",
      args: { action: "act", kind: "press", key: "Escape", expect: { kind: "menu_closed" } },
    },
    {
      label: "send with Enter",
      tool: "dev_app",
      args: {
        action: "act",
        kind: "press",
        key: "Enter",
        expect: { kind: "status_is", value: "Working" },
      },
    },
    {
      label: "read the result",
      tool: "dev_app",
      args: {
        action: "snapshot",
        expect: { kind: "text_appears", value: RESULT },
        deadline_ms: 30_000,
      },
    },
    { label: "detach", tool: "dev_app", args: { action: "close" } },
  ];
}

async function run() {
  const { values: args } = parseArgs({ options: { identity: { type: "string" } }, strict: true });
  assert.equal(process.platform, "win32", "The native replay launches the Windows developer app");
  assert.equal(args.identity, identity, `Pass --identity ${identity}`);
  for (const file of [
    "packages/ggcoder/dist/app-sidecar.js",
    "packages/ggcoder/dist/dev-app-driver/index.js",
    "packages/ggcoder/dist/core/agent-session.js",
    "packages/gg-ai/dist/index.js",
  ])
    assert.ok(existsSync(join(workspace, file)), `Build first: ${file} is missing`);
  // Vite is pinned to 1420; never stop or reuse someone else's dev server.
  if ((await portAnswers(1420, "127.0.0.1")) || (await portAnswers(1420, "::1")))
    throw new Error("Port 1420 is in use (another dev server?); stop it yourself and rerun");

  const driver = await import(
    pathToFileURL(join(workspace, "packages/ggcoder/dist/dev-app-driver/index.js")).href
  );
  const started = Date.now();
  const out = resolve(workspace, ".gg/eyes/out/dev-app-replay", String(started));
  mkdirSync(out, { recursive: true });
  const evidence = {
    boundary:
      "Isolated Windows developer Tauri WebView2 (minimized), real Rust IPC and native transport, real Node daemon (dist/app-sidecar.js), scripted local Azure Responses provider, scripted palsu agent driving the dev_app tool in-process. No real model, installed app or visible-window check.",
    status: "running",
    stage: "setup",
    calls: [],
    checks: [],
    gaps: [],
    provider: { requests: 0, commandRequests: 0 },
    cleanup: { status: "not-reached" },
  };
  const root = mkdtempSync(join(tmpdir(), "gg-dev-app-replay-"));
  const scrub = (text) =>
    String(text).split(root).join("<profile>").replaceAll(root.replaceAll("\\", "/"), "<profile>");
  let server;
  let session;
  let agent;
  let palsu;
  let logFd;
  let ownedTree = [];
  const stopNow = () => session?.stopNow();
  process.once("exit", stopNow);
  try {
    const paths = driver.createIsolatedProfile(join(root, "app"));
    const agentDir = join(paths.home, ".gg/identities", identity);
    mkdirSync(join(agentDir, "commands"), { recursive: true });
    writeFileSync(
      join(agentDir, "commands/steroids.md"),
      `---\nname: steroids\ndescription: Harmless replay fixture\n---\nHarmless replay fixture; answer with the result marker. ${MARKER} $ARGUMENTS\n`,
    );
    json(join(agentDir, "auth.json"), {});
    json(join(agentDir, "settings.json"), {
      defaultProvider: "azure",
      defaultModel: "azure:fixture",
      autoCompact: false,
      idealReviewEnabled: false,
    });
    writeFileSync(join(paths.project, "README.md"), "Disposable replay fixture project.\n");

    evidence.stage = "provider";
    server = http.createServer(async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/openai/v1/responses");
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          assert.ok(size < 2_000_000);
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        evidence.provider.requests += 1;
        const command = body.includes(MARKER);
        if (command) {
          evidence.provider.commandRequests += 1;
          // Long enough for the pane to show Working between two reads.
          await sleep(HOLD_MS);
        }
        const events = [
          {
            type: "response.output_text.delta",
            delta: command ? `${RESULT}: fixture command ran.` : "Fixture reply.",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 4 } },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } catch (error) {
        evidence.provider.failure ??= scrub(error.message).slice(0, 300);
        response.writeHead(400);
        response.end("Fixture rejected request");
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const providerUrl = `http://127.0.0.1:${server.address().port}/openai/v1/responses`;

    evidence.stage = "launch";
    const cdpPort = await freePort();
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !SECRET_KEY.test(key)),
    );
    const env = driver.devAppEnvironment(base, paths, {
      cdpPort,
      window: "minimized",
      extra: {
        GG_SIDECAR_PATH: fileURLToPath(import.meta.url),
        GG_DEV_APP_REPLAY_MODE: "sidecar",
        GG_DEV_APP_REPLAY_PROVIDER: providerUrl,
        COREPACK_HOME:
          process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node/corepack"),
        COREPACK_DEFAULT_TO_LATEST: "0",
        CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
        RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup"),
      },
    });
    logFd = openSync(join(paths.audit, "developer.log"), "a");
    const launchStart = Date.now();
    session = await driver.launchDevApp({
      appDir: app,
      configPath: join(app, "src-tauri", "tauri.local.conf.json"),
      env,
      cdpPort,
      // A cold Rust build plus daemon start can take minutes.
      readyDeadlineMs: 900_000,
      stdio: ["ignore", logFd, logFd],
    });
    evidence.launchMs = Date.now() - launchStart;
    const client = session.client;

    evidence.stage = "seed-pane";
    const seeded = await waitFor(
      "workspace layout",
      async () => {
        const state = await client.evaluate(driver.seedAgentPaneScript(paths.project));
        return state === "seeded" || state === "has-pane" ? state : null;
      },
      60_000,
    );
    evidence.checks.push(`Workspace pane: ${seeded}`);
    const paneId = await waitFor(
      "rendered Code pane",
      () =>
        client.evaluate(
          `document.querySelector('.agent-pane textarea') && document.querySelector('[data-pane-id] .agent-pane')?.closest('[data-pane-id]')?.dataset.paneId`,
        ),
      300_000,
    );
    const state = await waitFor(
      "daemon session on the fixture provider",
      () =>
        client.evaluate(
          `window.__TAURI_INTERNALS__.invoke('agent_state', { paneId: ${JSON.stringify(paneId)} }).then((s) => s.ready && s.provider === 'azure' ? { provider: s.provider, model: s.model } : null)`,
        ),
      300_000,
    );
    assert.equal(state.model, "azure:fixture");
    evidence.checks.push("Real daemon session ready on the scripted azure:fixture provider");
    const commands = await waitFor(
      "fixture command listed",
      () =>
        client.evaluate(
          `window.__TAURI_INTERNALS__.invoke('agent_commands', { paneId: ${JSON.stringify(paneId)} }).then((r) => JSON.stringify(r).includes('steroids')).catch(() => null)`,
        ),
      30_000,
    ).catch(() => null);
    if (commands) evidence.checks.push("Daemon lists the fixture /steroids command over IPC");
    else
      evidence.gaps.push(
        "Could not read the command list over IPC before the run; the slash menu itself is checked by the replay.",
      );

    evidence.stage = "agent";
    const agentHome = join(root, "agent-home");
    const agentCwd = join(root, "agent-cwd");
    mkdirSync(join(agentHome, ".gg"), { recursive: true });
    mkdirSync(agentCwd, { recursive: true });
    json(join(agentHome, ".gg/auth.json"), {
      palsu: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    });
    for (const key of Object.keys(process.env))
      if (/^GG_/.test(key) || SECRET_KEY.test(key)) delete process.env[key];
    Object.assign(process.env, { HOME: agentHome, USERPROFILE: agentHome });
    const ai = await import(pathToFileURL(join(workspace, "packages/gg-ai/dist/index.js")).href);
    const { AgentSession } = await import(
      pathToFileURL(join(workspace, "packages/ggcoder/dist/core/agent-session.js")).href
    );
    palsu = ai.registerPalsuProvider();
    const script = agentScript(cdpPort);
    palsu.appendResponses(
      ...script.map((step, index) => ai.palsuToolCall(step.tool, step.args, `replay-${index + 1}`)),
      ai.palsuText(
        "Replay finished: the swallowed send was caught, the command ran and the result was read.",
      ),
    );
    agent = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5-5",
      cwd: agentCwd,
      systemPrompt: "Scripted dev-app replay.",
    });
    await agent.initialize();
    const startedAt = new Map();
    agent.eventBus.on("tool_call_start", (event) => startedAt.set(event.toolCallId, Date.now()));
    agent.eventBus.on("tool_call_end", (event) => {
      const index = Number(event.toolCallId.replace("replay-", "")) - 1;
      const step = script[index];
      const first = scrub(
        String(event.result)
          .split("\n")
          .find((line) => line.trim()) ?? "",
      ).slice(0, 240);
      evidence.calls.push({
        step: index + 1,
        label: step?.label ?? event.toolCallId,
        tool: step?.tool,
        isError: event.isError,
        durationMs: event.durationMs,
        firstLine: first,
        ...(index === script.length - 2
          ? { resultSeen: String(event.result).includes(RESULT) }
          : {}),
      });
      if (!startedAt.has(event.toolCallId)) startedAt.set(event.toolCallId, Date.now());
    });
    const replayStart = Date.now();
    await agent.prompt(
      "Smoke test /steroids in the dev app the user started; its control port is given.",
    );
    evidence.replayWallMs = Date.now() - replayStart;
    evidence.modelCalls = palsu.state.callCount;
    evidence.pendingScriptedResponses = palsu.getPendingResponseCount();

    evidence.stage = "assert";
    const byStep = (n) => evidence.calls.find((call) => call.step === n);
    assert.equal(evidence.calls.length, script.length, "every scripted call ran");
    for (const [index, step] of script.entries()) {
      const call = byStep(index + 1);
      if (step.expectError) {
        assert.ok(
          call.isError && call.firstLine.includes(`[${step.expectError}]`),
          `${step.label}: expected [${step.expectError}], got ${call.firstLine}`,
        );
      } else assert.ok(!call.isError, `${step.label} failed: ${call.firstLine}`);
    }
    const broken = byStep(4);
    assert.ok(broken.durationMs < 5000, `broken send took ${broken.durationMs} ms`);
    evidence.checks.push(
      `Broken send with the slash menu open failed with [menu_swallowed_key] in ${broken.durationMs} ms`,
    );
    assert.match(byStep(6).firstLine, /^confirmed/);
    evidence.checks.push(
      `Enter after Escape confirmed the pane shows Working in ${byStep(6).durationMs} ms`,
    );
    assert.equal(byStep(7).resultSeen, true);
    assert.match(byStep(7).firstLine, /^confirmed/);
    evidence.checks.push(
      `Snapshot wait confirmed the fixture result text in ${byStep(7).durationMs} ms`,
    );
    assert.equal(
      evidence.provider.commandRequests,
      1,
      "the expanded command reached the provider exactly once",
    );
    evidence.checks.push("Scripted provider received the expanded /steroids command exactly once");
    assert.ok(
      session.client.goneReason === null && alive(session.pid),
      "attached close left the app running",
    );
    evidence.checks.push("dev_app close detached without stopping the app it did not launch");
    evidence.after = {
      wallTimeSeconds: Math.round(evidence.replayWallMs / 100) / 10,
      assistantTurns: script.length + 1,
      modelCalls: evidence.modelCalls,
      retries: { resentPrompts: 0, relaunches: 0, recoveryActions: 1 },
      idleWaitSeconds:
        Math.round(
          evidence.calls
            .filter((call) => call.isError)
            .reduce((sum, call) => sum + call.durationMs, 0) / 100,
        ) / 10,
      idleWaitDefinition:
        "time inside dev_app calls that ended in an error while the app sat idle (only the caught broken send)",
    };
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.assertion = scrub(error instanceof Error ? error.message : String(error)).slice(
      0,
      800,
    );
    process.exitCode = 1;
  } finally {
    evidence.stage = evidence.status === "passed" ? "cleanup" : `cleanup after ${evidence.stage}`;
    const errors = [];
    const attempt = async (label, action) => {
      try {
        await action();
      } catch (error) {
        errors.push(`${label}: ${scrub(error.message ?? error).slice(0, 200)}`);
      }
    };
    await attempt("agent", async () => agent?.dispose());
    await attempt("palsu", async () => palsu?.unregister());
    if (session?.pid) {
      await attempt("tree", async () => {
        const { descendantsFromTable } = await import(
          pathToFileURL(join(workspace, "packages/ggcoder/dist/dev-app-driver/index.js")).href
        );
        ownedTree = [session.pid, ...descendantsFromTable(await processTable(), session.pid)];
      });
    }
    await attempt("app", async () => session?.stop());
    await attempt("provider", async () => {
      if (!server) return;
      server.closeAllConnections();
      if (server.listening)
        await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())));
    });
    if (logFd !== undefined) await attempt("log", async () => closeSync(logFd));
    await sleep(1000);
    const survivors = ownedTree.filter(alive);
    const viteStillUp = (await portAnswers(1420, "127.0.0.1")) || (await portAnswers(1420, "::1"));
    if (survivors.length) errors.push(`${survivors.length} owned processes survived`);
    if (viteStillUp) errors.push("port 1420 still answers after cleanup");
    await attempt("profile", async () =>
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }),
    );
    evidence.cleanup = {
      status: errors.length ? "failed" : "passed",
      ownedProcesses: ownedTree.length,
      survivors: survivors.length,
      errors,
    };
    if (errors.length && evidence.status === "passed") {
      evidence.status = "failed";
      process.exitCode = 1;
    }
    evidence.totalWallMs = Date.now() - started;
    json(join(out, "result.json"), evidence);
    process.removeListener("exit", stopNow);
    console.log(
      JSON.stringify({
        status: evidence.status,
        stage: evidence.stage,
        output: out,
        assertion: evidence.assertion,
      }),
    );
    console.log(
      evidence.status === "passed"
        ? "DEV APP REPLAY DEV SMOKE PASS (one minimized developer launch; no packaging)"
        : "DEV APP REPLAY DEV SMOKE FAIL",
    );
  }
}

if (process.env.GG_DEV_APP_REPLAY_MODE === "sidecar") {
  // Daemon wrapper: only the provider transport is redirected; the daemon itself is production code.
  const url = new URL(process.env.GG_DEV_APP_REPLAY_PROVIDER);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  for (const key of Object.keys(process.env)) if (/^AZURE_/.test(key)) delete process.env[key];
  Object.assign(process.env, providerEnvironment);
  const realFetch = globalThis.fetch;
  const fixtureFetch = (input, init) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (target.href !== providerEnvironment.AZURE_OPENAI_BASE_URL)
      return Promise.reject(new Error("External network unavailable in fixture"));
    return realFetch(url, init);
  };
  globalThis.fetch = fixtureFetch;
  await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/app-sidecar.js")).href);
  // gg-ai's providerFetch defers only to a replaced global, so give it a fresh identity after import.
  globalThis.fetch = (input, init) => fixtureFetch(input, init);
} else await run();
