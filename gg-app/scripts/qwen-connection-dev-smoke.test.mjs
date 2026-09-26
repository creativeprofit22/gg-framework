// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { click, fixtureLayout, liveConnectionExpression, validateQwenEvidence } from "./qwen-connection-smoke-scenario.mjs";
import { JSDOM } from 'jsdom';
import { blockedLocalDiscovery, frontendReadyOutput, secretBearing, smokeWindowMode } from "./qwen-connection-dev-smoke.mjs";
import { validateWorkspaceLayoutCandidate } from '../src/workspace-layout.ts';

function complete() {
  const baseline = (i) => ({ provider: "azure", model: "azure:fixture", sessionId: `session-${i}`, sessionPath: `C:/fixture/session-${i}.jsonl` });
  const window = (saved, events, i) => ({ ...baseline(i), saved, auth: saved, events: { auth: events, models: events },
    unverified: true, liveForm: true, liveHub: true, uiModels: true, inputEmpty: true, masked: true });
  const daemon = (pid, stage) => ({ pid, startedAtMs: pid * 1000, previousExited: pid > 10,
    present: stage === "save" || stage === "replace", matchesSave: stage === "save", matchesReplace: stage === "replace", matchesInherited: false });
  const stage = (name, pid, count) => ({ name, daemon: daemon(pid, name), windows: [0, 1].map(i => window(name === "save" || name === "replace", count, i)),
    eventBaselines: [0, 1].map(() => ({ auth: count - 1, models: count - 1 })), localOnlyNotice: true });
  return { version: 1, origin: "http://localhost:1420", windowMode: 'minimized', initialVaultAbsence: true,
    windows: [0, 1].map(i => ({ label: `window-${i}`, targetId: `target-${i}`, origin: "http://localhost:1420",
      observations: ["initial", "save", "replace", "remove"].map(boundary => ({ boundary, minimized: true })) })),
    daemons: [10, 11, 12, 13].map(pid => ({ pid, startedAtMs: pid * 1000, exited: true })),
    baselines: [0, 1].map(baseline), networkDeniedAttempts: 0, secretOutput: false, inputsUnchanged: true, artifactUnchanged: true,
    cancelledToIdle: true, providerRequests: 1, noProviderRequestsForCredentialMutations: true,
    cleanup: { vaultAbsent: true, ownedProcessesStopped: true, providerClosed: true,
      processes: [0, 1].map(() => ({ stopped: true, survivors: [] })) },
    stages: [stage("initial", 10, 0), stage("save", 11, 1), stage("replace", 12, 2),
      ...["busy-save", "busy-remove"].map(name => ({ name, daemon: daemon(12, "replace"), rejected: true, inputRetained: true, saved: true, eventsUnchanged: true })),
      stage("remove", 13, 3)] };
}

const check = (value) => validateQwenEvidence(value, secretBearing);
describe("Qwen native smoke evidence", () => {
  it('keeps minimized as the default and accepts only the explicit visual option', () => {
    expect(smokeWindowMode(['--identity', 'com.ggcoder.local-fork'])).toBe('minimized');
    expect(smokeWindowMode(['--identity', 'com.ggcoder.local-fork', '--visual'])).toBe('visible');
    expect(() => smokeWindowMode(['--identity', 'com.ggcoder.app', '--visual'])).toThrow();
    expect(() => smokeWindowMode(['--identity', 'com.ggcoder.local-fork', '--visible'])).toThrow();
    const launcher = readFileSync(new URL('./qwen-connection-dev-smoke.mjs', import.meta.url), 'utf8');
    expect(launcher).toContain('GG_APP_DEV_SMOKE_WINDOW: windowMode');
    const native = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    expect(native).toContain('Some("visible") => Ok(false)');
  });
  it('accepts explicitly recorded visible windows but rejects a mixed mode', () => {
    const evidence = complete();
    evidence.windowMode = 'visible';
    for (const window of evidence.windows) for (const observation of window.observations) observation.minimized = false;
    expect(() => check(evidence)).not.toThrow();
    evidence.windows[1].observations[1].minimized = true;
    expect(() => check(evidence)).toThrow();
  });
  it.each([false, true])('observes the actual hub marker and rejects missing/remounted DOM (saved=%s)', saved => {
    const dom = new JSDOM(`<div class="login-grid"><button class="login-tile">Qwen Cloud (Token Plan)${saved ? '<span aria-label="Connected"></span>' : ''}</button></div><form><input type="password" placeholder="Enter sk-sp- key"><span>${saved ? 'Saved connection — not remotely verified' : 'No saved connection'}</span></form>`);
    try {
      const { document } = dom.window;
      dom.window.qwenObservedForm = document.querySelector('form');
      dom.window.qwenObservedHub = document.querySelector('.login-grid');
      const observe = () => new Function('document', 'window', `return ${liveConnectionExpression(saved)}`)(document, dom.window);
      expect(observe()).toBe(true);
      const hub = document.querySelector('.login-grid');
      hub.replaceWith(hub.cloneNode(true));
      expect(observe()).toBe(false);
      dom.window.qwenObservedHub = null;
      document.querySelector('.login-grid').remove();
      expect(observe()).toBe(false);
    } finally { dom.window.close(); }
  });
  it('clicks the real UI using trusted CDP pointer input', async () => {
    const sent = [];
    const client = { evaluate: async () => ({ x: 40, y: 80 }), send: async (name, args) => { sent.push([name, args]); } };
    await click(client, 'Login to AI Providers', async (_label, check) => { await check(); });
    expect(sent).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 80, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 80, button: 'left', clickCount: 1 }],
    ]);
  });
  it('targets the requested pane when two Home buttons coexist during startup', async () => {
    const dom = new JSDOM('<section id="workspace-pane-primary"><button>Login to AI Providers</button></section><section id="workspace-pane-auth"><button>Login to AI Providers</button></section>');
    try {
      const sent = [];
      [...dom.window.document.querySelectorAll('button')].forEach((button, i) => {
        button.scrollIntoView = () => {};
        button.getBoundingClientRect = () => ({ x: i * 400, y: 0, width: 100, height: 40 });
      });
      const client = { evaluate: async expression => new Function('document', `return ${expression}`)(dom.window.document), send: async (_name, args) => { sent.push(args); } };
      await click(client, 'Login to AI Providers', async (_label, check) => { expect(await check()).toBe(true); }, '#workspace-pane-auth');
      expect(sent.map(event => event.x)).toEqual([450, 450]);
    } finally { dom.window.close(); }
  });
  it('seeds the exact current persisted workspace layout contract', () => {
    const layout = fixtureLayout('C:\\fixture');
    expect(validateWorkspaceLayoutCandidate(layout)).not.toBeNull();
    const selected = fixtureLayout('C:/fixture', 'C:/fixture/session-1.jsonl');
    expect(validateWorkspaceLayoutCandidate(selected)).not.toBeNull();
    expect(selected.panes.primary.sessionPath).toBe('C:/fixture/session-1.jsonl');
  });
  it('suppresses only the exact default local metadata probe without permitting transport', () => {
    expect(blockedLocalDiscovery('http://127.0.0.1:11434/v1/models', 'GET')).toBe(true);
    for (const url of ['http://127.0.0.1:11434/v1/chat/completions', 'http://127.0.0.1:11434/v1/models?x=1', 'https://api.qwen.ai/v1/models', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions']) {
      expect(blockedLocalDiscovery(url, 'GET')).toBe(false);
    }
    expect(blockedLocalDiscovery('http://127.0.0.1:11434/v1/models', 'POST')).toBe(false);
  });
  it('recognizes the owned Vite origin with ANSI-styled port output', () => {
    expect(frontendReadyOutput('\u001b[36mhttp://localhost:\u001b[1m1420\u001b[22m/\u001b[39m')).toBe(true);
    expect(frontendReadyOutput('http://localhost:1420/')).toBe(true);
    expect(frontendReadyOutput('http://127.0.0.1:1420/')).toBe(false);
    expect(frontendReadyOutput('http://localhost:1421/')).toBe(false);
  });
  it("accepts complete two-window native evidence without launching anything", () => expect(() => check(complete())).not.toThrow());
  it.each([
    ["one window", e => e.windows.pop()],
    ["one-window replacement", e => e.stages[2].windows.pop()],
    ["duplicate native label", e => e.windows[1].label = e.windows[0].label],
    ["duplicate WebView target", e => e.windows[1].targetId = e.windows[0].targetId],
    ["wrong origin", e => e.windows[1].origin = "http://127.0.0.1:1420"],
    ["missing daemon", e => delete e.stages[1].daemon.pid],
    ["missing start identity", e => delete e.stages[1].daemon.startedAtMs],
    ["unchanged daemon", e => e.stages[1].daemon.pid = e.stages[0].daemon.pid],
    ["unobserved old exit", e => e.stages[2].daemon.previousExited = false],
    ["missing replacement", e => e.stages.splice(2, 1)],
    ["wrong replacement injection", e => e.stages[2].daemon.matchesReplace = false],
    ["missing removal", e => e.stages.pop()],
    ["inherited credential after removal", e => e.stages[5].daemon.matchesInherited = true],
    ["credential remains after removal", e => e.stages[5].daemon.present = true],
    ["missed secondary auth event", e => e.stages[1].windows[1].events.auth = 0],
    ["missed secondary model event", e => e.stages[1].windows[1].events.models = 0],
    ["hub remounted", e => e.stages[2].windows[0].liveHub = false],
    ["form remounted", e => e.stages[2].windows[1].liveForm = false],
    ["model UI not observed", e => e.stages[1].windows[0].uiModels = false],
    ["active provider changed", e => e.stages[2].windows[1].provider = "qwen-cloud"],
    ["session not recovered", e => e.stages[2].windows[0].sessionId = "different-session"],
    ['durable session path missing', e => delete e.stages[1].windows[0].sessionPath],
    ['durable session path changed', e => e.stages[1].windows[1].sessionPath = 'C:/fixture/different.jsonl'],
    ["busy save not rejected", e => e.stages[3].rejected = false],
    ["busy removal restarted daemon", e => e.stages[4].daemon.pid = 99],
    ["input retained after save", e => e.stages[1].windows[0].inputEmpty = false],
    ["remotely verified wording", e => e.stages[2].localOnlyNotice = false],
    ["failed vault cleanup", e => e.cleanup.vaultAbsent = false],
    ["missing final daemon exit", e => e.daemons[3].exited = false],
    ["missing daemon cleanup identity", e => e.daemons.pop()],
    ["provider listener left running", e => e.cleanup.providerClosed = false],
    ["failed process cleanup", e => e.cleanup.processes[0].survivors = [55]],
    ["empty process cleanup", e => e.cleanup.processes = []],
    ["source drift", e => e.inputsUnchanged = false],
    ["binary drift", e => e.artifactUnchanged = false],
    ["external network attempt", e => e.networkDeniedAttempts = 1],
    ["secret-bearing process output", e => e.secretOutput = true],
    ["secret-bearing evidence", e => e.diagnostic = "sk-sp-synthetic-not-a-real-key"],
    ["bootstrap header in evidence", e => e.diagnostic = "x-gg-token: synthetic"],
    ["normal window", e => e.windows[0].observations[0].minimized = false],
    ["unobserved cancellation", e => e.cancelledToIdle = false],
  ])("rejects %s", (_name, mutate) => {
    const evidence = complete(); mutate(evidence);
    expect(() => check(evidence)).toThrow();
  });
  it("does not treat the fixed status vocabulary as a secret", () => {
    expect(secretBearing(JSON.stringify(complete()))).toBe(false);
    expect(secretBearing("Token Plan only. Use an sk-sp- key.")).toBe(false);
  });
  it("pins production origin checks and keeps the fixture selector debug-only", () => {
    const native = new URL("../src-tauri/src/", import.meta.url);
    const commands = readFileSync(new URL("qwen_cloud_connection/commands.rs", native), "utf8");
    expect(commands).toContain('development && origin == "http://localhost:1420"');
    expect(commands).not.toContain("GG_QWEN_SMOKE");
    const storage = readFileSync(new URL("qwen_cloud_connection/storage.rs", native), "utf8");
    expect(storage).toContain("#[cfg(debug_assertions)]\n        if let Some(entry) = super::dev_smoke::selected_entry()?");
    expect(storage).toContain("OsVault::new(SERVICE, ACCOUNT)");
  });
});
