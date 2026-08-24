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

function createDirectoryJunction(path, target) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$null = New-Item -ItemType Junction -Path ${psLiteral(path)} -Target ${psLiteral(target)}`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
}

function withExclusiveFileLock(path, readyPath, holdMilliseconds, body) {
  const lockBody =
    `$lock = [IO.File]::Open(${psLiteral(path)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); ` +
    `try { [IO.File]::WriteAllText(${psLiteral(readyPath)}, 'ready'); Start-Sleep -Milliseconds ${holdMilliseconds} } finally { $lock.Dispose() }`;
  const encodedLockBody = Buffer.from(lockBody, "utf16le").toString("base64");
  return (
    `$null = Get-RestartManagerLockState -ResourcePath ${psLiteral(path)}; ` +
    `$owner = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', ${psLiteral(encodedLockBody)}) -PassThru -WindowStyle Hidden; ` +
    `try { $readyDeadline = [DateTime]::UtcNow.AddSeconds(3); while (-not (Test-Path -LiteralPath ${psLiteral(readyPath)})) { if ([DateTime]::UtcNow -ge $readyDeadline) { throw 'Lock holder did not become ready' }; Start-Sleep -Milliseconds 10 }; ` +
    `${body} } finally { if (-not $owner.HasExited) { $owner.Kill(); $owner.WaitForExit() } }`
  );
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

  it("logs successful pre-installer hash and directory rename operations", () => {
    const fixture = transactionFixture();
    const backupDirectory = join(fixture.root, "successful-backup");
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; ` +
        `$metadata = Get-PreInstallerFileMetadata -Path ${psLiteral(fixture.installedExecutable)}; ` +
        `Move-InstallDirectoryToBackup -InstallDirectory ${psLiteral(fixture.installDirectory)} -BackupPath ${psLiteral(backupDirectory)}; ` +
        `[pscustomobject]@{ Size = $metadata.Size; Sha256 = $metadata.Sha256; BackupExists = Test-Path -LiteralPath ${psLiteral(backupDirectory)} } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Size: fixture.oldBytes.length,
      Sha256: sha256(fixture.oldBytes).toUpperCase(),
      BackupExists: true,
    });
    const log = readFileSync(fixture.logPath, "utf8");
    expect(log).toContain(
      `OPERATION START name=pre-installer-hash path="${fixture.installedExecutable}"`,
    );
    expect(log).toContain(
      `OPERATION SUCCESS name=pre-installer-hash path="${fixture.installedExecutable}"`,
    );
    expect(log).toContain(
      `OPERATION START name=pre-installer-directory-rename path="${fixture.installDirectory}" destinationPath="${backupDirectory}"`,
    );
    expect(log).toContain(
      `OPERATION SUCCESS name=pre-installer-directory-rename path="${fixture.installDirectory}" destinationPath="${backupDirectory}"`,
    );
  });

  it("registers only the exact installed executable and ignores nested decoy files", () => {
    const fixture = transactionFixture();
    const nestedDirectory = join(fixture.installDirectory, "resources", "runtime");
    const nestedDecoy = join(nestedDirectory, "decoy.node");
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(nestedDecoy, "decoy payload");
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; $script:capturedResources = @(); ` +
        `$null = Get-RestartManagerLockState -ResourcePath ${psLiteral(fixture.installedExecutable)}; ` +
        `function Invoke-RestartManagerQuery([string[]]$Resources) { $script:capturedResources = @($Resources); return [pscustomobject]@{ Status = 'none'; Stage = ''; Reason = ''; Error = 0; Needed = 0; Attempt = 0; Attempts = 0; Owners = @() } }; ` +
        `Wait-InstalledPayloadLocksClear -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -TimeoutMilliseconds 500 -PollIntervalMilliseconds 25; ` +
        `[pscustomobject]@{ Resources = @($script:capturedResources); DecoyExists = Test-Path -LiteralPath ${psLiteral(nestedDecoy)} } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Resources: [realpathSync.native(fixture.installedExecutable)],
      DecoyExists: true,
    });
    const log = readFileSync(fixture.logPath, "utf8");
    expect(log).toMatch(/LOCK CLEAR ATTEMPT attempt=1 .* resourceCount=1 status=none/);
    expect(log).toContain("LOCK CLEAR SUCCESS attempts=1");
  });

  it("treats a missing installed executable as immediately clear", () => {
    const fixture = installerFixture();
    const missingExecutable = join(fixture.root, "missing-install", "gg-coder-local-fork.exe");
    const logPath = join(fixture.root, "missing-install.log");
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(logPath)}; ` +
        `Wait-InstalledPayloadLocksClear -InstalledExecutable ${psLiteral(missingExecutable)} -TimeoutMilliseconds 500 -PollIntervalMilliseconds 25`,
    );

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("resourceCount=0 status=none reason=no-existing-file-resource");
    expect(log).toContain("LOCK CLEAR SUCCESS attempts=1");
  });

  it("detects the real Restart Manager owner of the installed executable until release", () => {
    const fixture = transactionFixture();
    const readyPath = join(fixture.root, "executable-lock-ready");
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; ` +
        withExclusiveFileLock(
          fixture.installedExecutable,
          readyPath,
          600,
          `Wait-InstalledPayloadLocksClear -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -TimeoutMilliseconds 3000 -PollIntervalMilliseconds 50; ` +
            `[pscustomobject]@{ OwnerPid = $owner.Id; ExecutableExists = Test-Path -LiteralPath ${psLiteral(fixture.installedExecutable)} } | ConvertTo-Json -Compress`,
        ),
    );

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence.ExecutableExists).toBe(true);
    const log = readFileSync(fixture.logPath, "utf8");
    expect(log).toContain(`status=owners count=1 ownerPid=${evidence.OwnerPid}`);
    expect(log).toMatch(/LOCK CLEAR SUCCESS attempts=[2-9][0-9]*/);
  });
  it("times out non-destructively with exact installed-payload owner evidence", () => {
    const fixture = transactionFixture();
    const readyPath = join(fixture.root, "timeout-lock-ready");
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; ` +
        withExclusiveFileLock(
          fixture.installedExecutable,
          readyPath,
          10000,
          `$failure = $null; try { Wait-InstalledPayloadLocksClear -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -TimeoutMilliseconds 200 -PollIntervalMilliseconds 25 } catch { $failure = $_ }; ` +
            `if (-not $failure) { throw 'Expected lock-clear timeout' }; ` +
            `[pscustomobject]@{ OwnerPid = $owner.Id; Failure = $failure.Exception.Message; DirectoryExists = Test-Path -LiteralPath ${psLiteral(fixture.installDirectory)}; FileExists = Test-Path -LiteralPath ${psLiteral(fixture.installedExecutable)} } | ConvertTo-Json -Compress`,
        ),
    );

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence).toMatchObject({ DirectoryExists: true, FileExists: true });
    expect(evidence.Failure).toContain(
      "Installed payload locks did not clear before the 200ms Restart Manager polling deadline",
    );
    expect(evidence.Failure).toContain(`ownerPid=${evidence.OwnerPid}`);
    const log = readFileSync(fixture.logPath, "utf8");
    expect(log).toContain(`ownerPid=${evidence.OwnerPid}`);
    expect(log).toContain("LOCK CLEAR TIMEOUT");
  });

  it("fails when a Restart Manager query returns after the polling deadline", () => {
    const fixture = transactionFixture();
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; ` +
        `$null = Get-RestartManagerLockState -ResourcePath ${psLiteral(fixture.installedExecutable)}; ` +
        `function Invoke-RestartManagerQuery([string[]]$Resources) { Start-Sleep -Milliseconds 100; return [pscustomobject]@{ Status = 'none'; Stage = ''; Reason = ''; Error = 0; Needed = 0; Attempt = 0; Attempts = 0; Owners = @() } }; ` +
        `$failure = $null; try { Wait-InstalledPayloadLocksClear -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -TimeoutMilliseconds 25 -PollIntervalMilliseconds 10 } catch { $failure = $_ }; ` +
        `if (-not $failure) { throw 'Expected post-query polling deadline failure' }; ` +
        `[pscustomobject]@{ Failure = $failure.Exception.Message; DirectoryExists = Test-Path -LiteralPath ${psLiteral(fixture.installDirectory)}; FileExists = Test-Path -LiteralPath ${psLiteral(fixture.installedExecutable)} } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      Failure: expect.stringContaining(
        "Installed payload locks did not clear before the 25ms Restart Manager polling deadline",
      ),
      DirectoryExists: true,
      FileExists: true,
    });
    const log = readFileSync(fixture.logPath, "utf8");
    expect(log).toMatch(
      /LOCK CLEAR ATTEMPT attempt=1 elapsedMs=(?:[3-9][0-9]|[1-9][0-9]{2,}).*status=none/,
    );
    expect(log).toContain("LOCK CLEAR TIMEOUT");
    expect(log).not.toContain("LOCK CLEAR SUCCESS");
  });

  it("formats exact owner-count and retry exhaustion limits from typed query results", () => {
    const fixture = transactionFixture();
    const result = runPowerShell(
      `$null = Get-RestartManagerLockState -ResourcePath ${psLiteral(fixture.installedExecutable)}; ` +
        `function Invoke-RestartManagerQuery([string[]]$Resources) { [pscustomobject]@{ Status = 'unavailable'; Stage = 'list'; Reason = 'owner-count-limit'; Error = 234; Needed = 4097; Attempt = 1; Attempts = 0; Owners = @() } }; ` +
        `$ownerLimit = Format-RestartManagerLockState -State (Get-RestartManagerLockState -ResourcePath ${psLiteral(fixture.installedExecutable)}); ` +
        `function Invoke-RestartManagerQuery([string[]]$Resources) { [pscustomobject]@{ Status = 'unavailable'; Stage = 'list'; Reason = 'error-more-data-retry-exhausted'; Error = 234; Needed = 12; Attempt = 0; Attempts = 4; Owners = @() } }; ` +
        `$retryLimit = Format-RestartManagerLockState -State (Get-RestartManagerLockState -ResourcePath ${psLiteral(fixture.installedExecutable)}); ` +
        `[pscustomobject]@{ OwnerLimit = $ownerLimit; RetryLimit = $retryLimit } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      OwnerLimit:
        "resourceCount=1 status=unavailable stage=list reason=owner-count-limit error=234 needed=4097 limit=4096 attempt=1",
      RetryLimit:
        "resourceCount=1 status=unavailable stage=list reason=error-more-data-retry-exhausted error=234 needed=12 attempts=4",
    });
  });

  it("rejects a directory resource without invoking the native query", () => {
    const fixture = transactionFixture();
    const nestedFile = join(fixture.installDirectory, "second-resource.bin");
    writeFileSync(nestedFile, "second resource");
    const result = runPowerShell(
      `$script:queryCalls = 0; function Invoke-RestartManagerQuery([string[]]$Resources) { $script:queryCalls += 1; throw 'native query must not run' }; ` +
        `$state = Get-RestartManagerLockState -ResourcePath ${psLiteral(fixture.installDirectory)}; ` +
        `[pscustomobject]@{ Evidence = Format-RestartManagerLockState -State $state; QueryCalls = $script:queryCalls; DirectoryExists = Test-Path -LiteralPath ${psLiteral(fixture.installDirectory)}; ExecutableExists = Test-Path -LiteralPath ${psLiteral(fixture.installedExecutable)}; NestedFileExists = Test-Path -LiteralPath ${psLiteral(nestedFile)} } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Evidence: "resourceCount=0 status=fatal stage=validate reason=container-resource-not-allowed",
      QueryCalls: 0,
      DirectoryExists: true,
      ExecutableExists: true,
      NestedFileExists: true,
    });
  });

  it("logs exception and Restart Manager evidence when the hash target is locked", () => {
    const fixture = transactionFixture();
    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; ` +
        `$lock = [IO.File]::Open(${psLiteral(fixture.installedExecutable)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); ` +
        `$failure = $null; try { try { Get-PreInstallerFileMetadata -Path ${psLiteral(fixture.installedExecutable)} | Out-Null } catch { $failure = $_ } } finally { $lock.Dispose() }; ` +
        `if (-not $failure) { throw 'Expected locked-file hash failure' }; ` +
        `[pscustomobject]@{ ProcessId = $PID; ExceptionType = $failure.Exception.GetType().FullName; HResult = $failure.Exception.HResult; Message = $failure.Exception.Message; FileStillExists = Test-Path -LiteralPath ${psLiteral(fixture.installedExecutable)} } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence).toMatchObject({
      ExceptionType: "System.Management.Automation.MethodInvocationException",
      FileStillExists: true,
    });
    expect(evidence.Message).toMatch(/used by another process|utilizado en otro proceso/i);
    const log = readFileSync(fixture.logPath, "utf8");
    expect(log).toContain(
      `OPERATION FAILED name=pre-installer-hash path="${fixture.installedExecutable}" exceptionType=${evidence.ExceptionType}`,
    );
    expect(log).toMatch(/hresult=0x[0-9A-F]{8} message=".+"/);
    expect(log).toContain(
      `LOCK EVIDENCE name=pre-installer-hash path="${fixture.installedExecutable}" nativeError=32`,
    );
    expect(log).toContain(`ownerPid=${evidence.ProcessId}`);
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

  it("rejects a log path reached through a junction before writing", () => {
    const fixture = installerFixture();
    const outsideDirectory = join(fixture.root, "outside-log-data");
    const junctionDirectory = join(fixture.root, "log-link");
    const outsideLog = join(outsideDirectory, "install.log");
    mkdirSync(outsideDirectory);
    createDirectoryJunction(junctionDirectory, outsideDirectory);

    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(join(junctionDirectory, "install.log"))}; ` +
        `$failure = ''; try { Write-Step 'must not be written' } catch { $failure = $_.Exception.Message }; ` +
        `[pscustomobject]@{ Failure = $failure; OutsideLogExists = Test-Path -LiteralPath ${psLiteral(outsideLog)} } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Failure: expect.stringContaining("Install log path traverses a reparse point"),
      OutsideLogExists: false,
    });
  });

  it("rejects an installer reached through a junction escaping the allowed root", () => {
    const fixture = installerFixture();
    const outsideDirectory = join(fixture.root, "outside-artifacts");
    const junctionDirectory = join(fixture.installerRoot, "escaped");
    const escapedInstaller = join(outsideDirectory, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    mkdirSync(outsideDirectory);
    writeFileSync(escapedInstaller, fixture.installerBytes);
    createDirectoryJunction(junctionDirectory, outsideDirectory);
    fixture.manifest.path = join(junctionDirectory, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    writeFileSync(fixture.metadataPath, JSON.stringify(fixture.manifest));

    const result = runPowerShell(
      `Read-VerifiedInstallerManifest -Path ${psLiteral(fixture.metadataPath)} -AllowedRoot ${psLiteral(fixture.installerRoot)}`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Contained path traverses a reparse point");
    expect(readFileSync(escapedInstaller)).toEqual(fixture.installerBytes);
  });

  it("rejects a nested junction before renaming the install directory", () => {
    const fixture = transactionFixture();
    const outsideDirectory = join(fixture.root, "outside-install-data");
    const junctionDirectory = join(fixture.installDirectory, "escaped");
    const outsideFile = join(outsideDirectory, "preserve.txt");
    const backupDirectory = join(fixture.root, "unsafe-backup");
    mkdirSync(outsideDirectory);
    writeFileSync(outsideFile, "preserve me");
    createDirectoryJunction(junctionDirectory, outsideDirectory);

    const result = runPowerShell(
      `$script:InstallLogPath = ${psLiteral(fixture.logPath)}; ` +
        `$failure = ''; try { Move-InstallDirectoryToBackup -InstallDirectory ${psLiteral(fixture.installDirectory)} -BackupPath ${psLiteral(backupDirectory)} } catch { $failure = $_.Exception.Message }; ` +
        `[pscustomobject]@{ Failure = $failure; InstallExists = Test-Path -LiteralPath ${psLiteral(fixture.installDirectory)}; BackupExists = Test-Path -LiteralPath ${psLiteral(backupDirectory)}; OutsideContent = [string](Get-Content -Raw -LiteralPath ${psLiteral(outsideFile)}) } | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Failure: expect.stringContaining("Install directory contains a reparse point"),
      InstallExists: true,
      BackupExists: false,
      OutsideContent: "preserve me",
    });
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

  it("stops an executable-lock timeout before hash, backup rename, or installer invocation", () => {
    const fixture = transactionFixture();
    const readyPath = join(fixture.root, "transaction-timeout-lock-ready");
    const body =
      transactionPrelude(fixture) +
      `$script:LockClearTimeoutMilliseconds = 500; $script:hashCalls = 0; $script:renameCalls = 0; $script:installerCalls = 0; ` +
      `function Get-PreInstallerFileMetadata([string]$Path) { $script:hashCalls += 1; throw 'hash must not run' }; ` +
      `function Move-InstallDirectoryToBackup([string]$InstallDirectory, [string]$BackupPath) { $script:renameCalls += 1; throw 'rename must not run' }; ` +
      `function Invoke-NsisInstaller([string]$InstallerPath) { $script:installerCalls += 1; throw 'installer must not run' }; ` +
      withExclusiveFileLock(
        fixture.installedExecutable,
        readyPath,
        10000,
        `$failure = ''; try { Invoke-VerifiedInstallTransaction -InstallDirectory ${psLiteral(fixture.installDirectory)} -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -InstallerManifest $manifest -WasRunning $false } catch { $failure = $_.Exception.Message }; ` +
          `$owner.Kill(); $owner.WaitForExit(); ` +
          `[pscustomobject]@{ Failure = $failure; OwnerPid = $owner.Id; HashCalls = $script:hashCalls; RenameCalls = $script:renameCalls; InstallerCalls = $script:installerCalls; InstallExists = Test-Path -LiteralPath ${psLiteral(fixture.installDirectory)}; ExecutableContent = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes(${psLiteral(fixture.installedExecutable)})); ExecutableSha256 = Get-Sha256 -Path ${psLiteral(fixture.installedExecutable)}; Backups = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -Directory -Filter 'GG Coder Local Fork.backup-*').Count; RecoveryArchives = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -File -Filter 'GG Coder Local Fork.backup-*.recovery.zip').Count } | ConvertTo-Json -Compress`,
      );

    const result = runPowerShell(body);

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence).toMatchObject({
      HashCalls: 0,
      RenameCalls: 0,
      InstallerCalls: 0,
      InstallExists: true,
      ExecutableContent: fixture.oldBytes.toString("utf8"),
      ExecutableSha256: sha256(fixture.oldBytes).toUpperCase(),
      Backups: 0,
      RecoveryArchives: 0,
    });
    expect(evidence.Failure).toContain(
      "Installed payload locks did not clear before the 500ms Restart Manager polling deadline",
    );
    expect(evidence.Failure).toContain(`ownerPid=${evidence.OwnerPid}`);
  });

  it("relaunches the unchanged executable once after a pre-backup lock timeout", () => {
    const fixture = transactionFixture();
    const readyPath = join(fixture.root, "transaction-relaunch-timeout-lock-ready");
    const body =
      transactionPrelude(fixture) +
      `$script:LockClearTimeoutMilliseconds = 500; $script:hashCalls = 0; $script:renameCalls = 0; $script:installerCalls = 0; $script:startCalls = 0; $script:startPaths = @(); ` +
      `function Get-PreInstallerFileMetadata([string]$Path) { $script:hashCalls += 1; throw 'hash must not run' }; ` +
      `function Move-InstallDirectoryToBackup([string]$InstallDirectory, [string]$BackupPath) { $script:renameCalls += 1; throw 'rename must not run' }; ` +
      `function Invoke-NsisInstaller([string]$InstallerPath) { $script:installerCalls += 1; throw 'installer must not run' }; ` +
      `function Start-VerifiedApp([string]$ExecutablePath, [ref]$LaunchedSnapshot) { $script:startCalls += 1; $script:startPaths += $ExecutablePath; return [pscustomobject]@{ ProcessId = 703; ExecutablePath = $ExecutablePath } }; ` +
      withExclusiveFileLock(
        fixture.installedExecutable,
        readyPath,
        10000,
        `$failure = ''; try { Invoke-VerifiedInstallTransaction -InstallDirectory ${psLiteral(fixture.installDirectory)} -InstalledExecutable ${psLiteral(fixture.installedExecutable)} -InstallerManifest $manifest -WasRunning $true } catch { $failure = $_.Exception.Message }; ` +
          `$owner.Kill(); $owner.WaitForExit(); ` +
          `[pscustomobject]@{ Failure = $failure; OwnerPid = $owner.Id; HashCalls = $script:hashCalls; RenameCalls = $script:renameCalls; InstallerCalls = $script:installerCalls; StartCalls = $script:startCalls; StartPaths = @($script:startPaths); ExecutableSha256 = Get-Sha256 -Path ${psLiteral(fixture.installedExecutable)}; Backups = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -Directory -Filter 'GG Coder Local Fork.backup-*').Count; RecoveryArchives = @(Get-ChildItem -LiteralPath ${psLiteral(fixture.root)} -File -Filter 'GG Coder Local Fork.backup-*.recovery.zip').Count } | ConvertTo-Json -Compress`,
      );

    const result = runPowerShell(body);

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence).toMatchObject({
      HashCalls: 0,
      RenameCalls: 0,
      InstallerCalls: 0,
      StartCalls: 1,
      ExecutableSha256: sha256(fixture.oldBytes).toUpperCase(),
      Backups: 0,
      RecoveryArchives: 0,
    });
    expect(evidence.StartPaths).toHaveLength(1);
    expect(realpathSync.native(evidence.StartPaths[0])).toBe(
      realpathSync.native(fixture.installedExecutable),
    );
    expect(evidence.Failure).toContain(
      "Installed payload locks did not clear before the 500ms Restart Manager polling deadline",
    );
    expect(evidence.Failure).toContain(`ownerPid=${evidence.OwnerPid}`);
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
