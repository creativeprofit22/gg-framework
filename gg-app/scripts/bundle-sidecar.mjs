// Bundle the ggcoder app-sidecar into a single self-contained ESM file shipped
// as a Tauri `bundle.resources` entry, plus the handful of native/optional
// packages it loads at runtime copied into a sibling node_modules/.
//
// Why external + copy (not a single SEA binary): ggcoder's runtime pulls in
// native `sharp` and lazily imports optional natives (playwright, transformers,
// unpdf, ...). Those cannot be inlined by a bundler, so we mark them `external`
// and copy the real packages (with their dependency trees) next to the bundle.
// Pure-JS linkedom is bundled to avoid flattening incompatible htmlparser2/entities
// versions into that external node_modules tree. Each OS/arch bundle is built on
// its own runner, so copied native binaries match the target.
import { build } from "esbuild";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const sidecarEntry = join(repoRoot, "packages", "ggcoder", "dist", "app-sidecar.js");
const outDir = join(here, "..", "src-tauri", "sidecar");
const outFile = join(outDir, "app-sidecar.mjs");
const nodeModulesOut = join(outDir, "node_modules");
const bundledSkillsSource = join(repoRoot, "packages", "ggcoder", "assets", "skills");

// Packages that must NOT be inlined: native addons, lazily-loaded optional
// heavy deps, and child-process entry points that esbuild cannot discover.
const EXTERNAL = [
  "sharp",
  "playwright",
  "@huggingface/transformers",
  "unpdf",
  "ogg-opus-decoder",
  "turndown",
  "turndown-plugin-gfm",
  "@mozilla/readability",
  // The Codex transport loads this package's zstd.wasm by path at runtime.
  // Keep the package external so the WASM asset survives the sidecar bundle.
  "@bokuweb/zstd-wasm",
  // LSP servers run as child processes from their real package entry points.
  // The server resolver also needs a physical tsserver.js path. Neither package
  // is imported by the sidecar, so esbuild would otherwise omit both and every
  // installed desktop build would silently lose TS/JS inline diagnostics.
  "typescript-language-server",
  "typescript",
  // source_path spawns opensrc's CLI by physical path; it is never imported.
  "opensrc",
  // Bash launches SRT's physical CLI as a child process for per-session OS
  // sandboxing; keep its platform binaries and CLI files on disk.
  "@anthropic-ai/sandbox-runtime",
];

// require resolver anchored at the ggcoder package, where these deps live.
const ggcoderRequire = createRequire(join(repoRoot, "packages", "ggcoder", "package.json"));

// Candidate node_modules roots to scan directly when `require.resolve` is
// blocked by a package's `exports` map (which often hides ./package.json).
const NM_ROOTS = [
  join(repoRoot, "packages", "ggcoder", "node_modules"),
  join(repoRoot, "packages", "gg-ai", "node_modules"),
  join(repoRoot, "node_modules"),
];

const MIB = 1024 * 1024;
const CATEGORY_ORDER = [
  "source-map",
  "type-declaration",
  "typescript-source",
  "native-or-wasm",
  "runtime-js",
  "json-or-manifest",
  "documentation",
  "test-fixture-benchmark",
  "license-notice",
  "other",
];
const OPENSRC_BINARIES = new Set([
  "opensrc-win32-x64.exe",
  "opensrc-darwin-x64",
  "opensrc-darwin-arm64",
  "opensrc-linux-x64",
  "opensrc-linux-musl-x64",
  "opensrc-linux-arm64",
  "opensrc-linux-musl-arm64",
]);

const PACKAGE_PAYLOAD_ALLOWLISTS = [
  {
    name: "onnxruntime-web",
    version: "1.22.0-dev.20250409-89f8206ba4",
    requiredPaths: ["package.json", "types.d.ts", "dist/ort.node.min.js", "dist/ort.node.min.mjs"],
    operations: [
      {
        path: ".",
        expectedEntries: [
          "README.md",
          "__commit.txt",
          "dist",
          "docs",
          "lib",
          "package.json",
          "types.d.ts",
        ],
        retainFiles: [
          "package.json",
          "types.d.ts",
          "dist/ort.node.min.js",
          "dist/ort.node.min.mjs",
        ],
      },
    ],
  },
  {
    name: "@huggingface/transformers",
    version: "3.8.1",
    requiredPaths: ["package.json", "LICENSE", "dist/transformers.node.mjs"],
    operations: [
      {
        path: "dist",
        expectedEntries: [
          "ort-wasm-simd-threaded.jsep.mjs",
          "ort-wasm-simd-threaded.jsep.wasm",
          "transformers.js",
          "transformers.min.js",
          "transformers.node.cjs",
          "transformers.node.min.cjs",
          "transformers.node.min.mjs",
          "transformers.node.mjs",
          "transformers.web.js",
          "transformers.web.min.js",
        ],
        retainFiles: ["transformers.node.mjs"],
      },
    ],
  },
  {
    name: "ogg-opus-decoder",
    version: "1.7.3",
    requiredPaths: ["package.json", "index.js", "types.d.ts"],
    operations: [
      {
        path: "dist",
        expectedEntries: ["ogg-opus-decoder.min.js", "ogg-opus-decoder.opus-ml.min.js"],
        removeDirectory: true,
      },
    ],
  },
  {
    name: "@wasm-audio-decoders/opus-ml",
    version: "0.0.2",
    requiredPaths: ["package.json", "index.js", "types.d.ts"],
    operations: [
      {
        path: "dist",
        expectedEntries: ["opus-ml-decoder.min.js"],
        removeDirectory: true,
      },
    ],
  },
  {
    name: "@mixmark-io/domino",
    version: "2.2.0",
    requiredPaths: ["package.json", "LICENSE"],
    operations: [
      {
        path: "test",
        expectedEntries: [
          "domino.js",
          "fixture",
          "html5lib-tests.json",
          "index.js",
          "parsing.js",
          "tools",
          "w3c",
          "web-platform-blocklist.json",
          "web-platform-tests.js",
          "xss.js",
        ],
        removeDirectory: true,
      },
      {
        path: ".yarn",
        expectedEntries: ["plugins", "versions"],
        removeDirectory: true,
      },
    ],
  },
  {
    name: "@anthropic-ai/sandbox-runtime",
    version: "0.0.67",
    requiredPaths: ["package.json", "LICENSE", "dist/cli.js"],
    operations: [
      {
        path: "vendor",
        expectedFiles: [
          "seccomp/arm64/apply-seccomp",
          "seccomp/build.ts",
          "seccomp/x64/apply-seccomp",
          "srt-win/arm64/srt-win.exe",
          "srt-win/build.ts",
          "srt-win/x64/srt-win.exe",
        ],
        retainFiles: ({ platform, arch }) => {
          const runtime = sandboxRuntimePath(platform, arch);
          return runtime ? [runtime] : [];
        },
      },
    ],
  },
];

function portablePath(path) {
  return path.split(sep).join("/");
}

/** Deterministically enumerate regular files without following symbolic links. */
function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = portablePath(relative(root, path));
      if (stat.isSymbolicLink()) {
        throw new Error(`unexpected symbolic link in staged sidecar: ${rel}`);
      }
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        files.push({ path, relative: rel, bytes: stat.size });
      } else {
        throw new Error(`unexpected non-file entry in staged sidecar: ${rel}`);
      }
    }
  };
  visit(root);
  return files;
}

function packageNameFor(path) {
  const parts = path.split("/");
  if (parts[0] === "node_modules" && parts[1]) {
    return parts[1].startsWith("@") && parts[2] ? `${parts[1]}/${parts[2]}` : parts[1];
  }
  if (parts[0] === "skills") return "(skills)";
  if (path === "app-sidecar.mjs") return "(bundle)";
  return "(other)";
}

function categoryFor(path) {
  const lower = path.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  const isLicense =
    /^(?:licen[cs]es?|copy(?:right|ing)s?|notices?|third[-_ ]?party(?:[-_ ]?(?:notices?|notice[-_ ]?text))?)(?:\.|$)/.test(
      basename,
    );
  if (path.endsWith(".map")) return "source-map";
  if (/\.d\.(?:ts|mts|cts)$/.test(lower)) return "type-declaration";
  if (/\.(?:ts|tsx|mts|cts)$/.test(lower)) return "typescript-source";
  if (/\.(?:node|wasm|dll|exe|so|dylib)$/.test(lower)) return "native-or-wasm";
  if (/\.(?:js|mjs|cjs|jsx)$/.test(lower)) return "runtime-js";
  if (lower.endsWith(".json")) return "json-or-manifest";
  if (
    !isLicense &&
    (/\.(?:md|markdown|mdown|mkd)$/.test(lower) ||
      /^(?:readme|changelog|changes|history)(?:\.|$)/.test(basename))
  ) {
    return "documentation";
  }
  if (
    /(?:^|\/)(?:__tests__|tests?|fixtures?|examples?|benchmarks?)(?:\/|$)/.test(lower) ||
    /(?:^|[._-])(?:test|spec|fixture|example|benchmark)(?:[._-]|$)/.test(basename)
  ) {
    return "test-fixture-benchmark";
  }
  if (isLicense) return "license-notice";
  return "other";
}

function emptySummary() {
  return { bytes: 0, files: 0 };
}

function addToMap(map, key, file) {
  const row = map.get(key) ?? emptySummary();
  row.bytes += file.bytes;
  row.files += 1;
  map.set(key, row);
}

function inventoryFromFiles(files) {
  const packages = new Map();
  const categories = new Map(CATEGORY_ORDER.map((name) => [name, emptySummary()]));
  let bytes = 0;
  for (const file of files) {
    bytes += file.bytes;
    addToMap(packages, packageNameFor(file.relative), file);
    addToMap(categories, categoryFor(file.relative), file);
  }
  return { bytes, files: files.length, packages, categories, entries: files };
}

function inventory(root) {
  return inventoryFromFiles(walkFiles(root));
}

function formatBytes(bytes) {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

function sortedNames(maps) {
  const names = new Set(maps.flatMap((map) => [...map.keys()]));
  return [...names].sort((a, b) => {
    const bytesA = maps[0].get(a)?.bytes ?? 0;
    const bytesB = maps[0].get(b)?.bytes ?? 0;
    return bytesB - bytesA || (a < b ? -1 : a > b ? 1 : 0);
  });
}

function renderDimension(label, before, removed, after) {
  console.log(`\nSidecar ${label} inventory`);
  console.log("name | before bytes/files | removed bytes/files | after bytes/files");
  for (const name of sortedNames([before, removed, after])) {
    const b = before.get(name) ?? emptySummary();
    const r = removed.get(name) ?? emptySummary();
    const a = after.get(name) ?? emptySummary();
    console.log(
      `${name} | ${formatBytes(b.bytes)} / ${b.files} | ${formatBytes(r.bytes)} / ${r.files} | ${formatBytes(a.bytes)} / ${a.files}`,
    );
  }
}

function renderInventory(before, removed, after) {
  console.log("\nSidecar total inventory");
  console.log("stage | bytes | files");
  for (const [name, value] of [
    ["before", before],
    ["removed", removed],
    ["after", after],
  ]) {
    console.log(`${name} | ${formatBytes(value.bytes)} | ${value.files}`);
  }
  renderDimension("package", before.packages, removed.packages, after.packages);
  renderDimension("category", before.categories, removed.categories, after.categories);
}

function jsonInventory(value) {
  return sortedNames([value]).map((name) => {
    const summary = value.get(name);
    return { name, bytes: summary.bytes, files: summary.files };
  });
}

function inventoryJson(before, removed, after) {
  const serialize = (value) => ({
    bytes: value.bytes,
    files: value.files,
    packages: jsonInventory(value.packages),
    categories: jsonInventory(value.categories),
  });
  return JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    before: serialize(before),
    removed: serialize(removed),
    after: serialize(after),
  });
}

/** Nearest ancestor directory literally named `node_modules`, or null. */
function enclosingNodeModules(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (parent.endsWith(`${sep}node_modules`)) return parent;
    dir = parent;
  }
  return null;
}

/** Walk up from a file to the nearest dir containing package.json. */
function nearestPackageDir(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve a package's root dir (the folder holding its package.json), searching
 * from the requiring package's directory. Robust to `exports` maps that hide
 * ./package.json and to pnpm's sibling layout
 * (.pnpm/<parent>/node_modules/<dep>).
 */
function packageRoot(name, fromRequire, fromDir) {
  const segs = name.split("/");
  // A resolved dir only counts as the package root when its package.json is the
  // REAL manifest (name matches). Some packages' `exports` maps remap
  // `<pkg>/package.json` to a nested stub — e.g. @modelcontextprotocol/sdk
  // resolves it to `dist/cjs/package.json` ({"type":"commonjs"}). Copying that
  // dir shipped a package with no dependencies field, so its dep tree
  // (zod-to-json-schema, …) was never copied and a bundled stdio MCP server
  // crashed at require time in the installed app.
  const isRealRoot = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === name;
    } catch {
      return false;
    }
  };
  // 1) Direct package.json resolution (works when exports allows it).
  try {
    const dir = dirname(fromRequire.resolve(`${name}/package.json`));
    if (isRealRoot(dir)) return dir;
  } catch {
    // ignore and fall through
  }
  // 2) Resolve the package entry, then walk up to the real package root (the
  //    nearest package.json can be a nested build stub — keep walking).
  try {
    const entry = fromRequire.resolve(name);
    let dir = nearestPackageDir(dirname(entry));
    while (dir) {
      if (isRealRoot(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = nearestPackageDir(parent);
    }
  } catch {
    // ignore and fall through
  }
  // 3) Direct directory lookup in candidate node_modules. pnpm places a
  //    package's deps as siblings under the same .pnpm/<x>/node_modules dir,
  //    so the requiring package's enclosing node_modules is a key candidate.
  const candidates = [];
  if (fromDir) {
    candidates.push(join(fromDir, "node_modules")); // nested
    // The pnpm sibling root is the ENCLOSING `node_modules` dir, which is two
    // levels up for a scoped package (.../node_modules/@scope/name) and one for
    // an unscoped one. Using dirname() alone silently missed every scoped
    // dependency of a scoped package — e.g. an MCP server's SDK, which then
    // shipped without its dep tree and crashed the spawned MCP server.
    const siblingRoot = enclosingNodeModules(fromDir);
    if (siblingRoot) candidates.push(siblingRoot);
  }
  candidates.push(...NM_ROOTS);
  for (const nm of candidates) {
    const candidate = join(nm, ...segs);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

/**
 * Sharp publishes every platform binary as an optional dependency. Windows x64
 * installers need only their host binary; unrelated packages retain npm's normal
 * optional-dependency behavior.
 */
export function selectedOptionalDependencies(
  packageName,
  optionalDependencies,
  platform = process.platform,
  arch = process.arch,
) {
  const names = Object.keys(optionalDependencies || {});
  if (packageName !== "sharp" || platform !== "win32") return names;
  if (arch !== "x64") {
    throw new Error(`sharp has no supported Windows host selection for ${platform}/${arch}`);
  }
  return names.filter((name) => name === "@img/colour" || name === "@img/sharp-win32-x64");
}

/**
 * Copy a package and its (optional) dependency tree into the flat output
 * node_modules, dereferencing pnpm symlinks. First version of a name wins
 * (npm-style hoist); the smoke test validates the result loads.
 */
export function copyPackage(
  name,
  fromRequire,
  fromDir,
  copied,
  { destination = nodeModulesOut, platform = process.platform, arch = process.arch } = {},
) {
  if (copied.has(name)) return;
  const linkedRoot = packageRoot(name, fromRequire, fromDir);
  if (!linkedRoot) {
    console.warn(`skip (not found): ${name}`);
    return;
  }
  // Resolve pnpm symlinks to the real .pnpm dir. Anchoring the child resolver
  // at the SYMLINK path can't see the package's own deps (pnpm places them as
  // siblings of the REAL location), which silently skipped every transitive
  // dep of a package found via the symlink — a bundled MCP server once
  // shipped without the MCP SDK's dependency tree and crashed on spawn.
  const root = realpathSync(linkedRoot);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = [
    ...Object.keys(pkg.dependencies || {}),
    ...selectedOptionalDependencies(name, pkg.optionalDependencies, platform, arch),
  ];

  copied.add(name);
  const dest = join(destination, ...name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(root, dest, { recursive: true, dereference: true });

  const childRequire = createRequire(join(root, "package.json"));
  for (const dep of deps) {
    copyPackage(dep, childRequire, root, copied, { destination, platform, arch });
  }
}

/**
 * Native packages can publish binaries for every supported OS/architecture in
 * one npm tarball. Keep only this build runner's payload: shipping dormant Intel
 * Mach-O files makes an arm64 app look Intel-based to macOS inventory scanners
 * and adds roughly 180 MB of unused files before compression.
 */
function pruneForeignNativePayloads(stagedOutDir) {
  const runtimes = join(stagedOutDir, "node_modules", "onnxruntime-node", "bin", "napi-v3");
  if (!existsSync(runtimes)) return;

  const selected = join(runtimes, process.platform, process.arch);
  if (!existsSync(selected)) {
    throw new Error(
      `onnxruntime-node has no native payload for ${process.platform}/${process.arch}`,
    );
  }

  const keep = join(stagedOutDir, `.gg-onnxruntime-${process.pid}`);
  cpSync(selected, keep, { recursive: true });
  rmSync(runtimes, { recursive: true, force: true });
  mkdirSync(join(runtimes, process.platform), { recursive: true });
  cpSync(keep, selected, { recursive: true });
  rmSync(keep, { recursive: true, force: true });
  console.log(`pruned onnxruntime-node payloads to ${process.platform}/${process.arch}`);
}

function pruneSourceMaps(stagedOutDir) {
  const removed = [];
  for (const file of walkFiles(stagedOutDir)) {
    if (file.relative.endsWith(".map")) {
      removed.push(file);
      rmSync(file.path);
    }
  }
  return removed;
}

function selectOpenSrcBinary() {
  if (process.platform === "win32" && process.arch === "x64") {
    return "opensrc-win32-x64.exe";
  }
  if (process.platform === "darwin" && ["x64", "arm64"].includes(process.arch)) {
    return `opensrc-darwin-${process.arch}`;
  }
  if (process.platform === "linux" && ["x64", "arm64"].includes(process.arch)) {
    const report = process.report?.getReport?.();
    const usesMusl = !report?.header?.glibcVersionRuntime;
    return `opensrc-linux-${usesMusl ? "musl-" : ""}${process.arch}`;
  }
  throw new Error(
    `opensrc has no supported binary mapping for ${process.platform}/${process.arch}`,
  );
}

function pruneForeignOpenSrcBinaries(stagedOutDir) {
  const binDir = join(stagedOutDir, "node_modules", "opensrc", "bin");
  const selectedName = selectOpenSrcBinary();
  const selected = join(binDir, selectedName);
  if (!existsSync(selected)) {
    throw new Error(`opensrc expected host binary is missing: ${selectedName}`);
  }

  const knownFiles = walkFiles(binDir).filter((file) => OPENSRC_BINARIES.has(file.relative));
  const removed = knownFiles
    .filter((file) => file.relative !== selectedName)
    .map((file) => ({
      ...file,
      relative: portablePath(relative(stagedOutDir, file.path)),
    }));
  const keep = join(binDir, `.gg-opensrc-${process.pid}`);
  cpSync(selected, keep);
  for (const file of knownFiles) rmSync(file.path);
  cpSync(keep, selected);
  rmSync(keep);

  const retained = walkFiles(binDir).filter((file) => OPENSRC_BINARIES.has(file.relative));
  if (retained.length !== 1 || retained[0].relative !== selectedName) {
    throw new Error(
      `opensrc pruning retained ${retained.map((file) => file.relative).join(", ") || "no native executable"}; expected only ${selectedName}`,
    );
  }
  return { removed, selectedName };
}

function assertPrunedLayout(
  stagedOutDir,
  before,
  removed,
  after,
  selectedOpenSrcBinary,
  packagePrune,
) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (after.bytes !== before.bytes - removed.bytes) {
    fail(
      `byte arithmetic failed: after ${after.bytes} != before ${before.bytes} - removed ${removed.bytes}`,
    );
  }
  if (after.files !== before.files - removed.files) {
    fail(
      `file arithmetic failed: after ${after.files} != before ${before.files} - removed ${removed.files}`,
    );
  }

  const opensrcPrefix = "node_modules/opensrc/bin/";
  for (const file of removed.entries) {
    const allowedOpenSrc =
      file.relative.startsWith(opensrcPrefix) &&
      OPENSRC_BINARIES.has(file.relative.slice(opensrcPrefix.length));
    const allowedPackagePrune = packagePrune.removedPaths.has(file.relative);
    if (!file.relative.endsWith(".map") && !allowedOpenSrc && !allowedPackagePrune) {
      fail(`unexpected removed path: ${file.relative}`);
    }
  }

  const beforeMaps = before.categories.get("source-map") ?? emptySummary();
  const removedMaps = removed.categories.get("source-map") ?? emptySummary();
  const retainedMaps = after.categories.get("source-map") ?? emptySummary();
  if (removedMaps.files !== beforeMaps.files) {
    fail(`removed source-map file count failed: ${removedMaps.files} != ${beforeMaps.files}`);
  }
  if (removedMaps.bytes < 25 * MIB) {
    fail(`removed source-map size threshold failed: ${formatBytes(removedMaps.bytes)} < 25.00 MiB`);
  }
  if (retainedMaps.files !== 0 || retainedMaps.bytes !== 0) {
    fail(
      `retained source-map gate failed: ${retainedMaps.files} files / ${formatBytes(retainedMaps.bytes)}`,
    );
  }

  const opensrcNativeFiles = after.entries.filter((file) => {
    if (!file.relative.startsWith(opensrcPrefix)) return false;
    return OPENSRC_BINARIES.has(file.relative.slice(opensrcPrefix.length));
  });
  if (
    opensrcNativeFiles.length !== 1 ||
    opensrcNativeFiles[0].relative !== `${opensrcPrefix}${selectedOpenSrcBinary}`
  ) {
    fail(
      `retained opensrc binary gate failed: expected ${selectedOpenSrcBinary}, found ${opensrcNativeFiles.map((file) => file.relative).join(", ") || "none"}`,
    );
  }

  const requiredFiles = [
    "app-sidecar.mjs",
    "skills/evidence-led-ui/SKILL.md",
    "node_modules/sharp/package.json",
    ...(process.platform === "win32" && process.arch === "x64"
      ? ["node_modules/@img/colour/package.json", "node_modules/@img/sharp-win32-x64/package.json"]
      : []),
    "node_modules/playwright/package.json",
    "node_modules/@huggingface/transformers/LICENSE",
    "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    "node_modules/onnxruntime-web/dist/ort.node.min.js",
    "node_modules/onnxruntime-web/dist/ort.node.min.mjs",
    "node_modules/ogg-opus-decoder/index.js",
    "node_modules/@wasm-audio-decoders/opus-ml/index.js",
    "node_modules/@mixmark-io/domino/LICENSE",
    "node_modules/@anthropic-ai/sandbox-runtime/LICENSE",
    "node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js",
    ...(packagePrune.sandboxRuntime
      ? [`node_modules/@anthropic-ai/sandbox-runtime/vendor/${packagePrune.sandboxRuntime}`]
      : []),
    "node_modules/unpdf/dist/index.mjs",
    "node_modules/typescript/lib/tsserver.js",
    "node_modules/typescript-language-server/lib/cli.mjs",
    "node_modules/opensrc/bin/opensrc.js",
    `node_modules/opensrc/bin/${selectedOpenSrcBinary}`,
    `node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/${process.arch}`,
  ];
  for (const path of requiredFiles) {
    if (!existsSync(join(stagedOutDir, ...path.split("/"))))
      fail(`required sidecar path missing: ${path}`);
  }

  if (process.platform === "win32" && process.arch === "x64") {
    const retainedSharpPlatforms = after.entries
      .map((file) => file.relative.match(/^node_modules\/@img\/(sharp-[^/]+)\//)?.[1])
      .filter((name, index, names) => name && names.indexOf(name) === index);
    const foreignSharpPlatforms = retainedSharpPlatforms.filter(
      (name) => name !== "sharp-win32-x64",
    );
    if (foreignSharpPlatforms.length > 0) {
      fail(`foreign Sharp payloads retained: ${foreignSharpPlatforms.join(", ")}`);
    }
  }

  const releaseTarget =
    (process.platform === "win32" && process.arch === "x64") || process.platform === "darwin";
  if (releaseTarget && removed.bytes < 65 * MIB) {
    fail(`minimum removed size gate failed: ${formatBytes(removed.bytes)} < 65.00 MiB`);
  }
  if (releaseTarget && after.bytes > before.bytes * 0.82) {
    fail(
      `relative size gate failed: ${formatBytes(after.bytes)} > 82% of ${formatBytes(before.bytes)}`,
    );
  }
  if (releaseTarget && after.bytes > 285 * MIB) {
    fail(`absolute size gate failed: ${formatBytes(after.bytes)} > 285.00 MiB`);
  }
  if (after.files > before.files - 900) {
    fail(`file-count gate failed: ${after.files} > ${before.files - 900}`);
  }

  if (errors.length > 0) throw new Error(`sidecar pruning gates failed:\n- ${errors.join("\n- ")}`);
}
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Recursive non-symlink walk; visit(absPath, dirent) gets files and dirs. */
function walk(root, visit) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      visit(p, entry);
      if (entry.isDirectory()) stack.push(p);
    }
  }
}

/** Delete files matched by `dead(fileAbsPath)`; returns bytes freed. */
function pruneFiles(dead) {
  let freed = 0;
  walk(nodeModulesOut, (p, entry) => {
    if (entry.isFile() && dead(p)) {
      freed += statSync(p).size;
      rmSync(p);
    }
  });
  return freed;
}

/**
 * Source maps are dev-tooling payload: nothing in the packaged app loads them,
 * and they were ~52 MB across the copied dependency tree.
 */
function stripSourceMaps() {
  let count = 0;
  walk(nodeModulesOut, (p, entry) => {
    if (entry.isFile() && p.endsWith(".map")) count++;
  });
  const freed = pruneFiles((p) => p.endsWith(".map"));
  console.log(`stripped ${count} source maps (${mb(freed)})`);
}

function sortedDirectoryEntries(directory) {
  return readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function assertExpectedEntries(packageName, operationRoot, expectedEntries) {
  const actualEntries = sortedDirectoryEntries(operationRoot);
  const expected = [...expectedEntries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (JSON.stringify(actualEntries) !== JSON.stringify(expected)) {
    throw new Error(
      `${packageName} layout changed at ${operationRoot}: expected [${expected.join(", ")}], found [${actualEntries.join(", ")}]`,
    );
  }
}

function removeEmptyDirectories(root, preserveRoot = true) {
  for (const name of sortedDirectoryEntries(root)) {
    const path = join(root, name);
    if (!lstatSync(path).isDirectory()) continue;
    removeEmptyDirectories(path, false);
  }
  if (!preserveRoot && readdirSync(root).length === 0) rmSync(root, { recursive: true });
}

function sandboxRuntimePath(platform, arch) {
  if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return null;
  if (platform === "win32" && ["x64", "arm64"].includes(arch)) {
    return `srt-win/${arch}/srt-win.exe`;
  }
  if (platform === "linux" && ["x64", "arm64"].includes(arch)) {
    return `seccomp/${arch}/apply-seccomp`;
  }
  throw new Error(`sandbox-runtime has no supported host layout for ${platform}/${arch}`);
}

/**
 * Prune only immutable, lockfile-pinned package layouts that are fully described
 * above. Every rule is validated before any package payload is removed, so a
 * dependency update or unexpected tarball layout aborts candidate promotion.
 */
export function pruneAllowlistedPackagePayloads(
  stagedNodeModulesOut,
  { platform = process.platform, arch = process.arch } = {},
) {
  const plans = PACKAGE_PAYLOAD_ALLOWLISTS.map((rule) => {
    const packageRoot = join(stagedNodeModulesOut, ...rule.name.split("/"));
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath))
      throw new Error(`required sidecar package missing: ${rule.name}`);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== rule.name || manifest.version !== rule.version) {
      throw new Error(
        `${rule.name} version changed: expected ${rule.version}, found ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}`,
      );
    }
    for (const requiredPath of rule.requiredPaths) {
      if (!existsSync(join(packageRoot, ...requiredPath.split("/")))) {
        throw new Error(`${rule.name} required runtime path missing: ${requiredPath}`);
      }
    }

    const operations = rule.operations.map((operation) => {
      const operationRoot = resolve(packageRoot, operation.path);
      if (!operationRoot.startsWith(`${packageRoot}${sep}`) && operationRoot !== packageRoot) {
        throw new Error(`${rule.name} prune path escapes its package: ${operation.path}`);
      }
      if (!existsSync(operationRoot)) {
        throw new Error(`${rule.name} expected prune path missing: ${operation.path}`);
      }
      if (operation.expectedEntries) {
        assertExpectedEntries(rule.name, operationRoot, operation.expectedEntries);
      }
      const files = walkFiles(operationRoot);
      if (operation.expectedFiles) {
        const actualFiles = files.map((file) => file.relative);
        const expectedFiles = [...operation.expectedFiles].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
          throw new Error(
            `${rule.name} layout changed at ${operation.path}: expected [${expectedFiles.join(", ")}], found [${actualFiles.join(", ")}]`,
          );
        }
      }
      const retainFiles =
        typeof operation.retainFiles === "function"
          ? operation.retainFiles({ platform, arch })
          : operation.retainFiles;
      for (const retained of retainFiles ?? []) {
        if (!files.some((file) => file.relative === retained)) {
          throw new Error(
            `${rule.name} required retained path missing: ${operation.path}/${retained}`,
          );
        }
      }
      return { ...operation, operationRoot, files, retainFiles: retainFiles ?? [] };
    });
    return { ...rule, packageRoot, operations };
  });

  const removedPaths = new Set();
  let removedBytes = 0;
  for (const plan of plans) {
    for (const operation of plan.operations) {
      const retained = new Set(operation.retainFiles);
      for (const file of operation.files) {
        if (!operation.removeDirectory && retained.has(file.relative)) continue;
        removedBytes += file.bytes;
        removedPaths.add(
          `node_modules/${plan.name}/${portablePath(relative(plan.packageRoot, file.path))}`,
        );
        rmSync(file.path);
      }
      if (operation.removeDirectory || retained.size === 0) {
        rmSync(operation.operationRoot, { recursive: true, force: true });
        if (existsSync(operation.operationRoot)) {
          throw new Error(`${plan.name} forbidden payload survived: ${operation.path}`);
        }
      } else {
        removeEmptyDirectories(operation.operationRoot);
        const retainedAfter = walkFiles(operation.operationRoot).map((file) => file.relative);
        const expectedAfter = [...retained].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (JSON.stringify(retainedAfter) !== JSON.stringify(expectedAfter)) {
          throw new Error(
            `${plan.name} retained layout failed at ${operation.path}: expected [${expectedAfter.join(", ")}], found [${retainedAfter.join(", ")}]`,
          );
        }
      }
    }
  }
  console.log(
    `pruned allowlisted package payloads (${removedPaths.size} files / ${mb(removedBytes)})`,
  );
  return { removedPaths, removedBytes, sandboxRuntime: sandboxRuntimePath(platform, arch) };
}

export async function buildAndPromoteDirectory(
  liveDirectory,
  buildCandidate,
  validateCandidate,
  {
    candidateDirectory = `${liveDirectory}.candidate`,
    backupDirectory = `${liveDirectory}.previous`,
    rename = renameSync,
    remove = rmSync,
    makeDirectory = mkdirSync,
  } = {},
) {
  if (existsSync(backupDirectory)) {
    if (existsSync(liveDirectory)) remove(backupDirectory, { recursive: true, force: true });
    else rename(backupDirectory, liveDirectory);
  }
  remove(candidateDirectory, { recursive: true, force: true });
  makeDirectory(candidateDirectory, { recursive: true });

  let result;
  try {
    result = await buildCandidate(candidateDirectory);
    await validateCandidate(candidateDirectory, result);
  } catch (error) {
    try {
      remove(candidateDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "sidecar candidate failed and cleanup failed",
      );
    }
    throw error;
  }

  let movedLive = false;
  try {
    if (existsSync(liveDirectory)) {
      rename(liveDirectory, backupDirectory);
      movedLive = true;
    }
    rename(candidateDirectory, liveDirectory);
  } catch (error) {
    try {
      if (movedLive) rename(backupDirectory, liveDirectory);
      remove(candidateDirectory, { recursive: true, force: true });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "sidecar promotion and rollback failed");
    }
    throw error;
  }

  if (movedLive) {
    try {
      remove(backupDirectory, { recursive: true, force: true });
    } catch (error) {
      console.warn(`sidecar promoted; stale backup cleanup failed: ${error.message}`);
    }
  }
  return result;
}

async function main() {
  if (!existsSync(sidecarEntry)) {
    throw new Error(`sidecar entry missing: ${sidecarEntry} (build @kenkaiiii/ggcoder first)`);
  }
  if (!existsSync(bundledSkillsSource)) {
    throw new Error(`bundled skills missing: ${bundledSkillsSource}`);
  }

  const result = await buildAndPromoteDirectory(
    outDir,
    async (stagedOutDir) => {
      const stagedOutFile = join(stagedOutDir, "app-sidecar.mjs");
      const stagedNodeModulesOut = join(stagedOutDir, "node_modules");
      cpSync(bundledSkillsSource, join(stagedOutDir, "skills"), { recursive: true });

      await build({
        entryPoints: [sidecarEntry],
        outfile: stagedOutFile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        external: EXTERNAL,
        // ESM bundles that reference `require`/__dirname need a banner shim so the
        // few CJS-interop call sites in dependencies keep working under Node ESM.
        banner: {
          js: [
            "import { createRequire as __ggCreateRequire } from 'node:module';",
            "import { fileURLToPath as __ggFileURLToPath } from 'node:url';",
            "import { dirname as __ggDirname } from 'node:path';",
            "const require = __ggCreateRequire(import.meta.url);",
            "const __filename = __ggFileURLToPath(import.meta.url);",
            "const __dirname = __ggDirname(__filename);",
          ].join("\n"),
        },
        logLevel: "info",
      });

      const copied = new Set();
      const ggcoderRoot = join(repoRoot, "packages", "ggcoder");
      for (const name of EXTERNAL) {
        copyPackage(name, ggcoderRequire, ggcoderRoot, copied, {
          destination: stagedNodeModulesOut,
        });
      }
      pruneForeignNativePayloads(stagedOutDir);
      const before = inventory(stagedOutDir);
      pruneSourceMaps(stagedOutDir);
      const packagePrune = pruneAllowlistedPackagePayloads(stagedNodeModulesOut);
      const opensrc = pruneForeignOpenSrcBinaries(stagedOutDir);
      const after = inventory(stagedOutDir);
      const retainedPaths = new Set(after.entries.map((file) => file.relative));
      const removed = inventoryFromFiles(
        before.entries.filter((file) => !retainedPaths.has(file.relative)),
      );
      return {
        before,
        removed,
        after,
        copied,
        packagePrune,
        selectedOpenSrcBinary: opensrc.selectedName,
      };
    },
    (stagedOutDir, staged) => {
      renderInventory(staged.before, staged.removed, staged.after);
      console.log(
        `GG_SIDECAR_SIZE_JSON=${inventoryJson(staged.before, staged.removed, staged.after)}`,
      );
      assertPrunedLayout(
        stagedOutDir,
        staged.before,
        staged.removed,
        staged.after,
        staged.selectedOpenSrcBinary,
        staged.packagePrune,
      );
    },
  );

  console.log(
    `bundled sidecar → ${outFile}\ncopied ${result.copied.size} external packages → ${nodeModulesOut}`,
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
