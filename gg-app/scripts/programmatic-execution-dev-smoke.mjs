import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { connectToDevWebview, createIsolatedProfile, reserveHeldTcpPort, sanitizedSmokeEnvironment } from "./phase-25-windows-smoke-helpers.mjs";
import { readProcessTable, processTreeSnapshot } from "./workspace-shell-evidence.mjs";
import { runSmokeLifecycle, validateNativeSmokeEvidence, trackOwnedProcess, waitForLiveProcess } from "./programmatic-smoke-lifecycle.mjs";
import { createNativeInputSmoke } from "./programmatic-native-input-smoke.mjs";
import { readExecutionDisplay, assertTranscriptIsolation } from "./programmatic-execution-smoke-checks.mjs";

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

function seed(paths) {
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
  assert.ok(!integratedRecovery || (!driftOnly && !visual), "Integrated recovery excludes drift-only and visual modes");
  const allowNormalWindow = process.argv.includes("--allow-normal-window");
  assert.ok(!allowNormalWindow || !visual, "Normal-window fallback does not enable visual/input checks");
  assert.ok(!driftOnly || !visual, "Drift-only smoke does not repeat visual/input checks");
  const reuseBuiltDev = process.argv.includes("--reuse-built-dev");
  assert.deepEqual(process.argv.slice(2), ["--identity", identity, ...(driftOnly ? ["--drift-only"] : []), ...(integratedRecovery ? ["--integrated-recovery"] : []), ...(visual ? ["--visual"] : []), ...(allowNormalWindow ? ["--allow-normal-window"] : []), ...(reuseBuiltDev ? ["--reuse-built-dev"] : [])]);
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
    const fixture = seed(paths);
    assert.equal(existsSync(join(paths.project, ".gg/programmatic/profile.json")), false);
    const baseline = snapshot(paths.project);
    const requests = [];
    let providerFailure;
    server = http.createServer(async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/openai/v1/responses");
        const chunks = [];
        let size = 0;
        for await (const chunk of request) { size += chunk.length; assert.ok(size < 1_000_000); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(requests.length < 3, "No automatic specialist rerun");
        requests.push(body);
        let events;
        if (requests.length < 3) {
          const first = requests.length === 1;
          const item = { type: "function_call", id: first ? "fc_read" : "fc_complete", call_id: first ? "fixture-read" : "fixture-complete",
            name: first ? "read" : "programmatic_result",
            arguments: JSON.stringify(first ? { file_path: "package.json" } : { summary: completion, successCondition: fixture.condition, toolCallIds: ["fixture-read"] }) };
          events = [{ type: "response.output_item.added", output_index: 0, item },
            { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
            { type: "response.output_item.done", output_index: 0, item }];
        } else events = [{ type: "response.output_text.delta", delta: "Harmless specialist finished." }];
        events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } catch (error) { providerFailure = error; response.writeHead(500); response.end("Fixture rejected request"); }
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
      GG_PROGRAMMATIC_EXECUTION_FIXTURE_DETECTOR: fixture.stagedDetector,
      GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort), GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1", GG_APP_DEV_SMOKE_WINDOW: visual ? "visible" : "minimized",
      COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node/corepack"), COREPACK_DEFAULT_TO_LATEST: "0",
      CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup") });
    console.log(`Fixture evidence: ${paths.audit}`);
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
    await client.evaluate(`import("/src/agent.ts").then(m => { window.fixtureEvents=[]; window.fixtureUnsubscribe=m.subscribe(e=>{ if (["ask_user","text_delta","done"].includes(e.type) && window.fixtureEvents.length < 100) window.fixtureEvents.push(e); }); return true; })`);
    const input = visual ? await createNativeInputSmoke(client, native.pid, paths.audit, waitFor) : null;
    const click = async (label) => {
      if (input) return input.activate(input.button(label), label, label === "Approve and save setup");
      await waitFor(`rendered ${label}`, () => client.evaluate(`Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`));
      await client.evaluate(`Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled).click()`);
    };
    await click("Opportunities");
    await waitFor("setup-required section", () => client.evaluate(`document.querySelector(".programmatic-chat")?.textContent.includes("Start with Review setup")`));
    await click("Review setup");
    await waitFor("exact proposal", () => client.evaluate(`document.querySelector('[aria-label="Exact settings to save"]')?.textContent.includes('"research"')`));
    assert.equal(requests.length, 0, "No provider dispatch during setup inspection");
    assert.equal(existsSync(join(paths.project, ".gg/programmatic/profile.json")), false, "Inspection must not write approval");
    await click("Approve and save setup");
    await waitFor("approved profile", () => existsSync(join(paths.project, ".gg/programmatic/profile.json")));
    await click("Check for opportunities");
    await waitFor("persisted scan", () => existsSync(fixture.statePath));
    const scanned = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    assert.equal(scanned.records.length, 1);
    Object.assign(fixture, { id: scanned.records[0].opportunity.identity.id, fingerprint: scanned.configurationFingerprint.sha256, condition: scanned.records[0].opportunity.verification });
    await waitFor("selectable opportunity", () => client.evaluate(`!!document.querySelector('.programmatic-row:not(:disabled)')`));
    if (input) await input.activate("document.querySelector('.programmatic-row:not(:disabled)')", "Select opportunity", true);
    else await client.evaluate(`document.querySelector('.programmatic-row:not(:disabled)').click()`);
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
      assert.equal(await client.evaluate(`Array.from(document.querySelectorAll('.programmatic-chat button')).find(b=>b.textContent.trim()==='Check for opportunities').disabled`), true);
      assert.equal(await client.evaluate(`Array.from(document.querySelectorAll('.programmatic-chat button')).some(b=>b.textContent.trim()==='Review task approval' && !b.disabled)`), false);
      assert.equal(await client.evaluate(`document.querySelector('.programmatic-detail')?.textContent.includes(${JSON.stringify(terminalLabel)})`), true);
      assert.deepEqual(readFileSync(profilePath), previousProfile);
      assert.deepEqual(readFileSync(fixture.statePath), previousState);
      await observeMinimized?.(driftOnly ? "dismissed-exact-drift" : "completed-exact-drift");
      await click("Review setup refresh");
      await waitFor("refresh proposal", () => client.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Approve and save refresh' && !b.disabled)`));
      assert.deepEqual(readFileSync(profilePath), previousProfile, "Review cannot write setup");
      await click("Approve and save refresh");
      await waitFor("new approved fingerprint", () => JSON.parse(readFileSync(profilePath, "utf8")).configurationFingerprint.sha256 !== fixture.fingerprint);
      assert.deepEqual(readFileSync(fixture.statePath), previousState, "Approval must not scan or reset lifecycle");
      await observeMinimized?.("refresh-approved-before-rescan");
      await click("Check for opportunities");
      await waitFor("reconciled fingerprint", () => JSON.parse(readFileSync(fixture.statePath, "utf8")).configurationFingerprint.sha256 !== fixture.fingerprint);
      await waitFor("retained terminal selection", () => client.evaluate(`document.querySelector('.programmatic-row[aria-pressed="true"]')?.textContent.includes(${JSON.stringify(terminalLabel)}) && document.querySelector('.programmatic-detail')?.textContent.includes(${JSON.stringify(terminalLabel)})`));
      const refreshed = JSON.parse(readFileSync(fixture.statePath, "utf8")).records[0];
      assert.deepEqual(refreshed.opportunity.identity, terminal.opportunity.identity);
      assert.deepEqual(refreshed.lifecycle, terminal.lifecycle);
      assert.equal(requests.length, driftOnly ? 0 : 3, "Drift workflow never dispatches a provider or specialist");
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
    await click("Check for opportunities");
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
      await click("Check for opportunities");
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
    const after = snapshot(paths.project);
    const changes = [...new Set([...Object.keys(baseline), ...Object.keys(after)])].filter((key) => baseline[key] !== after[key]);
    assert.deepEqual(changes.sort(), [".gg/programmatic/profile.json", ".gg/programmatic/state.json", ".gg/programmatic/state.previous.json", ...(driftOnly || integratedRecovery ? ["package.json"] : [])]);
    const finalParent = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
    assert.equal(finalParent.provider, parentState.provider);
    assert.equal(finalParent.model, parentState.model);
    assert.equal(finalParent.sessionId, parentState.sessionId);
    assert.equal(finalParent.messageCount, parentState.messageCount);
    // Startup/reload may create an empty earlier host session. Prove the task adds no child
    // transcript and leaves every non-active host transcript byte-for-byte unchanged.
    const transcriptsAfter = transcriptSnapshot();
    assertTranscriptIsolation(transcriptsBefore, transcriptsAfter, hostTranscripts[0]);
    json(join(paths.audit, "transcript-isolation.json"), { passed: true, hostTranscript: hostTranscripts[0], before: transcriptsBefore, after: transcriptsAfter });
    const events = await client.evaluate(`window.fixtureEvents`);
    if (driftOnly) assert.deepEqual(events, [], "No task approval, execution output or completion events");
    else assert.ok(events.some((event) => event.type === "text_delta" && event.data.text.includes("[research] read")));
    const parentIsolation = { before: { provider: parentState.provider, model: parentState.model, sessionId: parentState.sessionId, messageCount: parentState.messageCount }, after: { provider: finalParent.provider, model: finalParent.model, sessionId: finalParent.sessionId, messageCount: finalParent.messageCount } };
    return { passed: true, parentIsolation, driftOnly, integratedRecovery, minimized: false, nativeInputSmoke: visual, real: [driftOnly ? "rendered initial approval, scan, dismissal, exact drift inspection, separate refresh approval and rescan" : "rendered setup, separate approval, scan, selection, run approval and rescan", "native action/prompt/question/event proxy", "fresh profile approval validation", ...(driftOnly ? [] : ["Node dispatcher", "AgentSession", "read tool"]), "lifecycle storage", ...(integratedRecovery ? ["completed-history drift and approved refresh", "previous-state inspection without writes, then explicit recovery scan"] : [])], mocked: ["staged detector route only: setup-tauri-package to research", "local Azure Responses provider fixture", "MCP disabled; no server approved"], requests: requests.length, changedProjectFiles: changes, childTranscript: false };
  }
  const result = await runSmokeLifecycle({
    audit,
    workflow,
    diagnose: async () => client ? {
      workspaceLayout: await client.evaluate('localStorage.getItem("gg-workspace-layout-recursive:main")'),
      rejectedWorkspaceLayout: await client.evaluate('localStorage.getItem("gg-workspace-layout-recursive-rejected:main")'),
      text: String(await client.evaluate('document.body.innerText')).slice(0, 8192),
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
      if (!visual) validateNativeSmokeEvidence(paths.audit, result, { driftOnly, integratedRecovery, allowNormalWindow });
    },
  });
  console.log(`PROGRAMMATIC ${integratedRecovery ? "INTEGRATED RECOVERY" : driftOnly ? "DRIFT" : "EXECUTION"} DEV SMOKE PASS (one ${visual ? "visible" : result.minimized ? "minimized" : "normal-window fallback"} developer launch; no packaging)`);
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
  const detectorUrl = pathToFileURL(join(workspace, "packages/ggcoder/dist/core/programmatic/opportunities.js")).href;
  const original = readFileSync(fileURLToPath(detectorUrl), "utf8");
  const staged = readFileSync(process.env.GG_PROGRAMMATIC_EXECUTION_FIXTURE_DETECTOR, "utf8");
  const needle = 'specialistCommand: "setup-tauri-package"';
  assert.equal(original.split(needle).length - 1, 1);
  assert.equal(staged, original.replace(needle, 'specialistCommand: "research"'));
  registerHooks({ load(target, context, nextLoad) {
    return target === detectorUrl ? { format: "module", source: staged, shortCircuit: true } : nextLoad(target, context);
  } });
  await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/app-sidecar.js")));
} else if (process.argv[2] === "--preflight") {
  const { resolveAzureOpenAIConfig } = await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/core/auth-storage.js")));
  assert.ok(resolveAzureOpenAIConfig(providerEnvironment), "Fixture provider must satisfy real daemon startup validation");
  console.log("Fixture provider configuration preflight passed; no native app launched.");
} else await run();
