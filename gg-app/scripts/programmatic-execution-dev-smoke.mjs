import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import http from "node:http";
import { assertDiscoveryHandoff } from "./programmatic-discovery-observer.mjs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { connectToDevWebview, createIsolatedProfile, reserveHeldTcpPort, sanitizedSmokeEnvironment } from "./phase-25-windows-smoke-helpers.mjs";
import { readProcessTable, processTreeSnapshot } from "./workspace-shell-evidence.mjs";
import { runSmokeLifecycle, validateNativeSmokeEvidence, trackOwnedProcess, waitForLiveProcess } from "./programmatic-smoke-lifecycle.mjs";
import { createNativeInputSmoke } from "./programmatic-native-input-smoke.mjs";
import { smokeLabels, smokeButton, revealSmokeTarget, assessmentWorkflowStep, assessmentRequestCount, readExecutionDisplay, assertTranscriptIsolation, extendedWorkflowStep, extendedRequestCount, extendedCommandName } from "./programmatic-execution-smoke-checks.mjs";

import { discoveryWorkflowStep, discoveryRequestCount, runDiscoverySmoke } from "./programmatic-discovery-smoke.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(app, "..");
const identity = "com.ggcoder.local-fork";
const fixtureBody = "Harmless read-only research fixture. Read package.json, then report the selected success condition with tool evidence. FIXTURE EXACT SPECIALIST $ARGUMENTS";
const completion = "Isolated fixture manifest inspected.";
const mode = process.env.GG_PROGRAMMATIC_EXECUTION_FIXTURE_MODE;
const providerEnvironment = {
  AZURE_OPENAI_API_KEY: "fixture-not-a-credential",
  AZURE_OPENAI_BASE_URL: "https://programmatic-provider.invalid/openai/v1/responses",
  AZURE_OPENAI_DEPLOYMENT: "fixture",
};
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
async function waitFor(label, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}
function snapshot(directory, prefix = "") {
  const result = {};
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}${item.name}`;
    if (item.isSymbolicLink()) throw new Error("Unexpected fixture link");
    if (item.isDirectory()) Object.assign(result, snapshot(join(directory, item.name), `${relative}/`));
    else result[relative] = createHash("sha256").update(readFileSync(join(directory, item.name))).digest("hex");
  }
  return result;
}

function seed(paths, discoveryOnly = false) {
  if (discoveryOnly) {
    writeFileSync(join(paths.project, ".gitignore"), ".gg/\n");
    writeFileSync(join(paths.project, "AGENTS.md"), "Disposable read-only discovery fixture. Never create or execute commands during review.\n");
    json(join(paths.project, "package.json"), { name: "harmless-isolated-fixture" });
    return {};
  }
  mkdirSync(join(paths.project, "src-tauri"), { recursive: true });
  writeFileSync(join(paths.project, ".gitignore"), ".gg/\n");
  writeFileSync(join(paths.project, "AGENTS.md"), "NECESSARY FIXTURE PROJECT INSTRUCTIONS\n");
  json(join(paths.project, "package.json"), { name: "harmless-isolated-fixture" });
  writeFileSync(join(paths.project, "src-tauri/Cargo.toml"), "[package]\nname='fixture'\n");
  json(join(paths.project, "src-tauri/tauri.conf.json"), {});
  // Only this staged detector is mocked. Production profile validation, scanning and storage remain real.
  const detector = readFileSync(join(workspace, "packages/ggcoder/dist/core/programmatic/opportunities.js"), "utf8");
  const needle = 'specialistCommand: "setup-tauri-package"';
  assert.equal(detector.split(needle).length - 1, 1, "Exactly one detector route boundary");
  const stagedDetector = join(paths.audit, "fixture-opportunities.js");
  writeFileSync(stagedDetector, detector.replace(needle, 'specialistCommand: "research"'));
  return { stagedDetector, statePath: join(paths.project, ".gg/programmatic/state.json") };
}

// Read-only, sampled native evidence; never restore, focus or resize a window.
async function createMinimizedObserver(native, binary, audit, allowNormalWindow) {
  const root = (await readProcessTable()).find((entry) => entry.pid === native.pid);
  assert.ok(root && Number.isSafeInteger(root.startedAtMs), "Launcher process identity is available");
  const evidence = { root: { pid: root.pid, startedAtMs: root.startedAtMs }, continuousMonitoring: false, allowNormalWindow, samples: [] };
  let windowIdentity;
  return async (boundary) => {
    const sample = { boundary, timestamp: new Date().toISOString() };
    assert.ok(evidence.samples.length < 20, "Bounded native observations");
    evidence.samples.push(sample);
    try {
      assert.equal(native.exitCode, null, "Owned launcher is still running");
      const table = await readProcessTable();
      assert.equal(table.find((entry) => entry.pid === root.pid)?.startedAtMs, root.startedAtMs, "Launcher PID has not been reused");
      const tree = processTreeSnapshot(table, root.pid);
      assert.ok(tree.pids.length > 0 && tree.pids.length <= 256);
      assert.ok(tree.pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
      const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public class MinimizedWindow {
public delegate bool Callback(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder name, int size);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
public static IntPtr[] Find(uint pid) { var found = new List<IntPtr>(); bool ok = EnumWindows((h, unused) => { uint owner; GetWindowThreadProcessId(h, out owner); if (owner == pid) { var name = new StringBuilder(256); if (GetClassName(h, name, name.Capacity) > 0 && name.ToString() == "Tauri Window") found.Add(h); } return true; }, IntPtr.Zero); if (!ok) throw new Exception("Window enumeration failed"); return found.ToArray(); }
}'
$processes = @(Get-Process -Id ${tree.pids.join(",")} -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'gg-app' })
if ($processes.Count -ne 1) { throw 'Expected exactly one owned developer process' }
$p=$processes[0]; $windows=@([MinimizedWindow]::Find($p.Id))
if ($windows.Count -ne 1) { throw 'Expected exactly one owned Tauri window' }
$h=$windows[0]; [uint32]$owner=0
if ([MinimizedWindow]::GetWindowThreadProcessId($h,[ref]$owner) -eq 0 -or $owner -ne $p.Id) { throw 'Window ownership changed' }
@{pid=$p.Id; startedAtMs=([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds(); executable=$p.Path; windowClass='Tauri Window'; handle=$h.ToInt64(); minimized=[MinimizedWindow]::IsIconic($h); observedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress`;
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 64 * 1024 });
      Object.assign(sample, JSON.parse(stdout));
      assert.equal(sample.startedAtMs, tree.identities.find((entry) => entry.pid === sample.pid)?.startedAtMs, "Observed process matches owned tree identity");
      assert.equal(realpathSync.native(sample.executable).toLowerCase(), realpathSync.native(binary).toLowerCase(), "Observed window uses this developer executable");
      assert.ok(Number.isSafeInteger(sample.handle) && sample.handle > 0);
      const current = { pid: sample.pid, startedAtMs: sample.startedAtMs, handle: sample.handle };
      if (windowIdentity) assert.deepEqual(current, windowIdentity, "Same owned native window at every boundary");
      else windowIdentity = current;
      assert.equal(typeof sample.minimized, "boolean", "Native minimized observation is available");
      if (!allowNormalWindow) assert.equal(sample.minimized, true, `Native window minimized at ${boundary}`);
      sample.verified = true;
    } catch (error) {
      sample.error = error.message;
      throw error;
    } finally {
      json(join(audit, "native-minimized.json"), evidence);
    }
  };
}

async function run() {
  assert.equal(process.platform, "win32");
  const visual = process.argv.includes("--visual");
  const driftOnly = process.argv.includes("--drift-only");
  const integratedRecovery = process.argv.includes("--integrated-recovery");
  const extendedWorkflow = process.argv.includes("--extended-workflow");
  const discoveryOnly = process.argv.includes("--discovery-only");
  assert.ok(!discoveryOnly || (!extendedWorkflow && !driftOnly && !integratedRecovery), "Discovery is a separate bounded scenario");
  assert.ok(!extendedWorkflow || (!driftOnly && !integratedRecovery), "Extended workflow is a separate bounded scenario");
  assert.ok(!integratedRecovery || (!driftOnly && !visual), "Integrated recovery excludes drift-only and visual modes");
  const allowNormalWindow = process.argv.includes("--allow-normal-window");
  assert.ok(!extendedWorkflow || !allowNormalWindow, "Extended minimized verification never allows normal-window fallback");
  assert.ok(!allowNormalWindow || !visual, "Normal-window fallback does not enable visual/input checks");
  assert.ok(!driftOnly || !visual, "Drift-only smoke does not repeat visual/input checks");
  const reuseBuiltDev = process.argv.includes("--reuse-built-dev");
  assert.deepEqual(process.argv.slice(2), ["--identity", identity, ...(driftOnly ? ["--drift-only"] : []), ...(integratedRecovery ? ["--integrated-recovery"] : []), ...(extendedWorkflow ? ["--extended-workflow"] : []), ...(discoveryOnly ? ["--discovery-only"] : []), ...(visual ? ["--visual"] : []), ...(allowNormalWindow ? ["--allow-normal-window"] : []), ...(reuseBuiltDev ? ["--reuse-built-dev"] : [])]);
  const builtDev = join(app, "src-tauri/target/debug/gg-app.exe");
  if (reuseBuiltDev) {
    assert.match(process.env.GG_PROGRAMMATIC_BUILT_DEV_SHA256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(createHash("sha256").update(readFileSync(builtDev)).digest("hex"), process.env.GG_PROGRAMMATIC_BUILT_DEV_SHA256, "Previously verified developer binary must match recorded hash");
  }
  // Compile the current developer target; a debug-directory executable can be a stale smoke build.
  const frontendPort = await reserveHeldTcpPort();
  const frontendOrigin = reuseBuiltDev ? process.env.GG_PROGRAMMATIC_BUILT_DEV_ORIGIN : `http://127.0.0.1:${frontendPort.port}`;
  assert.match(frontendOrigin ?? "", /^http:\/\/127\.0\.0\.1:\d{4,5}$/);
  await frontendPort.release();
  assert.ok(existsSync(join(workspace, "packages/ggcoder/dist/core/programmatic/execution.js")), "Compile the development dispatcher first.");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gg-programmatic-execution-")));
  const audit = join(root, "audit");
  mkdirSync(audit);
  let paths;
  const owned = [];
  let server;
  let logFd;
  let client;
  let observeMinimized;
  async function workflow() {
    paths = createIsolatedProfile(root);
    // Keep cmd.exe arguments space-free; quoted Windows paths are re-escaped by spawn.
    const launchDir = mkdtempSync(join(workspace, ".gg/evidence/programmatic-native-launch-"));
    const nativeConfig = join(launchDir, "tauri.dev-smoke.json");
    json(nativeConfig, { ...JSON.parse(readFileSync(join(app, "src-tauri/tauri.local.conf.json"), "utf8")), build: { beforeDevCommand: `pnpm exec vite --host 127.0.0.1 --port ${frontendPort.port}`, devUrl: frontendOrigin } });
    const configArgument = `../.gg/evidence/${launchDir.split(/[\\/]/).at(-1)}/tauri.dev-smoke.json`;
    assert.match(configArgument, /^\.\.\/\.gg\/evidence\/programmatic-native-launch-[A-Za-z0-9]+\/tauri\.dev-smoke\.json$/);
    const nativeCommand = `pnpm exec tauri dev --config ${configArgument}`;
    const agentDir = join(paths.home, ".gg/identities", identity);
    mkdirSync(join(agentDir, "commands"), { recursive: true });
    writeFileSync(join(agentDir, "commands/research.md"), `---\nname: research\ndescription: Harmless fixture\n---\n${fixtureBody}\n`);
    json(join(agentDir, "auth.json"), {});
    json(join(agentDir, "settings.json"), { defaultProvider: "azure", defaultModel: "azure:fixture", autoCompact: false, idealReviewEnabled: false });
    const fixture = seed(paths, discoveryOnly);
    assert.equal(existsSync(join(paths.project, ".gg/programmatic/profile.json")), false);
    const baseline = snapshot(paths.project);
    const requests = [];
    const assessments = [];
    let pendingAssessment;
    let providerFailure;
    server = http.createServer(async (request, response) => {
      try {
        if (providerFailure) throw providerFailure;
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/openai/v1/responses");
        const chunks = [];
        let size = 0;
        for await (const chunk of request) { size += chunk.length; assert.ok(size < 1_000_000); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let events;
        if (pendingAssessment) {
          pendingAssessment.requests.push(body);
          const step = assessmentWorkflowStep(pendingAssessment.mode, pendingAssessment.requests.length, body, pendingAssessment.callId);
          events = typeof step === "string" ? [{ type: "response.output_text.delta", delta: step }] : [
            { type: "response.output_item.added", output_index: 0, item: step },
            { type: "response.function_call_arguments.done", output_index: 0, item_id: step.id, arguments: step.arguments },
            { type: "response.output_item.done", output_index: 0, item: step },
          ];
        } else {
          assert.ok(requests.length < (discoveryOnly ? discoveryRequestCount : extendedWorkflow ? extendedRequestCount : 3), "No automatic specialist rerun or unexpected continuation");
          requests.push(body);
          if (discoveryOnly || (extendedWorkflow && requests.length > 3)) {
            const step = discoveryOnly ? discoveryWorkflowStep(requests.length, body) : extendedWorkflowStep(requests.length, body);
            events = typeof step === "string" ? [{ type: "response.output_text.delta", delta: step }] : [
              { type: "response.output_item.added", output_index: 0, item: step },
              { type: "response.function_call_arguments.done", output_index: 0, item_id: step.id, arguments: step.arguments },
              { type: "response.output_item.done", output_index: 0, item: step },
            ];
          } else if (requests.length < 3) {
            const first = requests.length === 1;
            const item = { type: "function_call", id: first ? "fc_read" : "fc_complete", call_id: first ? "fixture-read" : "fixture-complete",
              name: first ? "read" : "programmatic_result",
              arguments: JSON.stringify(first ? { file_path: "package.json" } : { summary: completion, successCondition: fixture.condition, toolCallIds: ["fixture-read"] }) };
            events = [{ type: "response.output_item.added", output_index: 0, item },
              { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
              { type: "response.output_item.done", output_index: 0, item }];
          } else events = [{ type: "response.output_text.delta", delta: "Harmless specialist finished." }];
        }
        events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } catch (error) {
        providerFailure ??= error;
        json(join(paths.audit, "provider-failure.json"), { request: requests.length, assessment: pendingAssessment?.mode, assessmentRequest: pendingAssessment?.requests.length, error: String(providerFailure) });
        response.writeHead(400); response.end("Fixture rejected request");
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const providerUrl = `http://127.0.0.1:${server.address().port}/openai/v1/responses`;
    const reservation = await reserveHeldTcpPort();
    const cdpPort = reservation.port;
    await reservation.release();
    const env = sanitizedSmokeEnvironment(process.env, paths);
    for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS|^AZURE_|^HOMEDRIVE$|^HOMEPATH$)/i.test(key)) delete env[key];
    Object.assign(env, { GG_SIDECAR_PATH: fileURLToPath(import.meta.url), GG_PROGRAMMATIC_EXECUTION_FIXTURE_MODE: "sidecar",
      GG_PROGRAMMATIC_EXECUTION_FIXTURE_PROVIDER: providerUrl,
      ...(discoveryOnly ? { GG_PROGRAMMATIC_DISCOVERY_ONLY: "1", GG_PROGRAMMATIC_DISCOVERY_AUDIT: paths.audit } : { GG_PROGRAMMATIC_EXECUTION_FIXTURE_DETECTOR: fixture.stagedDetector }),
      GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort), GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1", GG_APP_DEV_SMOKE_WINDOW: visual ? "visible" : "minimized",
      COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node/corepack"), COREPACK_DEFAULT_TO_LATEST: "0",
      CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup") });
    console.log(`Fixture evidence: ${paths.audit}`);
    if (discoveryOnly) json(join(paths.audit, "discovery-source.json"), Object.fromEntries([
      "packages/ggcoder/src/core/agent-session.ts", "packages/ggcoder/src/app-sidecar-programmatic-chat.ts",
      "packages/ggcoder/src/app-sidecar.ts", "packages/ggcoder/dist/app-sidecar-programmatic-chat.js",
      "packages/ggcoder/dist/app-sidecar.js", "gg-app/src-tauri/src/lib.rs", "gg-app/src/agent.ts",
      "gg-app/src/AgentPane.tsx", "gg-app/src/programmatic-chat-state.ts", "gg-app/src/programmatic-discovery-state.ts",
      "gg-app/src/ProgrammaticDiscovery.tsx", "gg-app/scripts/programmatic-discovery-smoke.mjs",
      "gg-app/scripts/programmatic-discovery-observer.mjs", "gg-app/scripts/programmatic-execution-dev-smoke.mjs",
    ].map((file) => [file, createHash("sha256").update(readFileSync(join(workspace, file))).digest("hex")])));
    logFd = openSync(join(paths.audit, "developer.log"), "a");
    if (reuseBuiltDev) {
      const frontend = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm exec vite --host 127.0.0.1 --port ${new URL(frontendOrigin).port}`], { cwd: app, env, windowsHide: true, stdio: ["ignore", logFd, logFd] });
      const frontendOwner = trackOwnedProcess(frontend);
      owned.push(frontendOwner);
      await waitForLiveProcess(frontend, "reused build frontend HTTP readiness", async () => (await fetch(frontendOrigin)).ok);
      json(join(paths.audit, "reused-build.json"), { binary: builtDev, sha256: createHash("sha256").update(readFileSync(builtDev)).digest("hex"), origin: frontendOrigin });
    }
    const native = reuseBuiltDev
      ? spawn(builtDev, [], { cwd: app, env, windowsHide: true, stdio: ["ignore", logFd, logFd] })
      : spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", nativeCommand], { cwd: app, env, windowsHide: true, stdio: ["ignore", logFd, logFd] });
    const nativeOwner = trackOwnedProcess(native);
    owned.push(nativeOwner);
    if (!visual) observeMinimized = await createMinimizedObserver(native, builtDev, paths.audit, allowNormalWindow);
    client = await connectToDevWebview(cdpPort, (label, check) => waitForLiveProcess(native, label, check), (target) => String(target.url).startsWith(frontendOrigin));
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await waitFor("developer document", () => client.evaluate(`location.origin === ${JSON.stringify(frontendOrigin)} && document.readyState === "complete"`));
    await waitFor("initial workspace persistence", () => client.evaluate(`Boolean(localStorage.getItem("gg-workspace-layout-recursive:main"))`));
    await client.evaluate(`(() => {
      localStorage.setItem("gg-workspace-layout-recursive:main", JSON.stringify({ version: 9, root: { type: "leaf", paneId: "primary" }, focusedPaneId: "primary", panes: { primary: { kind: "agent", mode: "code", cwd: ${JSON.stringify(paths.project)}, sessionPath: null } } }));
      window.fixtureBeforeReload = true;
      return true;
    })()`);
    await client.send("Page.reload");
    await waitFor("fresh fixture document", () => client.evaluate(`!window.fixtureBeforeReload && document.readyState === "complete"`));
    await waitFor("rendered project pane", () => client.evaluate(`!!document.querySelector('.agent-pane textarea')`));
    await waitFor("native session", () => client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"}).then(s => s.ready && s.provider === "azure" && s)`));
    await observeMinimized?.("native-ready");
    const parentState = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
    assert.equal(parentState.provider, "azure");
    assert.equal(parentState.model, "azure:fixture");
    const sessionsDir = join(agentDir, "sessions");
    const transcriptSnapshot = () => Object.fromEntries(Object.entries(snapshot(sessionsDir)).filter(([name]) => name.endsWith(".jsonl")));
    const transcriptsBefore = transcriptSnapshot();
    const hostTranscripts = Object.keys(transcriptsBefore).filter((name) => JSON.parse(readFileSync(join(sessionsDir, name), "utf8").split("\n")[0]).id === parentState.sessionId);
    assert.equal(hostTranscripts.length, 1, "Exactly one transcript belongs to the active host session");
    const subscribeEvents = () => client.evaluate(`import("/src/agent.ts").then(m => { window.fixtureUnsubscribe?.(); window.fixtureEvents=[]; window.fixtureUnsubscribe=m.subscribe(e=>{ if (["ask_user","text_delta","done"].includes(e.type) && window.fixtureEvents.length < 100) window.fixtureEvents.push(e); }); return true; })`);
    await subscribeEvents();
    const input = visual ? await createNativeInputSmoke(client, native.pid, paths.audit, waitFor) : null;
    const click = async (label) => {
      if (input) return input.activate(input.button(label), label, label === "Approve and save setup");
      const target = smokeButton(label);
      await waitFor(`rendered ${label}`, () => client.evaluate(`!!(${target}) && !(${target}).disabled`));
      await revealSmokeTarget(client, target);
      assert.equal(await client.evaluate(`(${target}).getClientRects().length > 0`), true, `Visible button ${label}`);
      await client.evaluate(`(${target}).click()`);
    };
    let assessmentMessageDelta = 0;
    const assess = async (assessmentMode, label) => {
      assert.equal(pendingAssessment, undefined);
      const specialistCount = requests.length;
      const before = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
      const eventOffset = await client.evaluate(`window.fixtureEvents.length`);
      const entry = { mode: assessmentMode, callId: `assessment-${assessmentMode}-${assessments.length + 1}`, requests: [] };
      pendingAssessment = entry;
      await click(label);
      await waitFor(`${assessmentMode} assessment settled`, async () => {
        if (providerFailure) throw providerFailure;
        const state = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
        // A successful initial review may replace Review setup with Change settings.
        const ready = assessmentMode === "setup" ? "Close review without saving" : smokeLabels.scan;
        return entry.requests.length === assessmentRequestCount && !state.running &&
          await client.evaluate(`!!(${smokeButton(ready)}) && !(${smokeButton(ready)}).disabled`);
      });
      assert.equal(providerFailure, undefined);
      assert.equal(entry.requests.length, assessmentRequestCount);
      assert.equal(requests.length, specialistCount, "Assessment does not invoke a specialist");
      const after = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.provider, before.provider);
      assert.equal(after.model, before.model);
      entry.messageDelta = after.messageCount - before.messageCount;
      assessmentMessageDelta += entry.messageDelta;
      entry.events = await client.evaluate(`window.fixtureEvents.splice(${eventOffset})`);
      assert.ok(!entry.events.some((event) => event.type === "ask_user" || event.data?.text?.includes("[research]")), "Assessment cannot request task approval or run a specialist");
      assessments.push(entry);
      pendingAssessment = undefined;
      json(join(paths.audit, "assessment-requests.json"), assessments);
    };
    if (discoveryOnly) {
      const protectedSnapshot = () => Object.fromEntries(Object.entries(snapshot(agentDir)).filter(([name]) =>
        name === "settings.json" || name.startsWith("commands/") || name.startsWith("programmatic/")));
      const protectedBefore = protectedSnapshot();
      const result = await runDiscoverySmoke({ client, click, waitFor, requests, input, observe: observeMinimized });
      assertDiscoveryHandoff({ ...result,
        host: JSON.parse(readFileSync(join(paths.audit, "discovery-host.json"), "utf8")),
        http: JSON.parse(readFileSync(join(paths.audit, "discovery-http.json"), "utf8")) });
      assert.equal(providerFailure, undefined);
      assert.deepEqual(snapshot(paths.project), baseline, "Discovery/review changes no project, command, settings or lifecycle files");
      const protectedAfter = protectedSnapshot();
      assert.deepEqual(protectedAfter, protectedBefore, "Discovery/review changes no global settings, commands or lifecycle files");
      assert.equal(existsSync(join(paths.project, "src-tauri")), false);
      assert.equal(existsSync(join(paths.audit, "fixture-opportunities.js")), false);
      const finalState = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
      assert.equal(finalState.sessionId, parentState.sessionId);
      assert.equal(finalState.provider, parentState.provider);
      if (input) { input.evidence.passed = true; input.save(); }
      json(join(paths.audit, "discovery.json"), { ...result, projectBefore: baseline, projectAfter: snapshot(paths.project), protectedBefore, protectedAfter });
      return { ...result, changedProjectFiles: [], childTranscript: false };
    }
    await click("Opportunities");
    await waitFor("setup-required section", () => client.evaluate(`document.querySelector(".programmatic-chat")?.textContent.includes("Nothing is saved until you approve.")`));
    await assess("setup", smokeLabels.setup);
    await waitFor("exact proposal", () => client.evaluate(`document.querySelector('[aria-label="Exact settings to save"]')?.textContent.includes('"research"')`));
    assert.equal(requests.length, 0, "No specialist dispatch during setup assessment");
    assert.equal(assessments.length, 1, "Exactly one explicit setup assessment");
    assert.equal(existsSync(fixture.statePath), false, "Setup assessment cannot scan implicitly");
    assert.equal(existsSync(join(paths.project, ".gg/programmatic/profile.json")), false, "Inspection must not write approval");
    await click("Approve and save setup");
    await waitFor("approved profile", () => existsSync(join(paths.project, ".gg/programmatic/profile.json")));
    await assess("configured", smokeLabels.scan);
    await waitFor("persisted scan", () => existsSync(fixture.statePath));
    const scanned = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    assert.equal(scanned.records.length, 1);
    Object.assign(fixture, { id: scanned.records[0].opportunity.identity.id, fingerprint: scanned.configurationFingerprint.sha256, condition: scanned.records[0].opportunity.verification });
    await waitFor("selectable opportunity", () => client.evaluate(`!!document.querySelector('.programmatic-row:not(:disabled)')`));
    if (input) await input.activate("document.querySelector('.programmatic-row:not(:disabled)')", "Select opportunity", true);
    else {
      await revealSmokeTarget(client, "document.querySelector('.programmatic-row:not(:disabled)')");
      await client.evaluate(`document.querySelector('.programmatic-row:not(:disabled)').click()`);
    }
    await observeMinimized?.("approved-scanned-selected");
    const reconcileDrift = async () => {
      const terminalLabel = driftOnly ? "Dismissed" : "Completed";
      const profilePath = join(paths.project, ".gg/programmatic/profile.json");
      const previousProfile = readFileSync(profilePath);
      const previousState = readFileSync(fixture.statePath);
      const terminal = JSON.parse(previousState.toString("utf8")).records[0];
      assert.equal(terminal.lifecycle.state, driftOnly ? "dismissed" : "completed");
      json(join(paths.project, "package.json"), { name: "harmless-isolated-fixture", description: "one exact configuration drift" });
      await click("Refresh results");
      await waitFor("exact rendered drift", () => client.evaluate(`document.querySelector('.programmatic-chat')?.textContent.includes('modified: package.json')`));
      assert.equal(await client.evaluate(`Array.from(document.querySelectorAll('.programmatic-chat button')).find(b=>b.textContent.trim()===${JSON.stringify(smokeLabels.scan)}).disabled`), true);
      assert.equal(await client.evaluate(`Array.from(document.querySelectorAll('.programmatic-chat button')).some(b=>b.textContent.trim()==='Review task approval' && !b.disabled)`), false);
      assert.equal(await client.evaluate(`document.querySelector('.programmatic-detail')?.textContent.includes(${JSON.stringify(terminalLabel)})`), true);
      assert.deepEqual(readFileSync(profilePath), previousProfile);
      assert.deepEqual(readFileSync(fixture.statePath), previousState);
      await observeMinimized?.(driftOnly ? "dismissed-exact-drift" : "completed-exact-drift");
      await assess("setup", "Review setup refresh");
      await waitFor("refresh proposal", () => client.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Approve and save refresh' && !b.disabled)`));
      assert.deepEqual(readFileSync(profilePath), previousProfile, "Review cannot write setup");
      await click("Approve and save refresh");
      await waitFor("new approved fingerprint", () => JSON.parse(readFileSync(profilePath, "utf8")).configurationFingerprint.sha256 !== fixture.fingerprint);
      assert.deepEqual(readFileSync(fixture.statePath), previousState, "Approval must not scan or reset lifecycle");
      await observeMinimized?.("refresh-approved-before-rescan");
      await assess("configured", smokeLabels.scan);
      await waitFor("reconciled fingerprint", () => JSON.parse(readFileSync(fixture.statePath, "utf8")).configurationFingerprint.sha256 !== fixture.fingerprint);
      await waitFor("retained terminal selection", () => client.evaluate(`document.querySelector('.programmatic-row[aria-pressed="true"]')?.textContent.includes(${JSON.stringify(terminalLabel)}) && document.querySelector('.programmatic-detail')?.textContent.includes(${JSON.stringify(terminalLabel)})`));
      const refreshed = JSON.parse(readFileSync(fixture.statePath, "utf8")).records[0];
      assert.deepEqual(refreshed.opportunity.identity, terminal.opportunity.identity);
      assert.deepEqual(refreshed.lifecycle, terminal.lifecycle);
      assert.equal(requests.length, driftOnly ? 0 : 3, "Drift assessments never dispatch a specialist");
      assert.equal(providerFailure, undefined);
      json(join(paths.audit, "drift.json"), { changedInput: "package.json", identity: fixture.id,
        previousFingerprint: fixture.fingerprint, fingerprint: JSON.parse(readFileSync(profilePath, "utf8")).configurationFingerprint.sha256,
        lifecycleBefore: terminal.lifecycle, lifecycleAfter: refreshed.lifecycle,
        profileBefore: createHash("sha256").update(previousProfile).digest("hex"),
        stateBefore: createHash("sha256").update(previousState).digest("hex"), requests: requests.length });
    };
    if (driftOnly) {
      await click("Dismiss this item");
      await waitFor("dismissed fixture detail", () => client.evaluate(`document.querySelector('.programmatic-detail')?.textContent.includes('Dismissed')`));
      await reconcileDrift();
    } else {
    if (input) {
      await input.activate("document.querySelector('.programmatic-detail summary')", "Inspect evidence", true);
      assert.equal(await client.evaluate(`document.querySelector('.programmatic-detail details').open`), true);
      await input.layout("desktop-selected");
      await input.zoom(2);
      await input.layout("desktop-200-percent");
      await input.zoom(1);
      await input.resize(600, 640);
      await input.layout("native-600x640");
      await input.resize(1280, 900);
    }
    await click("Review task approval");
    const question = await waitFor("native approval question", () => client.evaluate(`window.fixtureEvents.find(e=>e.type==="ask_user")?.data`));
    assert.equal(requests.length, 0, "No provider dispatch before approval");
    assert.match(question.questions[0].question, /research/);
    await observeMinimized?.("task-awaiting-separate-approval");
    await waitFor("rendered specialist approval", () => client.evaluate(`Array.from(document.querySelectorAll('[data-ask-option]')).some(b=>b.textContent.includes(${JSON.stringify(question.questions[0].options[0].label)}))`));
    const approval = `Array.from(document.querySelectorAll('[data-ask-option]')).find(b=>b.textContent.includes(${JSON.stringify(question.questions[0].options[0].label)}))`;
    if (input) await input.activate(approval, "Approve isolated read-only task");
    else await client.evaluate(`(${approval}).click()`);
    await waitFor("isolated result through native events", () => client.evaluate(`window.fixtureEvents.some(e=>e.type==="text_delta" && e.data.text.includes(${JSON.stringify(completion)}))`));
    await waitFor("parent settled", () => client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"}).then(s=>!s.running)`));
    const executionDisplay = await waitFor("attributed execution evidence in native transcript", () => client.evaluate(`(${readExecutionDisplay.toString()})(document, ${JSON.stringify(completion)})`));
    assert.ok(executionDisplay.text.includes("Inferred, not confirmed"));
    assert.ok(executionDisplay.text.includes("GG confirmed the listed tools ran, but did not independently check whether the result is correct."));
    assert.ok(executionDisplay.items.some((item) => item.includes("Checked directly") && item.includes("Tool read completed (fixture-read).")));
    assert.ok(!executionDisplay.text.includes(completion), "Execution evidence must not repeat the streamed summary");
    assert.equal(executionDisplay.summaryCount, 1, "One visible specialist summary");
    assert.equal(executionDisplay.executableElements, 0);
    json(join(paths.audit, "execution-display.json"), { passed: true, nativeWebviewDom: true, ...executionDisplay });
    if (providerFailure) throw providerFailure;
    assert.equal(requests.length, 3);
    const childInput = JSON.stringify(requests[0]);
    assert.ok(childInput.includes(fixtureBody));
    assert.ok(childInput.includes("NECESSARY FIXTURE PROJECT INSTRUCTIONS"));
    assert.ok(!childInput.includes(parentState.sessionId));
    const allowed = new Set(["read", "find", "grep", "ls", "code_search", "code_nav", "web_search", "web_fetch", "ask_user", "research_corpus", "programmatic_result"]);
    assert.ok(requests[0].tools.every((tool) => allowed.has(tool.name)));
    assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).records[0].lifecycle.state, "completed");
    await waitFor("completed selected detail", () => client.evaluate(`document.querySelector('.programmatic-detail')?.textContent.includes('Completed')`));
    await observeMinimized?.("read-only-task-completed");
    await assess("configured", smokeLabels.scan);
    await waitFor("completed selection after rescan", () => client.evaluate(`document.querySelector('.programmatic-row[aria-pressed="true"]')?.textContent.includes('Completed') && document.querySelector('.programmatic-detail')?.textContent.includes('Completed') && !document.querySelector('.programmatic-chat [role="status"]')?.textContent.includes('Working')`));
    assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).records[0].opportunity.identity.id, fixture.id);
    assert.equal(requests.length, 3, "Rescan must not dispatch another specialist");
    if (input) {
      await input.pointer();
      await input.layout("completed-after-rescan");
      input.evidence.passed = true;
      input.save();
    }
    }
    if (integratedRecovery) {
      await observeMinimized?.("execution-rescanned");
      await reconcileDrift();
    }
    await observeMinimized?.("scenario-rescanned");
    if (integratedRecovery) {
      const { programmaticLifecycleStateV1Schema } = await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/core/programmatic/contracts.js")));
      const validBytes = readFileSync(fixture.statePath);
      const valid = programmaticLifecycleStateV1Schema.parse(JSON.parse(validBytes.toString("utf8")));
      assert.equal(valid.records.length, 1);
      assert.equal(valid.records[0].opportunity.identity.id, fixture.id);
      assert.equal(valid.records[0].lifecycle.state, "completed");
      const previousPath = join(paths.project, ".gg/programmatic/state.previous.json");
      const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
      const previousBeforePreparation = hash(readFileSync(previousPath));
      // Controlled snapshot preparation is explicit; never touch any non-fixture state.
      writeFileSync(join(paths.audit, "recovery-valid-state.json"), validBytes);
      writeFileSync(previousPath, validBytes);
      const previousHash = hash(readFileSync(previousPath));
      writeFileSync(fixture.statePath, "{interrupted fixture primary");
      const corruptHash = hash(readFileSync(fixture.statePath));
      await click("Refresh results");
      await waitFor("recovered persisted report", () => client.evaluate(`document.querySelector('.programmatic-chat')?.textContent.includes('Showing older saved results.') && document.querySelector('.programmatic-detail')?.textContent.includes('Completed')`));
      assert.equal(hash(readFileSync(fixture.statePath)), corruptHash, "Report reads must not repair primary bytes");
      assert.equal(hash(readFileSync(previousPath)), previousHash);
      assert.equal(await client.evaluate(`document.querySelector('.programmatic-detail')?.textContent.includes('Completed')`), true);
      await observeMinimized?.("recovered-inspection");
      await assess("configured", smokeLabels.scan);
      await waitFor("explicit recovery scan", () => {
        try { return programmaticLifecycleStateV1Schema.safeParse(JSON.parse(readFileSync(fixture.statePath, "utf8"))).success; } catch { return false; }
      });
      const restored = programmaticLifecycleStateV1Schema.parse(JSON.parse(readFileSync(fixture.statePath, "utf8")));
      assert.deepEqual(restored.records, valid.records);
      assert.equal(hash(readFileSync(previousPath)), previousHash, "Corrupt primary must not replace valid previous state");
      assert.equal(requests.length, 3, "Recovery cannot rerun the specialist");
      await observeMinimized?.("recovered-rescanned");
      json(join(paths.audit, "recovery.json"), { recoverySource: "previous", controlledPreviousSnapshot: true, previousBeforePreparation, validHash: hash(validBytes), previousHash, corruptHash, restoredHash: hash(readFileSync(fixture.statePath)), identity: fixture.id, lifecycleBefore: valid.records[0].lifecycle, lifecycleAfter: restored.records[0].lifecycle, readPreservedBytes: true, requests: requests.length });
    }
    let eventsBeforeRendererReload;
    if (extendedWorkflow) {
      const stateBytes = readFileSync(fixture.statePath);
      const profileBytes = readFileSync(join(paths.project, ".gg/programmatic/profile.json"));
      const commandFile = join(paths.project, `.gg/commands/${extendedCommandName}.md`);
      const invoke = (command, args) => client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify({ paneId: "primary", ...args })})`);
      const settled = async (count) => {
        await waitFor(`extended provider boundary ${count}`, async () => {
          if (providerFailure) throw providerFailure;
          return requests.length === count && !(await invoke("agent_state", {})).running
            && await client.evaluate(`Boolean(document.querySelector('.agent-pane button[aria-label="Send message"]'))`);
        });
        if (providerFailure) throw providerFailure;
      };
      const typePrompt = async (text) => {
        if (input) return input.type(text);
        await client.evaluate(`(() => { const e=document.querySelector('.agent-pane textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
      };
      const sendTyped = async () => {
        if (input) await input.key("Enter", "Enter", 13);
        else await client.evaluate(`document.querySelector('.agent-pane textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))`);
      };
      const review = async (label, beforeCount, previousId) => {
        const question = await waitFor(`${label} native question`, () => client.evaluate(`window.fixtureEvents.filter(e=>e.type==='ask_user').map(e=>e.data).findLast(q=>q.id!==${JSON.stringify(previousId)} && q.id!==${JSON.stringify(questionId)})`));
        assert.equal(requests.length, beforeCount, `${label}: zero child/next dispatch before approval`);
        assert.notEqual(question.id, previousId);
        const target = `Array.from(document.querySelectorAll('.ask-band:not(.is-done):not(.is-closed) [data-ask-option]')).find(b=>b.textContent.includes(${JSON.stringify(question.questions[0].options[0].label)}))`;
        await waitFor(`${label} rendered`, () => client.evaluate(`Boolean(${target})`));
        if (input) {
          for (const width of [600, 480]) {
            await input.resize(width, 640);
            await input.threadLayout(`${label}-${width}x640`, target);
          }
          await input.activate(target, label);
        } else await client.evaluate(`(${target}).click()`);
        return question.id;
      };
      const questionId = await client.evaluate(`window.fixtureEvents.find(e=>e.type==='ask_user').data.id`);
      await click("Opportunities"); // Close the panel; the extension lives in the ordinary transcript.
      await typePrompt("/programmatic focus on the manifest; retain completed history");
      assert.equal(requests.length, 3, "Optional typing does not dispatch");
      await sendTyped();
      await settled(7);
      await waitFor("in-thread extended advice", () => client.evaluate(`document.body.innerText.includes('NATIVE EXTENDED ADVICE')`));
      assert.deepEqual(readFileSync(fixture.statePath), stateBytes);
      assert.deepEqual(readFileSync(join(paths.project, ".gg/programmatic/profile.json")), profileBytes);
      assert.equal(existsSync(commandFile), false);
      await observeMinimized?.("extended-advice-settled");
      await typePrompt("NATIVE CREATE REQUEST: create only the reviewed manifest prompt, not execution.");
      await sendTyped();
      const creationId = await review("extended-creation-review", 11, questionId);
      await settled(13);
      assert.equal(existsSync(commandFile), true);
      const catalog = await invoke("agent_commands", {});
      assert.ok(catalog.commands.some((entry) => entry.name === extendedCommandName), "New command is in the native catalog");
      // Narrow sizes exercise review cards; optional typing uses the normal
      // viewport, including its command suggestion popup.
      if (input) await input.resize(1280, 900);
      await typePrompt(`/${extendedCommandName}`);
      await waitFor("renderer catalog refresh", () => client.evaluate(`Array.from(document.querySelectorAll('.slash-item')).some(e=>e.textContent.includes(${JSON.stringify(extendedCommandName)}))`));
      assert.equal(requests.length, 13, "Discovery does not execute newly created command");
      await typePrompt("NATIVE RUN REQUEST: request a separate read-only review of the created command.");
      await sendTyped();
      const executionId = await review("extended-execution-review", 14, creationId);
      await settled(extendedRequestCount);
      assert.notEqual(creationId, executionId);
      assert.deepEqual(readFileSync(fixture.statePath), stateBytes, "Direct run creates no synthetic Opportunity");
      assert.deepEqual(readFileSync(join(paths.project, ".gg/programmatic/profile.json")), profileBytes);
      await observeMinimized?.("extended-run-settled");
      eventsBeforeRendererReload = await client.evaluate(`window.fixtureEvents`);
      assert.ok(Array.isArray(eventsBeforeRendererReload));
      await client.send("Page.reload");
      await waitFor("restored extension history", () => client.evaluate(`document.body.innerText.includes('NATIVE EXTENDED ADVICE') && document.body.innerText.includes('NATIVE CREATION SETTLED') && document.body.innerText.includes('NATIVE RUN SETTLED')`));
      assert.equal(requests.length, extendedRequestCount, "Reload cannot replay creation or execution");
      await subscribeEvents();
      await click("Opportunities");
      await assess("configured", smokeLabels.scan);
      await waitFor("retained terminal history after extension", () => client.evaluate(`document.querySelector('.programmatic-chat')?.textContent.includes('Completed')`));
      assert.deepEqual(readFileSync(fixture.statePath), stateBytes);
      json(join(paths.audit, "extended-workflow.json"), { passed: true, creationId, executionId, requests: requests.length, history: "native renderer reload, same daemon/session; not daemon restart", verification: "canonical loading only; deterministic helper checks are backend evidence", profilePreserved: true, lifecyclePreserved: true });
      if (input) { input.evidence.passed = true; input.save(); }
    }
    assert.deepEqual(assessments.map((entry) => ({ mode: entry.mode, requests: entry.requests.length })),
      ["setup", "configured", ...(driftOnly ? [] : ["configured"]),
        ...(driftOnly || integratedRecovery ? ["setup", "configured"] : []),
        ...(integratedRecovery ? ["configured"] : []), ...(extendedWorkflow ? ["configured"] : [])]
        .map((assessmentMode) => ({ mode: assessmentMode, requests: assessmentRequestCount })),
      "Only explicitly requested setup/configured assessments reach the provider");
    const after = snapshot(paths.project);
    const changes = [...new Set([...Object.keys(baseline), ...Object.keys(after)])].filter((key) => baseline[key] !== after[key]);
    assert.deepEqual(changes.sort(), [...(extendedWorkflow ? [`.gg/commands/${extendedCommandName}.md`] : []), ".gg/programmatic/profile.json", ".gg/programmatic/state.json", ".gg/programmatic/state.previous.json", ...(driftOnly || integratedRecovery ? ["package.json"] : [])].sort());
    const finalParent = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
    assert.equal(finalParent.provider, parentState.provider);
    assert.equal(finalParent.model, parentState.model);
    assert.equal(finalParent.sessionId, parentState.sessionId);
    if (extendedWorkflow) assert.ok(finalParent.messageCount > parentState.messageCount, "Only explicit parent turns extend its transcript");
    else assert.equal(finalParent.messageCount, parentState.messageCount + assessmentMessageDelta, "Only explicit assessments may extend the parent transcript");
    // Startup/reload may create an empty earlier host session. Prove the task adds no child
    // transcript and leaves every non-active host transcript byte-for-byte unchanged.
    const transcriptsAfter = transcriptSnapshot();
    assertTranscriptIsolation(transcriptsBefore, transcriptsAfter, hostTranscripts[0]);
    json(join(paths.audit, "transcript-isolation.json"), { passed: true, hostTranscript: hostTranscripts[0], before: transcriptsBefore, after: transcriptsAfter });
    const events = eventsBeforeRendererReload ?? await client.evaluate(`window.fixtureEvents`);
    if (driftOnly) assert.deepEqual(events, [], "No task approval, execution output or completion events");
    else assert.ok(events.some((event) => event.type === "text_delta" && event.data.text.includes("[research] read")));
    const parentIsolation = { before: { provider: parentState.provider, model: parentState.model, sessionId: parentState.sessionId, messageCount: parentState.messageCount }, after: { provider: finalParent.provider, model: finalParent.model, sessionId: finalParent.sessionId, messageCount: finalParent.messageCount } };
    return { passed: true, parentIsolation, driftOnly, integratedRecovery, extendedWorkflow, minimized: false, nativeInputSmoke: visual, real: [driftOnly ? "rendered initial approval, scan, dismissal, exact drift inspection, separate refresh approval and rescan" : "rendered setup, separate approval, scan, selection, run approval and rescan", "native action/prompt/question/event proxy", "fresh profile approval validation", ...(driftOnly ? [] : ["Node dispatcher", "AgentSession", "read tool"]), "lifecycle storage", ...(integratedRecovery ? ["completed-history drift and approved refresh", "previous-state inspection without writes, then explicit recovery scan"] : [])], mocked: ["staged detector route only: setup-tauri-package to research", "local Azure Responses provider fixture", "MCP disabled; no server approved"], requests: requests.length, assessmentRequests: assessments.map((entry) => ({ mode: entry.mode, requests: entry.requests.length, messageDelta: entry.messageDelta })), changedProjectFiles: changes, childTranscript: false };
  }
  const result = await runSmokeLifecycle({
    audit,
    workflow,
    diagnose: async () => client ? {
      workspaceLayout: await client.evaluate('localStorage.getItem("gg-workspace-layout-recursive:main")'),
      rejectedWorkspaceLayout: await client.evaluate('localStorage.getItem("gg-workspace-layout-recursive-rejected:main")'),
      text: String(await client.evaluate('document.body.innerText')).slice(0, 8192),
      discoveryTrace: discoveryOnly ? await client.evaluate('window.fixtureDiscoveryTrace ?? []') : undefined,
      buttons: await client.evaluate('Array.from(document.querySelectorAll("button")).slice(0,32).map(b=>({text:b.textContent.slice(0,256),disabled:b.disabled}))'),
    } : {},
    beforeCleanup: async () => { await observeMinimized?.("before-cleanup"); },
    cleanup: async () => {
      const cleanupErrors = [];
      const cleanupReports = [];
      const attempt = async (action) => {
        try { await action(); } catch (error) { cleanupErrors.push(error); }
      };
      await attempt(() => client?.close());
      for (const owner of owned.reverse()) {
        await attempt(async () => {
          const report = await owner.cleanup();
          cleanupReports.push(report);
          if (!report.stopped) throw new Error(report.errors.join("; ") || "Owned cleanup unverified");
        });
      }
      let providerServerClosed = !server;
      await attempt(async () => {
        if (server) {
          server.closeAllConnections();
          if (server.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
        }
        providerServerClosed = true;
      });
      await attempt(() => { if (logFd !== undefined) closeSync(logFd); });
      await attempt(() => json(join(audit, "cleanup.json"), { ownedProcessTreesStopped: cleanupErrors.length === 0, providerServerClosed, processes: cleanupReports, errors: cleanupErrors.map((error) => error.message) }));
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Fixture cleanup failed");
    },
    validate: (result) => {
      if (!visual && !discoveryOnly) validateNativeSmokeEvidence(paths.audit, result, { driftOnly, integratedRecovery, extendedWorkflow, allowNormalWindow });
      if (!visual && discoveryOnly) {
        const observations = JSON.parse(readFileSync(join(paths.audit, "native-minimized.json"), "utf8"));
        assert.ok(observations.samples.length >= 3 && observations.samples.every((sample) => sample.verified && sample.minimized));
        result.minimized = true;
      }
    },
  });
  console.log(`PROGRAMMATIC ${discoveryOnly ? "DISCOVERY" : extendedWorkflow ? "EXTENDED WORKFLOW" : integratedRecovery ? "INTEGRATED RECOVERY" : driftOnly ? "DRIFT" : "EXECUTION"} DEV SMOKE PASS (one ${visual ? "visible" : result.minimized ? "minimized" : "normal-window fallback"} developer launch; no packaging)`);
}

if (mode === "sidecar") {
  // This wrapper supplies only the deterministic provider boundary; the dispatcher is production code.
  const url = new URL(process.env.GG_PROGRAMMATIC_EXECUTION_FIXTURE_PROVIDER);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  for (const key of Object.keys(process.env)) if (/^AZURE_/.test(key)) delete process.env[key];
  Object.assign(process.env, providerEnvironment);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (target.href !== providerEnvironment.AZURE_OPENAI_BASE_URL) return Promise.reject(new Error("External network unavailable in fixture"));
    // Mock only the provider transport; preserve the real Azure configuration validator.
    return realFetch(url, init);
  };
  if (process.env.GG_PROGRAMMATIC_DISCOVERY_ONLY === "1") {
    const adapterUrl = pathToFileURL(join(workspace, "packages/ggcoder/dist/app-sidecar-programmatic-chat.js")).href;
    registerHooks({ load(target, context, nextLoad) {
      const loaded = nextLoad(target, context);
      if (target !== adapterUrl) return loaded;
      const source = String(loaded.source);
      const needle = "const candidateReview = await this.reviewCandidate(input);";
      assert.equal(source.split(needle).length - 1, 1);
      return { ...loaded, source: `import { writeFileSync as writeReviewTrace } from "node:fs";\n` + source.replace(needle,
        needle + `\nwriteReviewTrace(${JSON.stringify(join(process.env.GG_PROGRAMMATIC_DISCOVERY_AUDIT, "discovery-host.json"))}, JSON.stringify({ target, now: this.target(), epoch, currentEpoch: this.epoch, candidateReview }, null, 2));`) };
    } });
    const end = http.ServerResponse.prototype.end;
    http.ServerResponse.prototype.end = function (chunk, ...args) {
      if (this.req?.url === "/programmatic" && typeof chunk === "string" && chunk.length < 100_000) {
        const body = JSON.parse(chunk);
        if (body.action === "review-candidate") json(join(process.env.GG_PROGRAMMATIC_DISCOVERY_AUDIT, "discovery-http.json"), { status: this.statusCode, body });
      }
      return end.call(this, chunk, ...args);
    };
  }
  if (process.env.GG_PROGRAMMATIC_DISCOVERY_ONLY !== "1") {
  const detectorUrl = pathToFileURL(join(workspace, "packages/ggcoder/dist/core/programmatic/opportunities.js")).href;
  const original = readFileSync(fileURLToPath(detectorUrl), "utf8");
  const staged = readFileSync(process.env.GG_PROGRAMMATIC_EXECUTION_FIXTURE_DETECTOR, "utf8");
  const needle = 'specialistCommand: "setup-tauri-package"';
  assert.equal(original.split(needle).length - 1, 1);
  assert.equal(staged, original.replace(needle, 'specialistCommand: "research"'));
  registerHooks({ load(target, context, nextLoad) {
    return target === detectorUrl ? { format: "module", source: staged, shortCircuit: true } : nextLoad(target, context);
  } });
  }
  await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/app-sidecar.js")));
} else if (process.argv[2] === "--preflight") {
  const { resolveAzureOpenAIConfig } = await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/core/auth-storage.js")));
  assert.ok(resolveAzureOpenAIConfig(providerEnvironment), "Fixture provider must satisfy real daemon startup validation");
  console.log("Fixture provider configuration preflight passed; no native app launched.");
} else await run();
