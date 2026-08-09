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
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const sidecarEntry = join(here, "error-mom-sidecar.mjs");
const ggcoderSidecarEntry = join(repoRoot, "packages", "ggcoder", "dist", "app-sidecar.js");
const outDir = join(here, "..", "src-tauri", "sidecar");
const outFile = join(outDir, "app-sidecar.mjs");
const nodeModulesOut = join(outDir, "node_modules");
const bundledSkillsSource = join(repoRoot, "packages", "ggcoder", "assets", "skills");
const bundledSkillsOut = join(outDir, "skills");

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
  // Default MCP server: spawned as a stdio child, never imported, so esbuild
  // won't bundle it. Copy it next to the sidecar so resolveStdioCommand can
  // resolve its bin and rewrite `npx -y @kenkaiiii/kencode-search` to a direct
  // `node dist/index.js` spawn. Without this the shipped app silently falls
  // back to raw npx, paying a ~90 MB `npm exec` wrapper per MCP connection.
  "@kenkaiiii/kencode-search",
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
  // (zod-to-json-schema, …) was never copied and the bundled kencode-search
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
    // dependency of a scoped package — e.g. kencode-search's MCP SDK, which
    // then shipped without its dep tree and crashed the spawned MCP server.
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
 * Copy a package and its (optional) dependency tree into the flat output
 * node_modules, dereferencing pnpm symlinks. First version of a name wins
 * (npm-style hoist); the smoke test validates the result loads.
 */
function copyPackage(name, fromRequire, fromDir, copied) {
  if (copied.has(name)) return;
  const linkedRoot = packageRoot(name, fromRequire, fromDir);
  if (!linkedRoot) {
    console.warn(`skip (not found): ${name}`);
    return;
  }
  // Resolve pnpm symlinks to the real .pnpm dir. Anchoring the child resolver
  // at the SYMLINK path can't see the package's own deps (pnpm places them as
  // siblings of the REAL location), which silently skipped every transitive
  // dep of a package found via the symlink — the bundled kencode-search
  // shipped without the MCP SDK's dependency tree and crashed on spawn.
  const root = realpathSync(linkedRoot);
  copied.add(name);
  const dest = join(nodeModulesOut, ...name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(root, dest, { recursive: true, dereference: true });

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };
  const childRequire = createRequire(join(root, "package.json"));
  for (const dep of Object.keys(deps)) {
    copyPackage(dep, childRequire, root, copied);
  }
}

/**
 * Native packages can publish binaries for every supported OS/architecture in
 * one npm tarball. Keep only this build runner's payload: shipping dormant Intel
 * Mach-O files makes an arm64 app look Intel-based to macOS inventory scanners
 * and adds roughly 180 MB of unused files before compression.
 */
function pruneForeignNativePayloads() {
  const runtimes = join(nodeModulesOut, "onnxruntime-node", "bin", "napi-v3");
  if (!existsSync(runtimes)) return;

  const selected = join(runtimes, process.platform, process.arch);
  if (!existsSync(selected)) {
    throw new Error(
      `onnxruntime-node has no native payload for ${process.platform}/${process.arch}`,
    );
  }

  const keep = join(outDir, `.gg-onnxruntime-${process.pid}`);
  cpSync(selected, keep, { recursive: true });
  rmSync(runtimes, { recursive: true, force: true });
  mkdirSync(join(runtimes, process.platform), { recursive: true });
  cpSync(keep, selected, { recursive: true });
  rmSync(keep, { recursive: true, force: true });
  console.log(`pruned onnxruntime-node payloads to ${process.platform}/${process.arch}`);
}

function pruneSourceMaps() {
  const removed = [];
  for (const file of walkFiles(outDir)) {
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

function pruneForeignOpenSrcBinaries() {
  const binDir = join(nodeModulesOut, "opensrc", "bin");
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
      relative: portablePath(relative(outDir, file.path)),
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

function assertPrunedLayout(before, removed, after, selectedOpenSrcBinary) {
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
    if (!file.relative.endsWith(".map") && !allowedOpenSrc) {
      fail(`unexpected removed path: ${file.relative}`);
    }
  }

  const removedMaps = removed.categories.get("source-map") ?? emptySummary();
  const retainedMaps = after.categories.get("source-map") ?? emptySummary();
  if (removedMaps.files < 900) {
    fail(`removed source-map file threshold failed: ${removedMaps.files} < 900`);
  }
  if (removedMaps.bytes < 45 * MIB) {
    fail(`removed source-map size threshold failed: ${formatBytes(removedMaps.bytes)} < 45.00 MiB`);
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
    "node_modules/playwright/package.json",
    "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    "node_modules/unpdf/dist/index.mjs",
    "node_modules/typescript/lib/tsserver.js",
    "node_modules/typescript-language-server/lib/cli.mjs",
    "node_modules/opensrc/bin/opensrc.js",
    `node_modules/opensrc/bin/${selectedOpenSrcBinary}`,
    "node_modules/@kenkaiiii/kencode-search/dist/index.js",
    `node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/${process.arch}`,
  ];
  for (const path of requiredFiles) {
    if (!existsSync(join(outDir, ...path.split("/"))))
      fail(`required sidecar path missing: ${path}`);
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

async function main() {
  if (!existsSync(ggcoderSidecarEntry)) {
    throw new Error(
      `sidecar entry missing: ${ggcoderSidecarEntry} (build @kenkaiiii/ggcoder first)`,
    );
  }
  if (!existsSync(bundledSkillsSource)) {
    throw new Error(`bundled skills missing: ${bundledSkillsSource}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(bundledSkillsSource, bundledSkillsOut, { recursive: true });

  await build({
    entryPoints: [sidecarEntry],
    outfile: outFile,
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
    copyPackage(name, ggcoderRequire, ggcoderRoot, copied);
  }
  pruneForeignNativePayloads();

  const before = inventory(outDir);
  const removedSourceMaps = pruneSourceMaps();
  const opensrc = pruneForeignOpenSrcBinaries();
  const removed = inventoryFromFiles([...removedSourceMaps, ...opensrc.removed]);
  const after = inventory(outDir);

  console.log(
    `bundled sidecar → ${outFile}\ncopied ${copied.size} external packages → ${nodeModulesOut}`,
  );
  renderInventory(before, removed, after);
  console.log(`GG_SIDECAR_SIZE_JSON=${inventoryJson(before, removed, after)}`);
  assertPrunedLayout(before, removed, after, opensrc.selectedName);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
