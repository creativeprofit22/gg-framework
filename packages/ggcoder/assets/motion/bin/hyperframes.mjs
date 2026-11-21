#!/usr/bin/env node
// GG Motion's HyperFrames launcher.
//
// GG ships one pinned HyperFrames CLI with the app and one matching set of
// skills (../plugin.json carries the version). This launcher is the only way
// Motion runs the CLI: it resolves the bundled package from its own location,
// so it never downloads a different release through npx, and it pins the same
// environment HyperFrames' own plugin launcher does (no standalone skill
// installs, no update checks). It also opts out of CLI telemetry.
//
// Usage: node hyperframes.mjs <hyperframes command> [args...]
//        node hyperframes.mjs --script <absolute-script-path> [args...]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = fileURLToPath(new URL("../", import.meta.url));

/** The release version GG bundled the skills for. */
function bundledVersion() {
  const manifest = JSON.parse(readFileSync(join(bundleRoot, "plugin.json"), "utf8"));
  if (manifest.name !== "hyperframes" || typeof manifest.version !== "string") {
    throw new Error(`Invalid GG Motion manifest: ${join(bundleRoot, "plugin.json")}`);
  }
  return manifest.version;
}

/** Absolute path of the bundled CLI entry, plus its installed version. */
function resolveCli() {
  const require = createRequire(import.meta.url);
  let pkgPath;
  try {
    pkgPath = require.resolve("hyperframes/package.json");
  } catch {
    throw new Error(
      "The HyperFrames CLI bundled with GG is missing. Reinstall GG Coder to restore Motion mode.",
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hyperframes;
  if (typeof bin !== "string") throw new Error(`No hyperframes bin in ${pkgPath}`);
  return { entry: join(dirname(pkgPath), bin), version: pkg.version };
}

/**
 * Private by default: `snapshot` and `capture` send frames/images to Google,
 * OpenRouter or Vertex automatically whenever those API keys exist in the
 * user's environment. Opt out unless the caller asked for the analysis.
 * `add` copies a snippet to the system clipboard by default, which would
 * silently overwrite whatever the user had copied; the snippet is also
 * printed, so the agent never needs the clipboard.
 */
function withPrivacyDefaults(args) {
  const has = (flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  if (args[0] === "snapshot" && !has("--describe")) return [...args, "--describe", "false"];
  if (args[0] === "capture" && !has("--skip-vision") && !has("--vision")) {
    return [...args, "--skip-vision"];
  }
  if (args[0] === "add" && !has("--clipboard") && !has("--no-clipboard")) {
    return [...args, "--no-clipboard"];
  }
  return args;
}

function main(rawArgs) {
  const args = withPrivacyDefaults(rawArgs);
  if (args[0] === "skills") {
    throw new Error(
      "HyperFrames skills are bundled with GG Motion and update with GG releases. Do not install or update them.",
    );
  }
  const version = bundledVersion();
  const cli = resolveCli();
  if (cli.version !== version) {
    process.stderr.write(
      `warning: bundled HyperFrames CLI ${cli.version} differs from the skills release ${version}\n`,
    );
  }

  // Put the running Node first on PATH so anything the CLI or a helper script
  // spawns as `node` uses this runtime, even on machines without Node installed.
  const nodeDir = dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: [nodeDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_SKILL_PKG_VERSION: version,
    HYPERFRAMES_PLUGIN_VERSION: version,
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    HYPERFRAMES_NO_TELEMETRY: "1",
  };

  let childArgs;
  if (args[0] === "--script") {
    if (!args[1]) throw new Error("--script requires a Node script path.");
    childArgs = args.slice(1);
  } else {
    childArgs = [cli.entry, ...args];
  }

  const child = spawn(process.execPath, childArgs, { env, stdio: "inherit", windowsHide: true });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
