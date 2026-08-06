import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("detached local installer helper", () => {
  it("hashes files without relying on Get-FileHash", () => {
    const root = mkdtempSync(join(tmpdir(), "gg-installer-helper-"));
    temporaryDirectories.push(root);
    const fixturePath = join(root, "hash-fixture.bin");
    const fixtureBytes = Buffer.from("portable SHA-256 fixture", "utf8");
    writeFileSync(fixturePath, fixtureBytes);

    const result = runPowerShell(
      `function Get-FileHash { throw 'Get-FileHash must not be called' }; Get-Sha256 -Path ${psLiteral(fixturePath)}`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      createHash("sha256").update(fixtureBytes).digest("hex").toUpperCase(),
    );
  });

  it("takes the installer path and SHA-256 from latest-installer metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "gg-installer-helper-"));
    temporaryDirectories.push(root);
    const installerRoot = join(root, "nsis");
    mkdirSync(installerRoot);
    const installerPath = join(installerRoot, "fixture-setup.exe");
    const installerBytes = Buffer.from("verified fixture installer", "utf8");
    writeFileSync(installerPath, installerBytes);
    const sha256 = createHash("sha256").update(installerBytes).digest("hex");
    const metadataPath = join(root, "latest-installer.json");
    writeFileSync(
      metadataPath,
      `${JSON.stringify({ path: installerPath, size: installerBytes.length, sha256 })}\n`,
    );

    const result = runPowerShell(
      `$result = Read-VerifiedInstallerMetadata -Path ${psLiteral(metadataPath)} -AllowedRoot ${psLiteral(installerRoot)}; $result | ConvertTo-Json -Compress`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      Path: realpathSync.native(installerPath),
      Sha256: sha256.toUpperCase(),
      Size: installerBytes.length,
    });
  });

  it("rejects metadata whose SHA-256 does not match the installer", () => {
    const root = mkdtempSync(join(tmpdir(), "gg-installer-helper-"));
    temporaryDirectories.push(root);
    const installerRoot = join(root, "nsis");
    mkdirSync(installerRoot);
    const installerPath = join(installerRoot, "fixture-setup.exe");
    writeFileSync(installerPath, "different bytes");
    const metadataPath = join(root, "latest-installer.json");
    writeFileSync(
      metadataPath,
      `${JSON.stringify({ path: installerPath, sha256: "0".repeat(64) })}\n`,
    );

    const result = runPowerShell(
      `Read-VerifiedInstallerMetadata -Path ${psLiteral(metadataPath)} -AllowedRoot ${psLiteral(installerRoot)}`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Installer SHA-256 mismatch");
  });

  it("rejects a metadata path outside the allowed NSIS output directory", () => {
    const root = mkdtempSync(join(tmpdir(), "gg-installer-helper-"));
    temporaryDirectories.push(root);
    const installerRoot = join(root, "nsis");
    mkdirSync(installerRoot);
    const installerPath = join(root, "outside-setup.exe");
    const installerBytes = Buffer.from("outside", "utf8");
    writeFileSync(installerPath, installerBytes);
    const metadataPath = join(root, "latest-installer.json");
    writeFileSync(
      metadataPath,
      `${JSON.stringify({
        path: installerPath,
        sha256: createHash("sha256").update(installerBytes).digest("hex"),
      })}\n`,
    );

    const result = runPowerShell(
      `Read-VerifiedInstallerMetadata -Path ${psLiteral(metadataPath)} -AllowedRoot ${psLiteral(installerRoot)}`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside the allowed NSIS output directory");
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
      "$captured = [pscustomobject]@{ ProcessId = 101; ExecutablePath = 'C:\\Fixtures\\GG Coder\\gg-app.exe'; CreationTicks = 12345 }; " +
      "$same = [pscustomobject]@{ ProcessId = 101; ExecutablePath = 'c:\\fixtures\\gg coder\\gg-app.exe'; CreationTicks = 12345 }; ";

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
});
