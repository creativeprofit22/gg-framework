import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCrossPaneProjectIsolationSmoke } from "./cross-pane-project-isolation-dev-smoke.mjs";
import { appearanceEnvironment, createAppearanceScope, ensureAppearanceDebugBuild, ensureNormalServer, evidenceRoot } from "./appearance-dev.mjs";
import { appearanceRoot } from "./appearance-dev-identity.mjs";
import { connectToDevWebview, createIsolatedProfile } from "./phase-25-windows-smoke-helpers.mjs";

const errorMessage = error => error instanceof Error ? error.message : String(error);

export function assertNativeBackground(samples, expected, count) {
  assert.equal(samples.length, count, "Must observe every fixture native window");
  assert.equal(new Set(samples.map(sample => sample.label)).size, count);
  for (const sample of samples) {
    assert.equal(sample.rgb, expected, `Native background differs: ${sample.label}`);
  }
}

async function readNativeBackground(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok);
  const targets = (await response.json()).filter(target => target.type === "page" && !String(target.url).startsWith("devtools://"));
  const samples = [];
  for (const target of targets) {
    const windowClient = await connectToDevWebview(cdpPort, async (_label, probe) => probe(), candidate => candidate.id === target.id);
    try {
      const sample = await windowClient.evaluate("(async()=>({label:window.__TAURI_INTERNALS__.metadata.currentWindow.label,...await window.__TAURI_INTERNALS__.invoke('appearance_background_probe').then(rgb=>({rgb}),error=>({error:String(error)}))}))()");
      assert.ok(!sample.error, `Native background readback failed for ${sample.label}: ${sample.error}`);
      samples.push(sample);
    } finally { await windowClient.close(); }
  }
  return samples;
}

class AppearanceSmokeCleanupError extends AggregateError {
  constructor(failures, cleanupError) {
    super([...failures, cleanupError], [...failures, cleanupError].map(errorMessage).join("; "));
    this.verificationErrors = failures;
    this.cleanupError = cleanupError;
  }
}

export async function runAppearanceSmokeSession(env, smokeOptions, options = {}) {
  const scope = createAppearanceScope(options);
  const failures = [];
  try {
    await (options.ensureServer ?? ensureNormalServer)(env, scope);
    await (options.runFixture ?? runCrossPaneProjectIsolationSmoke)({
      ...smokeOptions,
      beforeNativeStart: async (nativeEnv, config) => {
        await ensureAppearanceDebugBuild(nativeEnv, config, scope);
        scope.check();
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await scope.close();
    } catch (cleanupError) {
      throw new AppearanceSmokeCleanupError(failures, cleanupError);
    } finally { scope.dispose(); }
  }
  if (failures.length) throw failures[0];
}

export async function runAppearanceSmoke(options = {}) {
  const out = resolve(options.out ?? resolve(evidenceRoot, `fixture-${Date.now()}`));
  await mkdir(out, { recursive: true });
  const evidence = { boundary: "Isolated native Tauri WebView2 and real Rust IPC; credential-free controlled daemon history, not a model or installed-app test. Settings opened through the existing tray event. 390px is an emulated content viewport, not a physical native window.", status: "running", checks: [], captures: [], sources: {}, cleanup: null };
  const failures = [];
  try {
    for (const file of ["main.tsx", "appearance.ts", "appearance-native.ts", "appearance.css", "theme.ts", "AppearanceSettings.tsx", "SettingsModal.tsx", "App.css"]) {
      evidence.sources[file] = createHash("sha256").update(await readFile(resolve(appearanceRoot, "gg-app/src", file))).digest("hex");
    }
    evidence.verifierSources = {};
    for (const file of ["scripts/appearance-dev-smoke.mjs", "scripts/cross-pane-project-isolation-dev-smoke.mjs", "src-tauri/src/appearance_background_probe.rs", "src-tauri/src/lib.rs", "src-tauri/capabilities/default.json", "src-tauri/Cargo.lock"]) {
      evidence.verifierSources[file] = createHash("sha256").update(await readFile(resolve(appearanceRoot, "gg-app", file))).digest("hex");
    }
    const paths = createIsolatedProfile(await mkdtemp(resolve(out, "server-profile-")));
    const env = appearanceEnvironment(process.env, paths);
    async function wait(client, expression, label) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await client.evaluate(expression)) return;
        await new Promise(done => setTimeout(done, 80));
      }
      throw new Error(`Appearance native wait failed: ${label}`);
    }
    await runAppearanceSmokeSession(env, { identity: "com.ggcoder.local-fork", readingAnchors: true, reuseDevServer: true, visual: true,
      onCleanup: result => { evidence.cleanup = result; },
      async verifyWorkspace({ client, cdpPort }) {
        evidence.nativeBackgrounds = [];
        const verifyBackground = async (theme, count) => {
          const deadline = Date.now() + 20000;
          let samples;
          while (true) {
            try {
              samples = await readNativeBackground(cdpPort);
              assertNativeBackground(samples, theme === "light" ? "#fcfbfd" : "#0f1115", count);
              break;
            }
            catch (error) {
              if (Date.now() >= deadline) { evidence.nativeBackgrounds.push({ theme, samples }); throw error; }
              await new Promise(done => setTimeout(done, 80));
            }
          }
          evidence.nativeBackgrounds.push({ theme, samples });
        };
        assert.equal(await client.evaluate("location.pathname"), "/");
        await wait(client, "document.querySelectorAll('[data-pane-id] textarea').length >= 2", "normal workspace");
        const ids = await client.evaluate("[...document.querySelectorAll('[data-pane-id]')].map(e=>e.dataset.paneId)");
        const states = () => client.evaluate(`Promise.all(${JSON.stringify(ids)}.map(paneId=>window.__TAURI_INTERNALS__.invoke('agent_state',{paneId}))).then(states=>states.map(({sessionId,cwd})=>({sessionId,cwd})))`);
        const before = await states();
        await client.evaluate(`(() => {
          window.__appearanceHosts = [...document.querySelectorAll('[data-pane-id]')];
          for (const [index, input] of [...document.querySelectorAll('[data-pane-id] textarea')].entries()) {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, 'Appearance draft ' + index);
            input.dispatchEvent(new Event('input',{bubbles:true})); input.setSelectionRange(2,7);
          }
          return true;
        })()`);
        await client.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray-intent',payload:'settings'})");
        await wait(client, "document.querySelectorAll('.appearance-control select').length === 7", "production Settings controls");
        for (const theme of ["light", "dark"]) {
          await client.evaluate(`(() => { const select=document.querySelector('.appearance-control select');select.value=${JSON.stringify(theme)};select.dispatchEvent(new Event('change',{bubbles:true}));return true })()`);
          await wait(client, `document.documentElement.dataset.appearanceTheme === ${JSON.stringify(theme)}`, "document theme");
          // Theme is separate evidence: the fixture-only probe reads native WM_ERASEBKGND paint, not CSS or theme().
          const native = await client.evaluate(`(async()=>{const api=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');return api.getCurrentWindow().theme()})()`);
          assert.equal(native, theme);
          await verifyBackground(theme, 1);
          if (theme === "light") {
            // Negative control: the real SDK resolves but discards the color.
            // Read native paint afterwards, then recover through the production owner.
            const discarded = await client.evaluate("(async()=>{const api=await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');await api.getCurrentWindow().setBackgroundColor('#0f1115');return window.__TAURI_INTERNALS__.invoke('appearance_background_probe').then(rgb=>({rgb}),error=>({error:String(error)}))})()");
            assert.deepEqual(discarded, { error: "Native background erasure was not handled" }, "Native probe must detect the installed SDK's discarded color");
            evidence.discardedSdkColor = discarded;
            await client.evaluate("import('/src/appearance.ts').then(({appearance})=>appearance.update({theme:'dark'}))");
            await verifyBackground("dark", 1);
            await client.evaluate("import('/src/appearance.ts').then(({appearance})=>appearance.update({theme:'light'}))");
            await verifyBackground("light", 1);
          }
          await wait(client, `document.querySelectorAll('.action-metal.metal-fx-root').length > 0 && [...document.querySelectorAll('.action-metal.metal-fx-root')].every(e=>e.dataset.theme===${JSON.stringify(theme)})`, "native shader theme");
          assert.equal(await client.evaluate("getComputedStyle(document.querySelector('[role=dialog]')).color"), theme === "light" ? "rgb(32, 32, 42)" : "rgb(242, 243, 247)");
          for (const viewport of [{width:1280,height:800},{width:390,height:844}]) {
            await client.send("Emulation.setDeviceMetricsOverride", {...viewport, deviceScaleFactor:1, mobile:false});
            await client.evaluate("document.querySelector('.appearance-settings').scrollIntoView({block:'start'});new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
            const screenshot = await client.send("Page.captureScreenshot", {format:"png"});
            const name = `${theme}-settings-${viewport.width}.png`;
            await writeFile(resolve(out,name),Buffer.from(screenshot.data,"base64")); evidence.captures.push(name);
            assert.equal(await client.evaluate("document.querySelector('.settings-modal').scrollWidth <= document.querySelector('.settings-modal').clientWidth + 1"), true);
          }
          evidence.checks.push(`${theme}: saved normal Settings, document-root portal inheritance, native theme and OS background paint, desktop/narrow modal reflow`);
        }
        await client.send("Emulation.setDeviceMetricsOverride", {width:1280,height:800,deviceScaleFactor:1,mobile:false});
        await client.evaluate(`(() => {
          window.__appearanceAnchors = [...document.querySelectorAll('[data-pane-id]')].map(host => {
            const scroll=host.querySelector('.transcript'); const paragraph=host.querySelector('.ken-msg p');
            const node=paragraph.firstChild;
            scroll.scrollTop += paragraph.getBoundingClientRect().top-scroll.getBoundingClientRect().top+700;
            scroll.dispatchEvent(new Event('scroll'));
            const top=scroll.getBoundingClientRect().top+scroll.clientTop;
            for(let index=0;index<node.length;index++) {
              const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+1);
              const box=range.getBoundingClientRect();
              if(box.width && box.bottom>top) return {scroll,range,top:box.top-top};
            }
            throw new Error('No visible reading anchor');
          }); return true;
        })()`);
        await client.evaluate("(() => { for(const select of [...document.querySelectorAll('.appearance-control select')].slice(1)){select.selectedIndex=1;select.dispatchEvent(new Event('change',{bubbles:true}));}return true })()");
        await client.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
        const drifts = await client.evaluate("window.__appearanceAnchors.map(({scroll,range,top})=>Math.abs(range.getBoundingClientRect().top-scroll.getBoundingClientRect().top-scroll.clientTop-top))");
        assert.ok(drifts.every(drift=>drift<=1), `Reading changes moved anchored text: ${drifts.join(', ')}`);
        evidence.checks.push("Reading preference changes preserve the visible glyph in each transcript within one CSS pixel");
        await client.send("Input.dispatchKeyEvent", {type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
        await client.send("Input.dispatchKeyEvent", {type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
        await wait(client, "!document.querySelector('.settings-modal')", "Escape closes Settings");
        assert.deepEqual(await states(), before);
        assert.equal(await client.evaluate("window.__appearanceHosts.every(e=>e.isConnected && document.getElementById(e.id)===e)"), true);
        assert.deepEqual(await client.evaluate("[...document.querySelectorAll('[data-pane-id] textarea')].map(e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd}))"), ids.map((_,index)=>({value:`Appearance draft ${index}`,start:2,end:7})));
        evidence.checks.push("Theme and reading changes preserve native session IDs, project roots, keyed pane hosts, drafts and composer selection");
        const saved = await client.evaluate("localStorage.getItem('gg-app:appearance:v1')");
        await client.evaluate("location.reload();true");
        await wait(client, "document.documentElement.dataset.appearanceSize === '16' && Boolean(document.querySelector('[data-pane-id] textarea'))", "saved reload");
        assert.equal(await client.evaluate("localStorage.getItem('gg-app:appearance:v1')"), saved);
        evidence.checks.push("Saved reading preferences survive native WebView reload");
        await client.evaluate("window.__TAURI_INTERNALS__.invoke('new_window')");
        await client.evaluate("window.__TAURI_INTERNALS__.invoke('open_whatsnew_window')");
        const waitTarget = async (label, read) => {
          const end = Date.now() + 20000;
          while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
          throw new Error(`Appearance native target wait failed: ${label}`);
        };
        const secondary = await connectToDevWebview(cdpPort, waitTarget, target => target.url.includes('whatsnew'));
        try {
          await wait(secondary, "document.documentElement?.dataset.appearanceSize === '16' && Boolean(document.querySelector('.whatsnew-window'))", "standalone saved initialization");
          const labels = await client.evaluate("import('/node_modules/.vite/deps/@tauri-apps_api_window.js').then(async api=>(await api.getAllWindows()).map(w=>w.label))");
          assert.equal(labels.length, 3);
          assert.ok(labels.includes('main') && labels.includes('whatsnew') && labels.some(label=>label.startsWith('project-')));
          evidence.backgroundWindowLabels = labels;
          for (const theme of ["light", "dark"]) {
            await client.evaluate(`import('/src/appearance.ts').then(({appearance})=>appearance.update({theme:${JSON.stringify(theme)}}))`);
            await wait(secondary, `document.documentElement?.dataset.appearanceTheme === ${JSON.stringify(theme)}`, "standalone live theme");
            await verifyBackground(theme, 3);
          }
          // Do not await an IPC reply in the window being destroyed. WebView2
          // detaches that target before its JavaScript promise can settle.
          await client.evaluate("import('/node_modules/.vite/deps/@tauri-apps_api_window.js').then(async api=>(await api.Window.getByLabel('whatsnew')).close())");
          await waitTarget("standalone close", async () => {
            const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
            return !(await response.json()).some(target=>target.url.includes('whatsnew'));
          });
          evidence.checks.push("Main, project and What's New windows paint both requested native backgrounds; What's New inherits saved reading settings, receives live theme changes, and closes without a pending self-destruction request");
        } finally { secondary.close(); }
      },
    }, options);
    evidence.status = "passed";
  } catch (error) {
    failures.push(error);
    evidence.status = "failed";
    evidence.error = errorMessage(error instanceof AppearanceSmokeCleanupError && error.verificationErrors.length ? error.verificationErrors[0] : error);
    if (error instanceof AppearanceSmokeCleanupError) evidence.cleanupError = errorMessage(error.cleanupError);
  }
  try {
    await writeFile(resolve(out, "result.json"), JSON.stringify(evidence, null, 2));
  } catch (error) {
    const persistenceError = new Error(`Could not persist appearance smoke evidence at ${out}: ${errorMessage(error)}`, { cause: error });
    throw new AggregateError([...failures, persistenceError], [...failures, persistenceError].map(errorMessage).join("; "));
  }
  console.log(`Appearance smoke evidence: ${out}`);
  if (failures.length) throw failures[0];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAppearanceSmoke().catch(error=>{console.error(error);process.exitCode=1;});
}
