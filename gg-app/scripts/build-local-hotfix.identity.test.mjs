import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertIdentityDataRootWiring,
  assertInstalledSmokeIdentity,
  assertIsolatedIdentities,
  INSTALLED_SMOKE_IDENTITY,
  INSTALLED_SMOKE_TAURI_CONFIG,
  LOCAL_FORK_IDENTITY,
  LOCAL_TAURI_CONFIG,
} from "./build-local-hotfix.mjs";

const srcTauri = join(import.meta.dirname, "..", "src-tauri");
const baseConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));
const localConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.local.conf.json"), "utf8"));
const installedSmokeConfig = JSON.parse(
  readFileSync(join(srcTauri, "tauri.installed-smoke.conf.json"), "utf8"),
);
const installedSmokeHooks = readFileSync(
  join(srcTauri, "windows", "nsis-installed-smoke-hooks.nsh"),
  "utf8",
);
const cargoToml = readFileSync(join(srcTauri, "Cargo.toml"), "utf8");
const repoRoot = join(import.meta.dirname, "..", "..");
const identityDataSources = {
  corePaths: readFileSync(join(repoRoot, "packages", "gg-core", "src", "paths.ts"), "utf8"),
  sidecarPaths: readFileSync(
    join(repoRoot, "packages", "ggcoder", "src", "app-sidecar-paths.ts"),
    "utf8",
  ),
  appSidecar: readFileSync(join(repoRoot, "packages", "ggcoder", "src", "app-sidecar.ts"), "utf8"),
  rustShell: readFileSync(join(srcTauri, "src", "lib.rs"), "utf8"),
};

describe("Local Fork native identity", () => {
  it("preserves production config and supplies a fully isolated local overlay", () => {
    expect(localConfig).toMatchObject(LOCAL_TAURI_CONFIG);
    expect(assertIsolatedIdentities(baseConfig, cargoToml, localConfig)).toEqual(
      LOCAL_FORK_IDENTITY,
    );
    expect(LOCAL_FORK_IDENTITY).toEqual({
      productName: "GG Coder Local Fork",
      identifier: "com.ggcoder.local-fork",
      mainBinaryName: "gg-coder-local-fork",
      executableName:
        process.platform === "win32" ? "gg-coder-local-fork.exe" : "gg-coder-local-fork",
      installMode: "currentUser",
    });
    expect(localConfig.bundle.createUpdaterArtifacts).toBe(false);
    expect(localConfig.plugins.updater.endpoints).toEqual([]);
    expect(baseConfig).toMatchObject({
      productName: "GG Coder",
      identifier: "com.ggcoder.app",
      bundle: { createUpdaterArtifacts: true },
    });
  });

  it.each(["productName", "identifier", "mainBinaryName"])(
    "rejects a missing or incorrect local %s override",
    (key) => {
      expect(() =>
        assertIsolatedIdentities(baseConfig, cargoToml, {
          ...localConfig,
          [key]: "production-collision",
        }),
      ).toThrow("Local Fork identity must be fully isolated");
    },
  );

  it("fails closed when production identity drifts", () => {
    expect(() =>
      assertIsolatedIdentities({ ...baseConfig, productName: "GG Coder Fork" }, cargoToml),
    ).toThrow("Canonical production Tauri identity drifted");
    expect(() =>
      assertIsolatedIdentities(baseConfig, cargoToml.replace('name = "gg-app"', 'name = "fork"')),
    ).toThrow("Canonical production binary drifted");
  });

  it("requires identity-root wiring with a production legacy-path exception", () => {
    expect(assertIdentityDataRootWiring(identityDataSources)).toBe(true);

    expect(() =>
      assertIdentityDataRootWiring({
        ...identityDataSources,
        corePaths: identityDataSources.corePaths.replace("path.isAbsolute(override)", "true"),
      }),
    ).toThrow("gg-core must reject relative overrides");

    expect(() =>
      assertIdentityDataRootWiring({
        ...identityDataSources,
        rustShell: identityDataSources.rustShell.replace(
          "if identifier == PRODUCTION_APP_IDENTIFIER",
          "if false",
        ),
      }),
    ).toThrow("production must keep the legacy Rust data root");

    expect(() =>
      assertIdentityDataRootWiring({
        ...identityDataSources,
        rustShell: identityDataSources.rustShell.replace(
          'cmd.env("GG_AGENT_DIR", &identity_data_root);',
          "// missing identity override",
        ),
      }),
    ).toThrow(
      "production must clear inherited GG_AGENT_DIR and non-production sidecars must set it",
    );

    expect(() =>
      assertIdentityDataRootWiring({
        ...identityDataSources,
        rustShell: identityDataSources.rustShell.replace(
          'cmd.env_remove("GG_AGENT_DIR");',
          "// missing production environment cleanup",
        ),
      }),
    ).toThrow(
      "production must clear inherited GG_AGENT_DIR and non-production sidecars must set it",
    );
  });
});

describe("Installed Smoke native identity", () => {
  it("uses distinct app, executable, uninstall, hook, and updater identities", () => {
    expect(installedSmokeConfig).toMatchObject(INSTALLED_SMOKE_TAURI_CONFIG);
    expect(assertInstalledSmokeIdentity(localConfig, installedSmokeConfig)).toEqual(
      INSTALLED_SMOKE_IDENTITY,
    );
    expect(installedSmokeConfig.productName).not.toBe(localConfig.productName);
    expect(installedSmokeConfig.identifier).not.toBe(localConfig.identifier);
    expect(installedSmokeConfig.mainBinaryName).not.toBe(localConfig.mainBinaryName);
    expect(
      `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${installedSmokeConfig.productName}`,
    ).not.toBe(
      `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${localConfig.productName}`,
    );
    expect(installedSmokeConfig.bundle.windows.nsis.installerHooks).toBe(
      "windows/nsis-installed-smoke-hooks.nsh",
    );
    expect(installedSmokeConfig.bundle.createUpdaterArtifacts).toBe(false);
    expect(installedSmokeConfig.plugins.updater.endpoints).toEqual([]);
    expect(installedSmokeHooks).not.toMatch(
      /taskkill|NSIS_HOOK_PREINSTALL|NSIS_HOOK_PREUNINSTALL/i,
    );
  });

  it.each(["productName", "identifier", "mainBinaryName"])(
    "rejects a Local Fork collision in %s",
    (key) => {
      expect(() =>
        assertInstalledSmokeIdentity(localConfig, {
          ...installedSmokeConfig,
          [key]: localConfig[key],
        }),
      ).toThrow();
    },
  );

  it("rejects the Local Fork hook and enabled updater endpoints", () => {
    expect(() =>
      assertInstalledSmokeIdentity(localConfig, {
        ...installedSmokeConfig,
        bundle: {
          ...installedSmokeConfig.bundle,
          windows: { nsis: localConfig.bundle.windows.nsis },
        },
      }),
    ).toThrow("dedicated NSIS hook");
    expect(() =>
      assertInstalledSmokeIdentity(localConfig, {
        ...installedSmokeConfig,
        plugins: { updater: { endpoints: ["https://updates.example.invalid"] } },
      }),
    ).toThrow("must not use an updater endpoint");
  });
});
