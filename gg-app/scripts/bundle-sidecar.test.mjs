import {
  existsSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAndPromoteDirectory,
  collectDepsFingerprintInputs,
  copyPackage,
  copyPackagesConcurrently,
  copyPlannedFiles,
  decideDepsReuse,
  dependencyPlanFingerprintInput,
  depsFingerprint,
  depsReuseRestoreHook,
  finishStage,
  invalidateDepsStamp,
  inventory,
  inventoryJson,
  nodeModulesManifest,
  parseBundleArgs,
  planDependencyCopy,
  pruneAllowlistedPackagePayloads,
  pruneForeignNativePayloads,
  pruneSourceMaps,
  readDepsStamp,
  recordDepsStamp,
  selectedOptionalDependencies,
  stageSidecarDependencies,
  stageWithDepsReuse,
  toFingerprintPath,
  writeDepsStamp,
} from "./bundle-sidecar.mjs";
import { loadInstalledLayoutListing } from "./installed-layout-listing.mjs";

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

  it("keeps only the host esbuild binary package on every host", () => {
    const esbuildOptionalDependencies = {
      "@esbuild/aix-ppc64": "0.28.2",
      "@esbuild/darwin-arm64": "0.28.2",
      "@esbuild/linux-x64": "0.28.2",
      "@esbuild/win32-arm64": "0.28.2",
      "@esbuild/win32-x64": "0.28.2",
    };
    expect(
      selectedOptionalDependencies("esbuild", esbuildOptionalDependencies, "win32", "x64"),
    ).toEqual(["@esbuild/win32-x64"]);
    expect(
      selectedOptionalDependencies("esbuild", esbuildOptionalDependencies, "darwin", "arm64"),
    ).toEqual(["@esbuild/darwin-arm64"]);
    expect(() =>
      selectedOptionalDependencies("esbuild", esbuildOptionalDependencies, "freebsd", "x64"),
    ).toThrow("esbuild has no host binary package for freebsd/x64");
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

/** Every directory and file (with contents) under root, as sorted portable paths. */
function treeSnapshot(root) {
  const entries = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      const rel = path
        .slice(root.length + 1)
        .split(/[\\/]/)
        .join("/");
      if (entry.isDirectory()) {
        entries.push(`${rel}/`);
        visit(path);
      } else entries.push(`${rel} = ${readFileSync(path, "utf8")}`);
    }
  };
  visit(root);
  return entries;
}

describe("concurrent sidecar package copy", () => {
  function createDependencyFixture() {
    const root = createSharpFixture();
    createPackage(root, "host", {
      dependencies: { leaf: "1.0.0", sharp: "0.34.5" },
    });
    createPackage(root, "leaf");
    const host = join(root, "node_modules", "host");
    writeFixtureFile(host, "lib/deep/nested/file.js", "nested");
    mkdirSync(join(host, "empty-dir"), { recursive: true });
    // A linked directory inside a package must be materialized, as cpSync's
    // dereference does for pnpm-style links.
    const linkedTarget = join(root, "linked-target");
    writeFixtureFile(linkedTarget, "inside.txt", "linked content");
    const linked = createDirectorySymlinkOrSkip(linkedTarget, join(host, "linked"));
    return { root, linked };
  }

  it("produces exactly the tree the sequential copy produces", async () => {
    const { root, linked } = createDependencyFixture();
    const fromRequire = createRequire(join(root, "package.json"));
    const sequential = join(root, "sequential", "node_modules");
    const concurrent = join(root, "concurrent", "node_modules");
    const options = { platform: "win32", arch: "x64" };

    const sequentialCopied = new Set();
    for (const name of ["host", "leaf"]) {
      copyPackage(name, fromRequire, root, sequentialCopied, {
        ...options,
        destination: sequential,
      });
    }
    const concurrentCopied = new Set();
    const result = await copyPackagesConcurrently(
      ["host", "leaf"],
      fromRequire,
      root,
      concurrentCopied,
      { ...options, destination: concurrent, concurrency: 3 },
    );

    expect(treeSnapshot(concurrent)).toEqual(treeSnapshot(sequential));
    expect([...concurrentCopied]).toEqual([...sequentialCopied]);
    expect(result.packages).toBe(concurrentCopied.size);
    expect(treeSnapshot(concurrent)).toContain("host/empty-dir/");
    expect(treeSnapshot(concurrent)).toContain("host/lib/deep/nested/file.js = nested");
    expect(existsSync(join(concurrent, "@img", "sharp-linux-x64"))).toBe(false);
    if (linked) {
      expect(treeSnapshot(concurrent)).toContain("host/linked/inside.txt = linked content");
    }
  });

  it("fails before writing anything for an unsupported Windows host architecture", async () => {
    const { root } = createDependencyFixture();
    const destination = join(root, "staged", "node_modules");

    await expect(
      copyPackagesConcurrently(
        ["host"],
        createRequire(join(root, "package.json")),
        root,
        new Set(),
        {
          destination,
          platform: "win32",
          arch: "arm64",
        },
      ),
    ).rejects.toThrow("sharp has no supported Windows host selection for win32/arm64");
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

function createNativePruneFixture() {
  const root = mkdtempSync(join(tmpdir(), "gg-native-prune-"));
  temporaryDirectories.push(root);
  const packageRoot = join(root, "node_modules", "onnxruntime-node");
  writeFixtureFile(
    packageRoot,
    "package.json",
    JSON.stringify({
      name: "onnxruntime-node",
      version: "1.24.3",
      binary: { napi_versions: [6] },
    }),
  );
  for (const name of [
    "DirectML.dll",
    "dxcompiler.dll",
    "dxil.dll",
    "onnxruntime.dll",
    "onnxruntime_binding.node",
  ]) {
    writeFixtureFile(packageRoot, `bin/napi-v6/win32/x64/${name}`, `runtime:${name}`);
  }
  writeFixtureFile(packageRoot, "bin/napi-v6/linux/x64/onnxruntime_binding.node", "foreign");
  return { root, packageRoot };
}

describe("locked ONNX native runtime selection", () => {
  it("keeps every Windows N-API 6 DLL and removes foreign runtimes", () => {
    const { root, packageRoot } = createNativePruneFixture();
    const selected = join(packageRoot, "bin/napi-v6/win32/x64");
    const before = readdirSync(selected).map((name) => [name, readFileSync(join(selected, name))]);
    pruneForeignNativePayloads(root, { platform: "win32", arch: "x64" });
    expect(existsSync(join(packageRoot, "bin/napi-v6/linux"))).toBe(false);
    for (const [name, bytes] of before)
      expect(readFileSync(join(selected, name)).equals(bytes)).toBe(true);
  });

  it.each(["version", "abi", "extra-root", "missing-dll", "missing-platform"])(
    "rejects %s drift before removing foreign files",
    (kind) => {
      const { root, packageRoot } = createNativePruneFixture();
      if (kind === "version" || kind === "abi") {
        const p = join(packageRoot, "package.json");
        const manifest = JSON.parse(readFileSync(p, "utf8"));
        if (kind === "version") manifest.version = "1.24.4";
        else manifest.binary.napi_versions = [3];
        writeFileSync(p, JSON.stringify(manifest));
      } else if (kind === "extra-root") writeFixtureFile(packageRoot, "bin/unreviewed/file");
      else if (kind === "missing-dll")
        rmSync(join(packageRoot, "bin/napi-v6/win32/x64/onnxruntime.dll"));
      expect(() =>
        pruneForeignNativePayloads(root, {
          platform: kind === "missing-platform" ? "darwin" : "win32",
          arch: "x64",
        }),
      ).toThrow(/onnxruntime-node/);
      expect(
        readFileSync(join(packageRoot, "bin/napi-v6/linux/x64/onnxruntime_binding.node"), "utf8"),
      ).toBe("foreign");
    },
  );
});

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
  createVersionedPackage(nodeModules, "@anthropic-ai/sandbox-runtime", "0.0.78", [
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

async function createInstalledPruneFixture() {
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
  const cacheDir = fileURLToPath(
    new URL("../node_modules/.cache/installed-layout-listing", import.meta.url),
  );
  mkdirSync(cacheDir, { recursive: true });
  const listing = loadInstalledLayoutListing({
    packages: packages.map(([name, parent]) => ({
      name,
      root: installedPackageRoot(
        name,
        parent ? join(installedPackageRoot(parent, manifest), "package.json") : manifest,
      ),
    })),
    lockfile: fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url)),
    // Kept across runs (the key tracks versions + lockfile); copies below stay
    // per test because pruning mutates them.
    cacheDir,
  });
  const copiedFiles = [];
  const writes = [];
  for (const { name, root: source, entries } of listing.packages) {
    const destination = join(nodeModules, ...name.split("/"));
    mkdirSync(destination, { recursive: true });
    for (const { path, isDirectory, isFile } of entries) {
      if (isDirectory) {
        mkdirSync(join(destination, path), { recursive: true });
        continue;
      }
      expect(isFile).toBe(true);
      const relativePath = dirname(path) === "." ? "" : dirname(path);
      const fileName = basename(path);
      const from = join(source, path);
      const to = join(destination, path);
      // Preserve the complete real layout without copying hundreds of MB of
      // discarded WASM/native bundles. Copy manifests, licenses and entry JS.
      if (
        (!relativePath && /^(package\.json|LICENSE|NOTICE|index\.js)$/.test(fileName)) ||
        (relativePath === "dist" &&
          /^(ort\.node\.min\.(js|mjs)|transformers\.node\.mjs|cli\.js)$/.test(fileName)) ||
        path === join("vendor", "java-proxy-agent", "srt-proxy-agent.jar")
      ) {
        writes.push(() => copyFile(from, to));
        copiedFiles.push({ from, to });
      } else writes.push(() => writeFile(to, ""));
    }
  }
  // Keep the complete installed layout and real retained bytes, but avoid
  // serializing 1,000+ independent disk writes on Windows. Settle each bounded
  // batch before propagating an error so cleanup never races outstanding I/O.
  for (let offset = 0; offset < writes.length; offset += 16) {
    const results = await Promise.allSettled(
      writes.slice(offset, offset + 16).map((write) => write()),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Installed prune fixture writes failed");
  }
  return { nodeModules, copiedFiles };
}

describe("allowlisted package payload pruning", () => {
  it("accepts current installed layouts and preserves copied runtime/license bytes", async () => {
    const { nodeModules, copiedFiles } = await createInstalledPruneFixture();
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

function createReuseFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gg-sidecar-reuse-")));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  createPackage(root, "host", { dependencies: { leaf: "1.0.0" } });
  createPackage(root, "leaf");
  const host = join(root, "node_modules", "host");
  writeFixtureFile(host, "lib/index.js", "export const host = 1;");
  writeFixtureFile(host, "lib/index.js.map", "{}");
  writeFixtureFile(host, "lib/deep/nested/file.js", "nested");
  writeFixtureFile(host, "docs/guide.md", "allowlisted payload");
  writeFixtureFile(host, "a-b.js", "sorts before the a/ directory segment-wise");
  writeFixtureFile(host, "a/inner.js", "inner");
  mkdirSync(join(host, "empty-dir"), { recursive: true });
  writeFixtureFile(join(root, "node_modules", "leaf"), "dist/leaf.js.map", "{}");
  writeFixtureFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  writeFixtureFile(root, "bundle-sidecar.mjs", "// script v1\n");
  writeFixtureFile(root, "binaries/ggnode-x86_64-pc-windows-msvc.exe", "node v1");
  return {
    root,
    live: join(root, "sidecar"),
    stamp: join(root, "sidecar-deps.stamp.json"),
    inputs: {
      root,
      lockfile: join(root, "pnpm-lock.yaml"),
      script: join(root, "bundle-sidecar.mjs"),
      binaries: join(root, "binaries"),
      platform: "win32",
      arch: "x64",
      libc: null,
      nodeVersion: "v22.12.0",
      execArgv: [],
      env: {},
    },
  };
}

const ALLOWLISTED_FIXTURE_PATH = "node_modules/host/docs/guide.md";

async function fixtureFreshStage(directory, plan) {
  await copyPlannedFiles(plan);
  const before = inventory(directory);
  pruneSourceMaps(directory);
  rmSync(join(directory, ...ALLOWLISTED_FIXTURE_PATH.split("/")));
  return finishStage(
    directory,
    before,
    new Set(plan.jobs.map((job) => job.name)),
    { removedPaths: new Set([ALLOWLISTED_FIXTURE_PATH]), removedBytes: 0, sandboxRuntime: null },
    "opensrc-fixture",
  );
}

function fixturePlan(fx, destination) {
  return planDependencyCopy(
    ["host"],
    createRequire(join(fx.root, "package.json")),
    fx.root,
    new Set(),
    { destination, platform: "win32", arch: "x64" },
  );
}

/** Runs the same exported reuse steps bundle-sidecar main() runs, on a fixture. */
async function stageRun(
  fx,
  {
    live = fx.live,
    stamp = fx.stamp,
    reuseDeps = true,
    freshStage = fixtureFreshStage,
    validate = () => {},
    inputs = {},
    collectInputs = (plan) => collectDepsFingerprintInputs({ plan, ...fx.inputs, ...inputs }),
    decide,
    state = {},
  } = {},
) {
  const liveNodeModules = join(live, "node_modules");
  const reuseState = { moved: false };
  const result = await buildAndPromoteDirectory(
    live,
    async (candidate) => {
      writeFixtureFile(candidate, "app-sidecar.mjs", "bundle");
      writeFixtureFile(candidate, "app-sidecar.mjs.map", "bundle map");
      writeFixtureFile(candidate, "skills/demo/SKILL.md", "skill");
      const plan = fixturePlan(fx, join(candidate, "node_modules"));
      const platform = "win32";
      const arch = "x64";
      if (!reuseDeps) {
        state.decision = { reuse: false, reason: "flag off" };
        return stageSidecarDependencies({
          stagedOutDir: candidate,
          plan,
          freshStage,
          platform,
          arch,
        });
      }
      const staged = await stageWithDepsReuse({
        stagedOutDir: candidate,
        plan,
        freshStage,
        stampPath: stamp,
        liveNodeModules,
        collectInputs,
        decide,
        reuseState,
        platform,
        arch,
      });
      state.decision = staged.decision;
      return staged;
    },
    validate,
    reuseDeps
      ? { beforeCandidateCleanup: depsReuseRestoreHook({ reuseState, liveNodeModules }) }
      : {},
  );
  if (reuseDeps) await recordDepsStamp(result, { stampPath: stamp, liveNodeModules });
  return { decision: state.decision, result };
}

function fingerprintWith(fx, overrides = {}, plan = fixturePlan(fx, join(fx.root, "plan"))) {
  return depsFingerprint(collectDepsFingerprintInputs({ plan, ...fx.inputs, ...overrides }));
}

async function stampedFixture() {
  const fx = createReuseFixture();
  await stageRun(fx);
  return fx;
}

describe("sidecar dependency reuse flag", () => {
  it("is off unless --reuse-deps is passed", () => {
    expect(parseBundleArgs([])).toEqual({ reuseDeps: false });
    expect(parseBundleArgs(["--verbose"])).toEqual({ reuseDeps: false });
    expect(parseBundleArgs(["--reuse-deps"])).toEqual({ reuseDeps: true });
  });
});

describe("sidecar dependency reuse", () => {
  it("reuses a matching stamp and produces exactly the tree and inventory of a fresh copy", async () => {
    const fx = createReuseFixture();
    const first = await stageRun(fx);
    expect(first.decision).toMatchObject({ reuse: false, reason: "no stamp" });
    expect(readDepsStamp(fx.stamp).ok).toBe(true);

    const reused = await stageRun(fx);
    expect(reused.decision).toMatchObject({ reuse: true });

    const reference = join(fx.root, "reference");
    const fresh = await stageRun(fx, {
      live: reference,
      stamp: join(fx.root, "reference.stamp.json"),
    });
    expect(fresh.decision.reuse).toBe(false);

    const reusedManifest = await nodeModulesManifest(join(fx.live, "node_modules"));
    const freshManifest = await nodeModulesManifest(join(reference, "node_modules"));
    expect(reusedManifest.files).toEqual(freshManifest.files);
    expect(reusedManifest.directories).toEqual(freshManifest.directories);
    expect(reusedManifest.hash).toBe(freshManifest.hash);
    expect(reusedManifest.directories).toContain("host/empty-dir");
    expect(reusedManifest.files.map((file) => file.path)).not.toContain("host/docs/guide.md");
    expect(reusedManifest.files.some((file) => file.path.endsWith(".map"))).toBe(false);

    const json = (staged) => inventoryJson(staged.before, staged.removed, staged.after);
    expect(json(reused.result)).toBe(json(fresh.result));
    const paths = (value) => value.entries.map((file) => file.relative);
    expect(paths(reused.result.before)).toEqual(paths(fresh.result.before));
    expect(paths(reused.result.removed)).toEqual(paths(fresh.result.removed));
    expect(paths(reused.result.after)).toEqual(paths(fresh.result.after));
    expect([...reused.result.packagePrune.removedPaths]).toEqual([ALLOWLISTED_FIXTURE_PATH]);
    expect([...reused.result.copied]).toEqual([...fresh.result.copied]);
    expect(existsSync(join(fx.live, "app-sidecar.mjs.map"))).toBe(false);
    expect(readFileSync(join(fx.live, "skills", "demo", "SKILL.md"), "utf8")).toBe("skill");
  });

  it("never reads, writes or deletes a stamp with the flag off", async () => {
    const fx = await stampedFixture();
    const before = readFileSync(fx.stamp, "utf8");
    const run = await stageRun(fx, { reuseDeps: false });
    expect(run.decision.reuse).toBe(false);
    expect(readFileSync(fx.stamp, "utf8")).toBe(before);
  });

  it("copies fully when any fingerprint input changes", async () => {
    const fx = createReuseFixture();
    const plan = fixturePlan(fx, join(fx.root, "plan"));
    const base = fingerprintWith(fx, {}, plan);
    expect(fingerprintWith(fx, {}, plan)).toBe(base);

    const changed = {
      platform: fingerprintWith(fx, { platform: "linux" }, plan),
      arch: fingerprintWith(fx, { arch: "arm64" }, plan),
      libc: fingerprintWith(fx, { libc: "musl" }, plan),
      "Node version": fingerprintWith(fx, { nodeVersion: "v24.0.0" }, plan),
      execArgv: fingerprintWith(fx, { execArgv: ["--preserve-symlinks"] }, plan),
      "plan source path": fingerprintWith(
        fx,
        {},
        {
          ...plan,
          jobs: plan.jobs.map((job, index) =>
            index === 0 ? { ...job, source: join(fx.root, "elsewhere", "host") } : job,
          ),
        },
      ),
      "plan file size": fingerprintWith(
        fx,
        {},
        {
          ...plan,
          files: plan.files.map((file, index) =>
            index === 0 ? { ...file, bytes: file.bytes + 1 } : file,
          ),
        },
      ),
      "plan file list": fingerprintWith(fx, {}, { ...plan, files: plan.files.slice(1) }),
    };
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_PRESERVE_SYMLINKS",
      "NODE_PRESERVE_SYMLINKS_MAIN",
    ]) {
      changed[name] = fingerprintWith(fx, { env: { [name]: "1" } }, plan);
    }
    writeFileSync(fx.inputs.lockfile, "lockfileVersion: '9.0'\n\n");
    changed.lockfile = fingerprintWith(fx, {}, plan);
    writeFileSync(fx.inputs.lockfile, "lockfileVersion: '9.0'\n");
    writeFileSync(fx.inputs.script, "// script v2\n");
    changed.script = fingerprintWith(fx, {}, plan);
    writeFileSync(fx.inputs.script, "// script v1\n");
    const node = join(fx.inputs.binaries, "ggnode-x86_64-pc-windows-msvc.exe");
    writeFileSync(node, "node v2");
    changed["staged Node hash"] = fingerprintWith(fx, {}, plan);
    rmSync(node);
    changed["staged Node removed"] = fingerprintWith(fx, {}, plan);
    writeFileSync(node, "node v1");

    for (const [name, value] of Object.entries(changed)) {
      expect(value, name).not.toBe(base);
    }
    expect(new Set(Object.values(changed)).size).toBe(Object.keys(changed).length);
    expect(fingerprintWith(fx, {}, plan)).toBe(base);
    expect(fingerprintWith(fx, { env: { PATH: "unrelated" } }, plan)).toBe(base);
  });

  it("ignores timestamp-only changes and copies fully after a real input change", async () => {
    const fx = await stampedFixture();
    const later = new Date(Date.UTC(2030, 0, 1));
    utimesSync(fx.inputs.lockfile, later, later);
    utimesSync(fx.inputs.script, later, later);
    expect((await stageRun(fx)).decision.reuse).toBe(true);

    writeFileSync(fx.inputs.lockfile, "lockfileVersion: '9.0'\n# changed\n");
    expect((await stageRun(fx)).decision).toMatchObject({ reuse: false, reason: "inputs changed" });
    expect(
      (await stageRun(fx, { inputs: { env: { NODE_PRESERVE_SYMLINKS: "0" } } })).decision,
    ).toMatchObject({ reuse: false, reason: "inputs changed" });
  });

  it.each([
    ["edited", (nm) => writeFileSync(join(nm, "host", "lib", "index.js"), "tampered")],
    ["added", (nm) => writeFileSync(join(nm, "host", "extra.js"), "extra")],
    ["removed", (nm) => rmSync(join(nm, "leaf", "payload.txt"))],
    ["empty directory added", (nm) => mkdirSync(join(nm, "host", "new-empty"))],
  ])("copies fully when the live tree was %s since stamping", async (_name, mutate) => {
    const fx = await stampedFixture();
    mutate(join(fx.live, "node_modules"));
    const run = await stageRun(fx);
    expect(run.decision).toMatchObject({
      reuse: false,
      reason: "previous node_modules changed since it was stamped",
    });
    const fresh = await nodeModulesManifest(join(fx.live, "node_modules"));
    expect(fresh.files.map((file) => file.path)).not.toContain("host/extra.js");
    expect(fresh.files.map((file) => file.path)).toContain("leaf/payload.txt");
  });

  it("copies fully when the live node_modules is missing or holds a link", async () => {
    const fx = await stampedFixture();
    const liveNodeModules = join(fx.live, "node_modules");
    const fingerprint = fingerprintWith(fx);
    const target = join(fx.root, "link-target");
    mkdirSync(target);
    if (createDirectorySymlinkOrSkip(target, join(liveNodeModules, "linked"))) {
      const decision = await decideDepsReuse({ stampPath: fx.stamp, fingerprint, liveNodeModules });
      expect(decision.reuse).toBe(false);
      expect(decision.reason).toMatch(/^reuse check failed: symbolic link/);
      rmSync(join(liveNodeModules, "linked"), { recursive: true, force: true });
    }
    rmSync(liveNodeModules, { recursive: true, force: true });
    expect(await decideDepsReuse({ stampPath: fx.stamp, fingerprint, liveNodeModules })).toEqual({
      reuse: false,
      reason: "no previous node_modules",
    });
  });

  it("leaves no stamp after an interrupted copy, so the next run copies fully", async () => {
    const fx = await stampedFixture();
    const liveBefore = await nodeModulesManifest(join(fx.live, "node_modules"));
    await expect(
      stageRun(fx, {
        freshStage: async (_directory, plan) => {
          await copyPlannedFiles({ ...plan, files: plan.files.slice(0, 2) });
          throw new Error("copy interrupted");
        },
        inputs: { nodeVersion: "v24.0.0" },
      }),
    ).rejects.toThrow("copy interrupted");
    expect(existsSync(fx.stamp)).toBe(false);
    expect(existsSync(`${fx.live}.candidate`)).toBe(false);
    expect((await nodeModulesManifest(join(fx.live, "node_modules"))).hash).toBe(liveBefore.hash);
    expect((await stageRun(fx)).decision).toMatchObject({ reuse: false, reason: "no stamp" });
  });

  it("copies fully when a run crashed after invalidating the stamp", async () => {
    const fx = await stampedFixture();
    invalidateDepsStamp(fx.stamp);
    // The process dies here, before the post-promotion stamp write.
    expect(
      await decideDepsReuse({
        stampPath: fx.stamp,
        fingerprint: fingerprintWith(fx),
        liveNodeModules: join(fx.live, "node_modules"),
      }),
    ).toEqual({ reuse: false, reason: "no stamp" });
  });

  it("restores the reused node_modules to the live sidecar when validation fails", async () => {
    const fx = await stampedFixture();
    const liveBefore = await nodeModulesManifest(join(fx.live, "node_modules"));
    const state = {};
    await expect(
      stageRun(fx, {
        state,
        validate: () => {
          throw new Error("validation failed");
        },
      }),
    ).rejects.toThrow("validation failed");
    expect(state.decision.reuse).toBe(true);
    expect(existsSync(fx.stamp)).toBe(false);
    expect(existsSync(`${fx.live}.candidate`)).toBe(false);
    expect((await nodeModulesManifest(join(fx.live, "node_modules"))).hash).toBe(liveBefore.hash);
    expect((await stageRun(fx)).decision).toMatchObject({ reuse: false, reason: "no stamp" });
  });

  it("copies fully when the reuse check throws", async () => {
    const fx = await stampedFixture();
    const reference = await nodeModulesManifest(join(fx.live, "node_modules"));
    const thrown = await stageRun(fx, {
      decide: async () => {
        throw new Error("decide exploded");
      },
    });
    expect(thrown.decision).toEqual({
      reuse: false,
      reason: "reuse check failed: decide exploded",
    });
    expect((await nodeModulesManifest(join(fx.live, "node_modules"))).hash).toBe(reference.hash);
    expect(readDepsStamp(fx.stamp).ok).toBe(true);

    const noInputs = await stageRun(fx, {
      collectInputs: () => {
        throw new Error("lockfile unreadable");
      },
    });
    expect(noInputs.decision).toEqual({
      reuse: false,
      reason: "reuse check failed: lockfile unreadable",
    });
    expect(noInputs.result.fingerprint).toBeNull();
    expect((await nodeModulesManifest(join(fx.live, "node_modules"))).hash).toBe(reference.hash);
    // Without a fingerprint there is nothing to stamp, so the next run copies fully.
    expect(existsSync(fx.stamp)).toBe(false);
  });

  it("removes the stamp before staging starts", async () => {
    const fx = await stampedFixture();
    // A valid stamp with a changed live tree forces the full-copy path.
    writeFileSync(join(fx.live, "node_modules", "host", "extra.js"), "extra");
    expect(readDepsStamp(fx.stamp).ok).toBe(true);
    const seen = [];
    const run = await stageRun(fx, {
      freshStage: async (directory, plan) => {
        seen.push(existsSync(fx.stamp));
        return fixtureFreshStage(directory, plan);
      },
    });
    expect(run.decision.reuse).toBe(false);
    expect(seen).toEqual([false]);
    expect(readDepsStamp(fx.stamp).ok).toBe(true);
  });

  it("restore hook only moves a reused tree back into an empty live folder", () => {
    const fx = createReuseFixture();
    const candidate = join(fx.root, "candidate");
    const liveNodeModules = join(fx.live, "node_modules");
    writeFixtureFile(candidate, "node_modules/host/index.js", "reused");

    depsReuseRestoreHook({ reuseState: { moved: false }, liveNodeModules })(candidate);
    expect(existsSync(liveNodeModules)).toBe(false);

    writeFixtureFile(liveNodeModules, "keep.js", "live");
    const occupied = { moved: true };
    depsReuseRestoreHook({ reuseState: occupied, liveNodeModules })(candidate);
    expect(readFileSync(join(liveNodeModules, "keep.js"), "utf8")).toBe("live");
    expect(occupied.moved).toBe(true);

    rmSync(liveNodeModules, { recursive: true });
    const moved = { moved: true };
    depsReuseRestoreHook({ reuseState: moved, liveNodeModules })(candidate);
    expect(readFileSync(join(liveNodeModules, "host", "index.js"), "utf8")).toBe("reused");
    expect(existsSync(join(candidate, "node_modules"))).toBe(false);
    expect(moved.moved).toBe(false);
  });

  it("leaves no stamp when writing it fails", async () => {
    const fx = createReuseFixture();
    const { result } = await stageRun(fx);
    const liveNodeModules = join(fx.live, "node_modules");
    expect(readDepsStamp(fx.stamp).ok).toBe(true);

    const recorded = await recordDepsStamp(result, {
      stampPath: fx.stamp,
      liveNodeModules,
      write: (path) => {
        writeFileSync(path, "{partial");
        throw new Error("disk full");
      },
    });
    expect(recorded).toBe(false);
    expect(existsSync(fx.stamp)).toBe(false);

    writeFileSync(fx.stamp, "stale");
    const missingTree = await recordDepsStamp(result, {
      stampPath: fx.stamp,
      liveNodeModules: join(fx.root, "missing", "node_modules"),
    });
    expect(missingTree).toBe(false);
    expect(existsSync(fx.stamp)).toBe(false);
    expect((await stageRun(fx)).decision).toMatchObject({ reuse: false, reason: "no stamp" });
  });

  it.each([
    ["bad JSON", () => "{not json", "stamp is not valid JSON"],
    [
      "truncated file",
      (raw) => raw.slice(0, Math.floor(raw.length / 2)),
      "stamp is not valid JSON",
    ],
    ["empty file", () => "", "stamp is not valid JSON"],
    ["array", () => "[]", "stamp is not an object"],
    [
      "wrong schema",
      (raw) => JSON.stringify({ ...JSON.parse(raw), schema: "gg-sidecar-deps/0" }),
      "stamp schema differs",
    ],
    [
      "checksum mismatch",
      (raw) => JSON.stringify({ ...JSON.parse(raw), output: "0".repeat(64) }),
      "stamp checksum mismatch",
    ],
    [
      "fingerprint type",
      (raw) => JSON.stringify({ ...JSON.parse(raw), fingerprint: 7 }),
      "stamp fields are malformed",
    ],
    [
      "removed entry bytes type",
      (raw) => {
        const stamp = JSON.parse(raw);
        stamp.removedEntries[0].bytes = "12";
        return JSON.stringify(stamp);
      },
      "stamp fields are malformed",
    ],
    [
      "removed path escapes node_modules",
      (raw) => JSON.stringify({ ...JSON.parse(raw), removedPaths: ["node_modules/../app.mjs"] }),
      "stamp fields are malformed",
    ],
    [
      "missing removedPaths",
      (raw) => {
        const stamp = JSON.parse(raw);
        delete stamp.removedPaths;
        return JSON.stringify(stamp);
      },
      "stamp fields are malformed",
    ],
  ])("copies fully on a corrupt stamp (%s)", async (_name, corrupt, reason) => {
    const fx = await stampedFixture();
    writeFileSync(fx.stamp, corrupt(readFileSync(fx.stamp, "utf8")));
    expect(readDepsStamp(fx.stamp)).toEqual({ ok: false, reason });
    expect((await stageRun(fx)).decision).toEqual({ reuse: false, reason });
  });

  it("writes the stamp atomically with no temporary file left behind", async () => {
    const fx = await stampedFixture();
    expect(readdirSync(fx.root).filter((name) => name.includes(".tmp"))).toEqual([]);
    const { stamp } = readDepsStamp(fx.stamp);
    expect(stamp.removedEntries.every((entry) => entry.relative.startsWith("node_modules/"))).toBe(
      true,
    );
    expect(stamp.removedEntries.map((entry) => entry.relative)).toContain(ALLOWLISTED_FIXTURE_PATH);
  });
});

describe("sidecar dependency fingerprint paths", () => {
  it("normalizes Windows paths to repo-relative forward-slash form, ignoring case", () => {
    const source = "E:\\Repo\\node_modules\\.pnpm\\a@1.0.0\\node_modules\\a";
    const expected = "node_modules/.pnpm/a@1.0.0/node_modules/a";
    expect(toFingerprintPath(source, "e:\\repo", "win32")).toBe(expected);
    expect(toFingerprintPath(source, "E:\\Repo", "win32")).toBe(expected);
    expect(toFingerprintPath(source.toLowerCase(), "E:\\Repo\\", "win32")).toBe(expected);
    expect(toFingerprintPath("D:\\Store\\pkg", "E:\\Repo", "win32")).toBe("d:/Store/pkg");
    expect(toFingerprintPath("E:\\Repo", "e:\\repo", "win32")).toBe(".");
    expect(toFingerprintPath("E:\\Repo-other\\x", "E:\\Repo", "win32")).toBe("e:/Repo-other/x");
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(toFingerprintPath("/repo/node_modules/a", "/repo", "linux")).toBe("node_modules/a");
    expect(toFingerprintPath("/Repo/node_modules/a", "/repo", "linux")).toBe(
      "/Repo/node_modules/a",
    );
  });

  it("gives the same plan input for the same repo addressed with different drive case", () => {
    const plan = (repo, candidate) => ({
      destination: `${candidate}\\node_modules`,
      jobs: [
        {
          name: "@img/colour",
          source: `${repo}\\node_modules\\.pnpm\\@img+colour@1.1.0\\node_modules\\@img\\colour`,
          dest: `${candidate}\\node_modules\\@img\\colour`,
        },
      ],
      directories: [`${candidate}\\node_modules\\@img\\colour`],
      files: [
        {
          from: `${repo}\\x\\package.json`,
          to: `${candidate}\\node_modules\\@img\\colour\\package.json`,
          bytes: 10,
        },
      ],
    });
    const upper = dependencyPlanFingerprintInput(
      plan("E:\\Repo", "E:\\Repo\\gg-app\\src-tauri\\sidecar.candidate"),
      "E:\\Repo",
      "win32",
    );
    const lower = dependencyPlanFingerprintInput(
      plan("e:\\Repo", "e:\\Repo\\gg-app\\src-tauri\\sidecar.candidate"),
      "e:\\repo",
      "win32",
    );
    expect(lower).toEqual(upper);
    expect(upper).toEqual({
      packages: [
        {
          name: "@img/colour",
          source: "node_modules/.pnpm/@img+colour@1.1.0/node_modules/@img/colour",
          dest: "@img/colour",
        },
      ],
      directories: ["@img/colour"],
      files: [{ path: "@img/colour/package.json", bytes: 10 }],
    });
  });

  it("records manifest and plan paths with forward slashes on every host", async () => {
    const fx = await stampedFixture();
    const manifest = await nodeModulesManifest(join(fx.live, "node_modules"));
    expect(manifest.files.map((file) => file.path)).toContain("host/lib/deep/nested/file.js");
    expect(manifest.files.some((file) => file.path.includes("\\"))).toBe(false);
    const input = dependencyPlanFingerprintInput(fixturePlan(fx, join(fx.root, "p")), fx.root);
    expect(input.packages.map((pkg) => pkg.source)).toEqual([
      "node_modules/host",
      "node_modules/leaf",
    ]);
    expect(input.files.some((file) => file.path.includes("\\"))).toBe(false);
  });
});

describe("sidecar candidate cleanup hook", () => {
  it.each([
    [
      "build",
      async (candidate) => {
        writeFileSync(join(candidate, "partial.bin"), "partial");
        throw new Error("build failed");
      },
      () => {},
    ],
    [
      "validation",
      async (candidate) => writeFileSync(join(candidate, "partial.bin"), "partial"),
      () => {
        throw new Error("validation failed");
      },
    ],
  ])("runs before candidate removal when %s fails", async (name, buildCandidate, validate) => {
    const { live, oldPayload } = createPromotionFixture();
    const seen = [];
    await expect(
      buildAndPromoteDirectory(live, buildCandidate, validate, {
        beforeCandidateCleanup: (candidate) => {
          seen.push(existsSync(join(candidate, "partial.bin")));
        },
      }),
    ).rejects.toThrow(`${name} failed`);
    expect(seen).toEqual([true]);
    expectOldPayloadIntact(live, oldPayload);
    expect(existsSync(`${live}.candidate`)).toBe(false);
  });

  it("keeps the candidate when the restore hook itself fails", async () => {
    const { live, oldPayload } = createPromotionFixture();
    await expect(
      buildAndPromoteDirectory(
        live,
        async (candidate) => writeFileSync(join(candidate, "moved.bin"), "only copy"),
        () => {
          throw new Error("validation failed");
        },
        {
          beforeCandidateCleanup: () => {
            throw new Error("restore failed");
          },
        },
      ),
    ).rejects.toThrow("sidecar candidate failed and restore failed");
    expect(readFileSync(join(`${live}.candidate`, "moved.bin"), "utf8")).toBe("only copy");
    expectOldPayloadIntact(live, oldPayload);
  });

  it("runs after rollback when promotion fails", async () => {
    const { live, oldPayload } = createPromotionFixture();
    const candidate = `${live}.candidate`;
    const seen = [];
    await expect(
      buildAndPromoteDirectory(
        live,
        async (directory) => writeFileSync(join(directory, "payload.bin"), "new"),
        () => {},
        {
          rename(from, to) {
            if (from === candidate && to === live) throw new Error("file is locked");
            renameSync(from, to);
          },
          beforeCandidateCleanup: (directory) => {
            seen.push([existsSync(live), existsSync(directory)]);
          },
        },
      ),
    ).rejects.toThrow("file is locked");
    expect(seen).toEqual([[true, true]]);
    expectOldPayloadIntact(live, oldPayload);
  });
});
