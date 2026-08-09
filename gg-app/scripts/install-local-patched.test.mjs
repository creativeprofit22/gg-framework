import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = join(import.meta.dirname, "install-local-patched.ps1");
const temporaryDirectories = [];

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(body) {
  const command = `& { . ${psLiteral(scriptPath)} -TaskName 'test-only' -LibraryOnly; ${body} }`;
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function localForkManifest(installerPath, installerBytes, payloadBytes) {
  return {
    path: installerPath,
    size: installerBytes.length,
    mtimeMs: Date.now(),
    sha256: sha256(installerBytes),
    schemaVersion: 1,
    identity: {
      productName: "GG Coder Local Fork",
      identifier: "com.ggcoder.local-fork",
      mainBinaryName: "gg-coder-local-fork",
      executableName: "gg-coder-local-fork.exe",
      installMode: "currentUser",
    },
    payload: {
      name: "gg-coder-local-fork.exe",
      size: payloadBytes.length,
      sha256: sha256(payloadBytes),
    },
  };
}

function installerFixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-installer-helper-"));
  temporaryDirectories.push(root);
  const installerRoot = join(root, "nsis");
  mkdirSync(installerRoot);
  const installerPath = join(installerRoot, "GG Coder Local Fork_1.2.3_x64-setup.exe");
  const installerBytes = Buffer.from("verified fixture installer", "utf8");
  const payloadBytes = Buffer.from("verified fixture payload", "utf8");
  writeFileSync(installerPath, installerBytes);
  const metadataPath = join(root, "latest-installer.json");
  const manifest = localForkManifest(installerPath, installerBytes, payloadBytes);
  writeFileSync(metadataPath, `${JSON.stringify(manifest)}\n`);
  return {
    root,
    installerRoot,
    installerPath,
    installerBytes,
    payloadBytes,
    metadataPath,
    manifest,
  };
}

function transactionFixture() {
  const fixture = installerFixture();
  const installDirectory = join(fixture.root, "GG Coder Local Fork");
  const installedExecutable = join(installDirectory, "gg-coder-local-fork.exe");
  const oldBytes = Buffer.from("previous Local Fork payload", "utf8");
  mkdirSync(installDirectory);
  writeFileSync(installedExecutable, oldBytes);
  const logPath = join(fixture.root, "transaction.log");
  return { ...fixture, installDirectory, installedExecutable, oldBytes, logPath };
}

function writeBytesPowerShell(path, bytes) {
  return `[IO.File]::WriteAllBytes(${psLiteral(path)}, [Convert]::FromBase64String(${psLiteral(bytes.toString("base64"))}))`;
}

function transactionPrelude(fixture) {
  return `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; $script:registrationRestores = 0; function Get-LocalForkRegistrationSnapshot { [pscustomobject]@{ Exists = $true; Values = @() } }; function Restore-LocalForkRegistration([object]$Snapshot) { $script:registrationRestores += 1 }; $rawManifest = ${psLiteral(JSON.stringify(fixture.manifest))} | ConvertFrom-Json; $manifest = [pscustomobject]@{ Path = $rawManifest.path; PayloadSize = [int64]$rawManifest.payload.size; PayloadSha256 = [string]$rawManifest.payload.sha256 }; `;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("detached local installer helper", () => {
  it("hashes files without relying on Get-FileHash", () => {
    const fixture = installerFixture();
    const fixturePath = join(fixture.root, "hash-fixture.bin");
    const fixtureBytes = Buffer.from("portable SHA-256 fixture", "utf8");
    writeFileSync(fixturePath, fixtureBytes);

    const result = runPowerShell(
      `function Get-FileHash { throw 'Get-FileHash must not be called' }; Get-Sha256 -Path ${psLiteral(fixturePath)}`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(sha256(fixtureBytes).toUpperCase());
  });

  it("validates the Local Fork identity and expected payload from the installer manifest", () => {
    const fixture = installerFixture();

    const result = runPowerShell(
      `$result = Read-VerifiedInstallerManifest -Path ${psLiteral(fixture.metadataPath)} -AllowedRoot ${psLiteral(fixture.installerRoot)}; $result | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      Path: realpathSync.native(fixture.installerPath),
      Sha256: sha256(fixture.installerBytes).toUpperCase(),
      Size: fixture.installerBytes.length,
      ProductName: "GG Coder Local Fork",
      Identifier: "com.ggcoder.local-fork",
      MainBinaryName: "gg-coder-local-fork",
      ExecutableName: "gg-coder-local-fork.exe",
      InstallMode: "currentUser",
      PayloadSize: fixture.payloadBytes.length,
      PayloadSha256: sha256(fixture.payloadBytes).toUpperCase(),
    });
  });

  it("rejects a manifest for a non-Local Fork identity", () => {
    const fixture = installerFixture();
    fixture.manifest.identity.identifier = "com.ggcoder.app";
    writeFileSync(fixture.metadataPath, JSON.stringify(fixture.manifest));

    const result = runPowerShell(
      `Read-VerifiedInstallerManifest -Path ${psLiteral(fixture.metadataPath)} -AllowedRoot ${psLiteral(fixture.installerRoot)}`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Local Fork identity mismatch for identifier");
  });

  it("rejects a manifest whose SHA-256 does not match the installer", () => {
    const fixture = installerFixture();
    fixture.manifest.sha256 = "0".repeat(64);
    writeFileSync(fixture.metadataPath, JSON.stringify(fixture.manifest));

    const result = runPowerShell(
      `Read-VerifiedInstallerManifest -Path ${psLiteral(fixture.metadataPath)} -AllowedRoot ${psLiteral(fixture.installerRoot)}`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Installer SHA-256 mismatch");
  });

  it("rejects a manifest path outside the allowed NSIS output directory", () => {
    const fixture = installerFixture();
    const outsidePath = join(fixture.root, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    writeFileSync(outsidePath, fixture.installerBytes);
    fixture.manifest.path = outsidePath;
    writeFileSync(fixture.metadataPath, JSON.stringify(fixture.manifest));

    const result = runPowerShell(
      `Read-VerifiedInstallerManifest -Path ${psLiteral(fixture.metadataPath)} -AllowedRoot ${psLiteral(fixture.installerRoot)}`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside the allowed NSIS output directory");
  });

  it("rejects unrelated current-user gg-coder-local-fork.exe processes", () => {
    const result = runPowerShell(
      `$installed = [pscustomobject]@{ ProcessId = 101; ExecutablePath = 'C:\\Users\\me\\AppData\\Local\\GG Coder Local Fork\\gg-coder-local-fork.exe' }; ` +
        `$unrelated = [pscustomobject]@{ ProcessId = 202; ExecutablePath = 'D:\\Tools\\gg-coder-local-fork.exe' }; ` +
        `Assert-NoUnrelatedGgAppProcesses -InstalledExecutable $installed.ExecutablePath -Processes @($installed, $unrelated)`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unrelated current-user gg-coder-local-fork.exe");
    expect(result.stderr).toContain("PID=202");
  });

  it("fails closed when gg-coder-local-fork.exe process enumeration is unavailable", () => {
    const result = runPowerShell(
      `function Get-CimInstance { throw 'simulated CIM failure' }; Get-CurrentUserGgAppProcesses`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unable to enumerate gg-coder-local-fork.exe processes safely");
  });

  it("rejects an unbounded shutdown timeout before executing helper logic", () => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-TaskName",
        "test-only",
        "-LibraryOnly",
        "-GracefulShutdownSeconds",
        "121",
      ],
      { encoding: "utf8", windowsHide: true },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ValidationError");
  });

  it("allows fallback only for the same captured process after an accepted close and no window", () => {
    const common =
      "$captured = [pscustomobject]@{ ProcessId = 101; ExecutablePath = 'C:\\Fixtures\\GG Coder Local Fork\\gg-coder-local-fork.exe'; CreationTicks = 12345 }; " +
      "$same = [pscustomobject]@{ ProcessId = 101; ExecutablePath = 'c:\\fixtures\\gg coder local fork\\gg-coder-local-fork.exe'; CreationTicks = 12345 }; ";

    const accepted = runPowerShell(
      `${common} Assert-SafeForceFallback -CapturedRoots @($captured) -CurrentRoots @($same) -AcceptedCloseRootIds @(101) -VisibleWindowRootIds @(); 'accepted'`,
    );
    const changedIdentity = runPowerShell(
      `${common} $same.CreationTicks = 99999; Assert-SafeForceFallback -CapturedRoots @($captured) -CurrentRoots @($same) -AcceptedCloseRootIds @(101) -VisibleWindowRootIds @()`,
    );
    const noAcceptedClose = runPowerShell(
      `${common} Assert-SafeForceFallback -CapturedRoots @($captured) -CurrentRoots @($same) -AcceptedCloseRootIds @() -VisibleWindowRootIds @()`,
    );
    const windowReturned = runPowerShell(
      `${common} Assert-SafeForceFallback -CapturedRoots @($captured) -CurrentRoots @($same) -AcceptedCloseRootIds @(101) -VisibleWindowRootIds @(101)`,
    );

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout.trim()).toBe("accepted");
    expect(changedIdentity.status).not.toBe(0);
    expect(changedIdentity.stderr).toContain("changed identity");
    expect(noAcceptedClose.status).not.toBe(0);
    expect(noAcceptedClose.stderr).toContain("did not accept a graceful window close");
    expect(windowReturned.status).not.toBe(0);
    expect(windowReturned.stderr).toContain("still has a visible main window");
  });

  it("requires Local Fork uninstall registration at the Local Fork directory and binary", () => {
    const fixture = transactionFixture();
    const accepted = runPowerShell(
      `function Get-LocalForkUninstallRegistration { [pscustomobject]@{ DisplayName = 'GG Coder Local Fork'; InstallLocation = ${psLiteral(`"${fixture.installDirectory}"`)}; MainBinaryName = 'gg-coder-local-fork.exe' } }; Assert-LocalForkUninstallRegistration -InstallDirectory ${psLiteral(fixture.installDirectory)}; 'accepted'`,
    );
    const wrongBinary = runPowerShell(
      `function Get-LocalForkUninstallRegistration { [pscustomobject]@{ DisplayName = 'GG Coder Local Fork'; InstallLocation = ${psLiteral(fixture.installDirectory)}; MainBinaryName = 'local-fork.exe' } }; Assert-LocalForkUninstallRegistration -InstallDirectory ${psLiteral(fixture.installDirectory)}`,
    );

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout.trim()).toBe("accepted");
    expect(wrongBinary.status).not.toBe(0);
    expect(wrongBinary.stderr).toContain("wrong main binary");
  });

  it("restores Local Fork registration values with their original registry types", () => {
    const fixture = installerFixture();
    const registryPath = `HKCU:\\Software\\GG Coder Local Fork Tests\\${randomUUID()}`;
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(join(fixture.root, "registry.log"))}; $path = ${psLiteral(registryPath)}; try { ` +
        `$null = New-Item -Path $path -Force; $null = New-ItemProperty -LiteralPath $path -Name 'Label' -Value 'original' -PropertyType String; $null = New-ItemProperty -LiteralPath $path -Name 'Count' -Value 42 -PropertyType DWord; ` +
        `$snapshot = Get-LocalForkRegistrationSnapshot -RegistrationPath $path; Remove-Item -LiteralPath $path -Recurse -Force; $null = New-Item -Path $path -Force; $null = New-ItemProperty -LiteralPath $path -Name 'Label' -Value 'mutated' -PropertyType String; ` +
        `Restore-LocalForkRegistration -Snapshot $snapshot -RegistrationPath $path; $key = Get-Item -LiteralPath $path; $values = Get-ItemProperty -LiteralPath $path; ` +
        `[pscustomobject]@{ Label = $values.Label; Count = $values.Count; LabelKind = [string]$key.GetValueKind('Label'); CountKind = [string]$key.GetValueKind('Count') } | ConvertTo-Json -Compress ` +
        `} finally { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Label: "original",
      Count: 42,
      LabelKind: "String",
      CountKind: "DWord",
    });
  });

  it("installs the verified payload, restarts it, and removes the backup on success", () => {
    const fixture = transactionFixture();
    const body =
      transactionPrelude(fixture) +
      `$script:startCount = 0; ` +
      `function Invoke-NsisInstaller([string]$InstallerPath) { New-Item -ItemType Directory -Path ${psLiteral(fixture.installDirectory)} | Out-Null; ${writeBytesPowerShell(fixture.installedExecutable, fixture.payloadBytes)}; return 0 }; ` +
      `function Assert-LocalForkUninstallRegistration([string]$InstallDirectory) {}; ` +
      `function Start-VerifiedApp([string]$ExecutablePath, [ref]$LaunchedSnapshot) { $script:startCount += 1; $snapshot = [pscustomobject]@{ ProcessId = 700; ExecutablePath = $ExecutablePath; CreationTicks = 1 }; if ($LaunchedSnapshot) { $LaunchedSnapshot.Value = $snapshot }; return $snapshot }; ` +
      `Invoke-VerifiedInstallTransaction -InstallDirectory ${psLiteral(fixture.installDirectory)} -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -InstallerManifest $manifest -WasRunning $true; ` +
      `[pscustomobject]@{ Content = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes(${psLiteral(fixture.installedExecutable)})); Backups = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -Directory -Filter 'GG Coder Local Fork.backup-*').Count; Starts = $script:startCount } | ConvertTo-Json -Compress`;

    const result = runPowerShell(body);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Content: fixture.payloadBytes.toString("utf8"),
      Backups: 0,
      Starts: 1,
    });
    expect(readFileSync(fixture.logPath, "utf8")).toContain(
      "SUCCESS: installed and relaunched verified GG Coder Local Fork",
    );
  });

  it("rolls back a payload hash mismatch without restarting an app that was closed", () => {
    const fixture = transactionFixture();
    const tamperedBytes = Buffer.from("tampered payload", "utf8");
    const body =
      transactionPrelude(fixture) +
      `$script:startCount = 0; ` +
      `function Invoke-NsisInstaller([string]$InstallerPath) { New-Item -ItemType Directory -Path ${psLiteral(fixture.installDirectory)} | Out-Null; ${writeBytesPowerShell(fixture.installedExecutable, tamperedBytes)}; return 0 }; ` +
      `function Start-VerifiedApp([string]$ExecutablePath, [ref]$LaunchedSnapshot) { $script:startCount += 1; return [pscustomobject]@{ ProcessId = 701 } }; ` +
      `$failure = ''; try { Invoke-VerifiedInstallTransaction -InstallDirectory ${psLiteral(fixture.installDirectory)} -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -InstallerManifest $manifest -WasRunning $false } catch { $failure = $_.Exception.Message }; ` +
      `[pscustomobject]@{ Failure = $failure; Content = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes(${psLiteral(fixture.installedExecutable)})); Backups = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -Directory -Filter 'GG Coder Local Fork.backup-*').Count; Starts = $script:startCount } | ConvertTo-Json -Compress`;

    const result = runPowerShell(body);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      Failure: expect.stringContaining("previous install was restored"),
      Content: fixture.oldBytes.toString("utf8"),
      Backups: 0,
      Starts: 0,
    });
  });

  it("restores and restarts the previous app when the new app fails startup", () => {
    const fixture = transactionFixture();
    const body =
      transactionPrelude(fixture) +
      `$script:startCount = 0; $script:stopCount = 0; ` +
      `function Invoke-NsisInstaller([string]$InstallerPath) { New-Item -ItemType Directory -Path ${psLiteral(fixture.installDirectory)} | Out-Null; ${writeBytesPowerShell(fixture.installedExecutable, fixture.payloadBytes)}; return 0 }; ` +
      `function Assert-LocalForkUninstallRegistration([string]$InstallDirectory) {}; ` +
      `function Stop-LaunchedVerifiedRoot([object]$Snapshot, [string]$ExpectedExecutable) { if ($Snapshot) { $script:stopCount += 1 } }; ` +
      `function Start-VerifiedApp([string]$ExecutablePath, [ref]$LaunchedSnapshot) { $script:startCount += 1; $snapshot = [pscustomobject]@{ ProcessId = 702; ExecutablePath = $ExecutablePath; CreationTicks = 2 }; if ($script:startCount -eq 1) { if ($LaunchedSnapshot) { $LaunchedSnapshot.Value = $snapshot }; throw 'simulated startup failure after launch' }; return $snapshot }; ` +
      `$failure = ''; try { Invoke-VerifiedInstallTransaction -InstallDirectory ${psLiteral(fixture.installDirectory)} -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -InstallerManifest $manifest -WasRunning $true } catch { $failure = $_.Exception.Message }; ` +
      `[pscustomobject]@{ Failure = $failure; Content = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes(${psLiteral(fixture.installedExecutable)})); Backups = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -Directory -Filter 'GG Coder Local Fork.backup-*').Count; Starts = $script:startCount; Stops = $script:stopCount; RegistrationRestores = $script:registrationRestores } | ConvertTo-Json -Compress`;

    const result = runPowerShell(body);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      Failure: expect.stringContaining("previous install was restored"),
      Content: fixture.oldBytes.toString("utf8"),
      Backups: 0,
      Starts: 2,
      Stops: 1,
      RegistrationRestores: 1,
    });
    expect(readFileSync(fixture.logPath, "utf8")).toContain("ROLLBACK SUCCESS");
  });

  it("preserves the backup and prints recovery instructions when rollback fails", () => {
    const fixture = transactionFixture();
    const partialBytes = Buffer.from("partial payload", "utf8");
    const body =
      transactionPrelude(fixture) +
      `function Invoke-NsisInstaller([string]$InstallerPath) { New-Item -ItemType Directory -Path ${psLiteral(fixture.installDirectory)} | Out-Null; ${writeBytesPowerShell(fixture.installedExecutable, partialBytes)}; return 9 }; ` +
      `function Remove-Item([string]$LiteralPath, [switch]$Recurse, [switch]$Force) { if ($LiteralPath -eq ${psLiteral(fixture.installDirectory)}) { throw 'simulated partial-directory removal failure' } }; ` +
      `$failure = ''; try { Invoke-VerifiedInstallTransaction -InstallDirectory ${psLiteral(fixture.installDirectory)} -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -InstallerManifest $manifest -WasRunning $true } catch { $failure = $_.Exception.Message }; ` +
      `$backup = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -Directory -Filter 'GG Coder Local Fork.backup-*'); ` +
      `[pscustomobject]@{ Failure = $failure; BackupCount = $backup.Count; BackupHasOldExecutable = if ($backup.Count -eq 1) { Test-Path -LiteralPath (Join-Path $backup[0].FullName 'gg-coder-local-fork.exe') } else { $false }; PartialStillExists = Test-Path -LiteralPath ${psLiteral(fixture.installedExecutable)} } | ConvertTo-Json -Compress`;

    const result = runPowerShell(body);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      Failure: expect.stringContaining("ROLLBACK FAILED"),
      BackupCount: 1,
      BackupHasOldExecutable: true,
      PartialStillExists: true,
    });
    expect(JSON.parse(result.stdout.trim()).Failure).toContain("Manual recovery");
  });

  it("verifies the restored executable hash before declaring rollback success", () => {
    const fixture = transactionFixture();
    const expected = { Size: fixture.oldBytes.length, Sha256: sha256(fixture.oldBytes) };
    writeFileSync(fixture.installedExecutable, "corrupted restored payload");

    const result = runPowerShell(
      `Assert-FileMatchesMetadata -Path ${psLiteral(fixture.installedExecutable)} -ExpectedSize ${expected.Size} -ExpectedSha256 ${psLiteral(expected.Sha256)} -Description 'Restored Local Fork executable'`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Restored Local Fork executable (size|SHA-256) mismatch/);
    expect(existsSync(fixture.installedExecutable)).toBe(true);
  });
});
