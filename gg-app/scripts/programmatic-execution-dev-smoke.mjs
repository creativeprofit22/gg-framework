import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectToDevWebview, createIsolatedProfile, reserveHeldTcpPort, sanitizedSmokeEnvironment } from "./phase-25-windows-smoke-helpers.mjs";
import { terminateProcessTree, readProcessTable, processTreeSnapshot, survivingProcessIds } from "./workspace-shell-evidence.mjs";

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

async function seed(paths, agentDir) {
  const previous = { ...process.env };
  try {
    process.env.HOME = paths.home;
    process.env.USERPROFILE = paths.home;
    process.env.GG_AGENT_DIR = agentDir;
    const { buildProgrammaticProfileProposal, persistProgrammaticProfile } = await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/core/programmatic/profile.js")));
    const { runProgrammaticScan } = await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/core/programmatic/lifecycle.js")));
    mkdirSync(join(paths.project, "src-tauri"), { recursive: true });
    writeFileSync(join(paths.project, ".gitignore"), ".gg/\n");
    writeFileSync(join(paths.project, "AGENTS.md"), "NECESSARY FIXTURE PROJECT INSTRUCTIONS\n");
    json(join(paths.project, "package.json"), { name: "harmless-isolated-fixture" });
    writeFileSync(join(paths.project, "src-tauri/Cargo.toml"), "[package]\nname='fixture'\n");
    json(join(paths.project, "src-tauri/tauri.conf.json"), {});
    const proposal = await buildProgrammaticProfileProposal(paths.project);
    assert.equal((await persistProgrammaticProfile(paths.project, proposal.configurationFingerprint, proposal.profile)).ok, true);
    assert.equal((await runProgrammaticScan(paths.project)).ok, true);
    const statePath = join(paths.project, ".gg/programmatic/state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.records.length, 1);
    state.records[0].opportunity.route = { status: "routable", specialistCommand: "research" };
    json(statePath, state);
    const profilePath = join(paths.project, ".gg/programmatic/profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.profile.scanners[0].specialistCommand = "research";
    json(profilePath, profile);
    return { id: state.records[0].opportunity.identity.id, fingerprint: state.configurationFingerprint.sha256, condition: state.records[0].opportunity.verification, statePath };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

async function run() {
  assert.equal(process.platform, "win32");
  assert.deepEqual(process.argv.slice(2), ["--identity", identity]);
  // Compile the current developer target; a debug-directory executable can be a stale smoke build.
  const nativeCommand = "pnpm exec tauri dev --config src-tauri/tauri.local.conf.json";
  assert.ok(existsSync(join(workspace, "packages/ggcoder/dist/core/programmatic/execution.js")), "Compile the development dispatcher first.");
  const paths = createIsolatedProfile(mkdtempSync(join(tmpdir(), "gg-programmatic-execution-")));
  const agentDir = join(paths.home, ".gg/identities", identity);
  mkdirSync(join(agentDir, "commands"), { recursive: true });
  writeFileSync(join(agentDir, "commands/research.md"), `---\nname: research\ndescription: Harmless fixture\n---\n${fixtureBody}\n`);
  json(join(agentDir, "auth.json"), {});
  json(join(agentDir, "settings.json"), { defaultProvider: "azure", defaultModel: "azure:fixture", autoCompact: false, idealReviewEnabled: false });
  const fixture = await seed(paths, agentDir);
  const baseline = snapshot(paths.project);
  const requests = [];
  let providerFailure;
  const server = http.createServer(async (request, response) => {
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
    GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort), GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1", GG_APP_DEV_SMOKE_WINDOW: "minimized",
    COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node/corepack"), COREPACK_DEFAULT_TO_LATEST: "0",
    CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup") });
  const logFd = openSync(join(paths.audit, "developer.log"), "a");
  const owned = [];
  let client;
  let failure;
  try {
    const native = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", nativeCommand], { cwd: app, env, windowsHide: true, stdio: ["ignore", logFd, logFd] });
    owned.push(native);
    await new Promise((done, reject) => { native.once("spawn", done); native.once("error", reject); });
    client = await connectToDevWebview(cdpPort, (label, check) => waitFor(label, () => {
      if (native.exitCode !== null) throw new Error("Developer app exited; inspect developer.log");
      return check();
    }, 300_000), (target) => String(target.url).startsWith("http://localhost:1420"));
    await client.send("Runtime.enable");
    await waitFor("developer document", () => client.evaluate(`location.origin === "http://localhost:1420" && document.readyState === "complete"`));
    await waitFor("native session", () => client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"}).then(s => s.ready && s.provider === "azure" && s)`));
    const parentState = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
    await client.evaluate(`import("/src/agent.ts").then(m => { window.fixtureEvents=[]; window.fixtureUnsubscribe=m.subscribe(e=>{ if (["ask_user","text_delta","done"].includes(e.type) && window.fixtureEvents.length < 100) window.fixtureEvents.push(e); }); return true; })`);
    await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_prompt", { paneId:"primary", text:${JSON.stringify(`/programmatic-run ${fixture.id} ${fixture.fingerprint}`)}, attachments:[], meta:null })`);
    const question = await waitFor("native approval question", () => client.evaluate(`window.fixtureEvents.find(e=>e.type==="ask_user")?.data`));
    assert.equal(requests.length, 0, "No provider dispatch before approval");
    assert.match(question.questions[0].question, /research/);
    await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_ask_user", {paneId:"primary", id:${JSON.stringify(question.id)}, action:"answer", answers:${JSON.stringify({ [question.questions[0].id]: question.questions[0].options[0].value })}})`);
    await waitFor("isolated result through native events", () => client.evaluate(`window.fixtureEvents.some(e=>e.type==="text_delta" && e.data.text.includes(${JSON.stringify(completion)}))`));
    await waitFor("parent settled", () => client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"}).then(s=>!s.running)`));
    if (providerFailure) throw providerFailure;
    assert.equal(requests.length, 3);
    const childInput = JSON.stringify(requests[0]);
    assert.ok(childInput.includes(fixtureBody));
    assert.ok(childInput.includes("NECESSARY FIXTURE PROJECT INSTRUCTIONS"));
    assert.ok(!childInput.includes(parentState.sessionId));
    const allowed = new Set(["read", "find", "grep", "ls", "code_search", "code_nav", "web_search", "web_fetch", "ask_user", "research_corpus", "programmatic_result"]);
    assert.ok(requests[0].tools.every((tool) => allowed.has(tool.name)));
    assert.equal(JSON.parse(readFileSync(fixture.statePath, "utf8")).records[0].lifecycle.state, "completed");
    const after = snapshot(paths.project);
    const changes = [...new Set([...Object.keys(baseline), ...Object.keys(after)])].filter((key) => baseline[key] !== after[key]);
    assert.deepEqual(changes.sort(), [".gg/programmatic/state.json", ".gg/programmatic/state.previous.json"]);
    const finalParent = await client.evaluate(`window.__TAURI_INTERNALS__.invoke("agent_state", {paneId:"primary"})`);
    assert.equal(finalParent.sessionId, parentState.sessionId);
    assert.equal(finalParent.messageCount, parentState.messageCount);
    const transcriptFiles = Object.keys(snapshot(join(agentDir, "sessions"))).filter((name) => name.endsWith(".jsonl"));
    assert.equal(transcriptFiles.length, 1, "Only the host transcript exists");
    const events = await client.evaluate(`window.fixtureEvents`);
    assert.ok(events.some((event) => event.type === "text_delta" && event.data.text.includes("[research] read")));
    json(join(paths.audit, "result.json"), { passed: true, minimized: true, real: ["developer app", "native prompt/question/event proxy", "Node dispatcher", "AgentSession", "read tool", "lifecycle storage"], mocked: ["local Azure Responses provider fixture", "MCP disabled; no server approved"], requests: requests.length, changedProjectFiles: changes, childTranscript: false });
  } catch (error) { failure = error; }
  finally {
    client?.close();
    const cleanupErrors = [];
    for (const child of owned.reverse()) {
      if (!child.pid) continue;
      try {
        const identities = processTreeSnapshot(await readProcessTable(), child.pid).identities;
        if (child.exitCode === null) await terminateProcessTree(child.pid);
        await waitFor("owned process cleanup", async () => survivingProcessIds(identities, await readProcessTable()).length === 0, 10_000);
      } catch (error) { cleanupErrors.push(error); }
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    closeSync(logFd);
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Fixture cleanup failed");
  }
  console.log(`Fixture evidence: ${paths.audit}`);
  if (failure) throw failure;
  console.log("PROGRAMMATIC EXECUTION DEV SMOKE PASS (one minimized developer launch; no packaging)");
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
  await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/app-sidecar.js")));
} else if (process.argv[2] === "--preflight") {
  const { resolveAzureOpenAIConfig } = await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/core/auth-storage.js")));
  assert.ok(resolveAzureOpenAIConfig(providerEnvironment), "Fixture provider must satisfy real daemon startup validation");
  console.log("Fixture provider configuration preflight passed; no native app launched.");
} else await run();
