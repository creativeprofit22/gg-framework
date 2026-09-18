// Opt-in Windows developer verification. Importing this file does not launch anything.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { connectToDevWebview, createIsolatedProfile, reserveHeldTcpPort, sanitizedSmokeEnvironment } from "./phase-25-windows-smoke-helpers.mjs";
import { runSmokeLifecycle, trackOwnedProcess } from "./programmatic-smoke-lifecycle.mjs";
import { readProcessTable, processTreeSnapshot } from "./workspace-shell-evidence.mjs";
import { runQwenScenario, validateQwenEvidence } from "./qwen-connection-smoke-scenario.mjs";

const self = fileURLToPath(import.meta.url);
const app = resolve(dirname(self), "..");
const workspace = resolve(app, "..");
const identity = "com.ggcoder.local-fork";
export const origin = "http://localhost:1420";
const keyEnv = "QWEN_CLOUD_TOKEN_PLAN_KEY";
const synthetic = (stage, run) => `sk-sp-qwen-smoke-${stage}-${run}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

export function smokeWindowMode(args) {
  if (JSON.stringify(args) === JSON.stringify(['--identity', identity])) return 'minimized';
  assert.deepEqual(args, ['--identity', identity, '--visual']);
  return 'visible';
}

export function blockedLocalDiscovery(url, method) {
  return url === 'http://127.0.0.1:11434/v1/models' && method === 'GET';
}

export function frontendReadyOutput(text) {
  return stripVTControlCharacters(text).includes(`${origin}/`);
}

export function secretBearing(text) {
  return /sk-sp-[A-Za-z0-9_-]+|x-gg-(?:token|session)|bearer\s+\S+|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[^\s"',}]+/i.test(text);
}

async function waitFor(label, check, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Unobserved boundary: ${label}`);
}

function hashes() {
  const result = {};
  const walk = (path) => {
    for (const item of readdirSync(join(workspace, path), { withFileTypes: true })) {
      const name = `${path}/${item.name}`;
      assert.ok(!item.isSymbolicLink(), "Hash inputs cannot be links");
      if (item.isDirectory()) walk(name);
      else result[name] = digest(readFileSync(join(workspace, name)));
    }
  };
  for (const path of ["gg-app/src", "gg-app/src-tauri/src", "gg-app/scripts", ...["gg-ai", "gg-agent", "gg-core", "ggcoder"].flatMap((p) => [`packages/${p}/src`, `packages/${p}/dist`])]) walk(path);
  for (const path of ["pnpm-lock.yaml", "gg-app/package.json", "gg-app/vite.config.ts", "gg-app/src-tauri/Cargo.lock", "gg-app/src-tauri/Cargo.toml", "gg-app/src-tauri/build.rs", "gg-app/src-tauri/tauri.conf.json", "gg-app/src-tauri/tauri.local.conf.json"]) result[path] = digest(readFileSync(join(workspace, path)));
  return result;
}

// No raw subprocess output is persisted or echoed. Even failure messages are
// fixed fixture labels, never a CDP exception containing a supplied key.
function capture(child, observations) {
  let tail = "";
  const consume = (chunk) => {
    const text = tail + chunk.toString("utf8");
    if (secretBearing(text)) observations.secretOutput = true;
    if (text.includes("QWEN_SMOKE_INITIAL_ABSENT")) observations.initialAbsent = true;
    if (text.includes("QWEN_SMOKE_CLEANUP_ABSENT")) observations.cleanupAbsent = true;
    tail = text.slice(-1024);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
}

async function finite(command, args, options, observations) {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  capture(child, observations);
  await new Promise((done, reject) => {
    child.once("error", () => reject(new Error("Approved local command could not start")));
    child.once("exit", (code) => code === 0 ? done() : reject(new Error("Approved local command failed; no raw output retained")));
  });
}

async function reserveFrontend() {
  // Cover both localhost families. Never kill a server using this fixed origin.
  const servers = [];
  try {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen({ host, port: 1420, exclusive: true, ipv6Only: host === "::1" }, done);
      });
    }
  } catch {
    for (const server of servers) if (server.listening) server.close();
    throw new Error("localhost:1420 unavailable; no existing server was stopped");
  }
  return async () => {
    for (const server of servers) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  };
}

async function sidecar() {
  const run = process.env.GG_QWEN_SMOKE_RUN;
  assert.match(run ?? "", /^[a-f0-9]{32}$/);
  const audit = process.env.GG_QWEN_SMOKE_AUDIT;
  assert.ok(audit && resolve(audit) === audit);
  const provider = new URL(process.env.GG_QWEN_SMOKE_PROVIDER);
  assert.equal(provider.hostname, "127.0.0.1");
  assert.equal(provider.protocol, "http:");
  assert.equal(provider.pathname, "/openai/v1/responses");
  const deniedPath = join(audit, `network-denied-${process.pid}.json`);
  const deny = () => {
    if (!existsSync(deniedPath)) json(deniedPath, { denied: true });
    throw new Error("Network request refused by Qwen fixture");
  };
  const value = process.env[keyEnv];
  const observation = { pid: process.pid, parentPid: process.ppid, present: value !== undefined,
    matchesSave: value === synthetic("save", run), matchesReplace: value === synthetic("replace", run),
    matchesInherited: value === synthetic("inherited", run) };
  json(join(audit, `daemon-${process.pid}.json`), observation);
  for (const key of Object.keys(process.env)) if (/^AZURE_/i.test(key)) delete process.env[key];
  const endpoint = "https://qwen-smoke.openai.azure.com/openai/v1/responses";
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: "synthetic-local-fixture", AZURE_OPENAI_BASE_URL: endpoint, AZURE_OPENAI_DEPLOYMENT: "fixture" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (blockedLocalDiscovery(target.href, method)) {
      // The real daemon auto-probes Ollama. Suppress this metadata-only probe
      // without contacting any user's server; no model discovery is replaced.
      const path = join(audit, `local-discovery-blocked-${process.pid}.json`);
      if (!existsSync(path)) json(path, { blocked: true, kind: 'default-local-model-metadata' });
      return Promise.reject(new Error('Local model discovery disabled by isolated fixture'));
    }
    if (target.href !== endpoint || method !== 'POST') return Promise.reject(deny());
    return realFetch(provider, init);
  };
  // Also deny alternate Node transports. The one local synthetic fetch is the
  // only permitted outbound socket; the production daemon can still listen.
  for (const transport of [http, https]) {
    transport.request = deny;
    transport.get = deny;
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (!first || typeof first !== "object" || first.host !== "127.0.0.1" || Number(first.port) !== Number(provider.port)) return deny();
    return connect.apply(this, args);
  };
  syncBuiltinESMExports();
  // No loader hooks: reload handlers, auth/model discovery, sessions and IPC are real.
  await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/app-sidecar.js")).href);
}

export async function run() {
  assert.equal(process.platform, "win32");
  const windowMode = smokeWindowMode(process.argv.slice(2));
  const releaseFrontend = await reserveFrontend();
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gg-qwen-native-")));
  const paths = createIsolatedProfile(root);
  const runId = randomBytes(16).toString("hex");
  const evidence = { version: 1, runId, origin, windowMode, windows: [], stages: [], daemons: [], cleanup: {}, passed: false };
  const observations = { secretOutput: false, initialAbsent: false, cleanupAbsent: false };
  const owned = [];
  const clients = [];
  let providerServer;
  let providerRequests = 0;
  let providerRejected = false;
  let env;
  let before;
  let artifactHash;
  let frontendReleased = false;
  let native;
  const binary = join(app, "src-tauri/target/debug/gg-app.exe");
  console.log(`Qwen smoke evidence (disposable, retained on failure): ${paths.audit}`);
  const progress = (stage) => {
    evidence.lastBoundary = stage;
    writeFileSync(join(paths.audit, 'stage-progress.json'), JSON.stringify({ stage, at: new Date().toISOString() }));
  };
  const guarded = (label, action) => async () => {
    try { return await action(); } catch (error) {
      const wait = /^Unobserved boundary: [a-zA-Z0-9 -]{1,100}$/.test(error?.message ?? '') ? error.message : null;
      if (wait) evidence.unobserved = wait;
      const sourceLocation = error?.stack?.match(/qwen-connection-smoke-scenario\.mjs:(\d+):(\d+)/);
      if (sourceLocation) evidence.assertionLocation = { file: 'qwen-connection-smoke-scenario.mjs', line: Number(sourceLocation[1]), column: Number(sourceLocation[2]) };
      throw new Error(`Qwen fixture boundary failed: ${evidence.lastBoundary ?? label}${wait ? `; ${wait}` : ''}`);
    }
  };
  await runSmokeLifecycle({
    audit: paths.audit,
    workflow: guarded("workflow; see stage-progress.json", async () => {
      progress('debug-build');
      before = hashes();
      json(join(paths.audit, "input-hashes-before.json"), before);
      const agentDir = join(paths.home, ".gg/identities", identity);
      mkdirSync(agentDir, { recursive: true });
      json(join(agentDir, "auth.json"), {});
      // Recovery must resume durable sessions, not freshly-created blank targets
      // whose restore descriptor deliberately has no session path.
      const { SessionManager } = await import(pathToFileURL(join(workspace, 'packages/ggcoder/dist/core/session-manager.js')).href);
      const sessions = new SessionManager(join(agentDir, 'sessions'));
      paths.sessions = await Promise.all([0, 1].map(() => sessions.create(paths.project, 'azure', 'azure:fixture')));
      json(join(agentDir, "settings.json"), { defaultProvider: "azure", defaultModel: "azure:fixture", autoCompact: false, idealReviewEnabled: false, mcpServers: {} });
      json(join(paths.project, "package.json"), { name: "qwen-harmless-fixture", private: true });
      env = sanitizedSmokeEnvironment(process.env, paths);
      for (const name of Object.keys(env)) if (/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^AZURE_|^HOMEDRIVE$|^HOMEPATH$|^NODE_OPTIONS$|^NODE_PATH$|PROXY|^NPM_CONFIG_|^CARGO_|^RUST)/i.test(name)) delete env[name];
      const cdp = await reserveHeldTcpPort();
      await cdp.release();
      const config = { ...JSON.parse(readFileSync(join(app, "src-tauri/tauri.local.conf.json"), "utf8")), build: { devUrl: origin } };
      Object.assign(env, { CARGO_NET_OFFLINE: "true", CARGO_PROFILE_DEV_DEBUG_ASSERTIONS: "true", RUSTFLAGS: "-C debug-assertions=yes", COREPACK_ENABLE_NETWORK: "0", COREPACK_DEFAULT_TO_LATEST: "0",
        CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE, ".cargo"),
        RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE, ".rustup"),
        COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA, "node/corepack"),
        TAURI_CONFIG: JSON.stringify(config), GG_NODE_BIN: process.execPath,
        GG_SIDECAR_PATH: self, GG_QWEN_SMOKE_MODE: "sidecar", GG_QWEN_SMOKE_RUN: runId, GG_QWEN_SMOKE_ACTION: "run", GG_QWEN_SMOKE_AUDIT: paths.audit,
        GG_APP_DEV_AUTH_FILE: join(agentDir, "auth.json"), GG_APP_DEV_LOG_DIR: join(paths.audit, "native-logs"),
        GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdp.port), GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1", GG_APP_DEV_SMOKE_WINDOW: windowMode,
        GG_DISABLE_TELEMETRY: "1", [keyEnv]: synthetic("inherited", runId) });
      json(join(paths.audit, "configuration.json"), { runId, config, profile: paths, inheritedSyntheticKey: true, origin, windowMode, cdpPort: cdp.port,
        commands: { build: ["cargo", "build", "--offline", "--locked", "--manifest-path", "gg-app/src-tauri/Cargo.toml", "--bin", "gg-app"],
          vite: [process.execPath, join(app, "node_modules/vite/bin/vite.js"), "--host", "localhost", "--port", "1420", "--strictPort"], native: [binary], cleanup: [binary] } });
      await finite("cargo", ["build", "--offline", "--locked", "--manifest-path", "gg-app/src-tauri/Cargo.toml", "--bin", "gg-app"], { cwd: workspace, env }, observations);
      const builtBytes = readFileSync(binary);
      assert.ok(builtBytes.includes(Buffer.from('QWEN_SMOKE_INITIAL_ABSENT')) && builtBytes.includes(Buffer.from('QWEN_SMOKE_CLEANUP_ABSENT')), 'Refuse a binary without the debug-only isolation startup');
      artifactHash = digest(builtBytes);
      json(join(paths.audit, "artifact-hash.json"), { sha256: artifactHash });
      assert.deepEqual(hashes(), before, "Source/output inputs changed during debug build");
      providerServer = http.createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/openai/v1/responses" || ++providerRequests !== 1) {
          providerRejected = true; response.writeHead(400); response.end(); return;
        }
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1_000_000) { providerRejected = true; request.destroy(); return; }
        }
        // Hold one harmless interactive run until normal native cancel closes it.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(': fixture held until cancel\n\n');
      });
      await new Promise((done, reject) => { providerServer.once("error", reject); providerServer.listen(0, "127.0.0.1", done); });
      env.GG_QWEN_SMOKE_PROVIDER = `http://127.0.0.1:${providerServer.address().port}/openai/v1/responses`;
      json(join(paths.audit, 'runtime-configuration.json'), {
        providerTransport: env.GG_QWEN_SMOKE_PROVIDER, providerBoundary: 'synthetic Azure only',
        node: { path: process.execPath, sha256: digest(readFileSync(process.execPath)), version: process.version },
        credentialStages: ['inherited-synthetic', 'absent', 'save-synthetic', 'replace-synthetic', 'absent'],
        fixtureSessions: paths.sessions.map(({ id, path }) => ({ id, path, sha256: digest(readFileSync(path)) })),
        authFixtureSha256: digest(readFileSync(join(agentDir, 'auth.json'))),
        settingsFixtureSha256: digest(readFileSync(join(agentDir, 'settings.json'))),
      });
      progress('frontend-startup');
      await releaseFrontend(); frontendReleased = true;
      const launch = (command, args, cwd) => {
        const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        capture(child, observations);
        owned.push(trackOwnedProcess(child));
        return child;
      };
      const frontend = launch(process.execPath, [join(app, "node_modules/vite/bin/vite.js"), "--host", "localhost", "--port", "1420", "--strictPort"], app);
      let frontendAnnounced = false;
      let frontendTail = '';
      frontend.stdout.on('data', chunk => {
        frontendTail = (frontendTail + chunk.toString('utf8')).slice(-2048);
        if (frontendReadyOutput(frontendTail)) frontendAnnounced = true;
      });
      await waitFor("owned frontend", async () => {
        assert.equal(frontend.exitCode, null);
        if (!frontendAnnounced) return false;
        try { return (await fetch(origin)).ok; } catch { return false; }
      });
      progress('native-startup');
      assert.equal(digest(readFileSync(binary)), artifactHash, 'Native artifact changed before launch');
      native = launch(binary, [], app);
      await waitFor("isolated vault absence", async () => { assert.equal(native.exitCode, null); return observations.initialAbsent; });
      const targets = new Set();
      const attach = async () => {
        let targetId;
        const client = await connectToDevWebview(cdp.port, async (label, check) => {
          let found;
          await waitFor(label, async () => { assert.equal(native.exitCode, null); try { found = await check(); return Boolean(found); } catch { return false; } });
          return found;
        }, (candidate) => {
          if (new URL(candidate.url).origin !== origin || targets.has(candidate.id)) return false;
          targetId = candidate.id; return true;
        });
        targets.add(targetId); clients.push(client);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        await waitFor("native document", () => client.evaluate(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`));
        const label = await client.evaluate(`window.__TAURI_INTERNALS__.metadata.currentWindow.label`);
        evidence.windows.push({ targetId, label, origin: await client.evaluate("location.origin") });
        return client;
      };
      progress('two-webviews');
      const first = await attach();
      await first.evaluate(`window.__TAURI_INTERNALS__.invoke('new_window')`);
      await attach();
      const daemon = async () => {
        const table = await readProcessTable();
        const tree = processTreeSnapshot(table, native.pid);
        const candidates = readdirSync(paths.audit).filter((name) => /^daemon-\d+\.json$/.test(name)).map((name) => JSON.parse(readFileSync(join(paths.audit, name), "utf8")));
        const live = candidates.flatMap((record) => {
          const entry = tree.identities.find((item) => item.pid === record.pid);
          return entry ? [{ ...record, startedAtMs: entry.startedAtMs }] : [];
        });
        assert.equal(live.length, 1, "One real daemon child must be live");
        return live[0];
      };
      const observeExit = async (previous) => {
        await waitFor("old daemon exit", async () => !(await readProcessTable()).some((p) => p.pid === previous.pid && p.startedAtMs === previous.startedAtMs));
        previous.exited = true;
      };
      await runQwenScenario({ clients, paths, evidence, waitFor, daemon, observeExit, progress,
        keys: { save: synthetic("save", runId), replace: synthetic("replace", runId) }, providerRequests: () => providerRequests });
      assert.equal(providerRequests, 1); assert.equal(providerRejected, false);
      assert.ok(!readdirSync(paths.audit).some((name) => name.startsWith("network-denied-")));
      evidence.networkDeniedAttempts = 0;
      evidence.providerRequests = providerRequests;
      evidence.initialVaultAbsence = observations.initialAbsent;
      return evidence;
    }),
    diagnose: async () => {
      const ui = [];
      for (const client of clients) {
        try {
          ui.push(await client.evaluate(`(async () => {
            let nativeCatalogHasQwen = false, nativeCatalogAvailable = false;
            try {
              const catalog = await window.__TAURI_INTERNALS__.invoke('app_auth_status');
              nativeCatalogAvailable = Array.isArray(catalog.providers);
              nativeCatalogHasQwen = catalog.providers.some(p => p.value === 'qwen-cloud');
            } catch {}
            return { loginPresent: Boolean(document.querySelector('.login-grid')), loginTiles: document.querySelectorAll('.login-tile').length,
              homePresent: Boolean([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Login to AI Providers')),
              qwenTextPresent: document.body.textContent.includes('Qwen Cloud'), loadingProviders: document.body.textContent.includes('Loading providers'),
              nativeCatalogAvailable, nativeCatalogHasQwen, originMatches: location.origin === 'http://localhost:1420',
              tileMatch: Boolean([...document.querySelectorAll('.login-tile')].find(b => b.textContent.includes('Qwen Cloud'))),
              tileLabels: [...document.querySelectorAll('.login-tile-name')].map(e => e.textContent).filter(s => /^[A-Za-z0-9 ()/-]{1,60}$/.test(s)) };
          })()`));
          if (evidence.lastBoundary === 'provisioning') {
            const shot = await client.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(paths.screenshots, `provisioning-${ui.length}.png`), Buffer.from(shot.data, 'base64'));
          }
        } catch { ui.push({ diagnosticAvailable: false }); }
      }
      return { decision: 'VERIFY-BEFORE-SHIP', failureClass: 'unverified-native-boundary',
        lastBoundary: evidence.lastBoundary, windowMode, unobserved: evidence.unobserved ?? null, assertionLocation: evidence.assertionLocation ?? null,
        initialVaultAbsence: observations.initialAbsent, windows: evidence.windows, ui,
        completedStages: evidence.stages, networkDenied: readdirSync(paths.audit).some(name => name.startsWith('network-denied-')) };
    },
    beforeCleanup: async () => {},
    cleanup: guarded("owned process or isolated vault cleanup", async () => {
      const errors = [];
      const reports = [];
      for (const client of clients) { try { client.close(); } catch { errors.push("webview-close"); } }
      for (const owner of owned.reverse()) {
        try { const report = await owner.cleanup(); reports.push(report); if (!report.stopped) errors.push("owned-process"); } catch { errors.push("owned-process"); }
      }
      try {
        const remainingProcesses = await readProcessTable();
        evidence.daemons = [...new Map(evidence.daemons.map(d => [`${d.pid}:${d.startedAtMs}`, d])).values()]
          .map(d => ({ ...d, exited: !remainingProcesses.some(p => p.pid === d.pid && p.startedAtMs === d.startedAtMs) }));
      } catch { errors.push('daemon-exit-observation'); }
      if (providerServer) {
        providerServer.closeAllConnections();
        if (providerServer.listening) await new Promise((done) => providerServer.close(done));
      }
      if (!frontendReleased) await releaseFrontend();
      // Startup absence arms ownership. Never delete a colliding preexisting entry.
      if (observations.initialAbsent) {
        try {
          assert.equal(digest(readFileSync(binary)), artifactHash, 'Refuse cleanup using a replaced binary');
          await finite(binary, [], { cwd: app, env: { ...env, GG_QWEN_SMOKE_ACTION: "cleanup" } }, observations);
        } catch { errors.push("vault-cleanup"); }
      }
      evidence.cleanup = { ownedProcessesStopped: reports.length >= 2 && reports.every((r) => r.stopped), vaultAbsent: observations.cleanupAbsent, providerClosed: !providerServer?.listening,
        processes: reports.map(({ stopped, survivors, identities, rootExited, terminationFailures }) => ({ stopped, survivors, identities, rootExited, terminationFailureCount: terminationFailures?.length ?? 0 })) };
      json(join(paths.audit, "cleanup.json"), { ...evidence.cleanup, errors });
      if (before) {
        const after = hashes(); json(join(paths.audit, "input-hashes-after.json"), after);
        evidence.inputsUnchanged = JSON.stringify(after) === JSON.stringify(before);
      }
      evidence.artifactUnchanged = artifactHash !== undefined && digest(readFileSync(binary)) === artifactHash;
      const sanitizeLogs = (directory) => {
        if (!existsSync(directory)) return;
        for (const item of readdirSync(directory, { withFileTypes: true })) {
          assert.ok(!item.isSymbolicLink(), 'Native log containment');
          const path = join(directory, item.name);
          if (item.isDirectory()) sanitizeLogs(path);
          else if (secretBearing(readFileSync(path, 'utf8'))) {
            observations.secretOutput = true;
            // These are this run's disposable logs, not user files. Fail the
            // smoke but never retain the offending credential-bearing bytes.
            writeFileSync(path, 'Suppressed credential-bearing native output; smoke failed.\n');
          }
        }
      };
      sanitizeLogs(join(paths.audit, 'native-logs'));
      sanitizeLogs(paths.temp);
      evidence.secretOutput = observations.secretOutput;
      assert.equal(errors.length, 0);
    }),
    validate: guarded("evidence checker", async (/* result is the shared evidence */) => {
      validateQwenEvidence(evidence, secretBearing);
      evidence.passed = true;
    }),
  });
  console.log("Qwen two-window developer-native smoke PASS; no installer or remote entitlement claim.");
}

if (process.env.GG_QWEN_SMOKE_MODE === "sidecar") await sidecar();
else if (process.argv[1] && resolve(process.argv[1]) === self) await run();
