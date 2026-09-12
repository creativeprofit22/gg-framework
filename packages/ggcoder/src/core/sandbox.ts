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
  /**
   * Unix socket paths sandboxed commands may open, e.g.
   * `/var/run/docker.sock`. Empty by default — each entry is a hole straight
   * through the sandbox (see {@link buildSandboxSettings}).
   */
  allowUnixSockets?: string[];
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
let warnedDegraded = false;

/**
 * Linux ships unix-socket blocking as a separate `apply-seccomp` helper, and
 * when it is missing SRT continues with the filter silently dropped
 * (linux-sandbox-utils.js:403 and :1118). The sandbox still starts, still
 * reports success, and still filters the network — but a sandboxed process can
 * open AF_UNIX sockets again, which is the Docker/SSH-agent socket back.
 * `workspace` mode promises to fail closed, so it has to notice.
 */
const DEGRADED_ISOLATION =
  /seccomp[^\n]*not available|unix socket (?:blocking disabled|access not restricted)/i;

export interface SandboxSupport {
  supported: boolean;
  reason: string;
  /** Isolation started but is missing a control we promised; null when intact. */
  degraded?: string | null;
}

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

/** `candidate` is `zone` or sits underneath it. */
function isInside(candidate: string, zone: string): boolean {
  return candidate === zone || candidate.startsWith(zone + path.sep);
}

/**
 * Resolve one WRITE root, refusing to let a symlink widen our own authority.
 *
 * {@link withRealPath} grants write access to wherever a path resolves to. That
 * is required for OS aliases (/tmp → /private/tmp) but is unsafe for roots the
 * sandbox itself hands over to untrusted code: every {@link toolCacheDirs}
 * entry is writable *by the sandboxed process*, so a command could delete one
 * and leave a symlink behind (`rm -rf ~/.deno && ln -s / ~/.deno`). The next
 * policy build would resolve that root to `/` and grant write access to the
 * whole filesystem — a persistent escape that outlives the run that planted it.
 *
 * So a resolved root is only accepted while it stays inside a zone we already
 * intended to expose. Anything else is an authority expansion rather than a
 * path alias, and BOTH forms are dropped: keeping the symlink itself would
 * still write through to the target. Losing a tool cache costs a slower
 * install; keeping it can cost the machine.
 */
function safeWriteRoots(target: string, zones: readonly string[]): string[] {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    // Not created yet (common for tool caches) — nothing to resolve, and a
    // path that does not exist cannot be pointing anywhere dangerous yet.
    return [target];
  }
  if (real === target) return [target];
  if (!zones.some((zone) => isInside(real, zone))) {
    log("WARN", "sandbox", "refusing write root that resolves outside the sandbox", {
      target,
      real,
    });
    return [];
  }
  return [target, real];
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
  // Where a write root is allowed to LAND once symlinks are resolved. These are
  // the areas we already intended to expose, so an alias inside them is just an
  // alias; a root resolving anywhere else is an escape attempt (see
  // safeWriteRoots). Anchors are themselves resolved so the comparison works on
  // macOS, where the workspace and temp dir are usually reached via /var.
  const writeZones = [
    ...new Set(
      [
        temp,
        workspace,
        ...(policy.additionalRoots ?? []).map((root) => path.resolve(root)),
        path.resolve(getAppPaths().agentDir),
        // Only when the user opted in. Listing $HOME unconditionally would
        // accept a tool cache repointed at ~/.ssh — writing authorized_keys is
        // persistence, and this list governs WRITES, so the ~/.ssh READ denial
        // below would not stop it.
        ...(policy.allowOutsideWorkspaceWrites ? [home] : []),
        ...(platform === "win32" ? [] : ["/tmp"]),
        // NB: the macOS /private aliases need no entry of their own — each
        // anchor above is expanded through withRealPath, so /var/folders/… and
        // /private/var/folders/… are both already zones. Listing bare /private
        // would be far wider than intended (it also holds /private/etc).
      ].flatMap(withRealPath),
    ),
  ];
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
      ].flatMap((target) => safeWriteRoots(target, writeZones)),
    ),
  ];

  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
      // Opt-in, and empty by default. Every entry is a full bypass of the
      // isolation around it: `/var/run/docker.sock` is unauthenticated
      // root-equivalent control of the host (mount / into a container and the
      // workspace boundary is gone), and the SSH agent socket signs anything
      // asked of it. The domain allowlist cannot see either — no TCP is
      // involved. Users who need `docker` in sandboxed bash grant it here
      // explicitly, rather than the sandbox quietly deciding for them.
      //
      // macOS only: on Linux/WSL2 SRT's seccomp filter blocks AF_UNIX by
      // syscall and cannot inspect paths, so a per-path list is unenforceable
      // there (it would need allowAllUnixSockets, which we do not expose).
      allowUnixSockets: platform === "darwin" ? [...new Set(policy.allowUnixSockets ?? [])] : [],
      // Always on, with no setting to turn it off.
      //
      // SRT couples three rules into this flag: network-bind, network-inbound
      // and `(allow network-outbound (remote ip "localhost:*"))`
      // (macos-sandbox-utils.js:473-477), with no per-port form. Dev servers,
      // preview servers and the screenshot tool all bind loopback, so turning
      // it off breaks everyday work outright.
      //
      // The egress half is a real hole only for someone running an
      // unauthenticated service on a local TCP port — `docker` exposed on
      // tcp://localhost:2375, a bare Ollama, a live `kubectl proxy`. That is
      // rare and self-inflicted, and the common case is already covered: Docker
      // listens on /var/run/docker.sock by default, which allowUnixSockets
      // above keeps shut. A setting for the remainder would be one more knob
      // nobody turns, breaking dev servers for whoever found it by accident.
      //
      // Linux is unaffected regardless: bwrap gives the sandbox its own network
      // namespace, so its loopback is not the host's.
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
let supportProbe: Promise<SandboxSupport> | null = null;

export function resetSandboxSupportProbeForTests(seed?: SandboxSupport): void {
  supportProbe = seed ? Promise.resolve(seed) : null;
  warnedUnsupported = false;
  warnedDegraded = false;
}

function probeSandboxSupport(settingsPath: string): Promise<SandboxSupport> {
  supportProbe ??= new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        [resolveSandboxCli(), "--settings", settingsPath, "-c", "exit 0"],
        {
          stdio: ["ignore", "ignore", "pipe"],
          // SRT reports the dropped seccomp filter through its debug logger, so
          // the one probe run has to ask for it. Only on Linux, which is the
          // only platform that degrades this way, and the output is parsed and
          // discarded here rather than shown.
          ...(process.platform === "linux" ? { env: { ...process.env, SRT_DEBUG: "1" } } : {}),
        },
      );
    } catch (error) {
      resolve({ supported: false, reason: (error as Error).message });
      return;
    }
    let stderr = "";
    let degraded: string | null = null;
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // Match per chunk: `stderr` keeps only the tail for the failure message,
      // and under SRT_DEBUG the warning is easily scrolled past it.
      degraded ??= text.match(DEGRADED_ISOLATION)?.[0] ?? null;
      stderr = `${stderr}${text}`.slice(-500);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ supported: false, reason: "sandbox probe timed out", degraded });
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
        degraded,
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
 * - **Loopback egress is unfiltered**: sandboxed commands can reach any local
 *   TCP port, because upstream ties that to port binding and dev servers need
 *   to bind. A service listening on localhost without authentication is
 *   reachable from sandboxed bash.
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

  if (support.degraded) {
    if (policy.mode === "workspace") {
      throw new Error(
        `OS sandbox isolation is incomplete: ${support.degraded}. Unix sockets ` +
          `(Docker, the SSH agent) stay reachable from sandboxed commands. Install ` +
          `@anthropic-ai/sandbox-runtime globally so the apply-seccomp helper is on ` +
          `disk, or set sandboxMode to "auto" to accept reduced isolation.`,
      );
    }
    if (!warnedDegraded) {
      warnedDegraded = true;
      log("WARN", "sandbox", "OS sandbox running with reduced isolation", {
        reason: support.degraded,
      });
    }
  }

  return {
    file: process.execPath,
    args: [resolveSandboxCli(), "--settings", settingsPath, "--", shell.file, ...shell.args],
    isCmdFallback: shell.isCmdFallback,
    sandboxed: true,
  };
}
