// Windows native smoke test for the repo-built, packaged Tauri debug app.
// The harness builds through `tauri build`, which consumes `build.frontendDist`,
// then owns one app process tree and one unique WebView2 profile. An installed
// GG Coder instance must remain open throughout to prove window isolation.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const tauriConfigPath = join(appDir, "src-tauri", "tauri.conf.json");
const debugExe = join(appDir, "src-tauri", "target", "debug", "gg-app.exe");
const artifactDir = join(appDir, "src-tauri", "target", "smoke-artifacts");
const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const buildCommand = "pnpm exec tauri build --debug --no-bundle";

let appPid;
let profileDir;
let smokeSessionId;
let daemonPort;
let webviewPid;
let daemonPid;
let stdout = "";
let stderr = "";
let screenshotPath;
let logPath;

function pass(label, detail) {
  console.log(`ASSERT PASS: ${label} — ${detail}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function powershell(script, options = {}) {
  const quietScript = `$ProgressPreference = "SilentlyContinue"\n${script}`;
  const encoded = Buffer.from(quietScript, "utf16le").toString("base64");
  return execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true, ...options },
  ).trim();
}

function asArray(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeExecutablePath(path) {
  return realpathSync.native(resolve(path)).replaceAll("/", "\\").toLowerCase();
}

function processSnapshot() {
  const output = powershell(`
    Get-CimInstance Win32_Process |
      Where-Object { $_.Name -in @('gg-app.exe', 'ggnode.exe', 'node.exe', 'msedgewebview2.exe') } |
      Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine |
      ConvertTo-Json -Compress
  `);
  return asArray(output ? JSON.parse(output) : []);
}

async function waitFor(description, probe, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  fail(`${description} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

function tauriWindows() {
  const output = powershell(`
    Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SmokeWindows {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int maxCount);
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
    $items = [System.Collections.Generic.List[object]]::new()
    [SmokeWindows]::EnumWindows({
      param($hwnd, $unused)
      if ([SmokeWindows]::IsWindowVisible($hwnd)) {
        $className = New-Object System.Text.StringBuilder 256
        [void][SmokeWindows]::GetClassName($hwnd, $className, $className.Capacity)
        if ($className.ToString() -eq 'Tauri Window') {
          [uint32]$owner = 0
          [void][SmokeWindows]::GetWindowThreadProcessId($hwnd, [ref]$owner)
          $rect = New-Object SmokeWindows+Rect
          if ([SmokeWindows]::GetWindowRect($hwnd, [ref]$rect)) {
            $title = New-Object System.Text.StringBuilder 512
            [void][SmokeWindows]::GetWindowText($hwnd, $title, $title.Capacity)
            $items.Add([pscustomobject]@{
              Handle = $hwnd.ToInt64()
              ProcessId = $owner
              ClassName = $className.ToString()
              Title = $title.ToString()
              Width = $rect.Right - $rect.Left
              Height = $rect.Bottom - $rect.Top
            })
          }
        }
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    $items | ConvertTo-Json -Compress
  `);
  return asArray(output ? JSON.parse(output) : []);
}

function captureWindow(window, outputPath) {
  const pathLiteral = outputPath.replaceAll("'", "''");
  powershell(`
    Add-Type -AssemblyName System.Drawing
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SmokeCapture {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@
    $hwnd = [IntPtr]::new([int64]${window.Handle})
    if (-not [SmokeCapture]::IsWindow($hwnd)) { throw 'captured HWND is no longer valid' }
    [void][SmokeCapture]::ShowWindow($hwnd, 9)
    [void][SmokeCapture]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 750
    $bitmap = New-Object System.Drawing.Bitmap ${window.Width}, ${window.Height}
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
      if (-not [SmokeCapture]::PrintWindow($hwnd, $hdc, 2)) {
        throw 'PrintWindow failed for the repo HWND'
      }
    } finally {
      $graphics.ReleaseHdc($hdc)
      $graphics.Dispose()
    }
    try {
      $bitmap.Save('${pathLiteral}', [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $bitmap.Dispose()
    }
  `);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeProfile() {
  if (!profileDir) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      if (!existsSync(profileDir)) return;
    } catch {
      // WebView2 can retain file handles briefly after its parent exits.
    }
    await sleep(250);
  }
  fail(`could not remove temporary WebView2 profile: ${profileDir}`);
}

async function main() {
  if (process.platform !== "win32") fail("this smoke test only runs on Windows");
  profileDir = mkdtempSync(join(tmpdir(), "gg-app-smoke-webview2-"));

  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const frontendDist = resolve(appDir, "src-tauri", tauriConfig.build?.frontendDist ?? "");
  if (!tauriConfig.build?.frontendDist) fail("tauri config has no build.frontendDist");
  console.log(`BUILD: ${buildCommand}`);
  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", buildCommand], {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });
  if (!existsSync(join(frontendDist, "index.html"))) {
    fail(`tauri build did not produce frontendDist/index.html: ${frontendDist}`);
  }
  if (!existsSync(debugExe)) fail(`packaged debug executable not found: ${debugExe}`);
  const normalizedDebugExe = normalizeExecutablePath(debugExe);
  pass(
    "packaged frontendDist build",
    `frontendDist=${frontendDist} executable=${normalizedDebugExe}`,
  );

  mkdirSync(artifactDir, { recursive: true });
  const before = processSnapshot();
  const beforeRepoPids = new Set(
    before
      .filter(
        (entry) =>
          entry.ExecutablePath &&
          normalizeExecutablePath(entry.ExecutablePath) === normalizedDebugExe,
      )
      .map((entry) => entry.ProcessId),
  );
  const installedApps = before.filter(
    (entry) =>
      entry.Name?.toLowerCase() === "gg-app.exe" &&
      entry.ExecutablePath &&
      normalizeExecutablePath(entry.ExecutablePath) !== normalizedDebugExe,
  );
  if (installedApps.length === 0) {
    fail("no concurrently installed gg-app.exe was open before the smoke");
  }
  pass(
    "installed app open before launch",
    installedApps.map((entry) => `pid=${entry.ProcessId} path=${entry.ExecutablePath}`).join(", "),
  );

  const child = spawn(debugExe, [], {
    cwd: appDir,
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profileDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  appPid = child.pid;
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const repoProcess = await waitFor("new packaged repo debug process", () => {
    const fresh = processSnapshot().filter(
      (entry) =>
        entry.ExecutablePath &&
        normalizeExecutablePath(entry.ExecutablePath) === normalizedDebugExe &&
        !beforeRepoPids.has(entry.ProcessId),
    );
    return fresh.find((entry) => entry.ProcessId === child.pid) ?? null;
  });
  appPid = repoProcess.ProcessId;
  const normalizedSpawnedPath = normalizeExecutablePath(repoProcess.ExecutablePath);
  if (appPid !== child.pid) fail(`spawn PID mismatch: child=${child.pid} process=${appPid}`);
  if (normalizedSpawnedPath !== normalizedDebugExe) {
    fail(
      `spawn executable mismatch: expected=${normalizedDebugExe} actual=${normalizedSpawnedPath}`,
    );
  }
  pass("spawn identity", `pid=${appPid} executable=${normalizedSpawnedPath}`);

  const eligibleWindows = await waitFor(
    "exactly one eligible repo Tauri Window",
    () => {
      const windows = tauriWindows().filter(
        (window) =>
          window.ProcessId === appPid &&
          window.Title === "Supah Coder" &&
          window.Width >= 480 &&
          window.Height >= 360,
      );
      return windows.length === 1 ? windows : null;
    },
    60000,
  );
  const [visibleWindow] = eligibleWindows;
  const windowProcess = processSnapshot().find(
    (entry) => entry.ProcessId === visibleWindow.ProcessId,
  );
  if (!windowProcess?.ExecutablePath) fail(`HWND ${visibleWindow.Handle} has no executable path`);
  const normalizedWindowPath = normalizeExecutablePath(windowProcess.ExecutablePath);
  if (visibleWindow.ProcessId !== child.pid) {
    fail(`HWND PID mismatch: child=${child.pid} window=${visibleWindow.ProcessId}`);
  }
  if (normalizedWindowPath !== normalizedDebugExe) {
    fail(`HWND executable mismatch: expected=${normalizedDebugExe} actual=${normalizedWindowPath}`);
  }
  pass(
    "exactly one eligible Tauri Window",
    `count=1 hwnd=${visibleWindow.Handle} pid=${visibleWindow.ProcessId} executable=${normalizedWindowPath} size=${visibleWindow.Width}x${visibleWindow.Height} title=${JSON.stringify(visibleWindow.Title)}`,
  );

  const webview = await waitFor("WebView2 process using isolated profile", () => {
    const normalizedProfile = profileDir.toLowerCase();
    return processSnapshot().find(
      (entry) =>
        entry.Name?.toLowerCase() === "msedgewebview2.exe" &&
        entry.ParentProcessId === appPid &&
        entry.CommandLine?.toLowerCase().includes(normalizedProfile),
    );
  });
  webviewPid = webview.ProcessId;
  pass(
    "WebView2 evidence",
    `pid=${webview.ProcessId} parent=${webview.ParentProcessId} profile=${profileDir}`,
  );

  const daemon = await waitFor("repo daemon child", () =>
    processSnapshot().find(
      (entry) =>
        ["ggnode.exe", "node.exe"].includes(entry.Name?.toLowerCase()) &&
        entry.ParentProcessId === appPid &&
        entry.CommandLine?.toLowerCase().includes("app-sidecar"),
    ),
  );
  daemonPid = daemon.ProcessId;
  pass(
    "daemon process evidence",
    `pid=${daemon.ProcessId} parent=${daemon.ParentProcessId} command=${daemon.CommandLine}`,
  );

  daemonPort = await waitFor(
    "daemon listening evidence",
    () => Number(stdout.match(/daemon listening on port (\d+)/)?.[1]) || null,
    120000,
  );
  pass("daemon listening evidence", `http://127.0.0.1:${daemonPort}`);

  const createResponse = await fetch(`http://127.0.0.1:${daemonPort}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: resolve(here, "..", "..") }),
    signal: AbortSignal.timeout(120000),
  });
  if (!createResponse.ok) {
    fail(`POST /session returned ${createResponse.status}: ${await createResponse.text()}`);
  }
  smokeSessionId = (await createResponse.json()).sessionId;
  if (!smokeSessionId) fail("POST /session returned no sessionId");
  pass("session creation evidence", `session=${smokeSessionId}`);

  const stateResponse = await fetch(`http://127.0.0.1:${daemonPort}/state`, {
    headers: { "x-gg-session": smokeSessionId },
    signal: AbortSignal.timeout(30000),
  });
  if (!stateResponse.ok) fail(`GET /state returned ${stateResponse.status}`);
  const state = await stateResponse.json();
  if (!("ready" in state)) fail(`GET /state omitted ready: ${JSON.stringify(state)}`);
  pass("session state evidence", `status=200 ready=${state.ready}`);

  screenshotPath = join(artifactDir, `windows-native-smoke-${runStamp}-pid-${appPid}.png`);
  captureWindow(visibleWindow, screenshotPath);
  if (!existsSync(screenshotPath)) fail(`screenshot was not created: ${screenshotPath}`);
  pass("HWND screenshot captured with PrintWindow", screenshotPath);
  console.log(`ARTIFACT: screenshot=${screenshotPath}`);

  if (installedApps.length > 0) {
    const liveInstalled = installedApps.filter((entry) => processExists(entry.ProcessId));
    if (liveInstalled.length !== installedApps.length) {
      fail("a concurrently installed GG Coder process exited during the smoke");
    }
    pass(
      "installed app remains open",
      liveInstalled
        .map((entry) => `pid=${entry.ProcessId} path=${entry.ExecutablePath}`)
        .join(", "),
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(`SMOKE FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (smokeSessionId && daemonPort) {
    await fetch(`http://127.0.0.1:${daemonPort}/session/${encodeURIComponent(smokeSessionId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  if (appPid && processExists(appPid)) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(appPid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      if (processExists(appPid)) process.exitCode = 1;
    }
  }
  if (appPid) {
    const ownedPids = [appPid, daemonPid, webviewPid].filter(Boolean);
    await waitFor(
      "owned repo process tree cleanup",
      () => ownedPids.every((pid) => !processExists(pid)),
      15000,
    )
      .then(() => pass("owned process tree cleaned", `root pid=${appPid}`))
      .catch((error) => {
        console.error(`CLEANUP FAIL: ${error.message}`);
        process.exitCode = 1;
      });
  }

  await removeProfile().catch((error) => {
    console.error(`CLEANUP FAIL: ${error.message}`);
    process.exitCode = 1;
  });
  if (profileDir && !existsSync(profileDir)) pass("temporary profile cleaned", profileDir);

  if (appPid) {
    logPath = join(artifactDir, `windows-native-smoke-${runStamp}-pid-${appPid}.log`);
    writeFileSync(logPath, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    console.log(`ARTIFACT: process-log=${logPath}`);
  }
}

if (!process.exitCode) console.log("SMOKE PASS");
