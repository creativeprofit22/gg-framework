import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import ts from "typescript";
import net from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { appearanceRoot as root, checkoutIdentity } from "./appearance-dev-identity.mjs";
import { createIsolatedProfile, reserveHeldTcpPort, sanitizedSmokeEnvironment } from "./phase-25-windows-smoke-helpers.mjs";
import { processTreeSnapshot, readProcessTable, survivingProcessIds, terminateProcessTree } from "./workspace-shell-evidence.mjs";

export const evidenceRoot = join(root, ".gg/eyes/out/appearance-native");
const appDir = join(root, "gg-app");
const packages = ["gg-ai", "gg-agent", "gg-core", "ggcoder"];
export function appearanceEnvironment(base, paths) {
  const env = sanitizedSmokeEnvironment(base, paths);
  for (const name of Object.keys(env)) {
    if (/(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS)(?:$|_)/i.test(name) || /^(?:GG_|TAURI_|WEBVIEW2_|VITE_|PLAYWRIGHT_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_|CHROME_|BROWSER_)/i.test(name)) delete env[name];
  }
  return { ...env, WEBVIEW2_USER_DATA_FOLDER: paths.webview2, GG_APP_CWD: paths.project,
    UIMAXXXING_EYES_NO_INSTALL: "1", COREPACK_ENABLE_NETWORK: "0", COREPACK_DEFAULT_TO_LATEST: "0", CARGO_NET_OFFLINE: "true",
    COREPACK_HOME: base.COREPACK_HOME ?? join(base.LOCALAPPDATA ?? "", "node/corepack"),
    CARGO_HOME: base.CARGO_HOME ?? join(base.USERPROFILE ?? "", ".cargo"),
    RUSTUP_HOME: base.RUSTUP_HOME ?? join(base.USERPROFILE ?? "", ".rustup") };
}
export function appearanceNativeEnvironment(env, port) {
  return { ...env, GG_SIDECAR_PATH: join(root, "packages/ggcoder/dist/app-sidecar.js"), GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1", GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(port), GG_APP_DEV_SMOKE_WINDOW: "visible" };
}
export async function verifyNormalServer() {
  const response = await fetch("http://127.0.0.1:1420/__gg-app-dev-identity", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Port 1420 conflict: missing normal-app checkout identity");
  let identity;
  try { identity = await response.json(); } catch { throw new Error("Port 1420 conflict: not a compatible GG app server"); }
  if (identity.checkout !== checkoutIdentity() || identity.preview !== false) throw new Error("Port 1420 conflict: different checkout or preview-enabled server; nothing was stopped");
  for (const file of ["main.tsx", "appearance.ts", "appearance-native.ts", "AppearanceSettings.tsx"]) {
    const module = await fetch(`http://127.0.0.1:1420/src/${file}`, { signal: AbortSignal.timeout(5000) });
    const text = await module.text();
    const match = text.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/);
    const map = match ? JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) : null;
    if (!module.ok || !map?.sourcesContent?.includes(readFileSync(join(appDir, "src", file), "utf8"))) throw new Error(`Port 1420 conflict: stale ${file}`);
  }
  const html = await fetch("http://127.0.0.1:1420/", { signal: AbortSignal.timeout(5000) });
  if (!html.ok || !(await html.text()).includes("/src/main.tsx")) throw new Error("Normal app HTTP readiness failed");
}
function listening() {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port: 1420 });
    socket.setTimeout(2000);
    const finish = (value) => { socket.destroy(); done(value); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.once("timeout", () => finish(true));
  });
}
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true, ...options });
  const exited = new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code) => done(code)); });
  // Callers await this promise; attach a handler immediately while checking readiness.
  void exited.catch(() => {});
  return { child, exited };
}
export function createAppearanceScope({ launchProcess = launch, processTableReader = readProcessTable, terminate = terminateProcessTree, signals = process } = {}) {
  const records = [];
  const cancelled = new Error("Appearance developer session cancelled");
  let closing = false, shutdown, sampling;
  let cancel;
  const cancellation = new Promise((_, reject) => { cancel = () => reject(cancelled); });
  void cancellation.catch(() => {});
  const check = () => { if (closing) throw cancelled; };
  const sample = () => {
    if (sampling) return sampling;
    sampling = (async () => {
      const table = await processTableReader();
      for (const record of records) {
        const { child, identities } = record;
        const root = identities.get(child.pid);
        if (root ? survivingProcessIds([root], table).length : child.exitCode === null && !child.signalCode) {
          for (const identity of processTreeSnapshot(table, child.pid).identities) identities.set(identity.pid, identity);
        }
      }
    })().finally(() => { sampling = undefined; });
    return sampling;
  };
  let inspectionError;
  const timer = setInterval(() => { void sample().catch(error => { inspectionError = error; void close().catch(() => {}); }); }, 250);
  const close = () => {
    if (shutdown) return shutdown;
    closing = true; cancel(); clearInterval(timer);
    shutdown = (async () => {
      const errors = [];
      if (inspectionError) errors.push(inspectionError);
      try { await sample(); } catch (error) { errors.push(error); }
      for (const { child, identities } of [...records].reverse()) {
        // A live ChildProcess is owned even if inspection failed before its first sample.
        try {
          if (child.exitCode === null && !child.signalCode && child.pid) {
            const identity = identities.get(child.pid);
            if (!identity || survivingProcessIds([identity], await processTableReader()).length) await terminate(child.pid);
          }
        } catch (error) { errors.push(error); }
        try {
          for (const pid of survivingProcessIds([...identities.values()], await processTableReader())) {
            try { await terminate(pid); } catch (error) { errors.push(error); }
          }
          const survivors = survivingProcessIds([...identities.values()], await processTableReader());
          if (survivors.length) throw new Error(`Owned appearance processes survived cleanup: ${survivors.join(", ")}`);
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, `Appearance cleanup failed: ${errors.map(error => error.message).join("; ")}`);
    })();
    return shutdown;
  };
  const onSignal = () => { void close().catch(() => {}); };
  signals.on("SIGINT", onSignal); signals.on("SIGTERM", onSignal);
  return {
    check, close, sample,
    isCancellation: error => error === cancelled,
    wait: async promise => { check(); const value = await Promise.race([promise, cancellation]); check(); return value; },
    launch: (...args) => {
      check();
      const record = launchProcess(...args);
      records.push({ ...record, identities: new Map() });
      return record;
    },
    dispose: () => { clearInterval(timer); signals.removeListener("SIGINT", onSignal); signals.removeListener("SIGTERM", onSignal); },
  };
}
export async function ensureNormalServer(env, scope, { isListening = listening, verify = verifyNormalServer } = {}) {
  if (await scope.wait(isListening())) { await scope.wait(verify()); return; }
  const clean = { ...env }; delete clean.GG_CHAT_DESIGN_PREVIEW; delete clean.TAURI_DEV_HOST;
  const { child, exited } = scope.launch(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm --filter gg-app dev --host 127.0.0.1"], { env: clean });
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    scope.check();
    if (child.exitCode !== null) throw new Error(`Vite exited ${await scope.wait(exited)}`);
    if (await scope.wait(isListening())) { await scope.wait(verify()); ready = true; break; }
    await scope.wait(new Promise(done => setTimeout(done, 150)));
  }
  if (!ready) throw new Error("Normal app Vite did not become ready on port 1420");
  await scope.wait(scope.sample());
}
function checkedBuildPath(checkout, path) {
  const local = relative(checkout, path);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error(`Build input outside checkout: ${path}`);
  let current = checkout;
  for (const part of local.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Unexpected symlink in build inputs: ${current}`);
  }
  return path;
}
function frameworkInputs(checkout) {
  const inputs = [join(checkout, "pnpm-lock.yaml")];
  const seen = new Set(), visiting = new Set();
  function config(path) {
    path = checkedBuildPath(checkout, resolve(path));
    if (visiting.has(path)) throw new Error(`Circular build config extends: ${path}`);
    if (seen.has(path)) return;
    visiting.add(path); inputs.push(path);
    const parsed = ts.parseConfigFileTextToJson(path.split(sep).join("/"), readFileSync(path, "utf8"));
    if (parsed.error) throw new Error(`Invalid build config: ${path}`);
    const bases = parsed.config.extends;
    for (const base of bases === undefined ? [] : Array.isArray(bases) ? bases : [bases]) {
      // Only repository-local configs are supported; never execute bundler configs
      // or resolve package-based extends/outside-checkout config paths.
      if (typeof base !== "string" || !base.startsWith(".")) throw new Error(`Unsupported build config extends in ${path}`);
      let parent = resolve(dirname(path), base);
      if (!parent.endsWith(".json") && !existsSync(parent)) parent += ".json";
      config(parent);
    }
    visiting.delete(path); seen.add(path);
  }
  // Actual build scripts: three tsup builds, then ggcoder's tsc -p tsconfig.build.json.
  // Keep this small explicit set aligned with those scripts, not the whole checkout.
  for (const name of packages) {
    const base = join(checkout, "packages", name);
    inputs.push(join(base, "src"), join(base, "package.json"));
    if (name !== "ggcoder") inputs.push(join(base, "tsup.config.ts"));
    config(join(base, name === "ggcoder" ? "tsconfig.build.json" : "tsconfig.json"));
  }
  return inputs;
}
function treeDigest(paths, checkout = root) {
  const hash = createHash("sha256");
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in build inputs: ${path}`);
    if (stat.isDirectory()) {
      hash.update(JSON.stringify(["directory", relative(checkout, path)]));
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      const content = readFileSync(path);
      hash.update(JSON.stringify(["file", relative(checkout, path), content.length])).update(content);
    } else throw new Error(`Unexpected build input type: ${path}`);
  }
  for (const path of paths) visit(checkedBuildPath(checkout, path));
  return hash.digest("hex");
}
export async function ensureFramework(env, scope, { checkout = root, stamp = join(evidenceRoot, "framework-build.json") } = {}) {
  const sources = frameworkInputs(checkout);
  const outputs = packages.map(name => join(checkout, "packages", name, "dist"));
  const source = treeDigest(sources, checkout);
  try { const saved = JSON.parse(readFileSync(stamp, "utf8")); if (saved.source === source && saved.output === treeDigest(outputs, checkout)) return; } catch { /* Missing or stale output needs a dependency-ordered local build. */ }
  for (const name of packages) {
    const { exited } = scope.launch(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm --filter @kenkaiiii/${name} build`], { env, cwd: checkout });
    const code = await scope.wait(exited); if (code !== 0) throw new Error(`${name} build failed (${code})`);
  }
  writeFileSync(stamp, JSON.stringify({ source, output: treeDigest(outputs, checkout) }, null, 2));
}
export async function ensureAppearanceDebugBuild(env, config, scope) {
  // Cargo owns freshness checks: no cache deletion, framework build, or readiness deadline.
  const nativeBuild = scope.launch("cargo", ["build", "--no-default-features", "--offline"], {
    cwd: join(appDir, "src-tauri"),
    env: { ...env, CARGO_NET_OFFLINE: "true", TAURI_CONFIG: JSON.stringify(config) },
  });
  const code = await scope.wait(nativeBuild.exited);
  if (code !== 0) throw new Error(`Appearance debug build failed (${code}); native readiness was not started`);
}

export async function runAppearanceDev() {
  if (process.platform !== "win32") throw new Error("This reviewed launcher currently supports Windows only");
  if (process.argv.slice(2).length) throw new Error("appearance-dev takes no arguments; it never accepts a production profile");
  for (const path of ["gg-app/node_modules/@tauri-apps/cli/tauri.js", "node_modules", "gg-app/src-tauri/tauri.local.conf.json"]) {
    if (!existsSync(join(root, path))) throw new Error(`Missing prerequisite: ${path}; no installation attempted`);
  }
  const config = JSON.parse(readFileSync(join(appDir, "src-tauri/tauri.local.conf.json"), "utf8"));
  if (config.identifier !== "com.ggcoder.local-fork" || config.bundle?.createUpdaterArtifacts !== false) throw new Error("Local Fork identity/updater configuration mismatch");
  // Inspect before doing any build or starting another listener.
  if (await listening()) await verifyNormalServer();
  mkdirSync(evidenceRoot, { recursive: true });
  const paths = createIsolatedProfile(mkdtempSync(join(evidenceRoot, "visible-profile-")));
  const env = appearanceEnvironment(process.env, paths);
  mkdirSync(join(paths.home, ".gg"), { recursive: true });
  writeFileSync(join(paths.home, ".gg/auth.json"), "{}\n", { flag: "wx" });
  writeFileSync(join(paths.home, ".gg/gg-app.json"), JSON.stringify({ projectsRoot: paths.project }), { flag: "wx" });
  await runAppearanceSession(env, paths, config);
}

// Internal dependency seams keep lifecycle tests away from builds and installed apps.
export async function runAppearanceSession(env, paths, config, options = {}) {
  const scope = createAppearanceScope(options);
  try {
    await scope.wait((options.ensureFramework ?? ensureFramework)(env, scope));
    // Finite builds have no deadline; only explicit cancellation stops them.
    const debugConfig = { ...config, build: { beforeDevCommand: "" } };
    await ensureAppearanceDebugBuild(env, debugConfig, scope);
    await ensureNormalServer(env, scope, options);
    scope.check();
    // Drain acquisition even on cancellation so a late reservation is always released.
    const reservation = await (options.reservePort ?? reserveHeldTcpPort)();
    const port = reservation.port;
    try { scope.check(); } finally { await reservation.release(); }
    scope.check();
    const devConfig = join(paths.audit, "dev-config.json");
    writeFileSync(devConfig, JSON.stringify({ ...config, build: { beforeDevCommand: "" } }));
    // The guard disables the debug orphan sweep, not real Rust IPC or the real daemon.
    const nativeEnv = appearanceNativeEnvironment(env, port);
    const app = scope.launch(process.execPath, [join(appDir, "node_modules/@tauri-apps/cli/tauri.js"), "dev", "--no-watch", "--config", devConfig], { cwd: appDir, env: nativeEnv });
    await scope.wait(scope.sample());
    writeFileSync(join(evidenceRoot, "visible-session.json"), JSON.stringify({ boundary: "Isolated visible native developer app with real workspace sidecar; no credentials seeded or prompts sent", profile: paths.root, cdpPort: port, pid: app.child.pid, checkout: checkoutIdentity() }, null, 2));
    console.log(`Appearance developer session starting; profile: ${paths.root}`);
    const deadline = Date.now() + 120000;
    let ready = false;
    while (Date.now() < deadline) {
      scope.check();
      if (app.child.exitCode !== null) throw new Error(`Developer app exited before readiness (${await scope.wait(app.exited)})`);
      try {
        const response = await scope.wait(fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }));
        const targets = await scope.wait(response.json());
        if (targets.some(target => target.type === "page" && /^http:\/\/(localhost|127\.0\.0\.1):1420\/$/.test(target.url))) { ready = true; break; }
      } catch (error) { if (scope.isCancellation(error)) throw error; /* WebView2 is not listening yet. */ }
      await scope.wait(new Promise(done => setTimeout(done, 150)));
    }
    if (!ready) throw new Error("Native appearance WebView did not become ready within 120 seconds");
    await scope.wait(scope.sample());
    console.log(`Visible appearance developer app ready; CDP ${port}; close the developer app to finish`);
    const code = await scope.wait(app.exited);
    if (code !== 0) throw new Error(`Developer app exited ${code}`);
  } catch (error) {
    if (!scope.isCancellation(error)) throw error;
  } finally {
    try { await scope.close(); } finally { scope.dispose(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAppearanceDev().catch(error => { console.error(error.message); process.exitCode = 1; });
}
