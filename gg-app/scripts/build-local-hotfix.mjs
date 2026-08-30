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
export const LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION = 2;
const RELEASE_NOTES_PATH = "gg-app/src/local-release-notes.json";
const MAX_RELEASE_NOTES_BYTES = 32 * 1024;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedText(value, field, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid Local Fork release-note ${field}.`);
  }
  return value;
}

export function validateLocalReleaseNotes(value) {
  if (!exactKeys(value, ["schemaVersion", "date", "label", "sections"])) {
    throw new Error("Invalid Local Fork release-note fields.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported Local Fork release-note schema.");
  }
  const date = boundedText(value.date, "date", 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Invalid Local Fork release-note date.");
  }
  const label = boundedText(value.label, "label", 120);
  if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > 8) {
    throw new Error("Invalid Local Fork release-note sections.");
  }
  const sections = value.sections.map((section, sectionIndex) => {
    if (!exactKeys(section, ["title", "items"])) {
      throw new Error(`Invalid Local Fork release-note section ${sectionIndex + 1}.`);
    }
    const title = boundedText(section.title, `section ${sectionIndex + 1} title`, 120);
    if (!Array.isArray(section.items) || section.items.length < 1 || section.items.length > 10) {
      throw new Error(`Invalid Local Fork release-note section ${sectionIndex + 1} items.`);
    }
    const items = section.items.map((item, itemIndex) =>
      boundedText(item, `section ${sectionIndex + 1} item ${itemIndex + 1}`, 500),
    );
    return { title, items };
  });
  return { schemaVersion: 1, date, label, sections };
}

export function releaseNotesEnvelope(sourceRevision, note) {
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) {
    throw new Error("Local Fork source revision must be a full 40-character Git SHA.");
  }
  const validatedNote = validateLocalReleaseNotes(note);
  const envelopeBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sourceRevision: sourceRevision.toLowerCase(),
      note: validatedNote,
    }),
    "utf8",
  );
  return {
    sourceRevision: sourceRevision.toLowerCase(),
    releaseNotes: {
      size: envelopeBytes.length,
      sha256: createHash("sha256").update(envelopeBytes).digest("hex"),
      base64: envelopeBytes.toString("base64"),
    },
  };
}

function gitBytes(root, args) {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
}

/** @param {string} root @param {(args: string[]) => Uint8Array} [runGit] */
export function committedReleaseNotes(root, runGit = (args) => gitBytes(root, args)) {
  const status = Buffer.from(runGit(["status", "--porcelain=v1", "--untracked-files=all"]));
  if (status.toString("utf8").trim()) {
    throw new Error("Local Fork builds require a clean worktree, including no untracked files.");
  }
  const sourceRevision = Buffer.from(runGit(["rev-parse", "--verify", "HEAD^{commit}"]))
    .toString("utf8")
    .trim();
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) {
    throw new Error("Could not resolve the full Local Fork source revision.");
  }
  try {
    runGit(["ls-files", "--error-unmatch", "--", RELEASE_NOTES_PATH]);
  } catch {
    throw new Error("Local Fork release notes must be tracked by Git.");
  }
  const currentBytes = readFileSync(join(root, ...RELEASE_NOTES_PATH.split("/")));
  const committedBytes = Buffer.from(runGit(["show", `HEAD:${RELEASE_NOTES_PATH}`]));
  if (!currentBytes.equals(committedBytes)) {
    throw new Error("Local Fork release notes differ from the source commit.");
  }
  if (currentBytes.length === 0 || currentBytes.length > MAX_RELEASE_NOTES_BYTES) {
    throw new Error("Local Fork release-note file is empty or oversized.");
  }
  const text = currentBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(currentBytes)) {
    throw new Error("Local Fork release notes must be valid UTF-8.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Local Fork release notes must be valid JSON.");
  }
  return releaseNotesEnvelope(sourceRevision, parsed);
}

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

export function assertIdentityDataRootWiring({ corePaths, sidecarPaths, appSidecar, rustShell }) {
  const requirements = [
    [corePaths.includes("process.env.GG_AGENT_DIR"), "gg-core must read GG_AGENT_DIR"],
    [corePaths.includes("path.isAbsolute(override)"), "gg-core must reject relative overrides"],
    [corePaths.includes('path.join(homeDir, ".gg")'), "gg-core must preserve the legacy default"],
    [
      sidecarPaths.includes("getAppPaths().agentDir"),
      "app-sidecar settings must use the resolved agent root",
    ],
    [appSidecar.includes("agentDataRoot: paths.agentDir"), "app-sidecar must log its data root"],
    [
      rustShell.includes('const PRODUCTION_APP_IDENTIFIER: &str = "com.ggcoder.app"'),
      "Rust must identify the production exception",
    ],
    [
      /if identifier == PRODUCTION_APP_IDENTIFIER\s*\{\s*legacy\s*\}/m.test(rustShell),
      "production must keep the legacy Rust data root",
    ],
    [
      rustShell.includes('legacy.join("identities").join(identifier)'),
      "non-production Rust data must be identity-scoped",
    ],
    [
      /if identifier == PRODUCTION_APP_IDENTIFIER\s*\{\s*cmd\.env_remove\("GG_AGENT_DIR"\);\s*\}\s*else\s*\{\s*cmd\.env\("GG_AGENT_DIR", &identity_data_root\);\s*\}/m.test(
        rustShell,
      ),
      "production must clear inherited GG_AGENT_DIR and non-production sidecars must set it",
    ],
    [rustShell.includes("bootstrap_identity_data"), "Rust must bootstrap identity data once"],
    [
      rustShell.includes('agent_data_root(identifier).join("gg-app-workspace.json")'),
      "workspace snapshots must be identity-scoped",
    ],
    [
      rustShell.includes('agent_data_root(identifier).join("auth.json")'),
      "native auth must be identity-scoped",
    ],
  ];
  const missing = requirements.filter(([ok]) => !ok).map(([, message]) => message);
  if (missing.length > 0) {
    throw new Error(`Local Fork identity data-root wiring is incomplete: ${missing.join("; ")}`);
  }
  return true;
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
  releaseMetadata,
  payloadMetadata = fileMetadata(payloadPath),
) {
  const installerStats = statSync(installerPath);
  return {
    schemaVersion: LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION,
    sourceRevision: releaseMetadata.sourceRevision,
    releaseNotes: releaseMetadata.releaseNotes,
    path: installerPath,
    size: installerStats.size,
    mtimeMs: installerStats.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(installerPath)).digest("hex"),
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
  const releaseMetadata = committedReleaseNotes(repoRoot);
  env.VITE_GG_GIT_SHA = releaseMetadata.sourceRevision;
  const baseConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));
  const cargoTomlPath = join(srcTauri, "Cargo.toml");
  const localConfig = JSON.parse(readFileSync(localTauriConfigPath(), "utf8"));
  assertIsolatedIdentities(baseConfig, readFileSync(cargoTomlPath, "utf8"), localConfig);
  assertIdentityDataRootWiring({
    corePaths: readFileSync(join(repoRoot, "packages", "gg-core", "src", "paths.ts"), "utf8"),
    sidecarPaths: readFileSync(
      join(repoRoot, "packages", "ggcoder", "src", "app-sidecar-paths.ts"),
      "utf8",
    ),
    appSidecar: readFileSync(
      join(repoRoot, "packages", "ggcoder", "src", "app-sidecar.ts"),
      "utf8",
    ),
    rustShell: readFileSync(join(srcTauri, "src", "lib.rs"), "utf8"),
  });

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
  writeInstallerManifest(installerManifest(installer, payload, releaseMetadata, payloadMetadata));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
