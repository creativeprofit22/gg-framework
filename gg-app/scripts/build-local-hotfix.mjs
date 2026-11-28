// Build an unsigned local-patched installer. Official release builds are unchanged.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
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
export const INSTALLED_SMOKE_IDENTITY = Object.freeze({
  productName: "GG Coder Local Fork Installed Smoke",
  identifier: "com.ggcoder.local-fork.installed-smoke",
  mainBinaryName: "gg-coder-local-fork-installed-smoke",
  executableName:
    process.platform === "win32"
      ? "gg-coder-local-fork-installed-smoke.exe"
      : "gg-coder-local-fork-installed-smoke",
  installMode: "currentUser",
});
export const LOCAL_TAURI_CONFIG = Object.freeze({
  productName: LOCAL_FORK_IDENTITY.productName,
  identifier: LOCAL_FORK_IDENTITY.identifier,
  mainBinaryName: LOCAL_FORK_IDENTITY.mainBinaryName,
  bundle: { createUpdaterArtifacts: false },
  plugins: { updater: { endpoints: [] } },
});
export const INSTALLED_SMOKE_TAURI_CONFIG = Object.freeze({
  productName: INSTALLED_SMOKE_IDENTITY.productName,
  identifier: INSTALLED_SMOKE_IDENTITY.identifier,
  mainBinaryName: INSTALLED_SMOKE_IDENTITY.mainBinaryName,
  bundle: {
    createUpdaterArtifacts: false,
    windows: {
      nsis: {
        installerHooks: "windows/nsis-installed-smoke-hooks.nsh",
        installMode: "currentUser",
      },
    },
  },
  plugins: { updater: { endpoints: [] } },
});
// Local-only Rust settings for the Tauri build child; release/CI builds never run this script.
export const LOCAL_CARGO_RELEASE_SETTINGS = Object.freeze({
  CARGO_PROFILE_RELEASE_INCREMENTAL: "true",
});

export function localCargoBuildEnv(baseEnv) {
  // Windows env names are case-insensitive, so match them that way.
  const isSet = (name) => Object.keys(baseEnv).some((key) => key.toUpperCase() === name);
  const childEnv = { ...baseEnv };
  for (const [name, value] of Object.entries(LOCAL_CARGO_RELEASE_SETTINGS)) {
    if (isSet(name)) continue;
    // CARGO_INCREMENTAL overrides the profile setting, so the user's choice wins.
    if (name === "CARGO_PROFILE_RELEASE_INCREMENTAL" && isSet("CARGO_INCREMENTAL")) continue;
    childEnv[name] = value;
  }
  return childEnv;
}
export const LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION = 2;
export const INSTALLED_SMOKE_MANIFEST_NAME = "latest-installed-smoke-installer.json";
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

/**
 * Local Fork rebuild gate: agents must be able to keep a claimed Roadmap phase
 * and record its status after the conversation compacts. Each file must still
 * contain its regression marker (so the guard cannot be silently deleted) and
 * must pass before this script bundles the sidecar or packages an installer
 * (build:local-patched, build:local-hotfix, and the local-update workflow all
 * run through here). Running bundle:sidecar directly, and upstream CI/release
 * builds, do not run this gate; they rely on the regular test suite instead.
 * Paths are relative to packages/ggcoder.
 */
export const PHASE_LEASE_REGRESSION_GATE = Object.freeze([
  Object.freeze({
    file: "src/roadmap-phase-lease-repository.test.ts",
    marker: "compaction session rotation (regression: orphaned phase leases)",
  }),
  Object.freeze({
    file: "src/app-sidecar-phase-binding.test.ts",
    marker: "compaction keeps phase ownership (regression: orphaned leases)",
  }),
  Object.freeze({
    file: "src/core/agent-session-compaction.test.ts",
    marker: "carries the Roadmap phase lease marker into the compaction checkpoint (regression)",
  }),
  // Exercises the daemon's own wiring (orphan-recovery predicate and the
  // compaction_end hand-off) compiled from app-sidecar.ts and the fork-owned
  // modules read by readAppSidecarSources() (APP_SIDECAR_SOURCES below); the
  // lease repository and its hasLiveLocalSession predicate are built in
  // app-sidecar-roadmap-daemon.ts. The unit tests above cannot see this wiring
  // because they construct their own options.
  Object.freeze({
    file: "src/app-sidecar-phase-lease-wiring.test.ts",
    marker: "daemon phase-lease wiring (regression: orphaned leases after compaction)",
  }),
]);

/** Returns the gate entries whose file or regression marker is missing. */
export function missingPhaseLeaseRegressionGuards(
  ggcoderRoot,
  readText = (path) => readFileSync(path, "utf8"),
) {
  return PHASE_LEASE_REGRESSION_GATE.filter(({ file, marker }) => {
    try {
      return !readText(join(ggcoderRoot, file)).includes(marker);
    } catch {
      return true;
    }
  });
}

export function phaseLeaseRegressionGateArgs() {
  return [
    "--filter",
    "@kenkaiiii/ggcoder",
    "exec",
    "vitest",
    "run",
    ...PHASE_LEASE_REGRESSION_GATE.map(({ file }) => file),
  ];
}

function runPhaseLeaseRegressionGate() {
  const missing = missingPhaseLeaseRegressionGuards(join(repoRoot, "packages", "ggcoder"));
  if (missing.length > 0) {
    console.error(
      "Build gate failed: Roadmap phase-lease regression tests are missing:\n" +
        missing.map(({ file, marker }) => `  ${file}: "${marker}"`).join("\n"),
    );
    process.exit(1);
  }
  const status = run(pnpm, phaseLeaseRegressionGateArgs());
  if (status !== 0) {
    console.error(
      "Build gate failed: agents could lose their Roadmap phase after compaction. " +
        "Fix the phase-lease regression tests before rebuilding.",
    );
    process.exit(status);
  }
}

function run(command, args, childEnv = env) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: childEnv,
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

function freshWindowsInstaller(dir, startedAt, identity) {
  if (!existsSync(dir)) return null;
  const productName = identity.productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const artifactPattern = new RegExp(`^${productName}_[^_]+_[^_]+-setup\\.exe$`);
  const candidates = readdirSync(dir)
    .filter((name) => artifactPattern.test(name))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs >= startedAt);
  if (candidates.length > 1) {
    const artifactLabel =
      identity.productName === LOCAL_FORK_IDENTITY.productName
        ? "Local Fork"
        : identity.productName;
    throw new Error(
      `Tauri produced multiple fresh ${artifactLabel} NSIS installers: ${candidates.join(", ")}`,
    );
  }
  return candidates[0] ?? null;
}

export function freshInstallerForPlatform(srcTauriRoot, platform, startedAt, identity) {
  const targetIdentity = identity ?? LOCAL_FORK_IDENTITY;
  const bundleDir = join(srcTauriRoot, "target", "release", "bundle");
  if (platform === "win32") {
    return freshWindowsInstaller(join(bundleDir, "nsis"), startedAt, targetIdentity);
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

export function assertInstalledSmokeIdentity(
  localConfig,
  smokeConfig = INSTALLED_SMOKE_TAURI_CONFIG,
) {
  if (
    smokeConfig.productName !== INSTALLED_SMOKE_IDENTITY.productName ||
    smokeConfig.identifier !== INSTALLED_SMOKE_IDENTITY.identifier ||
    smokeConfig.mainBinaryName !== INSTALLED_SMOKE_IDENTITY.mainBinaryName
  ) {
    throw new Error("Installed Smoke identity drifted.");
  }
  for (const key of ["productName", "identifier", "mainBinaryName"]) {
    if (smokeConfig[key] === localConfig[key]) {
      throw new Error(`Installed Smoke ${key} collides with Local Fork.`);
    }
  }
  if (smokeConfig.bundle?.createUpdaterArtifacts !== false) {
    throw new Error("Installed Smoke updater artifacts must be disabled.");
  }
  if ((smokeConfig.plugins?.updater?.endpoints ?? []).length !== 0) {
    throw new Error("Installed Smoke must not use an updater endpoint.");
  }
  const nsis = smokeConfig.bundle?.windows?.nsis;
  if (
    nsis?.installerHooks !== "windows/nsis-installed-smoke-hooks.nsh" ||
    nsis.installerHooks === localConfig.bundle?.windows?.nsis?.installerHooks
  ) {
    throw new Error("Installed Smoke must use its dedicated NSIS hook.");
  }
  if (nsis.installMode !== INSTALLED_SMOKE_IDENTITY.installMode) {
    throw new Error("Installed Smoke must install for the current user.");
  }
  return INSTALLED_SMOKE_IDENTITY;
}

/**
 * Native modules that own the identity data-root wiring since the 0.86.0 module split.
 * Kept in the original lib.rs source order (data-root branch first) so first-match
 * tamper checks still target the same code.
 */
export const IDENTITY_RUST_SOURCES = [
  "paths.rs",
  "identity.rs",
  "daemon.rs",
  "settings.rs",
  "auth.rs",
  "lib.rs",
];

export function readIdentityRustShell(srcTauri) {
  return IDENTITY_RUST_SOURCES.map((file) =>
    readFileSync(join(srcTauri, "src", file), "utf8"),
  ).join("\n");
}

// The daemon source checked by static guards: app-sidecar.ts plus the fork-owned
// modules its Local Fork wiring was extracted into.
const APP_SIDECAR_SOURCES = [
  "app-sidecar.ts",
  "app-sidecar-roadmap-daemon.ts",
  "app-sidecar-phase-lease-runtime.ts",
  "app-sidecar-roadmap-session-routes.ts",
  "app-sidecar-local-session-routes.ts",
];

export function readAppSidecarSources(ggcoderRoot) {
  return APP_SIDECAR_SOURCES.map((file) =>
    readFileSync(join(ggcoderRoot, "src", file), "utf8"),
  ).join("\n");
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

export function tauriBuildArgs(platform, configPathOrPaths) {
  const bundleArgs = platform === "win32" ? ["--bundles", "nsis"] : [];
  const configPaths = Array.isArray(configPathOrPaths) ? configPathOrPaths : [configPathOrPaths];
  return [
    "--filter",
    "gg-app",
    "tauri",
    "build",
    ...bundleArgs,
    "--no-sign",
    ...configPaths.flatMap((configPath) => ["--config", configPath]),
  ];
}

function stagedNodePath() {
  return join(
    srcTauri,
    "binaries",
    `ggnode-${hostTriple()}${process.platform === "win32" ? ".exe" : ""}`,
  );
}

export function localBuildConfigPaths(srcTauriRoot, installedSmoke = false) {
  return [
    join(srcTauriRoot, "tauri.local.conf.json"),
    ...(installedSmoke ? [join(srcTauriRoot, "tauri.installed-smoke.conf.json")] : []),
  ];
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
  identity,
) {
  const manifestIdentity = identity ?? LOCAL_FORK_IDENTITY;
  const installerStats = statSync(installerPath);
  return {
    schemaVersion: LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION,
    sourceRevision: releaseMetadata.sourceRevision,
    releaseNotes: releaseMetadata.releaseNotes,
    path: installerPath,
    size: installerStats.size,
    mtimeMs: installerStats.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(installerPath)).digest("hex"),
    identity: manifestIdentity,
    payload: {
      name: basename(payloadPath),
      ...payloadMetadata,
    },
  };
}

function writeInstallerManifest(metadata, manifestName = "latest-installer.json") {
  const outputDir = join(repoRoot, ".gg", "local-fixes");
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, manifestName);
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Verified fresh ${metadata.identity.productName} installer: ${metadata.path}`);
  console.log(`Installer SHA-256: ${metadata.sha256}`);
  console.log(`Payload SHA-256: ${metadata.payload.sha256}`);
}

// Local Fork: skip framework package builds whose inputs and output are unchanged.
export const PACKAGE_BUILD_STAMP_SCHEMA = "gg-local-package-build/1";
export const FRAMEWORK_PACKAGES = Object.freeze([
  Object.freeze({ name: "@kenkaiiii/gg-ai", dir: "gg-ai", deps: Object.freeze([]) }),
  Object.freeze({ name: "@kenkaiiii/gg-agent", dir: "gg-agent", deps: Object.freeze(["gg-ai"]) }),
  Object.freeze({ name: "@kenkaiiii/gg-core", dir: "gg-core", deps: Object.freeze(["gg-ai"]) }),
  Object.freeze({
    name: "@kenkaiiii/ggcoder",
    dir: "ggcoder",
    deps: Object.freeze(["gg-ai", "gg-agent", "gg-core"]),
  }),
]);
const PACKAGE_CONFIG_FILES = Object.freeze([
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsup.config.ts",
]);
const ROOT_BUILD_INPUT_FILES = Object.freeze(["tsconfig.json", "pnpm-lock.yaml"]);

function packageStampSha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function packageStampJson(value) {
  if (Array.isArray(value)) return `[${value.map(packageStampJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${packageStampJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPackageStampHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Content hash of every file under dir; links and special files throw so the caller builds. */
export function treeContentHash(dir, readFile = readFileSync) {
  const files = [];
  const visit = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = join(absolute, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`refusing to hash a link: ${rel}`);
      if (entry.isDirectory()) visit(path, rel);
      else if (entry.isFile())
        files.push({ path: rel, sha256: packageStampSha256(readFile(path)) });
      else throw new Error(`refusing to hash a special file: ${rel}`);
    }
  };
  if (!lstatSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  visit(dir, "");
  files.sort((a, b) => compareText(a.path, b.path));
  return { hash: packageStampSha256(packageStampJson(files)), files: files.length };
}

function optionalFileHash(path, readFile) {
  try {
    return packageStampSha256(readFile(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function packageBuildFingerprintInputs({
  root,
  pkg,
  dependencyFingerprints,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  readFile = readFileSync,
}) {
  const packageRoot = join(root, "packages", pkg.dir);
  const dependencies = {};
  for (const dir of pkg.deps) {
    const fingerprint = dependencyFingerprints[dir];
    if (!isPackageStampHash(fingerprint)) throw new Error(`no fingerprint for dependency ${dir}`);
    dependencies[dir] = fingerprint;
  }
  return {
    schema: PACKAGE_BUILD_STAMP_SCHEMA,
    package: pkg.name,
    source: treeContentHash(join(packageRoot, "src"), readFile).hash,
    config: Object.fromEntries(
      PACKAGE_CONFIG_FILES.map((name) => [
        name,
        optionalFileHash(join(packageRoot, name), readFile),
      ]),
    ),
    root: Object.fromEntries(
      ROOT_BUILD_INPUT_FILES.map((name) => [name, optionalFileHash(join(root, name), readFile)]),
    ),
    runtime: { nodeVersion, platform, arch },
    dependencies,
  };
}

export function packageBuildFingerprint(inputs) {
  return packageStampSha256(packageStampJson(inputs));
}

function packageStampChecksum({ schema, package: name, fingerprint, output }) {
  return packageStampSha256(packageStampJson({ schema, package: name, fingerprint, output }));
}

export function readPackageBuildStamp(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === "ENOENT" ? "no stamp" : `stamp unreadable (${error?.code})`,
    };
  }
  let stamp;
  try {
    stamp = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "stamp is not valid JSON" };
  }
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) {
    return { ok: false, reason: "stamp is not an object" };
  }
  if (stamp.schema !== PACKAGE_BUILD_STAMP_SCHEMA) {
    return { ok: false, reason: "stamp schema differs" };
  }
  const valid =
    typeof stamp.package === "string" &&
    isPackageStampHash(stamp.fingerprint) &&
    isPackageStampHash(stamp.output) &&
    isPackageStampHash(stamp.checksum);
  if (!valid) return { ok: false, reason: "stamp fields are malformed" };
  if (packageStampChecksum(stamp) !== stamp.checksum) {
    return { ok: false, reason: "stamp checksum mismatch" };
  }
  return { ok: true, stamp };
}

export function writePackageBuildStamp(path, { pkg, fingerprint, output }) {
  const fields = { schema: PACKAGE_BUILD_STAMP_SCHEMA, package: pkg, fingerprint, output };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ ...fields, checksum: packageStampChecksum(fields) })}\n`,
  );
  renameSync(temporary, path);
}

export function invalidatePackageBuildStamp(path) {
  rmSync(path, { force: true });
}

/** Skip only when the stamp, the inputs and the built output all agree; any doubt builds. */
export function decidePackageBuild({
  stampPath,
  pkg,
  fingerprint,
  outputDir,
  force = false,
  dependencyBuilt = false,
  readFile = readFileSync,
}) {
  try {
    if (force) return { build: true, reason: "forced" };
    if (dependencyBuilt) return { build: true, reason: "a package it depends on was rebuilt" };
    if (!fingerprint) return { build: true, reason: "inputs could not be hashed" };
    const read = readPackageBuildStamp(stampPath);
    if (!read.ok) return { build: true, reason: read.reason };
    if (read.stamp.package !== pkg) return { build: true, reason: "stamp is for another package" };
    if (read.stamp.fingerprint !== fingerprint) return { build: true, reason: "inputs changed" };
    if (!existsSync(outputDir)) return { build: true, reason: "output missing" };
    const output = treeContentHash(outputDir, readFile);
    if (output.files === 0) return { build: true, reason: "output missing" };
    if (output.hash !== read.stamp.output) {
      return { build: true, reason: "output changed since it was stamped" };
    }
    return { build: false, reason: "inputs and output unchanged" };
  } catch (error) {
    return { build: true, reason: `build check failed: ${error?.message ?? String(error)}` };
  }
}

/** Builds in dependency order; a rebuilt package rebuilds every package that depends on it. */
export function buildFrameworkPackages({
  root,
  stampDir,
  runBuild,
  packages = FRAMEWORK_PACKAGES,
  force = false,
  log = console.log,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  readFile = readFileSync,
  now = Date.now,
}) {
  const fingerprints = {};
  const built = new Set();
  const results = [];
  for (const pkg of packages) {
    const startedAt = now();
    let fingerprint = null;
    let fingerprintError = null;
    try {
      fingerprint = packageBuildFingerprint(
        packageBuildFingerprintInputs({
          root,
          pkg,
          dependencyFingerprints: fingerprints,
          nodeVersion,
          platform,
          arch,
          readFile,
        }),
      );
    } catch (error) {
      fingerprintError = error?.message ?? String(error);
    }
    fingerprints[pkg.dir] = fingerprint;
    const stampPath = join(stampDir, `${pkg.dir}.json`);
    const outputDir = join(root, "packages", pkg.dir, "dist");
    const decision = decidePackageBuild({
      stampPath,
      pkg: pkg.name,
      fingerprint,
      outputDir,
      force,
      dependencyBuilt: pkg.deps.some((dir) => built.has(dir)),
      readFile,
    });
    const reason =
      fingerprintError && decision.reason === "inputs could not be hashed"
        ? `inputs could not be hashed (${fingerprintError})`
        : decision.reason;
    if (!decision.build) {
      results.push({ name: pkg.name, built: false, reason, ms: now() - startedAt });
      log(`Skipping ${pkg.name} build: ${reason}`);
      continue;
    }
    log(`Building ${pkg.name}: ${reason}`);
    // An interrupted or failed build must leave no stamp behind.
    invalidatePackageBuildStamp(stampPath);
    const status = runBuild(pkg.name);
    if (status !== 0) {
      results.push({
        name: pkg.name,
        built: false,
        reason: `build failed (exit ${status})`,
        ms: now() - startedAt,
      });
      return { status, results };
    }
    built.add(pkg.dir);
    if (fingerprint) {
      try {
        const output = treeContentHash(outputDir, readFile);
        if (output.files === 0) throw new Error("build produced no output");
        writePackageBuildStamp(stampPath, { pkg: pkg.name, fingerprint, output: output.hash });
      } catch (error) {
        invalidatePackageBuildStamp(stampPath);
        log(`Not stamping ${pkg.name} (next run rebuilds it): ${error?.message ?? String(error)}`);
      }
    }
    results.push({ name: pkg.name, built: true, reason, ms: now() - startedAt });
  }
  return { status: 0, results };
}

export function parseLocalBuildArgs(args, platform) {
  const allowed = new Set(["--installed-smoke", "--force-package-builds"]);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length) {
    throw new Error("Usage: build-local-hotfix.mjs [--installed-smoke] [--force-package-builds]");
  }
  const installedSmoke = args.includes("--installed-smoke");
  if (installedSmoke && platform !== "win32") {
    throw new Error("Installed Smoke packaging requires Windows.");
  }
  return { installedSmoke, forcePackageBuilds: args.includes("--force-package-builds") };
}

function logStepTime(label, startedAt) {
  console.log(`Step time: ${label} ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
}

async function main() {
  const buildStartedAt = Date.now();
  const { installedSmoke, forcePackageBuilds } = parseLocalBuildArgs(
    process.argv.slice(2),
    process.platform,
  );
  const identity = installedSmoke ? INSTALLED_SMOKE_IDENTITY : LOCAL_FORK_IDENTITY;
  const configPaths = localBuildConfigPaths(srcTauri, installedSmoke);
  const releaseMetadata = committedReleaseNotes(repoRoot);
  env.VITE_GG_GIT_SHA = releaseMetadata.sourceRevision;
  const baseConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));
  const cargoTomlPath = join(srcTauri, "Cargo.toml");
  const localConfig = JSON.parse(readFileSync(configPaths[0], "utf8"));
  assertIsolatedIdentities(baseConfig, readFileSync(cargoTomlPath, "utf8"), localConfig);
  if (installedSmoke) {
    const smokeConfig = JSON.parse(readFileSync(configPaths[1], "utf8"));
    assertInstalledSmokeIdentity(localConfig, smokeConfig);
  }
  assertIdentityDataRootWiring({
    corePaths: readFileSync(join(repoRoot, "packages", "gg-core", "src", "paths.ts"), "utf8"),
    sidecarPaths: readFileSync(
      join(repoRoot, "packages", "ggcoder", "src", "app-sidecar-paths.ts"),
      "utf8",
    ),
    appSidecar: readAppSidecarSources(join(repoRoot, "packages", "ggcoder")),
    rustShell: readIdentityRustShell(srcTauri),
  });

  let stepStartedAt = Date.now();
  if (!env.GG_NODE_SOURCE) {
    const stagedNode = stagedNodePath();
    if (existsSync(stagedNode)) env.GG_NODE_SOURCE = stagedNode;
    else requireSuccess(run(pnpm, ["--filter", "gg-app", "stage:node"]));
  }
  logStepTime("stage node", stepStartedAt);
  stepStartedAt = Date.now();
  const packageBuild = buildFrameworkPackages({
    root: repoRoot,
    stampDir: join(repoRoot, ".gg", "local-fixes", "package-build-stamps"),
    force: forcePackageBuilds,
    runBuild: (packageName) => run(pnpm, ["--filter", packageName, "build"]),
  });
  for (const { name, built, ms } of packageBuild.results) {
    console.log(`Step time: ${name} ${built ? "build" : "skip"} ${(ms / 1000).toFixed(1)} s`);
  }
  requireSuccess(packageBuild.status);
  // The safety tests below exercise ggcoder, so its build step must have run last.
  if (packageBuild.results.at(-1)?.name !== "@kenkaiiii/ggcoder") {
    throw new Error("Framework package step did not finish with @kenkaiiii/ggcoder.");
  }
  logStepTime("framework packages", stepStartedAt);
  // Runs against the freshly built packages, before anything is bundled.
  stepStartedAt = Date.now();
  runPhaseLeaseRegressionGate();
  logStepTime("Roadmap safety tests", stepStartedAt);
  stepStartedAt = Date.now();
  requireSuccess(run(pnpm, ["--filter", "gg-app", "bundle:sidecar", "--reuse-deps"]));
  logStepTime("sidecar bundle", stepStartedAt);
  const bundleBuildStartedAt = Date.now();
  const buildStatus = runWithCargoTomlRestored(cargoTomlPath, () =>
    run(pnpm, tauriBuildArgs(process.platform, configPaths), localCargoBuildEnv(env)),
  );
  logStepTime("Tauri build", bundleBuildStartedAt);
  if (buildStatus !== 0) process.exit(buildStatus);
  const installer = freshInstallerForPlatform(
    srcTauri,
    process.platform,
    bundleBuildStartedAt,
    identity,
  );
  if (!installer) {
    console.error(`Tauri did not produce exactly one fresh ${identity.productName} installer.`);
    process.exit(1);
  }
  const payload = join(srcTauri, "target", "release", identity.executableName);
  if (!existsSync(payload)) {
    console.error(`Tauri did not produce the expected payload: ${payload}`);
    process.exit(1);
  }
  const payloadMetadata =
    process.platform === "win32" ? windowsNsisPayloadMetadata(payload) : fileMetadata(payload);
  writeInstallerManifest(
    installerManifest(installer, payload, releaseMetadata, payloadMetadata, identity),
    installedSmoke ? INSTALLED_SMOKE_MANIFEST_NAME : undefined,
  );
  logStepTime("total", buildStartedAt);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
