// Windows installed-app smoke for the dedicated disposable Local Fork identity.
// The installer is validated, installed under a temporary root, launched through
// the packaged-app checks, and silently uninstalled without touching real installs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { INSTALLED_SMOKE_IDENTITY, INSTALLED_SMOKE_MANIFEST_NAME } from "./build-local-hotfix.mjs";
import { fileMetadata, runInstalledSmokePreflight } from "./installed-smoke-preflight.mjs";
import {
  discoverPackagedLayout,
  removeTemporaryDirectory,
  smokePackagedLayout,
  waitFor,
} from "./smoke-packaged-windows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repoRoot = resolve(appDir, "..");
const installerRoot = join(appDir, "src-tauri", "target", "release", "bundle", "nsis");
const manifestPath = join(repoRoot, ".gg", "local-fixes", INSTALLED_SMOKE_MANIFEST_NAME);
const uninstallKey = `Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${INSTALLED_SMOKE_IDENTITY.productName}`;
const smokeRootPrefix = "gg-installed-smoke-";

function fail(message) {
  throw new Error(message);
}

export function smokeRevisionExpectations(sourceRevision) {
  const shortRevision = sourceRevision.slice(0, 7);
  return {
    expectedIdentity: `◆ Supah Coder Local Fork · ${shortRevision}`,
    shortRevision,
  };
}

function powershell(script, environment = {}) {
  const encoded = Buffer.from(
    `$ErrorActionPreference = "Stop"\n$ProgressPreference = "SilentlyContinue"\n${script}`,
    "utf16le",
  ).toString("base64");
  return execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      env: { ...process.env, ...environment },
      windowsHide: true,
    },
  ).trim();
}

function asArray(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function canonicalPath(path) {
  const normalized = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  const absolute = resolve(normalized);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function normalizedPaths(paths) {
  return [
    ...new Set(
      asArray(paths)
        .filter(Boolean)
        .map((path) => canonicalPath(path).toLowerCase()),
    ),
  ].sort();
}

export function installedSmokeInstallerArgs(stageRoot) {
  if (!isAbsolute(stageRoot)) fail("Installed Smoke stage root must be absolute.");
  return ["/S", "/NS", `/D=${stageRoot}`];
}

export function assertInstalledSmokeRegistration(registration, stageRoot) {
  if (!registration || typeof registration.InstallLocation !== "string") {
    fail("Installed Smoke uninstall registration is missing.");
  }
  if (canonicalPath(registration.InstallLocation) !== canonicalPath(stageRoot)) {
    fail("Installed Smoke registration points outside the temporary stage root.");
  }
  const uninstaller = join(stageRoot, "uninstall.exe");
  if (!existsSync(uninstaller)) fail(`Installed Smoke uninstaller is missing: ${uninstaller}`);
  return uninstaller;
}

export function assertSystemPathsUnchanged(before, after) {
  for (const key of ["activeExecutablePaths", "registeredInstallPaths"]) {
    const previous = normalizedPaths(before[key]);
    const current = normalizedPaths(after[key]);
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
      fail(`Installed Smoke changed protected system paths: ${key}`);
    }
  }
  return true;
}

export function installVerifiedSmoke({
  candidateManifestPath,
  stageRoot,
  expectedRevision,
  inspectSystemPaths,
  executeInstaller,
  allowedInstallerRoot = installerRoot,
}) {
  return runInstalledSmokePreflight({
    manifestPath: candidateManifestPath,
    stageRoot,
    inspectSystemPaths,
    validationOptions: { allowedInstallerRoot, expectedRevision },
    // Keep this callback as the immediate post-preflight operation: no path,
    // identity, or process state may change between validation and execution.
    execute(manifest) {
      executeInstaller(manifest.path, installedSmokeInstallerArgs(stageRoot));
      return manifest;
    },
  });
}

function inspectSystemPaths() {
  const output = powershell(`
    $names = @("gg-app.exe", "gg-coder-local-fork.exe")
    $active = @(Get-CimInstance Win32_Process |
      Where-Object { $names -contains $_.Name -and $_.ExecutablePath } |
      ForEach-Object { $_.ExecutablePath })
    $products = @("GG Coder", "GG Coder Local Fork")
    $registered = @()
    foreach ($product in $products) {
      $key = "Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$product"
      if (Test-Path -LiteralPath $key) {
        $location = (Get-ItemProperty -LiteralPath $key).InstallLocation
        if ($location) { $registered += $location }
      }
    }
    [pscustomobject]@{
      activeExecutablePaths = $active
      registeredInstallPaths = $registered
    } | ConvertTo-Json -Compress
  `);
  const result = JSON.parse(output);
  return {
    activeExecutablePaths: asArray(result.activeExecutablePaths),
    registeredInstallPaths: asArray(result.registeredInstallPaths),
  };
}

function readInstalledSmokeRegistration() {
  const output = powershell(
    `
      if (-not (Test-Path -LiteralPath $env:GG_INSTALLED_SMOKE_KEY)) { return }
      Get-ItemProperty -LiteralPath $env:GG_INSTALLED_SMOKE_KEY |
        Select-Object InstallLocation, UninstallString |
        ConvertTo-Json -Compress
    `,
    { GG_INSTALLED_SMOKE_KEY: uninstallKey },
  );
  return output ? JSON.parse(output) : null;
}

function checkedOutRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function executeInstaller(installer, args) {
  execFileSync(installer, args, { cwd: repoRoot, stdio: "inherit", windowsHide: false });
}

async function uninstallInstalledSmoke(stageRoot) {
  const registration = readInstalledSmokeRegistration();
  if (!registration) return;
  const uninstaller = assertInstalledSmokeRegistration(registration, stageRoot);
  execFileSync(uninstaller, ["/S"], { stdio: "inherit", windowsHide: false });
  await waitFor("Installed Smoke uninstall cleanup", () => {
    return !readInstalledSmokeRegistration() && !existsSync(stageRoot);
  });
}

function smokeRootForInstallDirectory(installDirectory) {
  const root = canonicalPath(dirname(resolve(installDirectory)));
  const offset = relative(realpathSync.native(tmpdir()), root);
  if (
    offset.startsWith("..") ||
    isAbsolute(offset) ||
    !basename(root).startsWith(smokeRootPrefix) ||
    basename(installDirectory) !== "package"
  ) {
    fail(`Installed Smoke refused cleanup outside its temporary root: ${installDirectory}`);
  }
  return root;
}

async function cleanupOnly() {
  const registration = readInstalledSmokeRegistration();
  if (!registration) {
    console.log("CLEANUP PASS: no Installed Smoke registration remains");
    return;
  }
  const stageRoot = canonicalPath(registration.InstallLocation ?? "");
  const smokeRoot = smokeRootForInstallDirectory(stageRoot);
  await uninstallInstalledSmoke(stageRoot);
  await removeTemporaryDirectory(smokeRoot);
  console.log(`CLEANUP PASS: ${smokeRoot}`);
}

async function runInstalledSmoke() {
  const protectedBefore = inspectSystemPaths();
  if (readInstalledSmokeRegistration()) {
    fail("Installed Smoke registration already exists; run cleanup-only first.");
  }
  const smokeRoot = mkdtempSync(join(tmpdir(), smokeRootPrefix));
  const stageRoot = join(smokeRoot, "package");
  const projectDir = join(smokeRoot, "project");
  mkdirSync(projectDir, { recursive: true });

  let manifest;
  let smokeResult;
  let primaryError;
  try {
    manifest = installVerifiedSmoke({
      candidateManifestPath: manifestPath,
      stageRoot,
      expectedRevision: checkedOutRevision(),
      inspectSystemPaths: () => protectedBefore,
      executeInstaller,
    });
    const registration = readInstalledSmokeRegistration();
    assertInstalledSmokeRegistration(registration, stageRoot);
    const layout = discoverPackagedLayout(stageRoot, manifest.payload.name);
    const installedPayload = fileMetadata(layout.executable);
    if (
      installedPayload.size !== manifest.payload.size ||
      installedPayload.sha256 !== manifest.payload.sha256
    ) {
      fail("Installed Smoke installed payload does not match the build manifest.");
    }
    smokeResult = await smokePackagedLayout(layout, { smokeRoot, projectDir });
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await uninstallInstalledSmoke(stageRoot);
    assertSystemPathsUnchanged(protectedBefore, inspectSystemPaths());
    await removeTemporaryDirectory(smokeRoot);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Installed Smoke failed and cleanup is required under ${smokeRoot}`,
    );
  }
  if (cleanupError) {
    throw new Error(
      `Installed Smoke cleanup is required under ${smokeRoot}: ${cleanupError.message}`,
    );
  }
  if (primaryError) throw primaryError;

  console.log(
    `INSTALLED SMOKE PASS: pid=${smokeResult.appPid} packagedNode=${smokeResult.packagedNode}`,
  );
}

async function main() {
  if (process.platform !== "win32") fail("Installed Smoke only supports Windows.");
  if (process.argv.includes("--cleanup-only")) return cleanupOnly();
  return runInstalledSmoke();
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`INSTALLED SMOKE FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
