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
  { live = true, wrongPath = false, ambiguous = false, installerFailure = false } = {},
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
function New-MockRoot([int]$ProcessId, [string]$Path) {
  [pscustomobject]@{ ProcessId = $ProcessId; ParentProcessId = 900; ExecutablePath = $Path; CreationTicks = 638000000000000000L + $ProcessId }
}
function Get-LocalForkRootProcesses {
  if (${ambiguous ? "$true" : "$false"}) {
    return @((New-MockRoot 4101 $script:MockExecutable), (New-MockRoot 4102 $script:MockExecutable))
  }
  if (-not $script:MockLive) { return @() }
  $path = if (${wrongPath ? "$true" : "$false"}) { ${psLiteral(wrongExecutable)} } else { $script:MockExecutable }
  return @((New-MockRoot 4101 $path))
}
function Invoke-GuardedLocalForkInstaller {
  param([string]$ScriptPath, [string]$ManifestPath, [string]$AllowedRoot, [string]$InstallerLogPath)
  $script:InstallerCalls++
  $script:InstallerAllowedRoot = $AllowedRoot
  if (${installerFailure ? "$true" : "$false"}) { throw 'fixture installer failure' }
  Copy-Item -LiteralPath ${psLiteral(files.payloadPath)} -Destination ${psLiteral(files.executablePath)} -Force
  $script:MockLive = $true
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

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("canonical Local Fork launcher", () => {
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
    "repairs a %s installed payload through the guarded installer",
    (installed) => {
      const files = fixture({ installed });
      const result = runScenario(files, { live: installed === "stale" });
      expect(result.ok, result.error).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        installerCalls: 1,
        installerAllowedRoot: files.artifactRoot,
        starterCalls: 0,
        result: {
          disposition: "installed-and-verified",
          executableSha256: files.payloadHash,
          pid: 4101,
        },
      });
      expect(sha256(readFileSync(files.executablePath))).toBe(files.payloadHash);
    },
  );

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

  it("fails closed when the guarded installer fails", () => {
    const files = fixture({ installed: "missing" });
    const result = runScenario(files, { live: false, installerFailure: true });
    expect(result).toMatchObject({ ok: false, installerCalls: 1, starterCalls: 0 });
    expect(result.error).toContain("fixture installer failure");
  });
});
