import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAndPromoteDirectory,
  copyPackage,
  selectedOptionalDependencies,
} from "./bundle-sidecar.mjs";

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

function createPromotionFixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-sidecar-promotion-"));
  temporaryDirectories.push(root);
  const live = join(root, "sidecar");
  mkdirSync(live);
  writeFileSync(join(live, "payload.bin"), Buffer.from([0, 1, 2, 255]));
  return { root, live, oldPayload: readFileSync(join(live, "payload.bin")) };
}

function expectOldPayloadIntact(live, oldPayload) {
  expect(readFileSync(join(live, "payload.bin"))).toEqual(oldPayload);
}

describe("sidecar candidate promotion", () => {
  it("leaves the live output byte-for-byte intact when the build fails", async () => {
    const { live, oldPayload } = createPromotionFixture();

    await expect(
      buildAndPromoteDirectory(
        live,
        async (candidate) => {
          writeFileSync(join(candidate, "partial.bin"), "partial");
          throw new Error("build failed");
        },
        () => {},
      ),
    ).rejects.toThrow("build failed");

    expectOldPayloadIntact(live, oldPayload);
    expect(existsSync(`${live}.candidate`)).toBe(false);
  });

  it("leaves the live output byte-for-byte intact when validation fails", async () => {
    const { live, oldPayload } = createPromotionFixture();

    await expect(
      buildAndPromoteDirectory(
        live,
        async (candidate) => writeFileSync(join(candidate, "payload.bin"), "invalid"),
        () => {
          throw new Error("validation failed");
        },
      ),
    ).rejects.toThrow("validation failed");

    expectOldPayloadIntact(live, oldPayload);
  });

  it("replaces the live output only after successful validation", async () => {
    const { live } = createPromotionFixture();

    await buildAndPromoteDirectory(
      live,
      async (candidate) => writeFileSync(join(candidate, "payload.bin"), "new"),
      (candidate) => expect(readFileSync(join(candidate, "payload.bin"), "utf8")).toBe("new"),
    );

    expect(readFileSync(join(live, "payload.bin"), "utf8")).toBe("new");
    expect(existsSync(`${live}.previous`)).toBe(false);
  });

  it("removes a stale candidate without touching the live output", async () => {
    const { live, oldPayload } = createPromotionFixture();
    mkdirSync(`${live}.candidate`);
    writeFileSync(join(`${live}.candidate`, "stale.bin"), "stale");

    await buildAndPromoteDirectory(
      live,
      async (candidate) => {
        expect(existsSync(join(candidate, "stale.bin"))).toBe(false);
        expectOldPayloadIntact(live, oldPayload);
        writeFileSync(join(candidate, "payload.bin"), "fresh");
      },
      () => {},
    );

    expect(readFileSync(join(live, "payload.bin"), "utf8")).toBe("fresh");
  });

  it("rolls back cleanly when Windows-style candidate rename fails", async () => {
    const { live, oldPayload } = createPromotionFixture();
    const candidate = `${live}.candidate`;

    await expect(
      buildAndPromoteDirectory(
        live,
        async (directory) => writeFileSync(join(directory, "payload.bin"), "new"),
        () => {},
        {
          rename(from, to) {
            if (from === candidate && to === live) {
              const error = new Error("file is locked");
              error.code = "EPERM";
              throw error;
            }
            renameSync(from, to);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "EPERM" });

    expectOldPayloadIntact(live, oldPayload);
    expect(existsSync(`${live}.previous`)).toBe(false);
    expect(existsSync(candidate)).toBe(false);
  });
});
