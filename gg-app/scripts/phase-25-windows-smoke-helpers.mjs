import { mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

export const PHASE25_TOAST_TITLE = "Roadmap reminder due";
export const PHASE25_TOAST_BODY = "Open GG Coder to review it.";

class DevCdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("dev fixture debugging connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("could not connect to the dev fixture")),
        { once: true },
      );
    });
    return new DevCdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `Dev fixture evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

// Real WebView DOM measurements, not screenshots or a second browser stack.
// Metrics override is CSS viewport emulation; it does not resize the OS window.
export async function measureReviewDockIsolation(client, { capture = async () => null } = {}) {
  const evidence = [];
  const settle = () => client.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  try {
    for (const size of [
      { name: "desktop", width: 1280, height: 900, zoom: 1 },
      { name: "600x640", width: 600, height: 640, zoom: 1 },
      { name: "320-pane", width: 640, height: 800, zoom: 1 },
      { name: "short", width: 1000, height: 480, zoom: 1 },
      { name: "200-percent", width: 1280, height: 900, zoom: 2 },
    ]) {
      await client.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      await client.evaluate(`document.documentElement.style.zoom = ${JSON.stringify(String(size.zoom))}; true`);
      await settle();
      if (size.name === "320-pane") {
        const width = await client.evaluate("document.querySelector('.agent-pane').getBoundingClientRect().width");
        await client.send("Emulation.setDeviceMetricsOverride", { width: Math.round(size.width + (320 - width) * 2), height: size.height, deviceScaleFactor: 1, mobile: false });
        await settle();
      }
      // The plan gate disables typing. Exercise retained multiline composer geometry
      // explicitly without enabling submission or accidentally typing in the sibling.
      await client.evaluate(`(() => {
        const input = document.querySelector('.agent-pane textarea.input');
        input.style.height = '100px';
        return true;
      })()`);
      await settle();
      for (const review of ["plan", "roadmap"]) {
        await client.evaluate(`(() => {
          const pane = document.querySelectorAll('.agent-pane')[0];
          const chat = pane.querySelector('.transcript');
          chat.scrollTop = 50; chat.dispatchEvent(new Event('scroll'));
          const trigger = pane.querySelector('[data-review-trigger="${review}"]');
          if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
          return true;
        })()`);
        await settle();
        const measured = await client.evaluate(`(() => {
          const panes = document.querySelectorAll('.agent-pane');
          const pane = panes[0], dock = pane.querySelector('.review-dock');
          const chat = pane.querySelector('.transcript'), composer = pane.querySelector('.inputwrap');
          if (!dock || !chat || !composer) throw new Error('Missing review layout elements');
          const meter = pane.querySelector('.ctx-meter[role="meter"]');
          const value = meter?.getAttribute('aria-valuenow');
          const label = meter?.querySelector('.ctx-meter-label')?.textContent;
          const accessibleLabel = meter?.getAttribute('aria-label');
          if (value == null || value.trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100) throw new Error('Context meter value is not finite and in range');
          if (!label || !accessibleLabel || /NaN/.test(label + accessibleLabel)) throw new Error('Invalid context meter label');
          const contextMeter = { value: Number(value), label, accessibleLabel };
          const reviewControls = ['plan', 'roadmap'].map(name => Boolean(dock.querySelector('[data-review-trigger="' + name + '"]')));
          const approvalGated = pane.querySelector('textarea.input')?.disabled === true;
          if (!reviewControls.every(Boolean) || !approvalGated) throw new Error('Review controls or approval gate lost');
          const rect = el => { const r = el.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, height:r.height, width:r.width }; };
          const before = rect(dock), chatBefore = chat.scrollTop;
          if (Math.abs(chatBefore - 50) > 2) throw new Error('Expansion jumped the reading position');
          chat.scrollTop = 100;
          const after = rect(dock);
          const chatScrolled = chat.scrollTop;
          const reader = dock.querySelector('.review-dock-panel:not([hidden]) .review-content-scroller');
          if (!reader || reader.clientHeight < 40) throw new Error('Review reading space clipped: ' + JSON.stringify({ size: ${JSON.stringify(size.name)}, dock: rect(dock), reader: reader && rect(reader) }));
          const headerBefore = rect(dock.querySelector('.review-dock-header'));
          reader.scrollTop = 100;
          const dockScrolled = reader.scrollTop;
          if (Math.abs(headerBefore.top - rect(dock.querySelector('.review-dock-header')).top) > 1) throw new Error('Reading scrolled review controls');
          if (chat.scrollTop !== chatScrolled) throw new Error('Dock changed chat scroll');
          if (Math.abs(before.top-after.top) > 1 || Math.abs(before.bottom-after.bottom) > 1) throw new Error('Chat moved dock');
          const input = rect(composer), transcript = rect(chat), paneRect = rect(pane);
          if (transcript.bottom > after.top + 1 || after.bottom > input.top + 1) throw new Error('Review overlaps chat or composer');
          if (input.bottom > innerHeight + 1 || input.height <= 0 || after.height <= 0) throw new Error('Composer or review unavailable ' + JSON.stringify({ size: ${JSON.stringify(size.name)}, input, dock: after, pane: paneRect, viewport: innerHeight, stack: rect(pane.querySelector('.conversation-stack')), tools: rect(pane.querySelector('.liveregion')) }));
          if (chatScrolled <= chatBefore || dockScrolled <= 0) throw new Error('Fixture did not exercise both scrollers');
          if (panes[1]?.querySelector('.review-dock')) throw new Error('Review leaked into sibling pane');
          if (chat.contains(dock) || dock.querySelector('[aria-modal=true]')) throw new Error('Review remains modal or in transcript');
          for (const element of [dock, ...dock.querySelectorAll('.plan-review, .roadmap-draft-actions')]) {
            if (['sticky', 'fixed', 'absolute'].includes(getComputedStyle(element).position)) throw new Error('Review chrome is not in normal flow');
          }
          return { contextMeter, reviewControls, approvalGated, dock: after, transcript, composer: input, pane: paneRect, chatBefore, chatScrolled, dockScrolled, siblingReviewCount: panes[1]?.querySelectorAll('.review-dock').length };
        })()`);
        await client.evaluate("document.querySelector('[aria-label=\"Expand review to output area\"]').click(); true");
        await settle();
        const maximized = await client.evaluate(`(() => {
          const dock = document.querySelector('.review-dock');
          const bounds = dock.getBoundingClientRect();
          const stack = dock.closest('.conversation-stack').getBoundingClientRect();
          const input = document.querySelector('.inputwrap').getBoundingClientRect();
          if (Math.abs(bounds.top - stack.top) > 1 || Math.abs(bounds.bottom - stack.bottom) > 1) throw new Error('Expanded review does not fill output area');
          if (Math.abs(input.top - ${measured.composer.top}) > 1 || Math.abs(input.bottom - ${measured.composer.bottom}) > 1) throw new Error('Expanded review moved composer');
          if (getComputedStyle(document.querySelector('.transcript-frame')).visibility !== 'hidden') throw new Error('Hidden output remains focusable');
          return { height: bounds.height, outputHeight: stack.height };
        })()`);
        await client.evaluate("document.querySelector('[aria-label=\"Restore review size\"]').click(); true");
        await settle();
        const restored = await client.evaluate("({ height: document.querySelector('.review-dock').getBoundingClientRect().height, scrollTop: document.querySelector('.transcript').scrollTop })");
        if (Math.abs(restored.height - measured.dock.height) > 1 || Math.abs(restored.scrollTop - measured.chatScrolled) > 2) throw new Error('Restore lost review size or output reading position');
        measured.maximized = maximized;
        if (size.name === "320-pane" && Math.abs(measured.pane.width - 320) > 1) throw new Error(`Expected actual 320 CSS-pixel pane: ${measured.pane.width}`);
        await client.evaluate("document.querySelector('.review-dock-panel:not([hidden]) .review-content-scroller').scrollTop = 0; true");
        await settle();
        const screenshot = await capture(`${size.name}-${review}`);
        let referencesScreenshot = null;
        if (review === "roadmap") {
          await client.evaluate("(() => { const dock = document.querySelector('.review-dock'); const refs = dock.querySelector('.roadmap-draft-references'); const reader = dock.querySelector('.roadmap-draft-review .review-content-scroller'); reader.scrollTop += refs.getBoundingClientRect().top - reader.getBoundingClientRect().top; return true; })()");
          await settle();
          referencesScreenshot = await capture(`${size.name}-${review}-references`);
        }
        await client.evaluate(`(() => {
          const dock = document.querySelector('.review-dock');
          dock.querySelector('[aria-expanded=true]').click();
          return true;
        })()`);
        await settle();
        const collapsed = await client.evaluate(`(() => {
          const dock = document.querySelector('.review-dock');
          const bounds = dock.getBoundingClientRect();
          for (const row of dock.querySelectorAll('[data-review-trigger]')) {
            const rect = row.getBoundingClientRect();
            if (row.offsetHeight < 48 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) throw new Error('Collapsed review row is chopped off ' + JSON.stringify({ size: ${JSON.stringify(size.name)}, row: rect.toJSON(), bounds: bounds.toJSON(), clientHeight: row.clientHeight }));
          }
          if (bounds.bottom > document.querySelector('.inputwrap').getBoundingClientRect().top + 1) throw new Error('Collapsed review overlaps composer');
          return { height: bounds.height, scrollTop: dock.scrollTop };
        })()`);
        const collapsedScreenshot = await capture(`${size.name}-${review}-collapsed`);
        evidence.push({ ...size, review, ...measured, screenshot, referencesScreenshot, collapsed, collapsedScreenshot });
      }
    }
    await client.evaluate("document.documentElement.style.zoom = ''; true");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await settle();
    const accessibility = { supported: false };
    try {
      const tree = await client.send("Accessibility.getFullAXTree");
      accessibility.supported = true;
      accessibility.controls = tree.nodes.filter(node => !node.ignored && ['button', 'region', 'textbox'].includes(node.role?.value)).map(node => ({ role: node.role.value, name: node.name?.value ?? '' }));
      accessibility.namedReviewControls = ['Plan approval required', 'Roadmap draft'].map(name => ({ name, found: accessibility.controls.some(control => control.name.includes(name)) }));
    } catch (error) { accessibility.unavailable = String(error); }
    const media = [];
    for (const feature of [ { name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' } ]) {
      await client.send('Emulation.setEmulatedMedia', { features: [feature] });
      await settle();
      const state = await client.evaluate(`(() => {
        const dock = document.querySelector('.review-dock');
        const style = getComputedStyle(dock);
        return { matches: matchMedia('(${feature.name}: ${feature.value})').matches, color: style.color, background: style.backgroundColor, animation: style.animationName, transition: style.transitionDuration };
      })()`);
      if (!state.matches) throw new Error(`Media emulation failed: ${feature.name}`);
      media.push({ feature, ...state, screenshot: await capture(feature.name) });
    }
    await client.send('Emulation.setEmulatedMedia', { features: [] });
    await client.evaluate(`(() => {
      const pane = document.querySelector('.agent-pane');
      const chat = pane.querySelector('.transcript');
      chat.scrollTop = chat.scrollHeight;
      chat.dispatchEvent(new Event('scroll'));
      return true;
    })()`);
    await settle();
    const bottomFollow = [];
    for (let i = 0; i < 2; i++) {
      await client.evaluate("document.querySelector('[data-review-trigger=roadmap]').click(); true");
      await settle();
      const distance = await client.evaluate("(() => { const chat = document.querySelector('.transcript'); return chat.scrollHeight - chat.clientHeight - chat.scrollTop; })()");
      bottomFollow.push(distance);
      if (Math.abs(distance) > 2) throw new Error(`Bottom following lost on review toggle: ${distance}`);
    }
    // Keyboard Escape from feedback first leaves feedback mode, then collapses the dock.
    await client.evaluate(`(() => {
      const pane = document.querySelectorAll('.agent-pane')[0];
      pane.querySelector('[data-review-trigger="plan"]').click();
      [...pane.querySelectorAll('.plan-review button')].find(b => b.textContent.trim() === 'Feedback').click();
      return true;
    })()`);
    await settle();
    await client.send("Input.insertText", { text: "Retain this native feedback" });
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await settle();
    // The textarea has disappeared; focus the body action before Escape collapse.
    await client.evaluate("document.querySelector('.plan-review button').focus(); true");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await settle();
    const keyboard = await client.evaluate(`(() => {
      const trigger = document.querySelector('[data-review-trigger="plan"]');
      if (document.activeElement !== trigger || trigger.getAttribute('aria-expanded') !== 'false') throw new Error('Collapse did not restore trigger focus');
      trigger.click();
      return true;
    })()`);
    await settle();
    await client.evaluate("[...document.querySelectorAll('.plan-review button')].find(b => b.textContent.trim() === 'Feedback').click(); true");
    await settle();
    const retained = await client.evaluate("document.querySelector('.plan-feedback-input').value === 'Retain this native feedback'");
    if (!retained) throw new Error('Feedback lost across keyboard collapse');
    return { measurements: evidence, accessibility, media, bottomFollowDistances: bottomFollow, keyboardFocusRestored: keyboard, feedbackRetained: retained, viewportEmulated: true, zoomMethod: 'CSS zoom (not native browser zoom)', screenReaderVerified: false, performanceBeforeComparisonVerified: false, composerEnlargement: '100px textarea height fixture; approval gate remains disabled' };
  } finally {
    await client.send('Emulation.setEmulatedMedia', { features: [] });
    await client.evaluate("document.documentElement.style.zoom = ''; true");
    await client.send("Emulation.clearDeviceMetricsOverride");
  }
}

export async function connectToDevWebview(
  cdpPort,
  waitFor,
  acceptTarget = (candidate) => !String(candidate.url).startsWith("devtools://"),
) {
  const target = await waitFor("dev fixture debugging target", async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find(
      (candidate) =>
        candidate.type === "page" &&
        typeof candidate.webSocketDebuggerUrl === "string" &&
        acceptTarget(candidate),
    );
  });
  return DevCdpClient.connect(target.webSocketDebuggerUrl);
}

export function createIsolatedProfile(root, projectDir = join(root, "project")) {
  const home = join(root, "home");
  const paths = {
    root,
    home,
    appData: join(home, "AppData", "Roaming"),
    localAppData: join(home, "AppData", "Local"),
    temp: join(root, "temp"),
    webview2: join(root, "webview2"),
    project: projectDir,
    audit: join(root, "audit"),
    screenshots: join(root, "screenshots"),
  };
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });
  return paths;
}

export function sanitizedSmokeEnvironment(baseEnvironment, paths, fixtureVariables = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (/^(GG_|TAURI_|WEBVIEW2_)/i.test(key)) continue;
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    WEBVIEW2_USER_DATA_FOLDER: paths.webview2,
    GG_APP_CWD: paths.project,
    ...fixtureVariables,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function finalizeSmokeLifecycle(state, operations, primaryError = null) {
  const cleanupErrors = [];
  const attempt = async (operation) => {
    try {
      await operation();
      return true;
    } catch (error) {
      cleanupErrors.push(error);
      return false;
    }
  };

  if (state.client) await attempt(() => operations.closeClient(state.client));
  let processTreeCleaned = !state.appPid;
  if (state.appPid) {
    processTreeCleaned = await attempt(() =>
      operations.terminateProcessTree(state.appPid, state.executable),
    );
  }
  let uninstalled = false;
  if (state.installedUninstaller) {
    await attempt(() => operations.uninstall(state.installedUninstaller));
    uninstalled = await attempt(() => operations.waitForInstalledRemoval());
  }
  if (state.releasePort) await attempt(state.releasePort);

  if (cleanupErrors.length) {
    const cleanupSummary = cleanupErrors.map(errorMessage).join("; ");
    const cleanupError = new AggregateError(
      cleanupErrors,
      `Smoke cleanup failed: ${cleanupSummary}`,
    );
    if (primaryError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `Smoke failed: ${errorMessage(primaryError)}; cleanup also failed: ${cleanupSummary}`,
      );
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return { processTreeCleaned, uninstalled };
}

export async function reserveHeldTcpPort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a fixture port");
  }
  let released = false;
  return {
    port: address.port,
    async release() {
      if (released) return;
      released = true;
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

export function assertDistinctPorts(ports) {
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error(`invalid fixture port: ${ports.join(", ")}`);
  }
  if (new Set(ports).size !== ports.length) {
    throw new Error(`duplicate fixture ports: ${ports.join(", ")}`);
  }
}

export function selectExactToast(candidates, { hiddenAppPid, protectedPids = [] }) {
  const protectedSet = new Set(protectedPids);
  const valid = candidates.filter((candidate) => {
    const bounds = candidate.bounds ?? {};
    const ownerPid = Number(candidate.ancestor?.processId);
    return (
      candidate.title?.text === PHASE25_TOAST_TITLE &&
      candidate.body?.text === PHASE25_TOAST_BODY &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      candidate.ancestor?.isOffscreen === false &&
      /^(?:ShellExperienceHost|explorer|StartMenuExperienceHost)$/i.test(
        candidate.ancestor?.ownerName ?? "",
      ) &&
      ownerPid !== hiddenAppPid &&
      !protectedSet.has(ownerPid)
    );
  });
  if (valid.length > 1) throw new Error(`duplicate matching Windows toasts found: ${valid.length}`);
  return valid[0] ?? null;
}
