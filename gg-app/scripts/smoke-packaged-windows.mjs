// Release-only Windows smoke: build an MSI, administratively extract it into
// temporary directories, launch the extracted app, and prove the packaged
// WebView shell, bundled Node sidecar, pane-scoped IPC, SSE reset, Phase 20
// fresh-session ordering, and Phase 21 Start/Resume restoration together.
// Fault scenarios use deterministic sidecar fixtures through the shell's
// supported GG_SIDECAR_PATH override.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  preparePhase20Scenario,
  reserveTcpPort,
  runPhase20Scenario,
} from "./phase-20-native-smoke.mjs";
import { preparePhase21Scenario, runPhase21Scenario } from "./phase-21-native-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const bundleDir = join(appDir, "src-tauri", "target", "release", "bundle", "msi");
const require = createRequire(import.meta.url);
const tauriCli = join(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
const PACKAGED_BUILD_ARGS = [
  tauriCli,
  "build",
  "--ci",
  "--bundles",
  "msi",
  "--features",
  "native-smoke",
  "--config",
  JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
];

function fail(message) {
  throw new Error(message);
}

class StopWaitingError extends Error {}

function normalizePath(path) {
  const absolute = resolve(path);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // Process command lines can contain paths that disappeared between snapshots.
  }
  return canonical.replaceAll("/", "\\").toLowerCase();
}

function normalizeEvidence(value) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

export function snapshotMsiArtifacts(root) {
  return new Map(
    walkFiles(root)
      .filter((path) => extname(path).toLowerCase() === ".msi")
      .map((path) => {
        const stat = statSync(path);
        return [normalizePath(path), { path, size: stat.size, mtimeMs: stat.mtimeMs }];
      }),
  );
}

export function discoverChangedMsi(before, after) {
  const changed = [...after.values()].filter((artifact) => {
    const previous = before.get(normalizePath(artifact.path));
    return !previous || previous.size !== artifact.size || previous.mtimeMs !== artifact.mtimeMs;
  });
  if (changed.length !== 1) {
    fail(
      `expected one newly built MSI, found ${changed.length}: ${changed.map((item) => item.path).join(", ") || "none"}`,
    );
  }
  return changed[0].path;
}

function findNamedFiles(root, expectedName) {
  const lowerName = expectedName.toLowerCase();
  return walkFiles(root).filter((path) => basename(path).toLowerCase() === lowerName);
}

export function discoverPackagedLayout(extractRoot) {
  const apps = findNamedFiles(extractRoot, "gg-app.exe");
  if (apps.length !== 1) fail(`expected one extracted gg-app.exe, found ${apps.length}`);
  const executable = realpathSync.native(apps[0]);
  const installDir = dirname(executable);
  const node = join(installDir, "ggnode.exe");
  const sidecar = join(installDir, "sidecar", "app-sidecar.mjs");
  if (!existsSync(node)) fail(`packaged Node runtime missing beside app: ${node}`);
  if (!existsSync(sidecar)) fail(`packaged sidecar resource missing: ${sidecar}`);
  return {
    executable,
    installDir,
    node: realpathSync.native(node),
    sidecar: realpathSync.native(sidecar),
  };
}

export async function waitFor(description, probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      if (error instanceof StopWaitingError) throw error;
      lastError = error;
    }
    await sleep(intervalMs);
  }
  fail(`${description} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

function powershell(script) {
  const encoded = Buffer.from(
    `$ErrorActionPreference = "Stop"\n$ProgressPreference = "SilentlyContinue"\n${script}`,
    "utf16le",
  ).toString("base64");
  return execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function asArray(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function processSnapshot() {
  const output = powershell(`
    Get-CimInstance Win32_Process |
      Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine |
      ConvertTo-Json -Compress
  `);
  return asArray(output ? JSON.parse(output) : []);
}

function visibleWindowPids() {
  const output = powershell(`
    Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PackagedSmokeWindows {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}
'@
    $owners = [System.Collections.Generic.HashSet[uint32]]::new()
    [PackagedSmokeWindows]::EnumWindows({
      param($hwnd, $unused)
      if ([PackagedSmokeWindows]::IsWindowVisible($hwnd)) {
        [uint32]$owner = 0
        [void][PackagedSmokeWindows]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        [void]$owners.Add($owner)
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    $owners | ConvertTo-Json -Compress
  `);
  return new Set(asArray(output ? JSON.parse(output) : []).map(Number));
}

export function collectOwnedProcessIds(processes, rootPid, ownedRoots) {
  // Never trust a bare PID after the launched process exits: Windows can reuse
  // it. Ownership starts from the expected PID plus temporary-path evidence.
  const owned = new Set();
  const normalizedRoots = ownedRoots.flatMap((root) => [
    normalizeEvidence(root),
    normalizePath(root),
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      const pathEvidence = [process.ExecutablePath, process.CommandLine]
        .filter((value) => typeof value === "string")
        .some((value) => normalizedRoots.some((root) => normalizeEvidence(value).includes(root)));
      const isVerifiedRoot = process.ProcessId === rootPid && pathEvidence;
      if (isVerifiedRoot || owned.has(process.ParentProcessId) || pathEvidence) {
        if (!owned.has(process.ProcessId)) changed = true;
        owned.add(process.ProcessId);
      }
    }
  }
  return [...owned].filter((pid) => Number.isInteger(pid) && pid > 0);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function removeTemporaryDirectory(directory, options = {}) {
  const remove = options.remove ?? (() => rmSync(directory, { recursive: true, force: true }));
  const exists = options.exists ?? (() => existsSync(directory));
  const sleep =
    options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const attempts = options.attempts ?? 40;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      remove();
      if (!exists()) return;
    } catch {
      // WebView2 can retain profile handles briefly after its process exits.
    }
    await sleep(250);
  }
  fail(`temporary packaged smoke directory survived: ${directory}`);
}

export async function cleanupOwnedProcesses(options) {
  const snapshot = options.snapshot ?? processSnapshot;
  const kill =
    options.kill ??
    ((pid) => {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        // A process can exit between the snapshot and taskkill.
      }
    });
  const exists = options.exists ?? processExists;
  const timeoutMs = options.timeoutMs ?? 15000;
  const startedAt = Date.now();
  let lastOwned = [];
  while (true) {
    lastOwned = collectOwnedProcessIds(
      await snapshot(),
      options.rootPid,
      options.ownedRoots,
    ).filter(exists);
    if (lastOwned.length === 0) return;
    if (Date.now() - startedAt >= timeoutMs) {
      fail(`packaged smoke processes survived cleanup: ${lastOwned.join(", ")}`);
    }
    // Kill children before parents; taskkill /T adds protection against races.
    for (const pid of lastOwned.toReversed()) await kill(pid);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

function isolatedEnvironment(root, projectDir) {
  const home = join(root, "home");
  // SHGetKnownFolderPath requires the conventional profile-relative layout;
  // arbitrary APPDATA paths can make Tauri's log plugin fail with UnknownPath.
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  const temp = join(root, "temp");
  const webview = join(root, "webview2");
  for (const directory of [home, appData, localAppData, temp, webview, projectDir]) {
    mkdirSync(directory, { recursive: true });
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    WEBVIEW2_USER_DATA_FOLDER: webview,
    GG_APP_CWD: projectDir,
  };
  delete env.GG_NODE_BIN;
  delete env.GG_SIDECAR_PATH;
  delete env.GG_APP_WORKSPACE_PATH;
  return env;
}

function extractMsi(msi, extractRoot, logPath) {
  mkdirSync(extractRoot, { recursive: true });
  execFileSync("msiexec.exe", ["/a", msi, "/qn", `TARGETDIR=${extractRoot}`, "/L*v", logPath], {
    stdio: "inherit",
    windowsHide: true,
  });
}

async function main() {
  if (process.platform !== "win32") fail("packaged launch smoke only supports Windows");
  const smokeRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "gg-app-packaged-smoke-")));
  const extractRoot = join(smokeRoot, "package");
  const msiLog = join(smokeRoot, "msi-extract.log");
  const fixtureSidecar = join(here, "phase-20-sidecar-fixture.mjs");
  const phase21FixtureSidecar = join(here, "phase-21-sidecar-fixture.mjs");
  const evidenceArgument = process.argv.indexOf("--evidence-dir");
  const evidenceDir =
    evidenceArgument >= 0
      ? resolve(process.argv[evidenceArgument + 1] || fail("--evidence-dir requires a path"))
      : join(appDir, "src-tauri", "target", "smoke-evidence", "phase-20-native");
  const phase21EvidenceArgument = process.argv.indexOf("--phase21-evidence-dir");
  const phase21EvidenceDir =
    phase21EvidenceArgument >= 0
      ? resolve(
          process.argv[phase21EvidenceArgument + 1] ||
            fail("--phase21-evidence-dir requires a path"),
        )
      : join(appDir, "src-tauri", "target", "smoke-evidence", "phase-21-native");
  const scenarioEvidence = [];
  let phase21Evidence = null;

  try {
    const packageArgument = process.argv.indexOf("--package-dir");
    const artifactArgument = process.argv.indexOf("--artifact");
    let msi = null;
    let layout;
    if (packageArgument >= 0) {
      const packagePath = process.argv[packageArgument + 1];
      if (!packagePath) fail("--package-dir requires an extracted package path");
      layout = discoverPackagedLayout(resolve(packagePath));
      console.log(`PACKAGE: existing extraction -> ${layout.installDir}`);
    } else {
      if (artifactArgument >= 0) {
        const artifactPath = process.argv[artifactArgument + 1];
        if (!artifactPath) fail("--artifact requires an MSI path");
        msi = resolve(artifactPath);
        if (!existsSync(msi) || extname(msi).toLowerCase() !== ".msi") {
          fail(`packaged smoke MSI does not exist: ${msi}`);
        }
      } else {
        const before = snapshotMsiArtifacts(bundleDir);
        console.log(`BUILD: ${process.execPath} ${PACKAGED_BUILD_ARGS.join(" ")}`);
        execFileSync(process.execPath, PACKAGED_BUILD_ARGS, {
          cwd: appDir,
          env: process.env,
          stdio: "inherit",
          windowsHide: false,
        });
        msi = discoverChangedMsi(before, snapshotMsiArtifacts(bundleDir));
      }
      extractMsi(msi, extractRoot, msiLog);
      layout = discoverPackagedLayout(extractRoot);
      console.log(`PACKAGE: ${relative(appDir, msi)} -> ${layout.installDir}`);
    }

    for (const scenario of ["success", "reject-409", "drop-reset"]) {
      const scenarioRoot = join(smokeRoot, scenario);
      const projectDir = join(scenarioRoot, "project");
      const env = isolatedEnvironment(scenarioRoot, projectDir);
      const { sessionPath } = preparePhase20Scenario({ home: env.HOME, projectDir, scenario });
      const cdpPort = await reserveTcpPort();
      const sidecarAuditPath =
        scenario === "success"
          ? join(env.HOME, ".gg", "gg-app-sidecar.log")
          : join(scenarioRoot, "sidecar-audit.jsonl");
      env.GG_APP_NATIVE_SMOKE_CDP_PORT = String(cdpPort);
      if (scenario !== "success") {
        env.GG_SIDECAR_PATH = fixtureSidecar;
        env.GG_PHASE20_SMOKE_SCENARIO = scenario;
        env.GG_PHASE20_SMOKE_AUDIT_FILE = sidecarAuditPath;
      }
      const expectedSidecar = scenario === "success" ? layout.sidecar : fixtureSidecar;
      let appPid;
      let scenarioError;
      try {
        const child = spawn(layout.executable, [], {
          cwd: projectDir,
          env,
          // Inherited pipe handles can be retained by WebView2 descendants and keep
          // this runner alive after the owned process tree has been terminated.
          stdio: "ignore",
          windowsHide: false,
        });
        appPid = child.pid;
        await waitFor(`${scenario} packaged app window and sidecar`, () => {
          if (!processExists(appPid)) throw new StopWaitingError("packaged app exited early");
          const processes = processSnapshot();
          const app = processes.find(
            (process) =>
              process.ProcessId === appPid &&
              process.ExecutablePath &&
              normalizePath(process.ExecutablePath) === normalizePath(layout.executable),
          );
          const node = processes.find(
            (process) =>
              process.ParentProcessId === appPid &&
              process.ExecutablePath &&
              normalizePath(process.ExecutablePath) === normalizePath(layout.node) &&
              normalizeEvidence(process.CommandLine ?? "").includes(
                normalizeEvidence(expectedSidecar),
              ),
          );
          return app && node && visibleWindowPids().has(appPid);
        });
        const evidence = await runPhase20Scenario({
          scenario,
          cdpPort,
          waitFor,
          evidenceDir,
          projectDir,
          sessionPath,
          sidecarAuditPath,
        });
        scenarioEvidence.push({
          scenario,
          appPid,
          eventOrder: evidence.sequence.map((entry) => `${entry.sequence}:${entry.type}`),
        });
        console.log(
          `PHASE20 ${scenario.toUpperCase()} PASS: ${JSON.stringify(scenarioEvidence.at(-1))}`,
        );
      } catch (error) {
        scenarioError = error;
      } finally {
        try {
          if (appPid) {
            await cleanupOwnedProcesses({
              rootPid: appPid,
              ownedRoots: [scenarioRoot, layout.installDir],
            });
          }
        } catch (cleanupError) {
          scenarioError = scenarioError
            ? new AggregateError(
                [scenarioError, cleanupError],
                `${scenario} smoke and process cleanup failed`,
              )
            : cleanupError;
        }
      }
      if (scenarioError) throw scenarioError;
    }

    const phase21Root = join(smokeRoot, "phase-21-start-resume");
    const phase21ProjectDir = join(phase21Root, "project");
    const phase21Env = isolatedEnvironment(phase21Root, phase21ProjectDir);
    const { initialSessionPath, boundSessionPath } = preparePhase21Scenario({
      home: phase21Env.HOME,
      projectDir: phase21ProjectDir,
    });
    const phase21AuditPath = join(phase21Root, "sidecar-audit.jsonl");
    const phase21NativeAuditPath = join(phase21Root, "native-audit.jsonl");
    const phase21CdpPort = await reserveTcpPort();
    phase21Env.GG_APP_NATIVE_SMOKE_CDP_PORT = String(phase21CdpPort);
    phase21Env.GG_SIDECAR_PATH = phase21FixtureSidecar;
    phase21Env.GG_PHASE21_SMOKE_AUDIT_FILE = phase21AuditPath;
    phase21Env.GG_PHASE21_NATIVE_SMOKE_AUDIT_FILE = phase21NativeAuditPath;
    let phase21AppPid;
    let phase21Error;
    try {
      const child = spawn(layout.executable, [], {
        cwd: phase21ProjectDir,
        env: phase21Env,
        stdio: "ignore",
        windowsHide: false,
      });
      phase21AppPid = child.pid;
      await waitFor("Phase 21 packaged app window and fixture sidecar", () => {
        if (!processExists(phase21AppPid)) {
          throw new StopWaitingError("packaged app exited early");
        }
        const processes = processSnapshot();
        const app = processes.find(
          (candidate) =>
            candidate.ProcessId === phase21AppPid &&
            candidate.ExecutablePath &&
            normalizePath(candidate.ExecutablePath) === normalizePath(layout.executable),
        );
        const node = processes.find(
          (candidate) =>
            candidate.ParentProcessId === phase21AppPid &&
            candidate.ExecutablePath &&
            normalizePath(candidate.ExecutablePath) === normalizePath(layout.node) &&
            normalizeEvidence(candidate.CommandLine ?? "").includes(
              normalizeEvidence(phase21FixtureSidecar),
            ),
        );
        return app && node && visibleWindowPids().has(phase21AppPid);
      });
      const evidence = await runPhase21Scenario({
        cdpPort: phase21CdpPort,
        waitFor,
        evidenceDir: phase21EvidenceDir,
        projectDir: phase21ProjectDir,
        initialSessionPath,
        boundSessionPath,
        sidecarAuditPath: phase21AuditPath,
        nativeAuditPath: phase21NativeAuditPath,
      });
      phase21Evidence = {
        appPid: phase21AppPid,
        operationId: evidence.backend.prompts[0].operationId,
        boundSessionPath,
        eventOrder: evidence.sequence.map((entry) => `${entry.sequence}:${entry.type}`),
      };
      console.log(`PHASE21 START/RESUME PASS: ${JSON.stringify(phase21Evidence)}`);
    } catch (error) {
      phase21Error = error;
    } finally {
      try {
        if (phase21AppPid) {
          await cleanupOwnedProcesses({
            rootPid: phase21AppPid,
            ownedRoots: [phase21Root, layout.installDir],
          });
        }
      } catch (cleanupError) {
        phase21Error = phase21Error
          ? new AggregateError(
              [phase21Error, cleanupError],
              "Phase 21 smoke and process cleanup failed",
            )
          : cleanupError;
      }
    }
    if (phase21Error) throw phase21Error;

    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "summary.json"),
      `${JSON.stringify({ msi, packagedNode: layout.node, scenarios: scenarioEvidence }, null, 2)}\n`,
    );
    mkdirSync(phase21EvidenceDir, { recursive: true });
    writeFileSync(
      join(phase21EvidenceDir, "summary.json"),
      `${JSON.stringify({ msi, packagedNode: layout.node, scenario: phase21Evidence }, null, 2)}\n`,
    );
  } finally {
    await removeTemporaryDirectory(smokeRoot);
  }
  console.log(
    `SMOKE PASS: packagedNode phase20=3 phase21=1 evidence=${evidenceDir},${phase21EvidenceDir}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`SMOKE FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
