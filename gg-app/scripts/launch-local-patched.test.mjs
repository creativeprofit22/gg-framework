import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcher = join(import.meta.dirname, "launch-local-patched.ps1");
const fixtureRoots = [];
const sourceRevision = "a".repeat(40);
const releaseNote = {
  schemaVersion: 1,
  date: "2026-08-29",
  label: "Roadmap completion now fails closed",
  sections: [{ title: "Safer phase completion", items: ["Roadmap completion fails closed."] }],
};

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function setReleaseEnvelope(manifest, envelope) {
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  manifest.releaseNotes = {
    size: bytes.length,
    sha256: sha256(bytes),
    base64: bytes.toString("base64"),
  };
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fixture({ installed = "current", malformed = false, manifestMutator } = {}) {
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
    const manifest = {
      schemaVersion: 2,
      sourceRevision,
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
    };
    setReleaseEnvelope(manifest, { schemaVersion: 1, sourceRevision, note: releaseNote });
    manifestMutator?.(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
    sourceRevision,
  };
}

function runScenario(
  files,
  { live = true, installerFailure = false, expectedSourceRevision = files.sourceRevision } = {},
) {
  const driver = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psLiteral(files.localAppData)}
. ${psLiteral(launcher)} -LibraryOnly
$script:InstallerCalls = 0
$script:InstallerAllowedRoot = $null
$script:StarterCalls = 0
function Invoke-GuardedLocalForkInstaller {
  param([string]$ScriptPath, [string]$ManifestPath, [string]$AllowedRoot, [string]$InstallerLogPath, [string]$ExpectedVersion, [string]$ExpectedSourceRevision)
  $script:InstallerCalls++
  $script:InstallerAllowedRoot = $AllowedRoot
  if (${installerFailure ? "$true" : "$false"}) { throw 'fixture installer failure' }
  [pscustomobject]@{ TaskName = 'fixture-installer-task'; Status = 'started' }
}
function Start-CanonicalLocalFork([string]$ExecutablePath) {
  $script:StarterCalls++
  throw 'fixture app launch must not occur'
}
try {
  $invokeParams = @{
    ManifestPath = ${psLiteral(files.manifestPath)}
    GuardedInstallerPath = ${psLiteral(join(import.meta.dirname, "install-local-patched.ps1"))}
    AllowedManifestRoot = ${psLiteral(files.root)}
    AllowedInstallerRoot = ${psLiteral(files.artifactRoot)}
    ExpectedExecutable = ${psLiteral(files.executablePath)}
    LauncherLogPath = ${psLiteral(files.logPath)}
    ExpectedVersion = '0.53.9'
    ExpectedSourceRevision = ${psLiteral(expectedSourceRevision)}
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

function runProcessOwnershipScenario(
  files,
  { verificationFailure = false, cleanupAfterSuccess = true } = {},
) {
  const driver = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psLiteral(files.localAppData)}
. ${psLiteral(launcher)} -LibraryOnly
$script:MockExecutable = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'GG Coder Local Fork\\gg-coder-local-fork.exe'))
$script:StarterCalls = 0
$script:StoppedPids = @()
$script:started = [pscustomobject]@{
  Id = 4100
  CreationTicks = 638000000000004100L
  Handle = [pscustomobject]@{ Id = 4100 }
}
function New-MockProcess([int]$ProcessId, [int]$ParentProcessId, [string]$Path, [long]$CreationTicks) {
  [pscustomobject]@{ ProcessId = $ProcessId; ParentProcessId = $ParentProcessId; ExecutablePath = $Path; CreationTicks = $CreationTicks }
}
function Get-ProcessTable {
  @(
    (New-MockProcess 4100 900 ${psLiteral(join(files.root, "launcher-host.exe"))} 638000000000004100L),
    (New-MockProcess 4101 4100 $script:MockExecutable 638000000000004101L),
    (New-MockProcess 4102 4101 ${psLiteral(join(files.root, "spawned-sidecar.exe"))} 638000000000004102L),
    (New-MockProcess 5101 777 $script:MockExecutable 638000000000005101L),
    (New-MockProcess 6101 4100 $script:MockExecutable 638000000000004099L)
  )
}
function Get-ProcessHandleById([int]$ProcessId) { [pscustomobject]@{ Id = $ProcessId } }
function Stop-ExactProcess([object]$Process, [long]$CreationTicks) {
  $script:StoppedPids += [int]$Process.Id
  $true
}
function Start-CanonicalLocalFork([string]$ExecutablePath) {
  $script:StarterCalls++
  $script:started
}
function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) }
${verificationFailure ? "function Confirm-LiveCanonicalRoot { throw 'fixture verification failure' }" : ""}
$invokeParams = @{
  ManifestPath = ${psLiteral(files.manifestPath)}
  GuardedInstallerPath = ${psLiteral(join(import.meta.dirname, "install-local-patched.ps1"))}
  AllowedManifestRoot = ${psLiteral(files.root)}
  AllowedInstallerRoot = ${psLiteral(files.artifactRoot)}
  ExpectedExecutable = ${psLiteral(files.executablePath)}
  LauncherLogPath = ${psLiteral(files.logPath)}
  ExpectedVersion = '0.53.9'
  ExpectedSourceRevision = ${psLiteral(files.sourceRevision)}
}
try {
  $result = Invoke-CanonicalLocalForkLaunch @invokeParams
  $errorMessage = $null
  if (${cleanupAfterSuccess ? "$true" : "$false"}) { Stop-InvocationOwnedProcessTree -StartedProcess $script:started }
} catch {
  $result = $null
  $errorMessage = $_.Exception.Message
}
$records = @(Get-ProcessTable)
$owned = @(Get-DescendantProcessTree -Processes $records -StartedProcess $script:started)
[pscustomobject]@{
  result = $result
  error = $errorMessage
  starterCalls = $script:StarterCalls
  ownedPids = @($owned.ProcessId)
  stoppedPids = @($script:StoppedPids)
} | ConvertTo-Json -Depth 6 -Compress
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
  {
    startFailure = false,
    expectedVersion = "0.53.9",
    expectedSourceRevision = files.sourceRevision,
    scriptPath,
  } = {},
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
    ExpectedSourceRevision = ${psLiteral(expectedSourceRevision)}
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
    expectedVersion = $invokeParams.ExpectedVersion; expectedSourceRevision = $invokeParams.ExpectedSourceRevision
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

  it("selects and cleans only descendants of this invocation's exact process", () => {
    const files = fixture();
    const result = runProcessOwnershipScenario(files);
    expect(result).toMatchObject({
      starterCalls: 1,
      ownedPids: [4100, 4101, 4102],
      stoppedPids: [4102, 4101, 4100],
      result: {
        disposition: "launched-and-verified",
        executableSha256: files.payloadHash,
        pid: 4101,
      },
    });
    expect(result.ownedPids).not.toContain(5101);
    expect(result.ownedPids).not.toContain(6101);
  });

  it("does not adopt a current unrelated installed process", () => {
    const files = fixture();
    const result = runProcessOwnershipScenario(files);
    expect(result.starterCalls).toBe(1);
    expect(result.result.disposition).toBe("launched-and-verified");
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
          sourceRevision: files.sourceRevision,
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
    expect(result.decodedCommand).toContain(
      `-ExpectedSourceRevision ${psLiteral(files.sourceRevision)}`,
    );
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

  it.each(["", "abc123", "g".repeat(40)])(
    "rejects malformed expected source revision %j before task registration",
    (expectedSourceRevision) => {
      const files = fixture({ installed: "missing" });
      const result = runTaskHandoff(files, { expectedSourceRevision });
      expect(result).toMatchObject({ ok: false, registerCalls: 0, startCalls: 0 });
      expect(result.error).toContain("expected source revision");
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

  it.each([
    ["missing schema", (manifest) => delete manifest.schemaVersion],
    ["legacy schema", (manifest) => (manifest.schemaVersion = 1)],
    ["missing notes", (manifest) => delete manifest.releaseNotes],
    ["invalid base64", (manifest) => (manifest.releaseNotes.base64 = "%%%%")],
    ["wrong note size", (manifest) => manifest.releaseNotes.size++],
    ["tampered note digest", (manifest) => (manifest.releaseNotes.sha256 = "0".repeat(64))],
    [
      "another envelope revision",
      (manifest) =>
        setReleaseEnvelope(manifest, {
          schemaVersion: 1,
          sourceRevision: "b".repeat(40),
          note: releaseNote,
        }),
    ],
    [
      "unknown envelope field",
      (manifest) =>
        setReleaseEnvelope(manifest, {
          schemaVersion: 1,
          sourceRevision,
          note: releaseNote,
          surprise: true,
        }),
    ],
    [
      "unknown note field",
      (manifest) =>
        setReleaseEnvelope(manifest, {
          schemaVersion: 1,
          sourceRevision,
          note: { ...releaseNote, surprise: true },
        }),
    ],
    [
      "empty note item",
      (manifest) =>
        setReleaseEnvelope(manifest, {
          schemaVersion: 1,
          sourceRevision,
          note: {
            ...releaseNote,
            sections: [{ title: "Safer phase completion", items: [""] }],
          },
        }),
    ],
  ])("rejects %s before process or installer actions", (_name, manifestMutator) => {
    const files = fixture({ manifestMutator });
    const result = runScenario(files, { live: false });
    expect(result).toMatchObject({ ok: false, installerCalls: 0, starterCalls: 0 });
  });

  it("rejects caller and manifest revision mismatches before process actions", () => {
    const files = fixture();
    const result = runScenario(files, {
      live: false,
      expectedSourceRevision: "b".repeat(40),
    });
    expect(result).toMatchObject({ ok: false, installerCalls: 0, starterCalls: 0 });
    expect(result.error).toContain("does not match the expected source revision");
  });

  it("excludes unrelated matching paths while retaining spawned descendants", () => {
    const files = fixture();
    const result = runProcessOwnershipScenario(files);
    expect(result.ownedPids).toEqual([4100, 4101, 4102]);
    expect(result.stoppedPids).toEqual([4102, 4101, 4100]);
    expect(result.stoppedPids).not.toContain(5101);
    expect(result.stoppedPids).not.toContain(6101);
  });

  it("cleans only the invocation-owned tree after verification failure", () => {
    const files = fixture();
    const result = runProcessOwnershipScenario(files, {
      verificationFailure: true,
      cleanupAfterSuccess: false,
    });
    expect(result.error).toContain("fixture verification failure");
    expect(result.stoppedPids).toEqual([4102, 4101, 4100]);
    expect(result.stoppedPids).not.toContain(5101);
    expect(result.stoppedPids).not.toContain(6101);
  });

  it("fails closed when the guarded installer fails", () => {
    const files = fixture({ installed: "missing" });
    const result = runScenario(files, { live: false, installerFailure: true });
    expect(result).toMatchObject({ ok: false, installerCalls: 1, starterCalls: 0 });
    expect(result.error).toContain("fixture installer failure");
  });
});
