import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALLED_SMOKE_IDENTITY,
  INSTALLED_SMOKE_MANIFEST_NAME,
  LOCAL_FORK_IDENTITY,
} from "./build-local-hotfix.mjs";
import {
  runInstalledSmokePreflight,
  validateInstalledSmokeManifest,
} from "./installed-smoke-preflight.mjs";
import {
  assertInstalledSmokeRegistration,
  assertSystemPathsUnchanged,
  installedSmokeInstallerArgs,
  installVerifiedSmoke,
} from "./smoke-built-local-fork.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-installed-smoke-manifest-"));
  temporaryDirectories.push(root);
  const installer = join(root, "GG Coder Local Fork Installed Smoke_1.2.3_x64-setup.exe");
  const bytes = Buffer.from("installed smoke installer");
  writeFileSync(installer, bytes);
  const stats = statSync(installer);
  const manifestPath = join(root, INSTALLED_SMOKE_MANIFEST_NAME);
  const manifest = {
    schemaVersion: 2,
    sourceRevision: "a".repeat(40),
    releaseNotes: { size: 1, sha256: "b".repeat(64), base64: "eA==" },
    path: installer,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    identity: INSTALLED_SMOKE_IDENTITY,
    payload: {
      name: INSTALLED_SMOKE_IDENTITY.executableName,
      size: 123,
      sha256: "c".repeat(64),
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, installer, manifestPath, manifest };
}

function rewriteManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("Installed Smoke manifest trust boundary", () => {
  it("accepts only the dedicated identity, artifact name, size, and hashes", () => {
    const { installer, manifestPath } = fixture();

    expect(validateInstalledSmokeManifest(manifestPath)).toMatchObject({
      path: installer,
      identity: INSTALLED_SMOKE_IDENTITY,
      payload: { name: INSTALLED_SMOKE_IDENTITY.executableName },
    });
  });

  it("rejects production identity before any process inspection or execution", () => {
    const { root, manifestPath, manifest } = fixture();
    rewriteManifest(manifestPath, { ...manifest, identity: LOCAL_FORK_IDENTITY });
    const inspectSystemPaths = vi.fn();
    const execute = vi.fn();

    expect(() =>
      runInstalledSmokePreflight({
        manifestPath,
        stageRoot: join(root, "stage"),
        inspectSystemPaths,
        execute,
      }),
    ).toThrow("dedicated Installed Smoke identity");
    expect(inspectSystemPaths).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      "production installer filename",
      (manifest) => ({
        ...manifest,
        path: join(dirname(manifest.path), "GG Coder Local Fork_1.2.3_x64-setup.exe"),
      }),
    ],
    ["wrong size", (manifest) => ({ ...manifest, size: manifest.size + 1 })],
    ["wrong hash", (manifest) => ({ ...manifest, sha256: "0".repeat(64) })],
    [
      "production payload",
      (manifest) => ({
        ...manifest,
        payload: { ...manifest.payload, name: LOCAL_FORK_IDENTITY.executableName },
      }),
    ],
  ])("rejects %s", (_label, mutate) => {
    const { manifestPath, manifest } = fixture();
    const changed = mutate(manifest);
    rewriteManifest(manifestPath, changed);

    expect(() => validateInstalledSmokeManifest(manifestPath)).toThrow();
  });

  it("rejects active and registered production paths before running the installer", () => {
    const { root, installer, manifestPath } = fixture();
    const execute = vi.fn();

    expect(() =>
      runInstalledSmokePreflight({
        manifestPath,
        stageRoot: join(root, "stage"),
        inspectSystemPaths: () => ({
          activeExecutablePaths: [join(root, "gg-coder-local-fork.exe")],
          registeredInstallPaths: [`"${root}"`],
        }),
        execute,
      }),
    ).toThrow("active or registered Local Fork path");
    expect(execute).not.toHaveBeenCalled();
    expect(installer.startsWith(root)).toBe(true);
  });

  it("executes only after manifest and path checks pass", () => {
    const { root, installer, manifestPath } = fixture();
    const execute = vi.fn((manifest) => manifest.path);

    expect(
      runInstalledSmokePreflight({
        manifestPath,
        stageRoot: join(root, "stage"),
        inspectSystemPaths: () => ({
          activeExecutablePaths: [join(root, "elsewhere", "gg-coder-local-fork.exe")],
          registeredInstallPaths: [join(root, "elsewhere")],
        }),
        execute,
      }),
    ).toBe(installer);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects stale revisions and installers outside the allowed NSIS root", () => {
    const { root, manifestPath } = fixture();

    expect(() =>
      validateInstalledSmokeManifest(manifestPath, {
        allowedInstallerRoot: join(root, "elsewhere"),
      }),
    ).toThrow("outside the NSIS output directory");
    expect(() =>
      validateInstalledSmokeManifest(manifestPath, {
        allowedInstallerRoot: root,
        expectedRevision: "d".repeat(40),
      }),
    ).toThrow("does not match the checked-out revision");
  });
});

describe("Installed Smoke runtime contract", () => {
  it("places silent switches before the final NSIS install-directory switch", () => {
    const stageRoot = join(tmpdir(), "gg-installed-smoke-test", "package");
    expect(installedSmokeInstallerArgs(stageRoot)).toEqual(["/S", "/NS", `/D=${stageRoot}`]);
  });

  it("executes NSIS immediately after the complete preflight", () => {
    const { root, installer, manifestPath, manifest } = fixture();
    const stageRoot = join(root, "stage");
    const executeInstaller = vi.fn();

    expect(
      installVerifiedSmoke({
        candidateManifestPath: manifestPath,
        stageRoot,
        expectedRevision: manifest.sourceRevision,
        allowedInstallerRoot: root,
        inspectSystemPaths: () => ({
          activeExecutablePaths: [join(root, "protected", "gg-coder-local-fork.exe")],
          registeredInstallPaths: [join(root, "protected")],
        }),
        executeInstaller,
      }),
    ).toMatchObject({ path: installer });
    expect(executeInstaller).toHaveBeenCalledWith(installer, ["/S", "/NS", `/D=${stageRoot}`]);
  });

  it("requires the disposable registration and uninstaller under the stage root", () => {
    const root = mkdtempSync(join(tmpdir(), "gg-installed-smoke-registration-"));
    temporaryDirectories.push(root);
    const stageRoot = join(root, "package");
    mkdirSync(stageRoot);
    writeFileSync(join(stageRoot, "uninstall.exe"), "uninstaller");

    expect(assertInstalledSmokeRegistration({ InstallLocation: stageRoot }, stageRoot)).toBe(
      join(stageRoot, "uninstall.exe"),
    );
    expect(() =>
      assertInstalledSmokeRegistration({ InstallLocation: join(root, "other") }, stageRoot),
    ).toThrow("outside the temporary stage root");
  });

  it("detects any protected process or registration path change", () => {
    const before = {
      activeExecutablePaths: ["C:\\Apps\\gg-app.exe"],
      registeredInstallPaths: ["C:\\Apps"],
    };
    expect(assertSystemPathsUnchanged(before, before)).toBe(true);
    expect(() =>
      assertSystemPathsUnchanged(before, { ...before, registeredInstallPaths: ["C:\\Other"] }),
    ).toThrow("changed protected system paths");
  });
});
