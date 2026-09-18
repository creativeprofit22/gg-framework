import assert from "node:assert/strict";

const ORIGIN = "http://localhost:1420";
const invoke = (command, args) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})})`;
const qwenTile = `[...document.querySelectorAll('.login-tile')].find(b => b.textContent.includes('Qwen Cloud'))`;
const form = `document.querySelector('input[placeholder="Enter sk-sp- key"]')?.closest('form')`;
const field = `${form}?.querySelector('input[type=password]')`;
const state = (client) => client.evaluate(invoke("agent_state", { paneId: "primary" }));

export async function click(client, label, waitFor, scope = '') {
  const button = `[...document.querySelectorAll(${JSON.stringify(`${scope} button`.trim())})].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`;
  await waitFor(label, () => client.evaluate(`Boolean(${button})`));
  const point = await client.evaluate(`(() => { const b = ${button}; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function fill(client, key) {
  assert.equal(await client.evaluate(`Boolean(${field} && !${field}.disabled && ${field}.type === 'password')`), true);
  await client.evaluate(`(() => { const input = ${field}; input.value = ''; input.focus(); return true; })()`);
  await client.send("Input.insertText", { text: key });
  assert.equal(await client.evaluate(`${field}.value === ${JSON.stringify(key)}`), true);
}

export function fixtureLayout(project, sessionPath = null) {
  return { version: 9, root: { type: "split", direction: "horizontal", size: { type: "ratio", value: 50 }, first: { type: "leaf", paneId: "primary" }, second: { type: "leaf", paneId: "auth" } }, focusedPaneId: "primary", panes: { primary: { kind: "agent", mode: "code", cwd: project, sessionPath }, auth: null } };
}

async function prepare(client, windowIdentity, paths, waitFor) {
  assert.ok(paths.session?.path && paths.session?.id, 'A durable isolated session must be selected before observing recovery');
  const layout = fixtureLayout(paths.project, paths.session.path);
  await client.evaluate(`localStorage.setItem(${JSON.stringify(`gg-workspace-layout-recursive:${windowIdentity.label}`)}, ${JSON.stringify(JSON.stringify(layout))}); window.qwenProvisioning = true; true`);
  await client.send("Page.reload");
  await waitFor("provisioned document", () => client.evaluate(`!window.qwenProvisioning && document.readyState === 'complete' && location.origin === ${JSON.stringify(ORIGIN)}`));
  await waitFor("recovered fixture session", async () => {
    try { const value = await state(client); return value.ready && value.provider === "azure" && value.model === "azure:fixture" && value.sessionId === paths.session.id && value.sessionPath === paths.session.path; } catch { return false; }
  });
  await click(client, "Login to AI Providers", waitFor, '#workspace-pane-auth');
  windowIdentity.loginObservations = [];
  let pollCount = 0;
  await waitFor("Qwen login tile", async () => {
    const observed = await client.evaluate(`({ tilePresent: Boolean(${qwenTile}), tiles: document.querySelectorAll('.login-tile').length, loading: document.body.textContent.includes('Loading providers'), home: Boolean([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Login to AI Providers')), documentReady: document.readyState === 'complete' })`);
    const sample = { poll: ++pollCount, ...observed };
    if (windowIdentity.loginObservations.length === 0) windowIdentity.loginObservations.push(sample);
    else windowIdentity.loginObservations[1] = sample;
    return observed.tilePresent;
  });
  await client.evaluate(`${qwenTile}.click(); true`);
  await waitFor("live connection form", () => client.evaluate(`Boolean(${field} && !${field}.disabled)`));
  await client.evaluate(`import('/src/agent.ts').then(async m => {
    window.qwenObserved = { auth: 0, models: 0 };
    window.qwenObservedForm = ${form}; window.qwenObservedHub = document.querySelector('.login-grid');
    window.qwenAuthUnsubscribe = m.subscribe(e => { if (e.type === 'auth_change' && e.data.provider === 'qwen-cloud') window.qwenObserved.auth++; });
    window.qwenModelUnsubscribe = await m.onModelsChanged(() => window.qwenObserved.models++);
    return true;
  })`);
  return state(client);
}

async function modelUi(client, saved, waitFor) {
  const trigger = `document.querySelector('.agent-pane .model-button')`;
  await waitFor("enabled model picker", () => client.evaluate(`Boolean(${trigger} && !${trigger}.disabled)`));
  if (!await client.evaluate(`${trigger}.getAttribute('aria-expanded') === 'true'`)) await client.evaluate(`${trigger}.click(); true`);
  await waitFor("rendered refreshed model catalog", () => client.evaluate(`(() => {
    const menu = document.getElementById(${trigger}.getAttribute('aria-controls'));
    if (!menu) return false;
    return Boolean([...menu.querySelectorAll('[role=group]')].find(g => g.getAttribute('aria-label')?.includes('Qwen Cloud'))) === ${saved};
  })()`));
  await client.evaluate(`${trigger}.click(); true`);
  return true;
}

export function liveConnectionExpression(saved) {
  return `(() => {
    const f = ${form}, tile = ${qwenTile};
    return Boolean(f && window.qwenObservedHub) && f === window.qwenObservedForm && document.querySelector('.login-grid') === window.qwenObservedHub &&
      f?.textContent.includes(${JSON.stringify(saved ? "Saved connection — not remotely verified" : "No saved connection")}) &&
      Boolean(tile?.querySelector('[aria-label="Connected"]')) === ${saved};
  })()`;
}

async function snapshot(client, saved, baseline, waitFor, { models = true } = {}) {
  await waitFor("live hub and form refresh", () => client.evaluate(liveConnectionExpression(saved)));
  const native = await client.evaluate(invoke("qwen_cloud_connection_status"));
  assert.equal(native.ok, true);
  assert.equal(native.status.credential, saved ? "saved" : "absent");
  assert.equal(native.status.verification, "not-tested");
  assert.equal(native.status.allowance, "unavailable-with-inference-key");
  const auth = await client.evaluate(`import('/src/agent.ts').then(m => m.authStatus()).then(p => p.find(x => x.value === 'qwen-cloud')?.connected)`);
  assert.equal(auth, saved);
  const current = await state(client);
  assert.equal(current.provider, baseline.provider);
  assert.equal(current.model, baseline.model);
  assert.equal(current.sessionId, baseline.sessionId);
  assert.equal(current.sessionPath, baseline.sessionPath);
  assert.equal(current.ready, true);
  const uiModels = models ? await modelUi(client, saved, waitFor) : null;
  return { saved, unverified: true, auth, liveForm: true, liveHub: true, uiModels,
    inputEmpty: await client.evaluate(`${field}.value === ''`), masked: await client.evaluate(`${field}.type === 'password'`),
    provider: current.provider, model: current.model, sessionId: current.sessionId, sessionPath: current.sessionPath,
    events: await client.evaluate(`({...window.qwenObserved})`) };
}

export async function runQwenScenario({ clients, paths, evidence, keys, waitFor, daemon: readDaemon, observeExit, progress, providerRequests }) {
  const daemonSnapshot = async (name, previous) => {
    progress(name);
    if (previous) await observeExit(previous);
    let current;
    await waitFor('real daemon identity', async () => {
      try { current = await readDaemon(); return !previous || current.pid !== previous.pid; } catch { return false; }
    });
    current.previousExited = previous ? previous.exited === true : null;
    evidence.daemons.push({ stage: name, ...current });
    return current;
  };
  const observeWindows = async (boundary) => {
    for (let i = 0; i < clients.length; i++) {
      const minimized = await clients[i].evaluate(`import('/node_modules/@tauri-apps/api/window.js').then(m => m.getCurrentWindow().isMinimized())`);
      evidence.windows[i].observations ??= [];
      evidence.windows[i].observations.push({ boundary, minimized });
      assert.equal(minimized, evidence.windowMode === 'minimized', 'Native window must match the explicitly selected mode');
    }
  };
  const baselines = [];
  progress('provisioning');
  for (let index = 0; index < clients.length; index++) baselines.push(await prepare(clients[index], evidence.windows[index], { ...paths, session: paths.sessions[index] }, waitFor));
  let daemon = await daemonSnapshot("initial");
  assert.equal(daemon.present, false);
  assert.equal(daemon.matchesInherited, false);
  evidence.baselines = baselines.map(({ provider, model, sessionId, sessionPath }) => ({ provider, model, sessionId, sessionPath }));
  const initial = [];
  for (let index = 0; index < clients.length; index++) initial.push(await snapshot(clients[index], false, baselines[index], waitFor));
  evidence.stages.push({ name: "initial", daemon, windows: initial });
  await observeWindows('initial');

  const mutation = async (name, index, saved, key) => {
    progress(name);
    const before = await Promise.all(clients.map(c => c.evaluate(`({...window.qwenObserved})`)));
    if (key) await fill(clients[index], key);
    await click(clients[index], name === "save" ? "Save key" : name === "replace" ? "Replace saved key" : "Remove connection", waitFor);
    await waitFor("committed mutation field cleared", () => clients[index].evaluate(`${field}.value === ''`));
    await waitFor("window-targeted auth and model invalidation", async () => {
      const current = await Promise.all(clients.map(c => c.evaluate(`({...window.qwenObserved})`)));
      return current.every((events, i) => events.auth > before[i].auth && events.models > before[i].models);
    });
    const next = await daemonSnapshot(name, daemon);
    assert.equal(next.present, saved);
    assert.equal(next.matchesInherited, false);
    assert.equal(next.matchesSave, name === "save");
    assert.equal(next.matchesReplace, name === "replace");
    const windows = [];
    for (let i = 0; i < clients.length; i++) windows.push(await snapshot(clients[i], saved, baselines[i], waitFor));
    assert.ok(windows.every(w => w.inputEmpty));
    const localOnlyNotice = await clients[index].evaluate(`${form}.textContent.includes(${JSON.stringify(saved ? "Key saved locally — not remotely tested." : "Qwen Cloud connection removed.")})`);
    assert.equal(localOnlyNotice, true);
    evidence.stages.push({ name, daemon: next, windows, eventBaselines: before, localOnlyNotice });
    daemon = next;
    await observeWindows(name);
  };
  await mutation("save", 0, true, keys.save);
  await mutation("replace", 1, true, keys.replace);
  assert.equal(providerRequests(), 0, "Saving never invokes a provider");

  // Submit and cancel via the ordinary native admission path. The local provider
  // leaves its response open, keeping the production AgentSession genuinely busy.
  const submitted = await clients[0].evaluate(invoke("agent_prompt", { paneId: "primary", text: "Hold the synthetic verification run; do not use tools." }));
  assert.equal(submitted.queued, false);
  await waitFor("real run admission and provider hold", async () => providerRequests() === 1 && (await state(clients[0])).running);
  const busyBefore = await Promise.all(clients.map(c => c.evaluate(`({...window.qwenObserved})`)));
  await fill(clients[1], keys.save);
  for (const label of ["Replace saved key", "Remove connection"]) {
    await click(clients[1], label, waitFor);
    await waitFor("busy rejection", () => clients[1].evaluate(`${form}.querySelector('[role=alert]')?.textContent === 'Finish or cancel every active run before changing this connection.'`));
    assert.equal(await clients[1].evaluate(`${field}.value === ${JSON.stringify(keys.save)}`), true);
    const same = await daemonSnapshot("busy");
    assert.equal(same.pid, daemon.pid);
    assert.equal(same.startedAtMs, daemon.startedAtMs);
    assert.equal(same.matchesReplace, true);
    for (const client of clients) {
      const status = await client.evaluate(invoke("qwen_cloud_connection_status"));
      assert.equal(status.ok && status.status.credential === "saved", true);
    }
    assert.deepEqual(await Promise.all(clients.map(c => c.evaluate(`({...window.qwenObserved})`))), busyBefore);
    evidence.stages.push({ name: label === "Replace saved key" ? "busy-save" : "busy-remove", daemon: same, rejected: true, inputRetained: true, saved: true, eventsUnchanged: true });
  }
  await clients[0].evaluate(invoke("agent_cancel", { paneId: "primary" }));
  await waitFor("cancelled run idle", async () => !(await state(clients[0])).running);
  evidence.cancelledToIdle = true;
  // Keep the entered value in the mutating form: removal must clear it itself.
  await mutation("remove", 1, false);
  assert.equal(providerRequests(), 1);
  evidence.providerRequests = providerRequests();
  evidence.noProviderRequestsForCredentialMutations = true;
}

// Accept only complete two-window evidence. This is deliberately independent of
// the launcher so omissions cannot be papered over by its success message.
export function validateQwenEvidence(e, secretBearing) {
  assert.equal(secretBearing(JSON.stringify(e)), false, "Secret-bearing evidence");
  assert.equal(e.version, 1);
  assert.equal(e.origin, ORIGIN);
  assert.ok(['minimized', 'visible'].includes(e.windowMode), 'An explicit window mode is required');
  assert.equal(e.windows.length, 2, "Both native windows are required");
  assert.equal(new Set(e.windows.map(w => w.label)).size, 2);
  assert.equal(new Set(e.windows.map(w => w.targetId)).size, 2);
  for (const w of e.windows) {
    assert.ok(w.label && w.targetId);
    assert.equal(w.origin, ORIGIN);
    assert.deepEqual(w.observations.map(o => o.boundary), ['initial', 'save', 'replace', 'remove']);
    assert.ok(w.observations.every(o => o.minimized === (e.windowMode === 'minimized')));
  }
  assert.equal(e.initialVaultAbsence, true);
  assert.equal(e.cleanup.vaultAbsent, true);
  assert.equal(e.cleanup.ownedProcessesStopped, true);
  assert.equal(e.cleanup.providerClosed, true);
  assert.ok(e.cleanup.processes.length >= 2);
  assert.ok(e.cleanup.processes.every(p => p.stopped && p.survivors.length === 0));
  assert.equal(e.networkDeniedAttempts, 0);
  assert.equal(e.secretOutput, false);
  assert.equal(e.inputsUnchanged, true);
  assert.equal(e.artifactUnchanged, true);
  assert.equal(e.cancelledToIdle, true);
  assert.equal(e.providerRequests, 1);
  assert.equal(e.noProviderRequestsForCredentialMutations, true);
  assert.deepEqual(e.stages.map(s => s.name), ["initial", "save", "replace", "busy-save", "busy-remove", "remove"]);
  assert.equal(e.baselines.length, 2);
  assert.equal(e.daemons.length, 4, 'Each real daemon must have exit evidence');
  assert.equal(new Set(e.daemons.map(d => `${d.pid}:${d.startedAtMs}`)).size, 4);
  assert.ok(e.daemons.every(d => d.exited === true));
  let previous;
  for (const stage of e.stages) {
    const d = stage.daemon;
    assert.ok(Number.isSafeInteger(d.pid) && d.pid > 0, "Missing daemon PID");
    assert.ok(Number.isSafeInteger(d.startedAtMs) && d.startedAtMs > 0, "Missing daemon creation identity");
    assert.ok(e.daemons.some(observed => observed.pid === d.pid && observed.startedAtMs === d.startedAtMs), 'Daemon identity not observed through cleanup');
    assert.equal(d.matchesInherited, false);
    assert.equal(d.present, !["initial", "remove"].includes(stage.name));
    assert.equal(d.matchesSave, stage.name === "save");
    assert.equal(d.matchesReplace, ["replace", "busy-save", "busy-remove"].includes(stage.name));
    if (stage.name.startsWith("busy-")) {
      assert.equal(stage.rejected, true);
      assert.equal(stage.inputRetained, true);
      assert.equal(stage.saved, true);
      assert.equal(stage.eventsUnchanged, true);
      assert.equal(d.pid, previous.pid);
      assert.equal(d.startedAtMs, previous.startedAtMs);
      continue;
    }
    if (previous) {
      assert.notEqual(d.pid, previous.pid, "Mutation must replace the daemon");
      assert.notEqual(d.startedAtMs, previous.startedAtMs);
      assert.equal(d.previousExited, true);
      assert.equal(stage.localOnlyNotice, true);
    }
    assert.equal(stage.windows.length, 2, "Each lifecycle boundary needs both windows");
    for (let i = 0; i < 2; i++) {
      const w = stage.windows[i], baseline = e.baselines[i];
      assert.equal(w.saved, d.present);
      assert.equal(w.auth, d.present);
      for (const flag of ["unverified", "liveForm", "liveHub", "uiModels", "inputEmpty", "masked"]) assert.equal(w[flag], true, flag);
      assert.equal(baseline.provider, "azure");
      assert.equal(baseline.model, "azure:fixture");
      assert.ok(baseline.sessionId);
      assert.equal(w.provider, baseline.provider);
      assert.equal(w.model, baseline.model);
      assert.equal(w.sessionId, baseline.sessionId);
      assert.equal(typeof w.sessionPath, 'string');
      assert.ok(w.sessionPath.length > 0);
      assert.equal(w.sessionPath, baseline.sessionPath);
      if (previous) {
        assert.ok(w.events.auth > stage.eventBaselines[i].auth, "Missing auth notification");
        assert.ok(w.events.models > stage.eventBaselines[i].models, "Missing model notification");
      }
    }
    previous = d;
  }
}
