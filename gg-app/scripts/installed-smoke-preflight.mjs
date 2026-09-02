import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  INSTALLED_SMOKE_IDENTITY,
  INSTALLED_SMOKE_MANIFEST_NAME,
  LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION,
} from "./build-local-hotfix.mjs";

export function fileMetadata(path) {
  const bytes = readFileSync(path);
  return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function validateInstalledSmokeManifest(manifestPath, options = {}) {
  if (basename(manifestPath) !== INSTALLED_SMOKE_MANIFEST_NAME) {
    throw new Error(`Installed Smoke requires ${INSTALLED_SMOKE_MANIFEST_NAME}.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Installed Smoke manifest is missing or invalid JSON.");
  }
  if (manifest?.schemaVersion !== LOCAL_INSTALLER_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Installed Smoke manifest schema is unsupported.");
  }
  const expectedIdentityEntries = Object.entries(INSTALLED_SMOKE_IDENTITY);
  if (
    !manifest.identity ||
    Object.keys(manifest.identity).length !== expectedIdentityEntries.length ||
    expectedIdentityEntries.some(([key, value]) => manifest.identity[key] !== value)
  ) {
    throw new Error("Installed Smoke manifest must use the dedicated Installed Smoke identity.");
  }
  if (typeof manifest.path !== "string" || !isAbsolute(manifest.path)) {
    throw new Error("Installed Smoke installer path must be absolute.");
  }
  if (
    !/^GG Coder Local Fork Installed Smoke_[^_]+_[^_]+-setup\.exe$/.test(basename(manifest.path))
  ) {
    throw new Error("Installed Smoke manifest names a non-smoke installer.");
  }
  if (options.allowedInstallerRoot && !pathIsWithin(options.allowedInstallerRoot, manifest.path)) {
    throw new Error("Installed Smoke installer is outside the NSIS output directory.");
  }
  if (options.expectedRevision && manifest.sourceRevision !== options.expectedRevision) {
    throw new Error("Installed Smoke manifest does not match the checked-out revision.");
  }
  if (
    !manifest.payload ||
    manifest.payload.name !== INSTALLED_SMOKE_IDENTITY.executableName ||
    !Number.isSafeInteger(manifest.payload.size) ||
    manifest.payload.size < 1 ||
    !/^[0-9a-f]{64}$/.test(manifest.payload.sha256)
  ) {
    throw new Error("Installed Smoke manifest payload identity or hash is invalid.");
  }
  if (!existsSync(manifest.path)) throw new Error("Installed Smoke installer is missing.");
  const actual = fileMetadata(manifest.path);
  if (
    !Number.isSafeInteger(manifest.size) ||
    manifest.size !== actual.size ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    manifest.sha256 !== actual.sha256
  ) {
    throw new Error("Installed Smoke installer size or SHA-256 mismatch.");
  }
  return manifest;
}

function unquotedPath(path) {
  return String(path)
    .trim()
    .replace(/^"(.*)"$/, "$1");
}

function canonicalPath(path) {
  const unquoted = unquotedPath(path);
  return existsSync(unquoted) ? realpathSync(unquoted) : resolve(unquoted);
}

function pathIsWithin(root, candidate) {
  const offset = relative(canonicalPath(root), canonicalPath(candidate));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

export function assertInstalledSmokePaths({
  installerPath,
  stageRoot,
  activeExecutablePaths = [],
  registeredInstallPaths = [],
}) {
  const protectedRoots = [
    ...activeExecutablePaths.map((path) => dirname(unquotedPath(path))),
    ...registeredInstallPaths.map(unquotedPath),
  ].filter(Boolean);
  for (const candidate of [installerPath, stageRoot]) {
    if (protectedRoots.some((root) => pathIsWithin(root, candidate))) {
      throw new Error(
        `Installed Smoke refused an active or registered Local Fork path: ${candidate}`,
      );
    }
  }
  return true;
}

export function runInstalledSmokePreflight({
  manifestPath,
  stageRoot,
  inspectSystemPaths,
  execute,
  validationOptions,
}) {
  const manifest = validateInstalledSmokeManifest(manifestPath, validationOptions);
  assertInstalledSmokePaths({
    installerPath: manifest.path,
    stageRoot,
    ...inspectSystemPaths(),
  });
  return execute(manifest);
}
