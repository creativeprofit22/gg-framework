import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProductionIdentity,
  LOCAL_TAURI_CONFIG,
  PRODUCTION_IDENTITY,
} from "./build-local-hotfix.mjs";

const srcTauri = join(import.meta.dirname, "..", "src-tauri");
const baseConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));
const cargoToml = readFileSync(join(srcTauri, "Cargo.toml"), "utf8");

describe("local-patched native identity", () => {
  it("preserves the production package identity and changes only updater artifact creation", () => {
    expect(LOCAL_TAURI_CONFIG).toEqual({ bundle: { createUpdaterArtifacts: false } });
    expect(assertProductionIdentity(baseConfig, cargoToml)).toEqual(PRODUCTION_IDENTITY);
    expect({
      ...baseConfig,
      ...LOCAL_TAURI_CONFIG,
      bundle: { ...baseConfig.bundle, ...LOCAL_TAURI_CONFIG.bundle },
    }).toMatchObject({
      productName: "GG Coder",
      identifier: "com.ggcoder.app",
      bundle: {
        createUpdaterArtifacts: false,
        windows: { nsis: { installMode: "currentUser" } },
      },
    });
    expect(PRODUCTION_IDENTITY).toEqual({
      productName: "GG Coder",
      identifier: "com.ggcoder.app",
      mainBinaryName: "gg-app",
      executableName: "gg-app.exe",
      installMode: "currentUser",
    });
  });

  it.each(["productName", "identifier", "mainBinaryName"])(
    "rejects a local %s identity override",
    (key) => {
      expect(() =>
        assertProductionIdentity(baseConfig, cargoToml, {
          ...LOCAL_TAURI_CONFIG,
          [key]: "local-fork",
        }),
      ).toThrow("Local Tauri config overrides production identity");
    },
  );

  it("fails closed when a production identity source drifts", () => {
    expect(() =>
      assertProductionIdentity({ ...baseConfig, productName: "GG Coder Fork" }, cargoToml),
    ).toThrow("Expected production productName GG Coder");
    expect(() =>
      assertProductionIdentity(baseConfig, cargoToml.replace('name = "gg-app"', 'name = "fork"')),
    ).toThrow("Expected production main binary gg-app");
  });
});
