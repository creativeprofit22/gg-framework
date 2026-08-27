import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcher = join(import.meta.dirname, "launch-local-patched.ps1");
const fixtureRoots = [];

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fixture({ installed = "current", malformed = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gg-local-launcher-test-"));
  fixtureRoots.push(root);
  const localAppData = join(root, "local-app-data");
  const installDirectory = join(localAppData, "GG Coder Local Fork");
  const executablePath = join(installDirectory, "gg-coder-local-fork.exe");
  const artifactRoot = join(root, "artifacts");
  const installerPath = join(artifactRoot, "GG Coder Local Fork_test_x64-setup.exe");
  const payloadPath = join(artifactRoot, "gg-coder-local-fork.exe");
  const manifestPath = join(root, "latest-installer.json");
  const logPath = join(root, "launcher.log");
  const payload = Buffer.from("blessed-local-fork-payload");
  const installer = Buffer.from("guarded-local-fork-installer");
  mkdirSync(installDirectory, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(installerPath, installer);
  writeFileSync(payloadPath, payload);
  if (installed === "current") writeFileSync(executablePath, payload);
  if (installed === "stale") writeFileSync(executablePath, "stale-local-fork-payload");
  if (malformed) {
    writeFileSync(manifestPath, "{ definitely-not-json");
  } else {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          path: installerPath,
          size: installer.length,
          sha256: sha256(installer),
          identity: {
            productName: "GG Coder Local Fork",
            identifier: "com.ggcoder.local-fork",
            mainBinaryName: "gg-coder-local-fork",
            executableName: "gg-coder-local-fork.exe",
            installMode: "currentUser",
          },
          payload: {
            name: "gg-coder-local-fork.exe",
            size: payload.length,
            sha256: sha256(payload),
          },
        },
        null,
        2,
      ),
    );
  }
  return {
    root,
    localAppData,
    executablePath,
    artifactRoot,
    payloadPath,
    manifestPath,
    logPath,
    payloadHash: sha256(payload),
  };
}

function runScenario(
  files,
  {
    live = true,
    wrongPath = false,
    ambiguous = false,
    installerFailure = false,
    replaceDuringStability = false,
  } = {},
) {
  const wrongExecutable = join(files.root, "wrong", "gg-coder-local-fork.exe");
  const driver = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psLiteral(files.localAppData)}
. ${psLiteral(launcher)} -LibraryOnly
$script:MockLive = ${live ? "$true" : "$false"}
$script:MockExecutable = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'GG Coder Local Fork\\gg-coder-local-fork.exe'))
$script:InstallerCalls = 0
$script:InstallerAllowedRoot = $null
$script:StarterCalls = 0
$script:ProcessSamples = 0
function New-MockRoot([int]$ProcessId, [string]$Path) {
  $replacementTicks = if (${replaceDuringStability ? "$true" : "$false"} -and $script:ProcessSamples -ge 4) { 1 } else { 0 }
  [pscustomobject]@{ ProcessId = $ProcessId; ParentProcessId = 900; ExecutablePath = $Path; CreationTicks = 638000000000000000L + $ProcessId + $replacementTicks }
}
function Get-LocalForkRootProcesses {
  $script:ProcessSamples++
  if (${ambiguous ? "$true" : "$false"}) {
    return @((New-MockRoot 4101 $script:MockExecutable), (New-MockRoot 4102 $script:MockExecutable))
  }
  if (-not $script:MockLive) { return @() }
  $path = if (${wrongPath ? "$true" : "$false"}) { ${psLiteral(wrongExecutable)} } else { $script:MockExecutable }
  return @((New-MockRoot 4101 $path))
}
function Invoke-GuardedLocalForkInstaller {
  param([string]$ScriptPath, [string]$ManifestPath, [string]$AllowedRoot, [string]$InstallerLogPath, [string]$ExpectedVersion)
  $script:InstallerCalls++
  $script:InstallerAllowedRoot = $AllowedRoot
  if (${installerFailure ? "$true" : "$false"}) { throw 'fixture installer failure' }
  [pscustomobject]@{ TaskName = 'fixture-installer-task'; Status = 'started' }
}
function Start-CanonicalLocalFork([string]$ExecutablePath) {
  $script:StarterCalls++
  $script:MockLive = $true
  [pscustomobject]@{ Id = 4101 }
}
function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) }
try {
  $invokeParams = @{
    ManifestPath = ${psLiteral(files.manifestPath)}
    GuardedInstallerPath = ${psLiteral(join(import.meta.dirname, "install-local-patched.ps1"))}
    AllowedManifestRoot = ${psLiteral(files.root)}
    AllowedInstallerRoot = ${psLiteral(files.artifactRoot)}
    ExpectedExecutable = ${psLiteral(files.executablePath)}
    LauncherLogPath = ${psLiteral(files.logPath)}
    ExpectedVersion = '0.53.9'
  }
  $result = Invoke-CanonicalLocalForkLaunch @invokeParams
  [pscustomobject]@{ ok = $true; result = $result; installerCalls = $script:InstallerCalls; installerAllowedRoot = $script:InstallerAllowedRoot; starterCalls = $script:StarterCalls } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message; installerCalls = $script:InstallerCalls; installerAllowedRoot = $script:InstallerAllowedRoot; starterCalls = $script:StarterCalls } | ConvertTo-Json -Depth 6 -Compress
}
`;
  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", driver],
    { encoding: "utf8", windowsHide: true },
  );
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

function runTaskHandoff(
  files,
  { startFailure = false, expectedVersion = "0.53.9", scriptPath } = {},
) {
  const installerLogPath = join(files.root, "install logs", "guarded install.log");
  const driver = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psLiteral(files.localAppData)}
. ${psLiteral(launcher)} -LibraryOnly
$script:RegisterCalls = 0
$script:StartCalls = 0
$script:RemoveCalls = 0
$script:TriggerCalls = 0
$script:TriggerSupplied = $false
$script:CapturedTaskName = $null
$script:CapturedPowerShellPath = $null
$script:CapturedEncodedCommand = $null
function New-ScheduledTaskAction {
  param([string]$Execute, [string]$Argument)
  [pscustomobject]@{ Execute = $Execute; Argument = $Argument }
}
function New-ScheduledTaskPrincipal {
  param([string]$UserId, [object]$LogonType, [object]$RunLevel)
  [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}
function New-ScheduledTaskTrigger {
  param([switch]$Once, [datetime]$At)
  $script:TriggerCalls++
  [pscustomobject]@{ Once = $Once; At = $At }
}
function Register-ScheduledTask {
  param([string]$TaskName, [object]$Action, [object]$Principal, [string]$Description, [switch]$Force, [object]$Trigger)
  $script:RegisterCalls++
  $script:TriggerSupplied = $PSBoundParameters.ContainsKey('Trigger')
  $script:CapturedTaskName = $TaskName
  $script:CapturedPowerShellPath = $Action.Execute
  $script:CapturedEncodedCommand = ($Action.Argument -split ' ')[-1]
}
function Start-ScheduledTask {
  param([string]$TaskName)
  $script:StartCalls++
  if (${startFailure ? "$true" : "$false"}) { throw 'fixture task start failure' }
}
function Unregister-ScheduledTask {
  param([string]$TaskName, [switch]$Confirm)
  $script:RemoveCalls++
}
try {
  $invokeParams = @{
    ScriptPath = ${psLiteral(scriptPath ?? join(import.meta.dirname, "install-local-patched.ps1"))}
    ManifestPath = ${psLiteral(files.manifestPath)}
    AllowedRoot = ${psLiteral(files.artifactRoot)}
    InstallerLogPath = ${psLiteral(installerLogPath)}
    ExpectedVersion = ${psLiteral(expectedVersion)}
  }
  $result = Invoke-GuardedLocalForkInstaller @invokeParams
  $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($script:CapturedEncodedCommand))
  [pscustomobject]@{
    ok = $true; result = $result; registerCalls = $script:RegisterCalls; startCalls = $script:StartCalls;
    removeCalls = $script:RemoveCalls; triggerCalls = $script:TriggerCalls; triggerSupplied = $script:TriggerSupplied;
    taskName = $script:CapturedTaskName; powerShellPath = $script:CapturedPowerShellPath; decodedCommand = $decoded;
    expectedManifestPath = [IO.Path]::GetFullPath($invokeParams.ManifestPath);
    expectedLogPath = [IO.Path]::GetFullPath($invokeParams.InstallerLogPath);
    expectedAllowedRoot = [IO.Path]::GetFullPath($invokeParams.AllowedRoot);
    expectedVersion = $invokeParams.ExpectedVersion
  } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{
    ok = $false; error = $_.Exception.Message; registerCalls = $script:RegisterCalls;
    startCalls = $script:StartCalls; removeCalls = $script:RemoveCalls;
    triggerCalls = $script:TriggerCalls; triggerSupplied = $script:TriggerSupplied
  } | ConvertTo-Json -Depth 6 -Compress
}
`;
  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", driver],
    { encoding: "utf8", windowsHide: true },
  );
  return {
    ...JSON.parse(stdout.trim().split(/\r?\n/).at(-1)),
    installerLogPath,
  };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("canonical Local Fork launcher", () => {
  it("hashes files without relying on Get-FileHash", () => {
    const files = fixture();
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `. ${psLiteral(launcher)} -LibraryOnly; function Get-FileHash { throw 'Get-FileHash must not be called' }; Get-Sha256 -Path ${psLiteral(files.payloadPath)}`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    expect(stdout.trim()).toBe(files.payloadHash);
  });

  it("accepts a current installed payload without reinstalling or relaunching", () => {
    const files = fixture();
    const result = runScenario(files);
    expect(result.ok, result.error).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      installerCalls: 0,
      starterCalls: 0,
      result: {
        disposition: "existing-and-verified",
        executableSha256: files.payloadHash,
        pid: 4101,
      },
    });
  });

  it.each(["stale", "missing"])(
    "schedules a %s payload repair and exits before app shutdown",
    (installed) => {
      const files = fixture({ installed });
      const before = installed === "stale" ? readFileSync(files.executablePath) : null;
      const result = runScenario(files, { live: installed === "stale" });
      expect(result.ok, result.error).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        installerCalls: 1,
        installerAllowedRoot: files.artifactRoot,
        starterCalls: 0,
        result: {
          disposition: "install-scheduled",
          taskName: "fixture-installer-task",
        },
      });
      if (before) expect(readFileSync(files.executablePath)).toEqual(before);
      expect(readFileSync(files.logPath, "utf8").trim().split(/\r?\n/).at(-1)).toContain(
        "SUCCESS disposition=install-scheduled taskName=fixture-installer-task",
      );
    },
  );

  it("registers a triggerless task, starts it manually, and preserves spaced arguments", () => {
    const files = fixture({ installed: "missing" });
    const result = runTaskHandoff(files);
    expect(result.ok, result.error).toBe(true);
    expect(result).toMatchObject({
      registerCalls: 1,
      triggerCalls: 0,
      triggerSupplied: false,
      startCalls: 1,
      removeCalls: 0,
      result: { Status: "started" },
    });
    expect(result.powerShellPath.toLowerCase()).toMatch(/powershell\.exe$/);
    expect(result.decodedCommand).toContain(`-TaskName ${psLiteral(result.taskName)}`);
    expect(result.decodedCommand).toContain(
      `-MetadataPath ${psLiteral(result.expectedManifestPath)}`,
    );
    expect(result.decodedCommand).toContain(`-LogPath ${psLiteral(result.expectedLogPath)}`);
    expect(result.decodedCommand).toContain(
      `-AllowedInstallerRoot ${psLiteral(result.expectedAllowedRoot)}`,
    );
    expect(result.decodedCommand).toContain(`-ExpectedVersion ${psLiteral("0.53.9")}`);
    expect(result.taskName).toMatch(/^ggcoder-local-launch-\d+-[0-9a-f]{32}$/);
  });

  it.each(["", "v0.53.9", "0.53", "0.53.9-beta", "0.53.9;exit 0"])(
    "rejects malformed expected version %j before task registration",
    (expectedVersion) => {
      const files = fixture({ installed: "missing" });
      const result = runTaskHandoff(files, { expectedVersion });
      expect(result).toMatchObject({ ok: false, registerCalls: 0, startCalls: 0 });
      expect(result.error).toContain("expected version");
    },
  );

  it("rejects a noncanonical installer script before task registration", () => {
    const files = fixture({ installed: "missing" });
    const result = runTaskHandoff(files, {
      scriptPath: join(files.root, "install-local-patched.ps1"),
    });
    expect(result).toMatchObject({ ok: false, registerCalls: 0, startCalls: 0 });
    expect(result.error).toContain("non-canonical guarded installer script");
  });

  it("removes only an unstarted task when scheduled-task startup fails", () => {
    const files = fixture({ installed: "missing" });
    const result = runTaskHandoff(files, { startFailure: true });
    expect(result).toMatchObject({
      ok: false,
      registerCalls: 1,
      startCalls: 1,
      removeCalls: 1,
    });
    expect(result.error).toContain("fixture task start failure");
  });

  it("fails closed on a malformed manifest before process or installer actions", () => {
    const files = fixture({ malformed: true });
    const result = runScenario(files, { live: false });
    expect(result).toMatchObject({ ok: false, installerCalls: 0, starterCalls: 0 });
    expect(result.error).toContain("Malformed Local Fork manifest");
  });

  it("fails closed when the named root process has the wrong executable path", () => {
    const files = fixture();
    const result = runScenario(files, { wrongPath: true });
    expect(result).toMatchObject({ ok: false, installerCalls: 0, starterCalls: 0 });
    expect(result.error).toContain("Wrong-path Local Fork root");
  });

  it("fails closed on ambiguous root processes", () => {
    const files = fixture();
    const result = runScenario(files, { ambiguous: true });
    expect(result).toMatchObject({ ok: false, installerCalls: 0, starterCalls: 0 });
    expect(result.error).toContain("Ambiguous Local Fork roots");
  });

  it("fails closed when the root identity changes during startup stability", () => {
    const files = fixture();
    const result = runScenario(files, { replaceDuringStability: true });
    expect(result).toMatchObject({ ok: false, installerCalls: 0, starterCalls: 0 });
    expect(result.error).toContain("stable identity");
  });

  it("fails closed when the guarded installer fails", () => {
    const files = fixture({ installed: "missing" });
    const result = runScenario(files, { live: false, installerFailure: true });
    expect(result).toMatchObject({ ok: false, installerCalls: 1, starterCalls: 0 });
    expect(result.error).toContain("fixture installer failure");
  });
});
