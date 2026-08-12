import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { copyPackage, selectedOptionalDependencies } from "./bundle-sidecar.mjs";

const sharpOptionalDependencies = {
  "@img/colour": "1.1.0",
  "@img/sharp-darwin-arm64": "0.34.5",
  "@img/sharp-linux-x64": "0.34.5",
  "@img/sharp-wasm32": "0.34.5",
  "@img/sharp-win32-arm64": "0.34.5",
  "@img/sharp-win32-ia32": "0.34.5",
  "@img/sharp-win32-x64": "0.34.5",
};

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createPackage(root, name, manifest = {}) {
  const directory = join(root, "node_modules", ...name.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", ...manifest }),
  );
  writeFileSync(join(directory, "payload.txt"), name);
}

function createSharpFixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-sharp-copy-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  createPackage(root, "sharp", { optionalDependencies: sharpOptionalDependencies });
  for (const name of Object.keys(sharpOptionalDependencies)) createPackage(root, name);
  return root;
}

describe("sidecar optional dependency selection", () => {
  it("copies only the required Sharp payloads on Windows x64", () => {
    const root = createSharpFixture();
    const destination = join(root, "staged", "node_modules");

    copyPackage("sharp", createRequire(join(root, "package.json")), root, new Set(), {
      destination,
      platform: "win32",
      arch: "x64",
    });

    expect(existsSync(join(destination, "sharp", "payload.txt"))).toBe(true);
    expect(existsSync(join(destination, "@img", "colour", "payload.txt"))).toBe(true);
    expect(existsSync(join(destination, "@img", "sharp-win32-x64", "payload.txt"))).toBe(true);
    expect(existsSync(join(destination, "@img", "sharp-linux-x64"))).toBe(false);
    expect(existsSync(join(destination, "@img", "sharp-win32-arm64"))).toBe(false);
  });

  it("preserves generic optional dependencies for unrelated packages", () => {
    const optionalDependencies = { "native-a": "1.0.0", "native-b": "2.0.0" };
    expect(selectedOptionalDependencies("unrelated", optionalDependencies, "win32", "x64")).toEqual(
      ["native-a", "native-b"],
    );
  });

  it("preserves existing Sharp behavior on other supported hosts", () => {
    expect(
      selectedOptionalDependencies("sharp", sharpOptionalDependencies, "darwin", "arm64"),
    ).toEqual(Object.keys(sharpOptionalDependencies));
  });

  it("fails before copying Sharp for an unsupported Windows host architecture", () => {
    const root = createSharpFixture();
    const destination = join(root, "staged", "node_modules");

    expect(() =>
      copyPackage("sharp", createRequire(join(root, "package.json")), root, new Set(), {
        destination,
        platform: "win32",
        arch: "arm64",
      }),
    ).toThrow("sharp has no supported Windows host selection for win32/arm64");
    expect(existsSync(destination)).toBe(false);
  });
});
