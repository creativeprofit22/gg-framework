import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { getAppPaths } from "../config.js";
import { DEFAULT_ALLOWED_DOMAINS } from "./sandbox-domains.js";
import type { ShellResolution } from "./shell.js";

export interface SandboxPolicy {
  /**
   * `workspace` always isolates and fails closed. `auto` isolates wherever the
   * OS supports it and degrades with a warning where the prerequisites are
   * absent, because SRT needs bubblewrap/socat on Linux and an elevated
   * `windows-install` on Windows — enforcing there would break every command.
   */
  mode: "auto" | "workspace" | "off";
  /**
   * Extra hosts reachable while sandboxed, on top of
   * {@link DEFAULT_ALLOWED_DOMAINS} unless {@link strictDomains} is set.
   */
  allowedDomains: string[];
  /**
   * Use only {@link allowedDomains}, dropping the built-in developer defaults.
   * Set when the user has explicitly taken over network policy.
   */
  strictDomains?: boolean;
  /** Extra workspace roots (multi-root sessions), mirroring the write guard. */
  additionalRoots?: string[];
  /** The user consented to writes outside the workspace; do not contradict them. */
  allowOutsideWorkspaceWrites?: boolean;
}

export interface SandboxLaunch extends ShellResolution {
  sandboxed: boolean;
}

/**
 * Environment applied only to sandboxed commands.
 *
 * The sandbox permanently protects `.git/hooks`, and git's only reason to write
 * there is copying inert `*.sample` templates during `init`/`clone` — which
 * fails the whole command. Pointing git at an empty template directory removes
 * that write, so cloning works with hook protection fully intact.
 */
export const SANDBOX_ENV_PATCH: Readonly<Record<string, string>> = {
  GIT_TEMPLATE_DIR: "",
};

interface SandboxSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: boolean;
    allowUnixSockets: string[];
    allowLocalBinding: boolean;
  };
  /**
   * macOS only: let sandboxed processes reach `com.apple.trustd.agent`.
   *
   * Without it, every client that verifies certificates through Security
   * framework fails — pip (truststore) and Go-based CLIs like gh, terraform
   * and kubectl. We do not terminate TLS, so certificates are still validated
   * against the real upstream and the domain allowlist still applies; this only
   * restores certificate checking itself.
   */
  enableWeakerNetworkIsolation?: boolean;
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    /** Git cannot initialise or clone a repository without writing its config. */
    allowGitConfig: boolean;
  };
}

const SANDBOX_CONFIG_DIR = path.join(os.homedir(), ".gg", "sandbox-configs");
const PROBE_TIMEOUT_MS = 20_000;
let warnedUnsupported = false;

function sensitiveReadPaths(home: string): string[] {
  return [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".kube"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".azure"),
    path.join(home, ".gg", "auth.json"),
  ];
}

/**
 * Package-manager caches that live outside the workspace.
 *
 * `npm install`, `cargo build`, `go mod download` and friends all write to a
 * shared cache in $HOME; without these the sandbox looks like it "breaks npm".
 * Everything here is regenerable build state — no credentials, which stay
 * unreadable via {@link sensitiveReadPaths}.
 */
function toolCacheDirs(home: string): string[] {
  return [
    path.join(home, ".npm"),
    path.join(home, ".cache"),
    path.join(home, "Library", "Caches"),
    path.join(home, ".pnpm-store"),
    path.join(home, ".yarn"),
    path.join(home, ".bun"),
    path.join(home, ".deno"),
    path.join(home, ".cargo"),
    path.join(home, ".rustup"),
    path.join(home, "go", "pkg", "mod"),
    path.join(home, ".m2"),
    path.join(home, ".gradle"),
    path.join(home, ".gem"),
    path.join(home, ".bundle"),
    path.join(home, ".nuget"),
    path.join(home, ".composer"),
    path.join(home, ".local", "share", "virtualenvs"),
  ];
}

/**
 * A path plus its symlink-resolved twin.
 *
 * macOS resolves /tmp to /private/tmp and /var/folders to /private/var/folders.
 * The sandbox matches on the real path, so listing only the symlink silently
 * denies every write to the system temp directory.
 */
function withRealPath(target: string): string[] {
  try {
    const real = realpathSync(target);
    return real === target ? [target] : [target, real];
  } catch {
    return [target];
  }
}

/** Pure policy builder, exported so the security boundary is regression-tested. */
export function buildSandboxSettings(
  cwd: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): SandboxSettings {
  const workspace = path.resolve(cwd);
  const temp = path.resolve(os.tmpdir());
  const home = os.homedir();
  const allowedDomains = [
    ...new Set(
      [...(policy.strictDomains ? [] : DEFAULT_ALLOWED_DOMAINS), ...policy.allowedDomains]
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  ].sort();
  // Mirror resolveWriteGuard's roots. The sandbox must never be stricter than
  // the write guard the user already controls, or bash silently loses
  // multi-root workspaces and the documented outside-workspace opt-out.
  const writeRoots = [
    ...new Set(
      [
        workspace,
        ...(policy.additionalRoots ?? []).map((root) => path.resolve(root)),
        temp,
        // The conventional scratch dir, distinct from os.tmpdir() on macOS.
        ...(platform === "win32" ? [] : ["/tmp"]),
        path.resolve(getAppPaths().agentDir),
        ...toolCacheDirs(home),
        ...(policy.allowOutsideWorkspaceWrites ? [home] : []),
      ].flatMap(withRealPath),
    ),
  ];

  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      // Dev servers, preview servers and the screenshot tool all bind a local
      // port. Loopback never leaves the machine, so blocking it costs core
      // workflows without buying containment.
      allowLocalBinding: true,
    },
    ...(platform === "darwin" ? { enableWeakerNetworkIsolation: true } : {}),
    filesystem: {
      denyRead: sensitiveReadPaths(home),
      // SRT adds its platform-required temporary paths; these are the only
      // product-owned write roots supplied by GG Coder.
      allowWrite: platform === "win32" ? writeRoots : [...writeRoots, "/dev/null"],
      // `.git/hooks` is a mandatory sandbox protection with no opt-out, which
      // is worth keeping: it stops a command installing a hook that later runs
      // unsandboxed. `git clone`/`git init` only write there to copy inert
      // `.sample` files, which SANDBOX_ENV_PATCH turns off.
      //
      // `.git/config` must be writable or `git init`, `git remote add` and
      // `git clone` all fail outright.
      allowGitConfig: true,
      // Resolve the workspace first: on macOS the sandbox matches real paths, so
      // a deny rule built from the symlinked path (/var/... vs /private/var/...)
      // silently never matches.
      denyWrite: withRealPath(workspace).flatMap((root) => [
        path.join(root, ".env"),
        path.join(root, ".env.local"),
      ]),
    },
  };
}

function resolveSandboxCli(): string {
  const packageEntry = import.meta.resolve("@anthropic-ai/sandbox-runtime");
  return path.join(path.dirname(fileURLToPath(packageEntry)), "cli.js");
}

/**
 * Does this machine actually support OS sandboxing? SRT reports missing
 * bubblewrap/socat or an unprovisioned Windows sandbox user only when it
 * initializes, so probe once per process with a trivial command instead of
 * reimplementing its per-platform dependency matrix.
 */
let supportProbe: Promise<{ supported: boolean; reason: string }> | null = null;

export function resetSandboxSupportProbeForTests(): void {
  supportProbe = null;
  warnedUnsupported = false;
}

function probeSandboxSupport(
  settingsPath: string,
): Promise<{ supported: boolean; reason: string }> {
  supportProbe ??= new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        [resolveSandboxCli(), "--settings", settingsPath, "-c", "exit 0"],
        {
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    } catch (error) {
      resolve({ supported: false, reason: (error as Error).message });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ supported: false, reason: "sandbox probe timed out" });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ supported: false, reason: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        supported: code === 0,
        reason: code === 0 ? "ok" : stderr.trim() || `sandbox probe exited with code ${code}`,
      });
    });
  });
  return supportProbe;
}

async function writeStableSettings(settings: SandboxSettings): Promise<string> {
  const json = `${JSON.stringify(settings, null, 2)}\n`;
  const digest = createHash("sha256").update(json).digest("hex").slice(0, 20);
  const settingsPath = path.join(SANDBOX_CONFIG_DIR, `${digest}.json`);
  await fs.mkdir(SANDBOX_CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(settingsPath, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return settingsPath;
}

/**
 * Known limitations when `sandboxMode` is enabled (upstream, not fixable here):
 *
 * - **Linux pipes/redirections**: `echo hi | grep hi` fails with "Permission
 *   denied" on /proc/self/fd/3 because bash's pipe setup clobbers the fd the
 *   seccomp filter arrives on (sandbox-runtime#261).
 * - **git over SSH**: `git@host:` remotes fail the SOCKS handshake on macOS —
 *   the injected ProxyCommand uses `nc`, which cannot authenticate. HTTPS
 *   remotes work. `~/.ssh` is also unreadable by design.
 * - **`git config --global`**: `~/.gitconfig` is a mandatory upstream write
 *   protection with no opt-out. Repo-local `git config` works.
 * - **Corporate TLS interception / private registries**: need the CA and
 *   registry host configured explicitly.
 * - **Ubuntu 24.04+**: AppArmor blocks the sandbox entirely, so `auto`
 *   degrades to no isolation (sandbox-runtime#428, #429).
 *
 * These are why the default is `off`; revisit when fixed upstream.
 */

/**
 * Wrap an already-resolved shell with Anthropic's cross-platform OS sandbox.
 * Initialization and dependency failures remain visible and fail closed: the
 * original command is never spawned outside the sandbox as an implicit fallback.
 */
export async function prepareSandboxLaunch(
  shell: ShellResolution,
  cwd: string,
  policy: SandboxPolicy,
): Promise<SandboxLaunch> {
  if (policy.mode === "off") return { ...shell, sandboxed: false };
  const settingsPath = await writeStableSettings(buildSandboxSettings(cwd, policy));

  const support = await probeSandboxSupport(settingsPath);
  if (!support.supported) {
    if (policy.mode === "workspace") {
      throw new Error(
        `${support.reason}. Install the OS sandbox prerequisites ` +
          `(Linux: bubblewrap + socat; Windows: run \`srt windows-install\`), ` +
          `or set sandboxMode to "auto" to run without OS isolation.`,
      );
    }
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      log("WARN", "sandbox", "OS sandbox unavailable; commands run unisolated", {
        reason: support.reason,
      });
    }
    return { ...shell, sandboxed: false };
  }

  return {
    file: process.execPath,
    args: [resolveSandboxCli(), "--settings", settingsPath, "--", shell.file, ...shell.args],
    isCmdFallback: shell.isCmdFallback,
    sandboxed: true,
  };
}
