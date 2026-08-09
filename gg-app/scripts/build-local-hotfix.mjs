// Build an unsigned local-patched installer. Official release builds are unchanged.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..");
const srcTauri = join(appDir, "src-tauri");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, VITE_GG_LOCAL_PATCHED: "1", VITE_GG_SOURCE_ROOT: repoRoot };
export const LOCAL_FORK_IDENTITY = Object.freeze({
  productName: "GG Coder Local Fork",
  identifier: "com.ggcoder.local-fork",
  mainBinaryName: "gg-coder-local-fork",
  executableName: process.platform === "win32" ? "gg-coder-local-fork.exe" : "gg-coder-local-fork",
  installMode: "currentUser",
});
export const LOCAL_TAURI_CONFIG = Object.freeze({
  productName: LOCAL_FORK_IDENTITY.productName,
  identifier: LOCAL_FORK_IDENTITY.identifier,
  mainBinaryName: LOCAL_FORK_IDENTITY.mainBinaryName,
  bundle: { createUpdaterArtifacts: false },
  plugins: { updater: { endpoints: [] } },
});
export const LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION = 1;

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function requireSuccess(status) {
  if (status !== 0) process.exit(status);
}

function newestFreshFile(dir, extension, startedAt) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(extension.toLowerCase()))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs >= startedAt)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function freshLocalForkWindowsInstaller(dir, startedAt) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => /^GG Coder Local Fork_[^_]+_[^_]+-setup\.exe$/.test(name))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs >= startedAt);
  if (candidates.length > 1) {
    throw new Error(
      `Tauri produced multiple fresh Local Fork NSIS installers: ${candidates.join(", ")}`,
    );
  }
  return candidates[0] ?? null;
}

export function freshInstallerForPlatform(srcTauriRoot, platform, startedAt) {
  const bundleDir = join(srcTauriRoot, "target", "release", "bundle");
  if (platform === "win32") {
    return freshLocalForkWindowsInstaller(join(bundleDir, "nsis"), startedAt);
  }
  if (platform === "darwin") return newestFreshFile(join(bundleDir, "dmg"), ".dmg", startedAt);
  return newestFreshFile(join(bundleDir, "appimage"), ".AppImage", startedAt);
}

function cargoPackageName(cargoToml) {
  const packageHeader = /^\[package\]\s*$/m.exec(cargoToml);
  if (!packageHeader) return null;
  const remainingToml = cargoToml.slice(packageHeader.index + packageHeader[0].length);
  const nextSectionOffset = remainingToml.search(/^\[/m);
  const packageSection =
    nextSectionOffset === -1 ? remainingToml : remainingToml.slice(0, nextSectionOffset);
  return packageSection.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? null;
}

export function assertIsolatedIdentities(baseConfig, cargoToml, localConfig = LOCAL_TAURI_CONFIG) {
  if (baseConfig.productName !== "GG Coder" || baseConfig.identifier !== "com.ggcoder.app") {
    throw new Error("Canonical production Tauri identity drifted.");
  }
  const productionBinary = baseConfig.mainBinaryName ?? cargoPackageName(cargoToml);
  if (productionBinary !== "gg-app") throw new Error("Canonical production binary drifted.");
  if (baseConfig.bundle?.createUpdaterArtifacts !== true) {
    throw new Error("Canonical production updater artifacts must remain enabled.");
  }
  if (
    localConfig.productName !== LOCAL_FORK_IDENTITY.productName ||
    localConfig.identifier !== LOCAL_FORK_IDENTITY.identifier ||
    localConfig.mainBinaryName !== LOCAL_FORK_IDENTITY.mainBinaryName
  ) {
    throw new Error("Local Fork identity must be fully isolated from production.");
  }
  if (localConfig.bundle?.createUpdaterArtifacts !== false) {
    throw new Error("Local Fork updater artifacts must be disabled.");
  }
  if ((localConfig.plugins?.updater?.endpoints ?? []).length !== 0) {
    throw new Error("Local Fork must not use an updater endpoint.");
  }
  if (localConfig.bundle?.windows?.nsis?.installMode === "perMachine") {
    throw new Error("Local Fork must not install per-machine.");
  }
  return LOCAL_FORK_IDENTITY;
}

function hostTriple() {
  return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
}

export function runWithCargoTomlRestored(cargoTomlPath, build) {
  const originalCargoToml = readFileSync(cargoTomlPath);
  try {
    return build();
  } finally {
    writeFileSync(cargoTomlPath, originalCargoToml);
  }
}

export function tauriBuildArgs(platform, configPath) {
  const bundleArgs = platform === "win32" ? ["--bundles", "nsis"] : [];
  return [
    "--filter",
    "gg-app",
    "tauri",
    "build",
    ...bundleArgs,
    "--no-sign",
    "--config",
    configPath,
  ];
}

function stagedNodePath() {
  return join(
    srcTauri,
    "binaries",
    `ggnode-${hostTriple()}${process.platform === "win32" ? ".exe" : ""}`,
  );
}

function localTauriConfigPath() {
  return join(srcTauri, "tauri.local.conf.json");
}

function fileMetadata(path) {
  const bytes = readFileSync(path);
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function windowsNsisPayloadMetadata(payloadPath) {
  const unpatchedMarker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
  const nsisMarker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS");
  const bytes = readFileSync(payloadPath);
  const markerOffset = bytes.indexOf(unpatchedMarker);
  if (markerOffset < 0 || bytes.indexOf(unpatchedMarker, markerOffset + 1) >= 0) {
    throw new Error("Expected exactly one unpatched Tauri bundle-type marker in gg-app.exe.");
  }
  const installerBytes = Buffer.from(bytes);
  nsisMarker.copy(installerBytes, markerOffset);
  return {
    size: installerBytes.length,
    sha256: createHash("sha256").update(installerBytes).digest("hex"),
  };
}

export function installerManifest(
  installerPath,
  payloadPath,
  payloadMetadata = fileMetadata(payloadPath),
) {
  const installerStats = statSync(installerPath);
  return {
    path: installerPath,
    size: installerStats.size,
    mtimeMs: installerStats.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(installerPath)).digest("hex"),
    schemaVersion: LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION,
    identity: LOCAL_FORK_IDENTITY,
    payload: {
      name: basename(payloadPath),
      ...payloadMetadata,
    },
  };
}

function writeInstallerManifest(metadata) {
  const outputDir = join(repoRoot, ".gg", "local-fixes");
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, "latest-installer.json");
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Verified fresh Local Fork installer: ${metadata.path}`);
  console.log(`Installer SHA-256: ${metadata.sha256}`);
  console.log(`Payload SHA-256: ${metadata.payload.sha256}`);
}

async function main() {
  const baseConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));
  const cargoTomlPath = join(srcTauri, "Cargo.toml");
  const localConfig = JSON.parse(readFileSync(localTauriConfigPath(), "utf8"));
  assertIsolatedIdentities(baseConfig, readFileSync(cargoTomlPath, "utf8"), localConfig);

  if (!env.GG_NODE_SOURCE) {
    const stagedNode = stagedNodePath();
    if (existsSync(stagedNode)) env.GG_NODE_SOURCE = stagedNode;
    else requireSuccess(run(pnpm, ["--filter", "gg-app", "stage:node"]));
  }
  for (const packageName of [
    "@kenkaiiii/gg-ai",
    "@kenkaiiii/gg-agent",
    "@kenkaiiii/gg-core",
    "@kenkaiiii/ggcoder",
  ]) {
    requireSuccess(run(pnpm, ["--filter", packageName, "build"]));
  }
  requireSuccess(run(pnpm, ["--filter", "gg-app", "bundle:sidecar"]));
  const bundleBuildStartedAt = Date.now();
  const buildStatus = runWithCargoTomlRestored(cargoTomlPath, () =>
    run(pnpm, tauriBuildArgs(process.platform, localTauriConfigPath())),
  );
  if (buildStatus !== 0) process.exit(buildStatus);
  const installer = freshInstallerForPlatform(srcTauri, process.platform, bundleBuildStartedAt);
  if (!installer) {
    console.error("Tauri did not produce exactly one fresh Local Fork installer for this build.");
    process.exit(1);
  }
  const payloadName = LOCAL_FORK_IDENTITY.executableName;
  const payload = join(srcTauri, "target", "release", payloadName);
  if (!existsSync(payload)) {
    console.error(`Tauri did not produce the expected payload: ${payload}`);
    process.exit(1);
  }
  const payloadMetadata =
    process.platform === "win32" ? windowsNsisPayloadMetadata(payload) : fileMetadata(payload);
  writeInstallerManifest(installerManifest(installer, payload, payloadMetadata));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
