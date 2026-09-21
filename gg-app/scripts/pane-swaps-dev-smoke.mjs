import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCrossPaneProjectIsolationSmoke } from "./cross-pane-project-isolation-dev-smoke.mjs";

const out = resolve(process.env.GG_PANE_SWAPS_EVIDENCE ?? resolve(fileURLToPath(new URL("../..", import.meta.url)), ".gg/eyes/out/pane-swaps-native", String(Date.now())));
await mkdir(out, { recursive: true });
const evidence = { boundary: "Isolated Windows developer Tauri WebView2, real Rust IPC/session routing, controlled credential-free fixture daemon, trusted CDP pointer/keyboard input. CSS viewport emulation, not OS window resizing, installed app or real provider.", checks: [], centers: [], cleanup: { status: "not-reached" }, status: "running", stage: "fixture-start" };
async function waitFor(client, expression, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await new Promise((done) => setTimeout(done, 75));
  }
  throw new Error(`Native pane-swap check timed out: ${label}`);
}
async function verifyWorkspace(context) {
  try {
    await verifyWorkspaceChecks(context);
  } catch (error) {
    try {
      const image = await context.client.send("Page.captureScreenshot", { format: "png" });
      await writeFile(resolve(out, "native-failure.png"), Buffer.from(image.data, "base64"));
    } catch {
      evidence.failureScreenshot = "unavailable";
    }
    throw error;
  }
}
async function verifyWorkspaceChecks({ client, projectA, projectB, projectC, readAudit }) {
  evidence.stage = "existing-side-and-shortcut-checks";
  const paneIds = ["primary", "swap-middle", "swap-right"];
  const leaf = (paneId) => ({ type: "leaf", paneId });
  const split = (first, second, value) => ({ type: "split", direction: "horizontal", size: { type: "ratio", value }, first, second });
  const layout = { version: 9, focusedPaneId: "primary", root: split(leaf("primary"), split(leaf("swap-middle"), leaf("swap-right"), 50), 33),
    panes: Object.fromEntries(paneIds.map((id, index) => [id, { kind: "agent", mode: "code", cwd: [projectA, projectB, projectC][index], sessionPath: null }])) };
  await client.evaluate(`localStorage.setItem('gg-workspace-layout-recursive:main', ${JSON.stringify(JSON.stringify(layout))}); location.reload(); true`);
  await waitFor(client, `document.querySelectorAll('[data-pane-id]').length === 3 && document.querySelectorAll('[data-pane-swap]').length === 4 && document.querySelectorAll('[data-pane-id] textarea').length === 3`, "three eligible developer panes");
  await client.evaluate(`window.__swapNativeHosts = [...document.querySelectorAll('[data-pane-id]')]; true`);
  const states = () => client.evaluate(`Promise.all(${JSON.stringify(paneIds)}.map(paneId => window.__TAURI_INTERNALS__.invoke('agent_state', { paneId })))`);
  const before = await states();
  assert.equal(new Set(before.map((state) => state.sessionId)).size, 3);
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('agent_prompt', { paneId: 'primary', text: 'hold', attachments: [], meta: null })`);
  assert.equal((await states())[0].running, true);
  const auditStart = readAudit().length;
  await client.evaluate(`(() => {
    for (const id of ${JSON.stringify(paneIds)}) {
      const input = document.querySelector('[data-pane-id="' + id + '"] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Native draft ' + id);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setSelectionRange(2, 7, 'backward');
    }
    return true;
  })()`);
  const key = async (key, code, virtualKey, modifiers = 0) => {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey, modifiers, text: key === "Enter" ? "\r" : key === " " ? " " : undefined });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey, modifiers });
  };
  await client.evaluate(`document.querySelector('[data-pane-swap="primary"]').focus(); true`);
  await key("Enter", "Enter", 13);
  await waitFor(client, `document.activeElement?.getAttribute('data-pane-swap') === 'swap-middle'`, "native keyboard handoff");
  assert.equal(await client.evaluate(`document.activeElement.hasAttribute('data-swap-keyboard-focus')`), true);
  await key("Enter", "Enter", 13);
  await waitFor(client, `document.activeElement?.getAttribute('data-pane-swap') === 'primary'`, "native reverse exchange");
  evidence.checks.push("Native WebView trusted Enter exchanges and reverses the pair; keyboard focus feedback follows the side position");
  await client.evaluate(`(() => { const input = document.querySelector('[data-pane-id="primary"] textarea'); input.focus(); input.setSelectionRange(2, 7, 'backward'); return true; })()`);
  await key("ArrowLeft", "ArrowLeft", 37, 11);
  await waitFor(client, `!document.querySelector('[data-pane-swap="primary"]:not([data-pane-swap-direction])')`, "native exact modifier chord");
  const editing = await client.evaluate(`({ pane: document.activeElement?.closest('[data-pane-id]')?.dataset.paneId, value: document.activeElement.value, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd })`);
  assert.deepEqual(editing, { pane: "primary", value: "Native draft primary", start: 2, end: 7 });
  await key("ArrowLeft", "ArrowLeft", 37, 11);
  await waitFor(client, `Boolean(document.querySelector('[data-pane-swap="primary"]:not([data-pane-swap-direction])'))`, "native chord reversal");
  const after = await states();
  assert.deepEqual(after.map(({ sessionId, cwd }) => ({ sessionId, cwd })), before.map(({ sessionId, cwd }) => ({ sessionId, cwd })));
  assert.equal(after[0].running, true);
  assert.equal(await client.evaluate(`window.__swapNativeHosts.every(el => el.isConnected && document.getElementById(el.id) === el)`), true);
  assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('[data-pane-id]')].map(el => el.querySelector('textarea').value)`), paneIds.map(id => `Native draft ${id}`));
  const audit = readAudit().slice(auditStart);
  assert.equal(audit.some(entry => entry.action === "session-created" || entry.action === "session-disposed"), false);
  evidence.checks.push("Native Rust IPC retains all three session identities and project roots, held primary activity, drafts and selection; no session creation/disposal during swaps");
  const tree = await client.send("Accessibility.getFullAXTree");
  const swapActions = tree.nodes.filter(node => node.role?.value === "button" && node.name?.value?.startsWith("Swap with middle:"));
  assert.equal(swapActions.length, 2);
  const centerActions = tree.nodes.filter(node => node.role?.value === "button" && /^Swap with (left|right) pane:/.test(node.name?.value ?? ""));
  assert.equal(centerActions.length, 2);
  evidence.checks.push("Native WebView accessibility tree exposes two side swap buttons and both center directions");
  evidence.sessions = after.map(({ sessionId, cwd, running }) => ({ sessionId, cwd, running }));
  const image = await client.send("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(out, "native-workspace.png"), Buffer.from(image.data, "base64"));
  await verifyCenters({ client, projects: [projectA, projectB, projectC], readAudit, key });
  evidence.stage = "owned-process-cleanup";
  console.log("PANE SWAPS DEVELOPER CHECKS PASSED; waiting for owned-process cleanup");
}
async function verifyCenters({ client, projects, readAudit, key }) {
  const rows = [["primary", "center-top", "right-top"], ["left-bottom", "center-bottom", "right-bottom"]];
  const ids = rows.flat();
  const leaf = (paneId) => ({ type: "leaf", paneId });
  const row = ([left, middle, right]) => ({ type: "split", direction: "horizontal", size: { type: "ratio", value: 33 }, first: leaf(left), second: { type: "split", direction: "horizontal", size: { type: "ratio", value: 50 }, first: leaf(middle), second: leaf(right) } });
  const layout = { version: 9, focusedPaneId: "primary", root: { type: "split", direction: "vertical", size: { type: "ratio", value: 50 }, first: row(rows[0]), second: row(rows[1]) },
    panes: Object.fromEntries(ids.map((id, index) => [id, { kind: "agent", mode: "code", cwd: projects[index % 3], sessionPath: null }])) };
  evidence.stage = "six-pane-readiness";
  await client.evaluate(`localStorage.setItem('gg-workspace-layout-recursive:main', ${JSON.stringify(JSON.stringify(layout))}); location.reload(); true`);
  await waitFor(client, `document.querySelectorAll('[data-pane-id]').length === 6 && document.querySelectorAll('[data-pane-swap]').length === 8 && document.querySelectorAll('[data-pane-id] textarea').length === 6`, "six eligible panes");
  const states = () => client.evaluate(`Promise.all(${JSON.stringify(ids)}.map(paneId => window.__TAURI_INTERNALS__.invoke('agent_state', { paneId })))`);
  const before = await states();
  assert.equal(new Set(before.map(s => s.sessionId)).size, 6);
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('agent_prompt', { paneId: 'primary', text: 'hold', attachments: [], meta: null })`);
  assert.equal((await states())[0].running, true);
  await client.evaluate(`(() => {
    window.__centerHosts = [...document.querySelectorAll('[data-pane-id]')];
    window.__centerEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'keyup', 'click']) document.addEventListener(type, event => {
      const button = event.target.closest?.('[data-pane-swap-direction]');
      if (button) window.__centerEvents.push({ type, trusted: event.isTrusted, pane: button.dataset.paneSwap, direction: button.dataset.paneSwapDirection });
    }, true);
    for (const id of ${JSON.stringify(ids)}) {
      const input = document.querySelector('[data-pane-id="' + id + '"] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Center draft ' + id);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setSelectionRange(2, 7, 'backward');
    }
    return true;
  })()`);
  const auditStart = readAudit().length;
  const selector = (id, direction) => `[data-pane-swap="${id}"][data-pane-swap-direction="${direction}"]`;
  const settle = () => waitFor(client, `[...document.querySelectorAll('.workspace-pane-slot')].every(el => el.getAnimations().length === 0)`, "animations settle");
  const geometry = () => client.evaluate(`[...document.querySelectorAll('[data-pane-id]')].map(el => ({ id: el.dataset.paneId, x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }))`);
  const control = (sel) => client.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(sel)});
    if (!button) throw new Error('Missing center control');
    const r = button.getBoundingClientRect(), s = getComputedStyle(button);
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    return { x, y, width: r.width, height: r.height, visible: s.visibility === 'visible' && Number(s.opacity) > 0 && !button.disabled,
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hit: button.contains(document.elementFromPoint(x, y)), focused: document.activeElement === button,
      feedback: button.hasAttribute('data-swap-keyboard-focus') && parseFloat(s.outlineWidth) >= 2 && s.outlineStyle !== 'none' && s.outlineColor !== 'rgba(0, 0, 0, 0)',
      outline: { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor } };
  })()`);
  const handoff = async (id, direction, keyboard) => {
    const sel = selector(id, direction);
    await waitFor(client, `document.activeElement === document.querySelector(${JSON.stringify(sel)}) && Boolean(document.querySelector(${JSON.stringify(sel)}))`, "same-center-direction focus");
    if (keyboard) assert.equal((await control(sel)).feedback, true, "Useful keyboard focus outline must survive handoff");
  };
  const exchanged = (original, actual, middle, side) => {
    for (const entry of original) {
      const expectedId = entry.id === middle ? side : entry.id === side ? middle : entry.id;
      assert.deepEqual(actual.find(item => item.id === expectedId), { ...entry, id: expectedId }, "Only the selected pair may change positions");
    }
  };
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await client.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    await client.evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
    await settle();
    for (const [rowIndex, [left, middle, right]] of rows.entries()) {
      for (const direction of ["left", "right"]) {
        const side = direction === "left" ? left : right;
        const sel = selector(middle, direction);
        const record = { viewport, row: rowIndex, direction, status: "running" };
        evidence.centers.push(record);
        evidence.stage = `${viewport.width}-row-${rowIndex}-${direction}-pointer`;
        const original = await geometry();
        // Begin outside this pane: pointerdown focus must not move the target.
        await client.evaluate(`document.querySelector('[data-pane-id="${rows[1 - rowIndex][0]}"] textarea').focus(); true`);
        const point = await control(sel);
        record.pointerBefore = point;
        assert.ok(point.visible && point.inside && point.hit && point.width >= 24 && point.height >= 24, "Center target must be visible, unclipped and hit-testable");
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
        const down = await control(sel);
        record.pointerDown = down;
        assert.ok(down.hit && Math.abs(down.x - point.x) <= 1 && Math.abs(down.y - point.y) <= 1, "Pointerdown must not move its target");
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        await handoff(side, direction, false);
        exchanged(original, await geometry(), middle, side);
        await settle();
        const reverse = await control(selector(side, direction));
        assert.ok(reverse.hit && Math.abs(reverse.x - point.x) <= 1 && Math.abs(reverse.y - point.y) <= 1, "Incoming center action must retain pointer position");
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        await handoff(middle, direction, false);
        assert.deepEqual(await geometry(), original);
        await settle();
        for (const [name, code, virtualKey] of [["Enter", "Enter", 13], [" ", "Space", 32]]) {
          evidence.stage = `${viewport.width}-row-${rowIndex}-${direction}-${code}`;
          // Reach the center via trusted Tab, then reverse immediately without
          // an animation wait, DOM click, refocus or re-query-based activation.
          await client.evaluate(`document.querySelector(${JSON.stringify(sel)}).focus(); true`);
          await key("Tab", "Tab", 9, 8);
          await key("Tab", "Tab", 9);
          assert.equal((await control(sel)).focused, true);
          await key(name, code, virtualKey);
          await handoff(side, direction, true);
          exchanged(original, await geometry(), middle, side);
          await key(name, code, virtualKey);
          await handoff(middle, direction, true);
          assert.deepEqual(await geometry(), original);
          await settle();
          record[code] = await control(sel);
          assert.equal(record[code].feedback, true, "Focus outline persists after animation completion");
        }
        record.status = "passed";
      }
    }
    const image = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(out, `native-center-${viewport.width}.png`), Buffer.from(image.data, "base64"));
  }
  evidence.stage = "six-pane-identity-and-trusted-input";
  const after = await states();
  assert.deepEqual(after.map(({ sessionId, cwd }) => ({ sessionId, cwd })), before.map(({ sessionId, cwd }) => ({ sessionId, cwd })));
  assert.equal(after[0].running, true);
  assert.equal(await client.evaluate(`window.__centerHosts.every(el => el.isConnected && document.getElementById(el.id) === el)`), true);
  assert.deepEqual(await client.evaluate(`${JSON.stringify(ids)}.map(id => { const input = document.querySelector('[data-pane-id="' + id + '"] textarea'); return { value: input.value, start: input.selectionStart, end: input.selectionEnd }; })`), ids.map(id => ({ value: `Center draft ${id}`, start: 2, end: 7 })));
  assert.equal(readAudit().slice(auditStart).some(entry => entry.action === "session-created" || entry.action === "session-disposed"), false);
  const events = await client.evaluate("window.__centerEvents");
  assert.ok(events.length > 0 && events.every(event => event.trusted));
  for (const direction of ["left", "right"]) for (const type of ["pointerdown", "pointerup", "keydown", "keyup", "click"]) {
    assert.ok(events.some(event => event.direction === direction && event.type === type));
  }
  evidence.inputEvents = events;
  evidence.checks.push("Both center directions in both rows at desktop/narrow sizes: trusted pointer down/up and fixed-position reversal; Tab, Enter/Space rapid reversal; same-direction focus and persistent rendered outline; six keyed hosts, sessions, project roots, drafts, selections and held work retained");
}
try {
  await runCrossPaneProjectIsolationSmoke({ identity: "com.ggcoder.local-fork", verifyWorkspace,
    reuseDevServer: Boolean(process.env.GG_APPEARANCE_SMOKE_THEME),
    onCleanup: (cleanup) => { evidence.cleanup = cleanup; },
  });
  assert.equal(evidence.cleanup.status, "passed");
  evidence.status = "passed";
  evidence.checks.push("Existing isolated fixture lifecycle completed and owned processes cleaned up");
} catch (error) {
  evidence.status = "failed";
  // The shared launcher's error includes raw developer logs and profile paths.
  // Never copy it to CI artifacts: retain only our bounded stage and verdicts.
  evidence.error = "Native fixture or assertion failed; inspect stage, center records and cleanup verdict.";
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, output: out, error: evidence.error }));
}
