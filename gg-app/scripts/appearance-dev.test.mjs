import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { ensureFramework, createAppearanceScope, runAppearanceSession, appearanceEnvironment, appearanceNativeEnvironment, verifyNormalServer } from "./appearance-dev.mjs";
import { runAppearanceSmokeSession } from "./appearance-dev-smoke.mjs";
import { appearanceRoot, checkoutIdentity } from "./appearance-dev-identity.mjs";
import { runCrossPaneProjectIsolationSmoke } from "./cross-pane-project-isolation-dev-smoke.mjs";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function lifecycleFixture(stage, reused = false) {
  const signals = new EventEmitter();
  const reached = deferred(), pending = deferred();
  const children = [], table = [];
  const launchProcess = vi.fn((command) => {
    const child = { pid: 100 + children.length * 2, exitCode: null };
    const exit = deferred();
    children.push({ child, exit, command });
    table.push({ pid: child.pid, ppid: 1, startedAtMs: 1 }, { pid: child.pid + 1, ppid: child.pid, startedAtMs: 2 });
    if (command === stage) reached.resolve();
    else if (command === "framework" || command === "cargo") { child.exitCode = 0; exit.resolve(0); table.splice(table.length - 2, 2); }
    return { child, exited: exit.promise };
  });
  const terminate = vi.fn(async pid => {
    const index = table.findIndex(row => row.pid === pid);
    if (index >= 0) table.splice(index, 1);
    const record = children.find(record => record.child.pid === pid);
    if (record) { record.child.exitCode = 1; record.exit.resolve(1); }
  });
  let probes = 0;
  const release = vi.fn(async () => {});
  const options = {
    signals, launchProcess, terminate, processTableReader: async () => [...table],
    ensureFramework: async (_, scope) => { const build = scope.launch("framework", []); await scope.wait(build.exited); },
    isListening: async () => {
      if (reused) return true;
      if (probes++ === 0) return false;
      if (stage === "vite") { reached.resolve(); return pending.promise; }
      return true;
    },
    verify: async () => {},
    reservePort: async () => { reached.resolve(); await pending.promise; return { port: 12345, release }; },
  };
  return { options, reached, pending, children, table, release, launchProcess, terminate, signals };
}

describe("framework build freshness", () => {
  const temporaryTrees = [];
  afterEach(() => { for (const tree of temporaryTrees.splice(0)) rmSync(tree, { recursive: true, force: true }); });
  function fixture() {
    const checkout = mkdtempSync(join(tmpdir(), "appearance-build-"));
    temporaryTrees.push(checkout);
    const put = (path, content) => { const file = join(checkout, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
    put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    put("tsconfig.json", '// JSONC is supported\n{"compilerOptions":{"target":"ES2022",},}');
    for (const name of ["gg-ai", "gg-agent", "gg-core", "ggcoder"]) {
      const base = `packages/${name}`;
      // The production manifests define the finite build-input set.
      put(`${base}/package.json`, readFileSync(join(appearanceRoot, base, "package.json")));
      put(`${base}/src/index.ts`, "export const value = 1;");
      put(`${base}/dist/index.js`, "export const value = 1;");
      put(`${base}/tsconfig.json`, '{"extends":"../../tsconfig.json"}');
      if (name === "ggcoder") put(`${base}/tsconfig.build.json`, '{"extends":"./tsconfig.json"}');
      else put(`${base}/tsup.config.ts`, 'export default { entry: ["src/index.ts"], format: ["esm", "cjs"] };');
    }
    const stamp = join(checkout, "framework-build.json");
    const scope = { launch: vi.fn(() => ({ exited: Promise.resolve(0) })), wait: promise => promise };
    return { checkout, stamp, scope, put, run: () => ensureFramework({}, scope, { checkout, stamp }) };
  }
  it("reuses unchanged inputs and outputs in dependency order", async () => {
    const f = fixture();
    await f.run(); await f.run();
    expect(f.scope.launch.mock.calls.map(([, args]) => args.at(-1))).toEqual(
      ["gg-ai", "gg-agent", "gg-core", "ggcoder"].map(name => `pnpm --filter @kenkaiiii/${name} build`));
  });
  it.each([
    ["tsconfig.json", '{"compilerOptions":{"target":"ES2023"}}'],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed"],
    ["packages/gg-ai/src/index.ts", "export const value = 2;"],
    ["packages/gg-core/tsup.config.ts", 'export default { entry: ["src/index.ts"], format: ["esm", "cjs"], external: ["optional-dep"] };'],
    ...["gg-ai", "gg-agent", "gg-core", "ggcoder"].map(name => [`packages/${name}/tsconfig.json`, '{"extends":"../../tsconfig.json","compilerOptions":{"sourceMap":false}}']),
    ["packages/ggcoder/tsconfig.build.json", '{"extends":"./tsconfig.json","compilerOptions":{"declaration":false}}'],
    ...["gg-ai", "gg-agent", "gg-core"].flatMap(name => [
      [`packages/${name}/tsup.config.ts`, 'export default { entry: ["src/other.ts"], format: ["esm", "cjs"] };'],
      [`packages/${name}/tsup.config.ts`, 'export default { entry: ["src/index.ts"], format: ["esm"] };'],
    ]),
  ])("rebuilds when only %s changes (%s)", async (path, content) => {
    const f = fixture(); await f.run(); f.scope.launch.mockClear();
    f.put(path, content); await f.run();
    expect(f.scope.launch).toHaveBeenCalledTimes(4);
    await f.run(); expect(f.scope.launch).toHaveBeenCalledTimes(4);
  });
  it("tracks transitive JSONC extends, including arrays and extensionless paths", async () => {
    const f = fixture();
    f.put("config/base.json", '{"extends":"./runtime"}');
    f.put("config/runtime.json", '{"compilerOptions":{"target":"ES2022"}}');
    f.put("tsconfig.json", '// ordered bases\n{"extends":["./config/base.json"],}');
    await f.run(); f.scope.launch.mockClear();
    f.put("config/runtime.json", '{"compilerOptions":{"target":"ES2023"}}');
    await f.run(); expect(f.scope.launch).toHaveBeenCalledTimes(4);
  });
  it.each(["tsconfig.json", "packages/gg-ai/tsup.config.ts", "packages/ggcoder/tsconfig.build.json"])("never accepts a stamp when required input %s is missing", async path => {
    const f = fixture(); await f.run(); f.scope.launch.mockClear();
    const saved = readFileSync(f.stamp, "utf8");
    rmSync(join(f.checkout, path));
    await expect(f.run()).rejects.toThrow("ENOENT");
    expect(readFileSync(f.stamp, "utf8")).toBe(saved);
    expect(f.scope.launch).not.toHaveBeenCalled();
  });
  it.each([
    ['{"extends":"./tsconfig.json"}', "Circular"],
    ['{"extends":"../outside.json"}', "outside checkout"],
    ['{"extends":', "Invalid"],
  ])("rejects unsafe or invalid config chains (%s)", async (content, message) => {
    const f = fixture(); f.put("tsconfig.json", content);
    await expect(f.run()).rejects.toThrow(message);
    expect(f.scope.launch).not.toHaveBeenCalled();
    expect(existsSync(f.stamp)).toBe(false);
  });
  it("does not fingerprint unrelated checkout files", async () => {
    const f = fixture(); await f.run(); f.scope.launch.mockClear();
    f.put("docs/example.md", "unrelated"); await f.run();
    expect(f.scope.launch).not.toHaveBeenCalled();
  });
  it("does not stamp failed or cancelled builds", async () => {
    const f = fixture();
    f.scope.launch.mockReturnValue({ exited: Promise.resolve(1) });
    await expect(f.run()).rejects.toThrow("gg-ai build failed (1)");
    expect(existsSync(f.stamp)).toBe(false);
    f.scope.launch.mockClear();
    f.scope.wait = async () => { throw new Error("cancelled"); };
    await expect(f.run()).rejects.toThrow("cancelled");
    expect(f.scope.launch).toHaveBeenCalledTimes(1);
    expect(existsSync(f.stamp)).toBe(false);
  });
  it("rebuilds missing outputs", async () => {
    const f = fixture(); await f.run(); f.scope.launch.mockClear();
    rmSync(join(f.checkout, "packages/gg-ai/dist"), { recursive: true });
    f.scope.launch.mockImplementation(() => {
      f.put("packages/gg-ai/dist/index.js", "rebuilt");
      return { exited: Promise.resolve(0) };
    });
    await f.run(); expect(f.scope.launch).toHaveBeenCalledTimes(4);
  });
  it("retains the output checksum check", async () => {
    const f = fixture(); await f.run(); f.scope.launch.mockClear();
    f.put("packages/ggcoder/dist/index.js", "stale output"); await f.run();
    expect(f.scope.launch).toHaveBeenCalledTimes(4);
  });
});

describe("appearance smoke finite prebuild", () => {
  function smokeFixture() {
    const fixture = lifecycleFixture("cargo", true);
    const ready = vi.fn();
    const config = { ...JSON.parse(readFileSync(join(appearanceRoot, "gg-app/src-tauri/tauri.local.conf.json"), "utf8")), build: { beforeDevCommand: "" } };
    fixture.options.ensureServer = vi.fn(async () => {});
    fixture.options.runFixture = async ({ beforeNativeStart }) => {
      await beforeNativeStart({ CARGO_NET_OFFLINE: "true" }, config);
      // Model the real fixture's bounded readiness wait, after the pre-start hook.
      await new Promise(resolve => setTimeout(() => { ready(); resolve(); }, 300_000));
    };
    return { ...fixture, ready, config };
  }
  it("starts the readiness clock only after an eleven-minute pending build completes", async () => {
    vi.useFakeTimers();
    const fixture = smokeFixture();
    const run = runAppearanceSmokeSession({}, {}, fixture.options);
    await fixture.reached.promise;
    await vi.advanceTimersByTimeAsync(660_000);
    expect(fixture.ready).not.toHaveBeenCalled();
    fixture.children[0].child.exitCode = 0; fixture.children[0].exit.resolve(0);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fixture.ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(fixture.ready).toHaveBeenCalledOnce();
    expect(fixture.launchProcess).toHaveBeenCalledWith("cargo", ["build", "--no-default-features", "--offline"], expect.objectContaining({ env: expect.objectContaining({ CARGO_NET_OFFLINE: "true", TAURI_CONFIG: JSON.stringify(fixture.config) }) }));
  });
  it("reports compiler failure without entering readiness", async () => {
    const fixture = smokeFixture();
    const run = runAppearanceSmokeSession({}, {}, fixture.options);
    const result = expect(run).rejects.toThrow("Appearance debug build failed (101); native readiness was not started");
    await fixture.reached.promise;
    fixture.children[0].child.exitCode = 101; fixture.children[0].exit.resolve(101);
    await result;
    expect(fixture.ready).not.toHaveBeenCalled();
  });
  it("runs Cargo incremental checks on every warm invocation without framework builds", async () => {
    vi.useFakeTimers();
    const fixture = smokeFixture();
    fixture.options.launchProcess = vi.fn(() => ({ child: { exitCode: 0 }, exited: Promise.resolve(0) }));
    for (let index = 0; index < 2; index++) {
      const run = runAppearanceSmokeSession({}, {}, fixture.options);
      await vi.advanceTimersByTimeAsync(300_000);
      await run;
    }
    expect(fixture.options.launchProcess.mock.calls.map(([command]) => command)).toEqual(["cargo", "cargo"]);
    expect(fixture.ready).toHaveBeenCalledTimes(2);
  });
  it("cancels an owned pending build and never enters readiness", async () => {
    const fixture = smokeFixture();
    const run = runAppearanceSmokeSession({}, {}, fixture.options);
    const result = expect(run).rejects.toThrow("cancelled");
    await fixture.reached.promise;
    fixture.signals.emit("SIGINT");
    await result;
    expect(fixture.table).toEqual([]);
    expect(fixture.ready).not.toHaveBeenCalled();
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
  });
});

describe("appearance startup cancellation", () => {
  it.each(["framework", "cargo", "vite", "reservation"])("cleans owned descendants and never launches native after cancellation during %s", async stage => {
    const fixture = lifecycleFixture(stage);
    const run = runAppearanceSession({}, {}, {}, fixture.options);
    await fixture.reached.promise;
    fixture.signals.emit("SIGINT");
    fixture.pending.resolve(false);
    await run;
    expect(fixture.table).toEqual([]);
    expect(fixture.launchProcess.mock.calls.some(([command]) => command === process.execPath)).toBe(false);
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    if (stage === "reservation") expect(fixture.release).toHaveBeenCalledOnce();
  });
  it("preserves a reused Vite server during reservation cancellation", async () => {
    const fixture = lifecycleFixture("reservation", true);
    fixture.table.push({ pid: 999, ppid: 1, startedAtMs: 1 });
    const run = runAppearanceSession({}, {}, {}, fixture.options);
    await fixture.reached.promise;
    fixture.signals.emit("SIGTERM"); fixture.pending.resolve();
    await run;
    expect(fixture.table).toEqual([{ pid: 999, ppid: 1, startedAtMs: 1 }]);
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });
  it("retains orphan identities but never kills a reused PID", async () => {
    const fixture = lifecycleFixture("vite");
    const scope = createAppearanceScope(fixture.options);
    scope.launch("server", []);
    await scope.sample();
    // Even before the root's exit event is delivered, a changed identity is not ours.
    fixture.table[0] = { pid: 100, ppid: 1, startedAtMs: 99 };
    fixture.table[1].ppid = 1;
    await scope.close();
    expect(fixture.terminate.mock.calls).toEqual([[101]]);
    expect(fixture.table).toEqual([{ pid: 100, ppid: 1, startedAtMs: 99 }]);
    expect(() => scope.launch("native", [])).toThrow("cancelled");
    scope.dispose();
  });
  it("checks cancellation again after releasing the reserved port", async () => {
    const fixture = lifecycleFixture("reservation", true);
    const releasing = deferred(), released = deferred();
    fixture.release.mockImplementation(async () => { releasing.resolve(); await released.promise; });
    const run = runAppearanceSession({}, {}, {}, fixture.options);
    await fixture.reached.promise;
    fixture.pending.resolve();
    await releasing.promise;
    fixture.signals.emit("SIGINT"); released.resolve();
    await run;
    expect(fixture.launchProcess.mock.calls.map(([command]) => command)).toEqual(["framework", "cargo"]);
  });
  it("shares one shutdown promise and attempts later cleanup after an earlier failure", async () => {
    const fixture = lifecycleFixture("vite");
    const scope = createAppearanceScope(fixture.options);
    scope.launch("server", []); scope.launch("native", []);
    fixture.terminate.mockImplementation(async pid => { if (pid === 102) throw new Error("native cleanup failed"); });
    const shutdown = scope.close();
    expect(scope.close()).toBe(shutdown);
    await expect(shutdown).rejects.toThrow("native cleanup failed");
    expect(fixture.terminate).toHaveBeenCalledWith(100);
    expect(fixture.terminate).toHaveBeenCalledWith(101);
    scope.dispose();
  });
});
describe("appearance developer isolation", () => {
  it("redirects every profile path and drops credentials, preview and debug inheritance", () => {
    const paths = { home:"isolated/home", appData:"isolated/roaming", localAppData:"isolated/local", temp:"isolated/temp", webview2:"isolated/webview", project:"isolated/project" };
    const env = appearanceEnvironment({ PATH:"tools", HOME:"production", USERPROFILE:"production", APPDATA:"production", LOCALAPPDATA:"production", GG_SIDECAR_PATH:"untrusted", GG_CHAT_DESIGN_PREVIEW:"1", OPENAI_API_KEY:"not-a-real-key", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:"--remote-debugging-port=9999", NODE_OPTIONS:"--require untrusted", PLAYWRIGHT_WS_ENDPOINT:"untrusted", VITE_GG_SOURCE_ROOT:"other-checkout" }, paths);
    expect(env.HOME).toBe(paths.home); expect(env.USERPROFILE).toBe(paths.home);
    expect(env.APPDATA).toBe(paths.appData); expect(env.LOCALAPPDATA).toBe(paths.localAppData);
    expect(env.WEBVIEW2_USER_DATA_FOLDER).toBe(paths.webview2); expect(env.GG_APP_CWD).toBe(paths.project);
    for (const key of ["GG_SIDECAR_PATH","GG_CHAT_DESIGN_PREVIEW","OPENAI_API_KEY","WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS","NODE_OPTIONS","PLAYWRIGHT_WS_ENDPOINT","VITE_GG_SOURCE_ROOT"]) expect(env[key]).toBeUndefined();
    expect(env.PATH).toBe("tools"); expect(env.COREPACK_ENABLE_NETWORK).toBe("0"); expect(env.CARGO_NET_OFFLINE).toBe("true");
  });
  it("rejects an unknown fixture theme before launching or creating a profile", async () => {
    await expect(runCrossPaneProjectIsolationSmoke({ identity: "com.ggcoder.local-fork", appearanceTheme: "unknown" })).rejects.toThrow("Appearance smoke theme must be dark or light");
  });
  it("selects the workspace sidecar directly, never the default reporting wrapper", () => {
    const env = appearanceNativeEnvironment({ GG_SIDECAR_PATH: "unexpected-wrapper" }, 43210);
    expect(env.GG_SIDECAR_PATH).toBe(join(appearanceRoot, "packages/ggcoder/dist/app-sidecar.js"));
    expect(env.GG_APP_DEV_SMOKE_WINDOW).toBe("visible");
    expect(env.GG_PHASE25_DEV_FIXTURE_CDP_PORT).toBe("43210");
  });
  it.each([{checkout:"other",preview:false},{checkout:checkoutIdentity(),preview:true}])("rejects incompatible port 1420 identity %j", async identity => {
    vi.stubGlobal("fetch", vi.fn(async()=>new Response(JSON.stringify(identity), {status:200})));
    await expect(verifyNormalServer()).rejects.toThrow("Port 1420 conflict");
  });
  it("checks current modules as well as server identity and HTML readiness", async () => {
    vi.stubGlobal("fetch", vi.fn(async url => {
      if (url.endsWith("/__gg-app-dev-identity")) return new Response(JSON.stringify({checkout:checkoutIdentity(),preview:false}));
      if (url.endsWith("/")) return new Response('<script src="/src/main.tsx"></script>');
      const file = String(url).split("/").at(-1);
      const map = {sourcesContent:[readFileSync(join(appearanceRoot,"gg-app/src",file),"utf8")]};
      return new Response(`//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`);
    }));
    await expect(verifyNormalServer()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
