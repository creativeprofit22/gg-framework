import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertIsolatedIdentities,
  LOCAL_FORK_IDENTITY,
  LOCAL_TAURI_CONFIG,
} from "./build-local-hotfix.mjs";

const srcTauri = join(import.meta.dirname, "..", "src-tauri");
const baseConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));
const localConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.local.conf.json"), "utf8"));
const cargoToml = readFileSync(join(srcTauri, "Cargo.toml"), "utf8");

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
});
