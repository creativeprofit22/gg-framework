import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  freshInstallerForPlatform,
  installerManifest,
  LOCAL_FORK_IDENTITY,
  runWithCargoTomlRestored,
  tauriBuildArgs,
  windowsNsisPayloadMetadata,
} from "./build-local-hotfix.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function fixture(): { root: string; nsis: string } {
  const root = mkdtempSync(join(tmpdir(), "gg-local-installer-"));
  temporaryDirectories.push(root);
  const nsis = join(root, "target", "release", "bundle", "nsis");
  mkdirSync(nsis, { recursive: true });
  return { root, nsis };
}

describe("local installer freshness", () => {
  it("selects the exact Local Fork Windows NSIS installer after build start", () => {
    const { root, nsis } = fixture();
    const startedAt = Date.now();
    const installer = join(nsis, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    writeFileSync(installer, "installer");
    const completedAt = new Date(startedAt + 1_000);
    utimesSync(installer, completedAt, completedAt);

    expect(freshInstallerForPlatform(root, "win32", startedAt)).toBe(installer);
  });

  it("rejects stale and non-Local Fork Windows installers", () => {
    const { root, nsis } = fixture();
    const staleInstaller = join(nsis, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    const localForkInstaller = join(nsis, "GG Coder_1.2.3_x64-setup.exe");
    writeFileSync(staleInstaller, "stale installer");
    writeFileSync(localForkInstaller, "wrong identity");
    const old = new Date(Date.now() - 60_000);
    utimesSync(staleInstaller, old, old);

    expect(freshInstallerForPlatform(root, "win32", Date.now())).toBeNull();
  });

  it("rejects ambiguous fresh Local Fork installers", () => {
    const { root, nsis } = fixture();
    const startedAt = Date.now();
    for (const name of [
      "GG Coder Local Fork_1.2.3_x64-setup.exe",
      "GG Coder Local Fork_1.2.4_x64-setup.exe",
    ]) {
      const installer = join(nsis, name);
      writeFileSync(installer, name);
      const completedAt = new Date(startedAt + 1_000);
      utimesSync(installer, completedAt, completedAt);
    }

    expect(() => freshInstallerForPlatform(root, "win32", startedAt)).toThrow(
      "multiple fresh Local Fork NSIS installers",
    );
  });
});

describe("local installer manifest", () => {
  it("hashes the NSIS-patched payload bytes that Tauri embeds", () => {
    const { root } = fixture();
    const payload = join(root, "target", "release", "gg-coder-local-fork.exe");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    const sourceBytes = Buffer.from("before__TAURI_BUNDLE_TYPE_VAR_UNKafter");
    const installerBytes = Buffer.from("before__TAURI_BUNDLE_TYPE_VAR_NSSafter");
    writeFileSync(payload, sourceBytes);

    expect(windowsNsisPayloadMetadata(payload)).toEqual({
      size: sourceBytes.length,
      sha256: createHash("sha256").update(installerBytes).digest("hex"),
    });
  });

  it("fails closed when the Tauri bundle marker is absent", () => {
    const { root } = fixture();
    const payload = join(root, "target", "release", "gg-coder-local-fork.exe");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(payload, "payload without marker");

    expect(() => windowsNsisPayloadMetadata(payload)).toThrow(
      "Expected exactly one unpatched Tauri bundle-type marker",
    );
  });

  it("keeps installer compatibility fields and authenticates the Local Fork payload", () => {
    const { root, nsis } = fixture();
    const installer = join(nsis, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    const payload = join(root, "target", "release", "gg-coder-local-fork.exe");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(installer, "installer bytes");
    writeFileSync(payload, "payload bytes");

    const manifest = installerManifest(installer, payload);

    expect(manifest).toMatchObject({
      path: installer,
      size: Buffer.byteLength("installer bytes"),
      schemaVersion: 1,
      identity: LOCAL_FORK_IDENTITY,
      payload: {
        name: "gg-coder-local-fork.exe",
        size: Buffer.byteLength("payload bytes"),
      },
    });
    expect(manifest.mtimeMs).toBeGreaterThan(0);
    expect(manifest.sha256).toBe(createHash("sha256").update("installer bytes").digest("hex"));
    expect(manifest.payload.sha256).toBe(
      createHash("sha256").update("payload bytes").digest("hex"),
    );
  });
});

describe("Tauri build arguments", () => {
  it("selects only NSIS on Windows and preserves non-Windows bundles", () => {
    const configPath = "local-config.json";

    expect(tauriBuildArgs("win32", configPath)).toEqual([
      "--filter",
      "gg-app",
      "tauri",
      "build",
      "--bundles",
      "nsis",
      "--no-sign",
      "--config",
      configPath,
    ]);
    expect(tauriBuildArgs("darwin", configPath)).toEqual([
      "--filter",
      "gg-app",
      "tauri",
      "build",
      "--no-sign",
      "--config",
      configPath,
    ]);
  });
});

describe("Cargo.toml restoration", () => {
  const originalCargoToml = Buffer.from(
    '[package]\r\nname = "gg-app"\r\nversion = "1.2.3"\r\n',
    "utf8",
  );

  function cargoFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "gg-local-cargo-"));
    temporaryDirectories.push(root);
    const cargoTomlPath = join(root, "Cargo.toml");
    writeFileSync(cargoTomlPath, originalCargoToml);
    return cargoTomlPath;
  }

  it("restores the original CRLF bytes after a successful build", () => {
    const cargoTomlPath = cargoFixture();

    const result = runWithCargoTomlRestored(cargoTomlPath, () => {
      writeFileSync(cargoTomlPath, '[package]\nversion = "9.9.9"\n');
      return 0;
    });

    expect(result).toBe(0);
    expect(readFileSync(cargoTomlPath)).toEqual(originalCargoToml);
  });

  it("restores the original CRLF bytes after a throwing build", () => {
    const cargoTomlPath = cargoFixture();
    const buildError = new Error("Tauri failed");

    expect(() =>
      runWithCargoTomlRestored(cargoTomlPath, () => {
        writeFileSync(cargoTomlPath, '[package]\nversion = "9.9.9"\n');
        throw buildError;
      }),
    ).toThrow(buildError);
    expect(readFileSync(cargoTomlPath)).toEqual(originalCargoToml);
  });
});
