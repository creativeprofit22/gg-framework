import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(app, "..");
const identity = "com.ggcoder.local-fork";
const fixture = JSON.parse(
  readFileSync(join(app, "src/test-fixtures/completed-verification-task.json"), "utf8"),
);
const providerEnvironment = {
  AZURE_OPENAI_API_KEY: "fixture-not-a-credential",
  AZURE_OPENAI_BASE_URL: "https://completion-provider.invalid/openai/v1/responses",
  AZURE_OPENAI_DEPLOYMENT: "fixture",
};
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
async function waitFor(label, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}

async function seed(paths, agentDir) {
  const { SessionManager } = await import(
    pathToFileURL(join(workspace, "packages/ggcoder/dist/core/session-manager.js"))
  );
  const manager = new SessionManager(join(agentDir, "sessions"));
  const session = await manager.create(paths.project, "azure", "azure:fixture");
  const timestamp = "2026-01-01T00:00:00.000Z";
  await manager.appendRequiredEntry(session.path, {
    type: "custom",
    id: randomUUID(),
    parentId: null,
    timestamp,
    kind: "app_transcript_marker",
    data: {
      version: 1,
      kind: "task",
      afterMessageCount: 0,
      data: { title: "Update sample window" },
    },
  });
  let parentId = null;
  // Resume just before the public final answer; the real agent must produce and persist that answer.
  for (const message of fixture.messages.slice(0, -1)) {
    const id = randomUUID();
    await manager.appendRequiredMessage(session.path, {
      type: "message",
      id,
      parentId,
      timestamp,
      message,
    });
    parentId = id;
  }
  const tasksDir = join(
    paths.home,
    ".gg-tasks/projects",
    createHash("sha256").update(paths.project).digest("hex").slice(0, 16),
  );
  mkdirSync(tasksDir, { recursive: true });
  const task = {
    id: randomUUID(),
    title: "Update sample window",
    prompt: fixture.messages[0].content,
    status: "pending",
    createdAt: timestamp,
  };
  json(join(tasksDir, "tasks.json"), [task]);
  return { session, task };
}

async function restoreWorkspace(client, project, sessionPath) {
  await waitFor(
    "native document",
    () => client.evaluate(`document.readyState === 'complete' && !!window.__TAURI_INTERNALS__`),
    180_000,
  );
  // Use the existing native smoke's persisted-layout setup; mounting the real pane performs binding.
  const layout = JSON.stringify({
    version: 9,
    root: { type: "leaf", paneId: "primary" },
    focusedPaneId: "primary",
    panes: { primary: { kind: "agent", mode: "code", cwd: project, sessionPath } },
  });
  await client.evaluate(`(async () => {
    const { windowLabel } = await import('/src/agent.ts');
    localStorage.setItem('gg-workspace-layout-recursive:' + windowLabel, ${JSON.stringify(layout)});
  })()`);
  await client.send("Page.reload", { ignoreCache: true });
  await waitFor("bound native pane", () =>
    client.evaluate(`!!document.querySelector('#workspace-pane-primary .chat-head-cwd')`),
  );
}

async function observe(client) {
  return client.evaluate(`(async () => {
    const agent = await import('/src/agent.ts');
    window.nativeCompletionEvidence = { label: agent.windowLabel, events: [] };
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => {
      const e = event.payload;
      if (['text_delta', 'agent_done', 'run_end', 'task_start', 'session_reset', 'hook', 'hook_armed'].includes(e.type)) {
        window.nativeCompletionEvidence.events.push({ receivedAt: new Date().toISOString(), ...e });
      }
    });
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: 'agent-event', target: { kind: 'WebviewWindow', label: agent.windowLabel }, handler
    });
    return agent.windowLabel;
  })()`);
}
const visibleAnswer = `(() => {
  const expected = ${JSON.stringify(fixture.finalAnswer)};
  const matches = [...document.querySelectorAll('.assistant-msg')].filter(e => e.textContent.includes(expected));
  if (matches.length !== 1) return false;
  const element = matches[0];
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
})()`;

async function run() {
  assert.equal(process.platform, "win32");
  assert.deepEqual(process.argv.slice(2), ["--visual"]);
  const paths = createIsolatedProfile(mkdtempSync(join(tmpdir(), "gg-completed-native-")));
  const agentDir = join(paths.home, ".gg/identities", identity);
  mkdirSync(agentDir, { recursive: true });
  json(join(agentDir, "auth.json"), {});
  json(join(agentDir, "settings.json"), {
    defaultProvider: "azure",
    defaultModel: "azure:fixture",
    autoCompact: false,
    idealReviewEnabled: false,
  });
  json(join(agentDir, "gg-app.json"), { projectsRoot: paths.project });
  const { session, task } = await seed(paths, agentDir);
  let requests = 0;
  let providerFailure;
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/openai/v1/responses");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= 1_000_000);
        chunks.push(chunk);
      }
      JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests++;
      assert.ok(requests <= 2, "No unexpected provider requests");
      const events = fixture.events
        .filter((e) => e.type === "text_delta")
        .slice(-2)
        .map((e) => ({ type: "response.output_text.delta", delta: e.data.text }));
      events.push({
        type: "response.completed",
        response: { usage: { input_tokens: 10, output_tokens: 20 } },
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    } catch (error) {
      providerFailure = error;
      response.writeHead(500);
      response.end("Fixture rejected request");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const reservation = await reserveHeldTcpPort();
  const cdpPort = reservation.port;
  await reservation.release();
  const env = sanitizedSmokeEnvironment(process.env, paths);
  for (const key of Object.keys(env))
    if (
      /(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS|^AZURE_|^HOMEDRIVE$|^HOMEPATH$)/i.test(
        key,
      )
    )
      delete env[key];
  Object.assign(env, {
    GG_SIDECAR_PATH: fileURLToPath(import.meta.url),
    GG_COMPLETED_NATIVE_MODE: "sidecar",
    GG_COMPLETED_NATIVE_PROVIDER: `http://127.0.0.1:${server.address().port}/openai/v1/responses`,
    GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort),
    GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
    GG_APP_DEV_SMOKE_WINDOW: "visible",
    COREPACK_HOME:
      process.env.COREPACK_HOME ?? join(process.env.LOCALAPPDATA ?? "", "node/corepack"),
    COREPACK_DEFAULT_TO_LATEST: "0",
    CARGO_HOME: process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.USERPROFILE ?? "", ".rustup"),
  });
  const logFd = openSync(join(paths.audit, "developer.log"), "a");
  const clients = [];
  let native;
  let failure;
  const results = [];
  console.log(`Native smoke evidence: ${paths.root}`);
  try {
    native = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "pnpm exec tauri dev --config src-tauri/tauri.local.conf.json"],
      { cwd: app, env, windowsHide: true, stdio: ["ignore", logFd, logFd] },
    );
    await new Promise((done, reject) => {
      native.once("spawn", done);
      native.once("error", reject);
    });
    const control = await connectToDevWebview(
      cdpPort,
      (label, check) => waitFor(label, check, 900_000),
      (target) =>
        String(target.url).startsWith("http://localhost:1420") &&
        !String(target.url).includes("whatsnew"),
    );
    clients.push(control);
    await restoreWorkspace(control, paths.project, null);
    await waitFor(
      "control agent ready",
      () =>
        control.evaluate(
          `window.__TAURI_INTERNALS__.invoke('agent_state', {paneId:'primary'}).then(s=>s.ready)`,
        ),
      180_000,
    );
    const controlLabel = await observe(control);
    const controlTarget = (
      await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    ).find((t) => t.type === "page" && !String(t.url).includes("whatsnew"));
    await control.evaluate(`window.__TAURI_INTERNALS__.invoke('new_window')`);
    const target = await connectToDevWebview(
      cdpPort,
      waitFor,
      (candidate) =>
        candidate.id !== controlTarget.id &&
        String(candidate.url).startsWith("http://localhost:1420") &&
        !String(candidate.url).includes("whatsnew"),
    );
    clients.push(target);
    await restoreWorkspace(target, paths.project, session.path);
    await waitFor("seeded history hydration", () =>
      target.evaluate(`document.body.textContent.includes('Verification completed draft.')`),
    );
    const targetLabel = await observe(target);
    assert.notEqual(targetLabel, controlLabel);

    for (const scenario of ["resumed-context", "task-pane"]) {
      await target.evaluate(`window.nativeCompletionEvidence.events.length = 0`);
      if (scenario === "resumed-context") {
        await target.evaluate(`document.querySelector('textarea').focus()`);
        await target.send("Input.insertText", { text: "Finish the sample update." });
        await target.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await target.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      } else {
        const tasks = await target.evaluate(
          `window.__TAURI_INTERNALS__.invoke('agent_tasks', {paneId:'primary'})`,
        );
        assert.ok(tasks.tasks.some((t) => t.id === task.id && t.status === "pending"));
        await target.evaluate(
          `[...document.querySelectorAll('button')].find(b => b.title.startsWith('View and run this project')).click()`,
        );
        await waitFor("Tasks pane Run control", () =>
          target.evaluate(
            `!!document.querySelector('button[title="Run this task in a fresh session"]:not(:disabled)')`,
          ),
        );
        await target.evaluate(
          `document.querySelector('button[title="Run this task in a fresh session"]').click()`,
        );
      }
      await waitFor(`${scenario} real completion receipt`, () =>
        target.evaluate(
          `window.nativeCompletionEvidence.events.some(e=>e.type==='run_end' && e.data.outcome==='completed')`,
        ),
      );
      assert.equal(providerFailure, undefined);
      const receipt = await target.evaluate(`window.nativeCompletionEvidence`);
      json(join(paths.audit, `${scenario}-receipt.json`), receipt);
      await waitFor(`${scenario} visible final answer`, () => target.evaluate(visibleAnswer));
      assert.ok(receipt.events.some((e) => e.type === "agent_done"));
      assert.ok(receipt.events.some((e) => e.type === "text_delta"));
      if (scenario === "task-pane") assert.ok(receipt.events.some((e) => e.type === "task_start"));
      const state = await target.evaluate(
        `window.__TAURI_INTERNALS__.invoke('agent_state', {paneId:'primary'})`,
      );
      const history = await target.evaluate(
        `window.__TAURI_INTERNALS__.invoke('agent_history', {paneId:'primary'})`,
      );
      assert.equal(history.history.at(-1).text, fixture.finalAnswer);
      assert.ok(!state.isRunning);
      assert.ok(resolve(state.sessionPath).startsWith(resolve(agentDir) + sep));
      const journal = readFileSync(state.sessionPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const finalMessage = journal
        .filter((row) => row.message?.role === "assistant")
        .at(-1).message;
      assert.equal(
        typeof finalMessage.content === "string"
          ? finalMessage.content
          : finalMessage.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
        fixture.finalAnswer,
      );
      assert.equal(
        journal.filter((row) => row.kind === "run_finished").at(-1).data.outcome,
        "completed",
      );
      for (const stage of ["completed", "reloaded"]) {
        if (stage === "reloaded") {
          await target.send("Page.reload", { ignoreCache: true });
          await waitFor(`${scenario} reload final answer`, () => target.evaluate(visibleAnswer));
          const after = await target.evaluate(
            `window.__TAURI_INTERNALS__.invoke('agent_state', {paneId:'primary'})`,
          );
          assert.equal(after.sessionId, state.sessionId);
          await observe(target);
        }
        await target.evaluate(
          `document.querySelector('.assistant-msg:last-of-type')?.scrollIntoView({block:'end'})`,
        );
        await target.evaluate(`Promise.all([...document.querySelectorAll('.assistant-msg')]
          .flatMap(e => e.getAnimations({subtree:true}))
          .filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime))
          .map(a => a.finished.catch(() => {})))`);
        const screenshot = await target.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(
          join(paths.screenshots, `${scenario}-${stage}.png`),
          Buffer.from(screenshot.data, "base64"),
        );
        assert.equal(await target.evaluate(visibleAnswer), true);
      }
      const leaked = await control.evaluate(
        `window.nativeCompletionEvidence.events.filter(e=>['agent_done','run_end','text_delta','task_start'].includes(e.type))`,
      );
      assert.deepEqual(leaked, [], "Secondary-window traffic must not reach the control window");
      results.push({
        scenario,
        targetLabel,
        sessionId: state.sessionId,
        receipt,
        persistedFinalAnswer: true,
        visibleAfterCompletion: true,
        visibleAfterReload: true,
        controlWindowLeak: false,
      });
      console.log(
        `PASS ${scenario}: real completion received, answer visible after completion/reload, no cross-window leak`,
      );
    }
    assert.equal(requests, 2);
    json(join(paths.audit, "result.json"), {
      passed: true,
      visual: true,
      real: [
        "React composer and Tasks pane controls",
        "production Node daemon and AgentSession",
        "daemon SSE",
        "Rust per-session proxy",
        "target WebviewWindow event listener",
        "React rendering",
        "native /history invoke",
        "session journal persistence",
        "webview reload via history",
        "task runner",
      ],
      simulated: ["Azure model response", "sanitized prior hook messages"],
      notExercised: ["removed verification gate generation", "installer", "external model service"],
      results,
    });
  } catch (error) {
    failure = error;
    for (const [index, client] of clients.entries()) {
      try {
        json(
          join(paths.audit, `failure-window-${index}.json`),
          await client.evaluate(
            `({events: window.nativeCompletionEvidence, text: document.body.innerText})`,
          ),
        );
        const shot = await client.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(
          join(paths.screenshots, `failure-window-${index}.png`),
          Buffer.from(shot.data, "base64"),
        );
      } catch {
        /* The owned webview may already have exited. */
      }
    }
  } finally {
    for (const client of clients) client.close();
    const cleanupErrors = [];
    if (native?.pid) {
      try {
        const identities = processTreeSnapshot(await readProcessTable(), native.pid).identities;
        if (native.exitCode === null) await terminateProcessTree(native.pid);
        await waitFor(
          "owned process cleanup",
          async () => survivingProcessIds(identities, await readProcessTable()).length === 0,
          10_000,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    closeSync(logFd);
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        "Native smoke cleanup failed",
      );
  }
  if (failure) throw failure;
  console.log(`COMPLETED VERIFICATION NATIVE SMOKE PASS: ${paths.audit}`);
}

if (process.env.GG_COMPLETED_NATIVE_MODE === "sidecar") {
  const url = new URL(process.env.GG_COMPLETED_NATIVE_PROVIDER);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  for (const key of Object.keys(process.env)) if (/^AZURE_/.test(key)) delete process.env[key];
  Object.assign(process.env, providerEnvironment);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (target.href !== providerEnvironment.AZURE_OPENAI_BASE_URL)
      return Promise.reject(new Error("External network unavailable in fixture"));
    return realFetch(url, init);
  };
  // Only model transport is substituted. No daemon routes, event bus, Rust IPC, or UI handlers are patched.
  await import(pathToFileURL(join(workspace, "packages/ggcoder/dist/app-sidecar.js")));
} else await run();
