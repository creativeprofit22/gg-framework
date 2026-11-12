// Install /setup-bench and the bench kit into the GG agent folder
// ($GG_AGENT_DIR, else ~/.gg):
//
//   commands/setup-bench.md                  the global command (atomic replace)
//   bench-kit/<kitVersion>-<sha8>/           one folder per kit build, never rewritten
//   bench-kit/current.json                   pointer to the folder /setup-bench vendors
//
// The kit folder is built in a temporary folder, verified against its
// manifest, then renamed into place; the pointer file is replaced atomically.
// Versioned folders plus a pointer avoid renaming over an existing folder,
// which fails on Windows while another process holds it open.
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashTree } from "../assets/bench-kit/lib/protocol.mjs";
import { KIT_VERSION } from "../assets/bench-kit/lib/version.mjs";

export const canonicalSetupBenchCommandPath = fileURLToPath(
  new URL("../assets/commands/setup-bench.md", import.meta.url),
);
export const canonicalBenchKitDir = fileURLToPath(new URL("../assets/bench-kit", import.meta.url));
export const MANIFEST_FILE = "manifest.json";
export const POINTER_FILE = "current.json";

/** Files that are never part of a kit build. @param {string} rel */
const excluded = (rel) =>
  rel === MANIFEST_FILE ||
  rel === "node_modules" ||
  rel.startsWith("node_modules/") ||
  rel.endsWith(".log") ||
  rel.endsWith(".tmp");

/** @param {string | Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function resolveAgentDir(
  agentDir = process.env.GG_AGENT_DIR || path.join(homedir(), ".gg"),
) {
  if (!path.isAbsolute(agentDir)) throw new Error("GG_AGENT_DIR must be absolute");
  return path.normalize(agentDir);
}

export function resolveSetupBenchCommandTarget(agentDir) {
  return path.join(resolveAgentDir(agentDir), "commands", "setup-bench.md");
}

/**
 * Manifest of a kit folder: version, a digest over every file, and each
 * file's hash. Text files with CR line endings are refused (the kit's
 * protocol hashes are byte-exact).
 * @param {string} [kitDir]
 */
export async function buildKitManifest(kitDir = canonicalBenchKitDir) {
  const tree = await hashTree(kitDir, { exclude: excluded });
  if (!tree.ok) throw new Error(`cannot build the kit manifest: ${tree.error.message}`);
  if (tree.value.files.length === 0) throw new Error(`no kit files found in ${kitDir}`);
  return {
    schema: 1,
    kitVersion: KIT_VERSION,
    digest: tree.value.digest,
    files: tree.value.files,
  };
}

/** @param {string} dir */
async function isRealDirectory(dir) {
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A built kit folder whose files still match the expected digest. @param {string} dir @param {string} digest */
async function verifiedKit(dir, digest) {
  if (!(await isRealDirectory(dir))) return false;
  const tree = await hashTree(dir, { exclude: excluded });
  if (!tree.ok || tree.value.digest !== digest) return false;
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8"));
    return manifest.digest === digest && manifest.kitVersion === KIT_VERSION;
  } catch {
    return false;
  }
}

/** Write a file by temp file + rename in the same folder. @param {string} file @param {string | Uint8Array} content */
async function writeAtomic(file, content) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Install the kit build into `<agent dir>/bench-kit/<version>-<sha8>/` and
 * point `current.json` at it. Reinstalling the same build is a no-op apart
 * from rewriting the pointer.
 * @param {{ agentDir?: string, kitDir?: string }} [options]
 */
export async function installBenchKit({ agentDir, kitDir = canonicalBenchKitDir } = {}) {
  const root = path.join(resolveAgentDir(agentDir), "bench-kit");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await isRealDirectory(root))) throw new Error(`Kit path must be a real directory: ${root}`);

  const manifest = await buildKitManifest(kitDir);
  const dirName = `${manifest.kitVersion}-${manifest.digest.slice(0, 8)}`;
  const target = path.join(root, dirName);
  const reused = await verifiedKit(target, manifest.digest);
  if (!reused) {
    const temporary = path.join(root, `.build-${process.pid}-${randomUUID()}`);
    try {
      await cp(kitDir, temporary, {
        recursive: true,
        filter: (source) => {
          const rel = path.relative(kitDir, source).split(path.sep).join("/");
          return rel === "" || !excluded(rel);
        },
      });
      await writeFile(
        path.join(temporary, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      if (!(await verifiedKit(temporary, manifest.digest)))
        throw new Error("the copied kit does not match its manifest");
      // A folder with this name but other contents is a damaged copy of this
      // exact build (the name is content-addressed), so it is safe to replace.
      if (
        await stat(target).then(
          () => true,
          () => false,
        )
      )
        await rm(target, { recursive: true, force: true });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  const pointer = {
    schema: 1,
    kitVersion: manifest.kitVersion,
    digest: manifest.digest,
    dir: dirName,
  };
  await writeAtomic(path.join(root, POINTER_FILE), `${JSON.stringify(pointer, null, 2)}\n`);
  return { root, dir: target, pointer, files: manifest.files.length, reused };
}

/**
 * Install /setup-bench and the kit it vendors.
 * @param {{ agentDir?: string, kitDir?: string }} [options]
 */
export async function installSetupBenchCommand({ agentDir, kitDir } = {}) {
  const source = await readFile(canonicalSetupBenchCommandPath);
  const target = resolveSetupBenchCommandTarget(agentDir);
  const commandsDir = path.dirname(target);
  await mkdir(commandsDir, { recursive: true, mode: 0o700 });
  if (!(await isRealDirectory(commandsDir)))
    throw new Error(`Commands path must be a real directory: ${commandsDir}`);
  await writeAtomic(target, source);
  const kit = await installBenchKit({ agentDir, ...(kitDir ? { kitDir } : {}) });
  return {
    source: canonicalSetupBenchCommandPath,
    target,
    sha256: sha256(source),
    kit,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const result = await installSetupBenchCommand();
  console.log(`Installed /setup-bench: ${result.target}`);
  console.log(`Canonical source: ${result.source}`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log(
    `Bench kit ${result.kit.pointer.kitVersion}: ${result.kit.dir} (${result.kit.files} files${result.kit.reused ? ", already installed" : ""})`,
  );
  console.log(`Kit digest: ${result.kit.pointer.digest}`);
}
