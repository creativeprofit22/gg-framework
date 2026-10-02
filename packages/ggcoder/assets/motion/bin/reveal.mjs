#!/usr/bin/env node
// GG Motion reveal: open the user's file manager at a finished video, with the
// file selected where the OS supports it (Finder, Explorer). Linux file
// managers have no common "select" flag, so the containing folder opens.
//
// Usage: node reveal.mjs <file-or-folder> [--dry-run] [--platform darwin|win32|linux]
// --dry-run prints the command instead of running it; --platform only works
// with --dry-run (for tests). Prints one JSON line: {"ok":true,"cmd":…,"args":…}.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const platformIndex = args.indexOf("--platform");
const platformArg = platformIndex >= 0 ? args[platformIndex + 1] : undefined;
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(platformIndex >= 0 && i === platformIndex + 1),
);
const target = positional[0];
if (!target || positional.length > 1) {
  fail("usage: reveal.mjs <file-or-folder> [--dry-run] [--platform darwin|win32|linux]");
}
if (platformArg !== undefined && !dryRun) fail("--platform only works with --dry-run");
if (platformArg !== undefined && !["darwin", "win32", "linux"].includes(platformArg)) {
  fail("--platform must be darwin, win32 or linux");
}
const platform = platformArg ?? process.platform;

const full = resolve(target);
const info = await stat(full).catch(() => undefined);
if (!info) fail(`Not found: ${full}`);
const isDir = info.isDirectory();

/** @returns {{ cmd: string, args: string[], verbatim: boolean }} */
function revealCommand() {
  if (platform === "darwin") {
    return { cmd: "open", args: isDir ? [full] : ["-R", full], verbatim: false };
  }
  if (platform === "win32") {
    // Explorer parses `/select,"<path>"` itself and rejects Node's default
    // quoting of the whole argument, so pass it verbatim. Windows paths cannot
    // contain `"`, so the quotes cannot be broken out of.
    return {
      cmd: "explorer.exe",
      args: isDir ? [`"${full}"`] : [`/select,"${full}"`],
      verbatim: true,
    };
  }
  return { cmd: "xdg-open", args: [isDir ? full : dirname(full)], verbatim: false };
}

const command = revealCommand();
if (!dryRun) {
  await new Promise((resolveLaunch) => {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: command.verbatim,
    });
    // Explorer exits 1 even on success, so only a failed launch counts.
    child.once("error", (error) => fail(`Could not open the file manager: ${error.message}`));
    child.once("spawn", () => {
      child.unref();
      resolveLaunch(undefined);
    });
  });
}
process.stdout.write(
  `${JSON.stringify({ ok: true, revealed: full, cmd: command.cmd, args: command.args, dryRun })}\n`,
);
