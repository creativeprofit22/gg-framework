import {
  copyFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAndPromoteDirectory,
  copyPackage,
  pruneAllowlistedPackagePayloads,
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

function createDirectorySymlinkOrSkip(target, link) {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EACCES", "ENOSYS", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
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

function writeFixtureFile(root, relativePath, content = relativePath) {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createVersionedPackage(nodeModules, name, version, files) {
  const root = join(nodeModules, ...name.split("/"));
  mkdirSync(root, { recursive: true });
  writeFixtureFile(root, "package.json", JSON.stringify({ name, version }));
  for (const file of files) writeFixtureFile(root, file);
  return root;
}

function createPackagePruneFixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-sidecar-prune-"));
  temporaryDirectories.push(root);
  const nodeModules = join(root, "node_modules");

  createVersionedPackage(nodeModules, "onnxruntime-web", "1.26.0-dev.20260416-b7804b056c", [
    "README.md",
    "__commit.txt",
    "types.d.ts",
    "dist/ort.node.min.js",
    "dist/ort.node.min.mjs",
    "dist/ort-wasm-simd-threaded.jsep.wasm",
    "docs/webgl-operators.md",
    "lib/index.ts",
  ]);
  createVersionedPackage(nodeModules, "@huggingface/transformers", "4.2.0", [
    "LICENSE",
    "dist/ort-wasm-simd-threaded.jsep.mjs",
    "dist/transformers.js",
    "dist/transformers.min.js",
    "dist/transformers.node.cjs",
    "dist/transformers.node.min.cjs",
    "dist/transformers.node.min.mjs",
    "dist/transformers.node.mjs",
    "dist/transformers.web.js",
    "dist/transformers.web.min.js",
  ]);
  createVersionedPackage(nodeModules, "ogg-opus-decoder", "1.7.5", [
    "index.js",
    "types.d.ts",
    "dist/ogg-opus-decoder.min.js",
    "dist/ogg-opus-decoder.opus-ml.min.js",
  ]);
  createVersionedPackage(nodeModules, "@wasm-audio-decoders/opus-ml", "0.0.3", [
    "index.js",
    "types.d.ts",
    "dist/opus-ml-decoder.min.js",
  ]);
  createVersionedPackage(nodeModules, "@mixmark-io/domino", "2.2.0", [
    "LICENSE",
    "test/domino.js",
    "test/fixture/data.txt",
    "test/html5lib-tests.json",
    "test/index.js",
    "test/parsing.js",
    "test/tools/tool.js",
    "test/w3c/test.js",
    "test/web-platform-blocklist.json",
    "test/web-platform-tests.js",
    "test/xss.js",
    ".yarn/plugins/plugin.cjs",
    ".yarn/versions/version.yml",
  ]);
  createVersionedPackage(nodeModules, "@anthropic-ai/sandbox-runtime", "0.0.75", [
    "LICENSE",
    "dist/cli.js",
    "vendor/java-proxy-agent/build.ts",
    "vendor/java-proxy-agent/srt-proxy-agent.jar",
    "vendor/seccomp/arm64/apply-seccomp",
    "vendor/seccomp/build.ts",
    "vendor/seccomp/x64/apply-seccomp",
    "vendor/srt-win/arm64/srt-win.exe",
    "vendor/srt-win/build.ts",
    "vendor/srt-win/x64/srt-win.exe",
  ]);
  return { nodeModules };
}

// Resolve from the actual dependency graph, never scan parallel versions in .pnpm.
function installedPackageRoot(name, fromManifest) {
  const require = createRequire(fromManifest);
  let directory = dirname(require.resolve(name));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) {
      return realpathSync(directory);
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate installed ${name}`);
    directory = parent;
  }
}

function createInstalledPruneFixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-installed-prune-"));
  temporaryDirectories.push(root);
  const nodeModules = join(root, "node_modules");
  const manifest = fileURLToPath(new URL("../../packages/ggcoder/package.json", import.meta.url));
  const packages = [
    ["@huggingface/transformers"],
    ["onnxruntime-web", "@huggingface/transformers"],
    ["ogg-opus-decoder"],
    ["@wasm-audio-decoders/opus-ml", "ogg-opus-decoder"],
    ["@mixmark-io/domino", "turndown"],
    ["@anthropic-ai/sandbox-runtime"],
  ];
  const copiedFiles = [];
  for (const [name, parent] of packages) {
    const source = installedPackageRoot(
      name,
      parent ? join(installedPackageRoot(parent, manifest), "package.json") : manifest,
    );
    const destination = join(nodeModules, ...name.split("/"));
    const visit = (relativePath = "") => {
      mkdirSync(join(destination, relativePath), { recursive: true });
      for (const entry of readdirSync(join(source, relativePath), { withFileTypes: true })) {
        // Production removes source maps before applying immutable inventories.
        if (entry.name.endsWith(".map")) continue;
        const path = join(relativePath, entry.name);
        if (entry.isDirectory()) visit(path);
        else {
          expect(entry.isFile()).toBe(true);
          const from = join(source, path);
          const to = join(destination, path);
          // Preserve the complete real layout without copying hundreds of MB of
          // discarded WASM/native bundles. Copy manifests, licenses and entry JS.
          if (
            (!relativePath && /^(package\.json|LICENSE|NOTICE|index\.js)$/.test(entry.name)) ||
            (relativePath === "dist" &&
              /^(ort\.node\.min\.(js|mjs)|transformers\.node\.mjs|cli\.js)$/.test(entry.name)) ||
            path === join("vendor", "java-proxy-agent", "srt-proxy-agent.jar")
          ) {
            copyFileSync(from, to);
            copiedFiles.push({ from, to });
          } else writeFileSync(to, "");
        }
      }
    };
    visit();
  }
  return { nodeModules, copiedFiles };
}

describe("allowlisted package payload pruning", () => {
  it("accepts current installed layouts and preserves copied runtime/license bytes", () => {
    const { nodeModules, copiedFiles } = createInstalledPruneFixture();
    pruneAllowlistedPackagePayloads(nodeModules, { platform: "win32", arch: "x64" });
    for (const { from, to } of copiedFiles) {
      expect(readFileSync(to).equals(readFileSync(from))).toBe(true);
    }
  });

  it("rejects a missing JVM agent before pruning any package", () => {
    const { nodeModules } = createPackagePruneFixture();
    rmSync(
      join(
        nodeModules,
        "@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar",
      ),
    );
    expect(() =>
      pruneAllowlistedPackagePayloads(nodeModules, { platform: "win32", arch: "x64" }),
    ).toThrow(/missing.*srt-proxy-agent.jar/);
    expect(existsSync(join(nodeModules, "ogg-opus-decoder/dist"))).toBe(true);
  });
  it("retains required Windows runtime and license files while removing forbidden payloads", () => {
    const { nodeModules } = createPackagePruneFixture();
    const result = pruneAllowlistedPackagePayloads(nodeModules, {
      platform: "win32",
      arch: "x64",
    });

    expect(result.sandboxRuntime).toBe("srt-win/x64/srt-win.exe");
    expect(
      existsSync(
        join(
          nodeModules,
          "@anthropic-ai",
          "sandbox-runtime",
          "vendor",
          "srt-win",
          "x64",
          "srt-win.exe",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          nodeModules,
          "@anthropic-ai",
          "sandbox-runtime",
          "vendor",
          "srt-win",
          "arm64",
          "srt-win.exe",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(join(nodeModules, "@anthropic-ai", "sandbox-runtime", "vendor", "seccomp")),
    ).toBe(false);
    expect(existsSync(join(nodeModules, "@anthropic-ai", "sandbox-runtime", "LICENSE"))).toBe(true);

    expect(
      existsSync(
        join(nodeModules, "@huggingface", "transformers", "dist", "transformers.node.mjs"),
      ),
    ).toBe(true);
    expect(
      existsSync(join(nodeModules, "@huggingface", "transformers", "dist", "transformers.web.js")),
    ).toBe(false);
    expect(existsSync(join(nodeModules, "@huggingface", "transformers", "LICENSE"))).toBe(true);
    expect(existsSync(join(nodeModules, "onnxruntime-web", "dist", "ort.node.min.mjs"))).toBe(true);
    expect(
      existsSync(join(nodeModules, "onnxruntime-web", "dist", "ort-wasm-simd-threaded.jsep.wasm")),
    ).toBe(false);
    expect(existsSync(join(nodeModules, "ogg-opus-decoder", "index.js"))).toBe(true);
    expect(existsSync(join(nodeModules, "ogg-opus-decoder", "dist"))).toBe(false);
    expect(existsSync(join(nodeModules, "@wasm-audio-decoders", "opus-ml", "index.js"))).toBe(true);
    expect(existsSync(join(nodeModules, "@wasm-audio-decoders", "opus-ml", "dist"))).toBe(false);
    expect(existsSync(join(nodeModules, "@mixmark-io", "domino", "test"))).toBe(false);
    expect(existsSync(join(nodeModules, "@mixmark-io", "domino", ".yarn"))).toBe(false);
    expect(existsSync(join(nodeModules, "@mixmark-io", "domino", "LICENSE"))).toBe(true);
  });

  it("aborts before pruning when a known package has an unknown layout", () => {
    const { nodeModules } = createPackagePruneFixture();
    const unexpected = join(
      nodeModules,
      "@huggingface",
      "transformers",
      "dist",
      "unexpected-runtime.js",
    );
    writeFileSync(unexpected, "unknown");

    expect(() =>
      pruneAllowlistedPackagePayloads(nodeModules, { platform: "win32", arch: "x64" }),
    ).toThrow("@huggingface/transformers layout changed");
    expect(existsSync(unexpected)).toBe(true);
    expect(
      existsSync(join(nodeModules, "onnxruntime-web", "dist", "ort-wasm-simd-threaded.jsep.wasm")),
    ).toBe(true);
  });

  it("aborts before pruning when an allowlisted package version changes", () => {
    const { nodeModules } = createPackagePruneFixture();
    const manifest = join(nodeModules, "ogg-opus-decoder", "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "ogg-opus-decoder", version: "1.8.0" }));

    expect(() =>
      pruneAllowlistedPackagePayloads(nodeModules, { platform: "win32", arch: "x64" }),
    ).toThrow("ogg-opus-decoder version changed");
    expect(existsSync(join(nodeModules, "ogg-opus-decoder", "dist"))).toBe(true);
  });

  it("rejects nested package symlinks before pruning any package", () => {
    const { nodeModules } = createPackagePruneFixture();
    const target = join(dirname(nodeModules), "linked-fixture");
    const link = join(nodeModules, "@mixmark-io", "domino", "test", "fixture", "linked");
    mkdirSync(target);
    if (!createDirectorySymlinkOrSkip(target, link)) return;

    expect(() =>
      pruneAllowlistedPackagePayloads(nodeModules, { platform: "win32", arch: "x64" }),
    ).toThrow(/unexpected symbolic link.*fixture[/\\]linked/);
    expect(
      existsSync(join(nodeModules, "onnxruntime-web", "dist", "ort-wasm-simd-threaded.jsep.wasm")),
    ).toBe(true);
  });

  it.each([
    ["win32", "arm64", "srt-win/arm64/srt-win.exe"],
    ["linux", "x64", "seccomp/x64/apply-seccomp"],
    ["linux", "arm64", "seccomp/arm64/apply-seccomp"],
    ["darwin", "x64", null],
    ["darwin", "arm64", null],
  ])("keeps only the sandbox runtime for %s/%s", (platform, arch, expectedRuntime) => {
    const { nodeModules } = createPackagePruneFixture();
    const result = pruneAllowlistedPackagePayloads(nodeModules, { platform, arch });
    const vendor = join(nodeModules, "@anthropic-ai", "sandbox-runtime", "vendor");
    const runtimePaths = [
      "seccomp/arm64/apply-seccomp",
      "seccomp/x64/apply-seccomp",
      "srt-win/arm64/srt-win.exe",
      "srt-win/x64/srt-win.exe",
    ];

    expect(result.sandboxRuntime).toBe(expectedRuntime);
    expect(existsSync(join(vendor, "java-proxy-agent/srt-proxy-agent.jar"))).toBe(true);
    expect(existsSync(join(vendor, "java-proxy-agent/build.ts"))).toBe(false);
    expect(runtimePaths.filter((path) => existsSync(join(vendor, ...path.split("/"))))).toEqual(
      expectedRuntime ? [expectedRuntime] : [],
    );
    expect(existsSync(join(nodeModules, "@anthropic-ai", "sandbox-runtime", "LICENSE"))).toBe(true);
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
