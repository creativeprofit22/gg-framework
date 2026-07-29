import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGED_WINDOWS_SMOKE_DISABLED_MESSAGE =
  "Packaged Windows smoke automation is retired: it must not build, extract, install, launch, inspect, stop, or clean up installed applications or system artifacts. Use isolated development fixtures for automation and perform release-candidate checks manually.";

function fail(message) {
  throw new Error(message);
}

function normalizePath(path) {
  const absolute = resolve(path);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // Pure artifact snapshots can contain paths removed between reads.
  }
  return canonical.replaceAll("/", "\\").toLowerCase();
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

export function snapshotMsiArtifacts(root) {
  return new Map(
    walkFiles(root)
      .filter((path) => extname(path).toLowerCase() === ".msi")
      .map((path) => {
        const stat = statSync(path);
        return [normalizePath(path), { path, size: stat.size, mtimeMs: stat.mtimeMs }];
      }),
  );
}

export function discoverChangedMsi(before, after) {
  const changed = [...after.values()].filter((artifact) => {
    const previous = before.get(normalizePath(artifact.path));
    return !previous || previous.size !== artifact.size || previous.mtimeMs !== artifact.mtimeMs;
  });
  if (changed.length !== 1) {
    fail(
      `expected one newly built MSI, found ${changed.length}: ${changed.map((item) => item.path).join(", ") || "none"}`,
    );
  }
  return changed[0].path;
}

function findNamedFiles(root, expectedName) {
  const lowerName = expectedName.toLowerCase();
  return walkFiles(root).filter((path) => basename(path).toLowerCase() === lowerName);
}

export function discoverPackagedLayout(extractRoot) {
  const apps = findNamedFiles(extractRoot, "gg-app.exe");
  if (apps.length !== 1) fail(`expected one extracted gg-app.exe, found ${apps.length}`);
  const executable = realpathSync.native(apps[0]);
  const installDir = dirname(executable);
  const node = join(installDir, "ggnode.exe");
  const sidecar = join(installDir, "sidecar", "app-sidecar.mjs");
  if (!existsSync(node)) fail(`packaged Node runtime missing beside app: ${node}`);
  if (!existsSync(sidecar)) fail(`packaged sidecar resource missing: ${sidecar}`);
  return {
    executable,
    installDir,
    node: realpathSync.native(node),
    sidecar: realpathSync.native(sidecar),
  };
}

export async function waitFor(description, probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  fail(`${description} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

export async function runPackagedWindowsSmoke() {
  throw new Error(PACKAGED_WINDOWS_SMOKE_DISABLED_MESSAGE);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runPackagedWindowsSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
