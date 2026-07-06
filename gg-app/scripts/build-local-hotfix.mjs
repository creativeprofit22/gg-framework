// Build a local-patched installer that preserves source fixes by keeping update
// checks visible while blocking direct official updater installs. This does not
// change release builds: the guard is enabled through VITE_GG_LOCAL_PATCHED=1.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..");
const srcTauri = join(appDir, "src-tauri");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const env = {
  ...process.env,
  VITE_GG_LOCAL_PATCHED: "1",
  VITE_GG_SOURCE_ROOT: repoRoot,
};

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  return result.status ?? 1;
}

function requireSuccess(status) {
  if (status !== 0) {
    process.exit(status);
  }
}

function hasUpdatedBundleFile(dir, extension, startedAt) {
  if (!existsSync(dir)) {
    return false;
  }
  return readdirSync(dir).some((name) => {
    const path = join(dir, name);
    return name.endsWith(extension) && statSync(path).mtimeMs >= startedAt;
  });
}

function localBundlesWereUpdatedAfter(startedAt) {
  const bundleDir = join(srcTauri, "target", "release", "bundle");
  return (
    hasUpdatedBundleFile(join(bundleDir, "msi"), ".msi", startedAt) &&
    hasUpdatedBundleFile(join(bundleDir, "nsis"), ".exe", startedAt)
  );
}

function hostTriple() {
  return execFileSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  }).trim();
}

function stagedNodePath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return join(srcTauri, "binaries", `ggnode-${hostTriple()}${ext}`);
}

function localTauriConfigPath() {
  const configDir = join(repoRoot, ".gg", "local-fixes");
  const configPath = join(configDir, "tauri-local-patched.conf.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        bundle: {
          createUpdaterArtifacts: false,
        },
      },
      null,
      2,
    )}\n`,
  );
  return configPath;
}

if (!env.GG_NODE_SOURCE) {
  const stagedNode = stagedNodePath();
  if (existsSync(stagedNode)) {
    env.GG_NODE_SOURCE = stagedNode;
  } else {
    requireSuccess(run(pnpm, ["--filter", "gg-app", "stage:node"]));
  }
}

requireSuccess(run(pnpm, ["--filter", "@kenkaiiii/gg-ai", "build"]));
requireSuccess(run(pnpm, ["--filter", "@kenkaiiii/gg-agent", "build"]));
requireSuccess(run(pnpm, ["--filter", "@kenkaiiii/gg-core", "build"]));
requireSuccess(run(pnpm, ["--filter", "@kenkaiiii/ggcoder", "build"]));
requireSuccess(run(pnpm, ["--filter", "gg-app", "bundle:sidecar"]));
const bundleBuildStartedAt = Date.now();
const buildStatus = run(pnpm, [
  "--filter",
  "gg-app",
  "tauri",
  "build",
  "--no-sign",
  "--config",
  localTauriConfigPath(),
]);
if (buildStatus !== 0 && !localBundlesWereUpdatedAfter(bundleBuildStartedAt)) {
  process.exit(buildStatus);
}
if (buildStatus !== 0) {
  console.log(
    "Local bundles were produced; ignoring updater/code signing failure for this local-patched build.",
  );
}
