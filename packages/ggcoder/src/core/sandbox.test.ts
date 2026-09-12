import type * as ChildProcessModule from "node:child_process";
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppPaths } from "../config.js";
import { createTestSymlinkSync } from "../test-utils/symlink.js";
import { DEFAULT_SETTINGS } from "./settings-manager.js";
import {
  buildSandboxSettings,
  prepareSandboxLaunch,
  resetSandboxSupportProbeForTests,
} from "./sandbox.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("buildSandboxSettings", () => {
  it("limits writes to the workspace and temp directory, and enforces an allowlist", () => {
    // A real directory, so symlinked temp roots (macOS /var → /private/var) are
    // exercised rather than silently skipped.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gg-sandbox-workspace-"));
    const settings = buildSandboxSettings(cwd, { mode: "workspace", allowedDomains: [] }, "darwin");

    expect(settings.filesystem.allowWrite).toEqual(
      expect.arrayContaining([
        fs.realpathSync(path.resolve(cwd)),
        fs.realpathSync(path.resolve(os.tmpdir())),
        getAppPaths().agentDir,
      ]),
    );
    expect(settings.filesystem.allowWrite).not.toContain(os.homedir());
    // The sandbox matches real paths, so a deny rule must cover the resolved
    // workspace or it silently never fires (macOS /var → /private/var).
    expect(settings.filesystem.denyWrite).toEqual(
      expect.arrayContaining([path.join(fs.realpathSync(path.resolve(cwd)), ".env")]),
    );
    expect(settings.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        path.join(os.homedir(), ".ssh"),
        path.join(os.homedir(), ".gg", "auth.json"),
      ]),
    );
    expect(settings.network).toMatchObject({
      strictAllowlist: true,
      allowUnixSockets: [],
      // Dev servers, preview servers and the screenshot tool all bind loopback,
      // so this stays on by default; the daemons worth protecting listen on
      // unix sockets, which allowUnixSockets keeps shut.
      allowLocalBinding: true,
    });
    // Egress is an allowlist, never open: an unknown host stays unreachable.
    expect(settings.network.allowedDomains).not.toContain("api.example.com");
  });

  it("keeps bash writable in the same roots the write guard already allows", () => {
    const cwd = path.join(os.tmpdir(), "gg-sandbox-workspace");
    const extraRoot = path.join(os.tmpdir(), "gg-sandbox-second-root");
    const settings = buildSandboxSettings(
      cwd,
      { mode: "workspace", allowedDomains: [], additionalRoots: [extraRoot] },
      "darwin",
    );

    // Multi-root sessions and ~/.gg must not silently lose bash writes.
    expect(settings.filesystem.allowWrite).toEqual(
      expect.arrayContaining([path.resolve(cwd), path.resolve(extraRoot), getAppPaths().agentDir]),
    );
    expect(settings.filesystem.allowWrite).not.toContain(os.homedir());
  });

  it("refuses a write root a sandboxed command redirected at the filesystem root", () => {
    // Every tool-cache dir is writable BY the sandboxed process, so a command
    // can delete one and leave a symlink: `rm -rf ~/.deno && ln -s / ~/.deno`.
    // Resolving that root would hand the next run write access to all of `/` —
    // an escape that outlives the run that planted it.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gg-sandbox-home-"));
    const planted = path.join(fakeHome, ".deno");
    createTestSymlinkSync(path.parse(os.tmpdir()).root, planted, "dir");
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gg-sandbox-workspace-"));
      const settings = buildSandboxSettings(
        cwd,
        { mode: "workspace", allowedDomains: [] },
        "darwin",
      );

      // Neither the symlink nor its target may be writable: writing through the
      // symlink lands on the target, so keeping either one is the same escape.
      expect(settings.filesystem.allowWrite).not.toContain(path.parse(os.tmpdir()).root);
      expect(settings.filesystem.allowWrite).not.toContain(planted);
      // The legitimate roots survive — this must not fail closed on everything.
      expect(settings.filesystem.allowWrite).toEqual(
        expect.arrayContaining([fs.realpathSync(path.resolve(cwd))]),
      );
    } finally {
      homeSpy.mockRestore();
    }
  });

  it("refuses a tool cache repointed at the SSH keys", () => {
    // The subtler version of the same trick, and the reason $HOME is not a
    // blanket-allowed landing zone: ~/.ssh sits inside the home directory, so
    // treating "anywhere under $HOME" as intended authority would accept it.
    // This list governs WRITES, so the ~/.ssh read denial does not cover it,
    // and a writable authorized_keys is persistence.
    // The fake home must sit outside `/tmp`, which is itself an intended zone.
    // os.tmpdir() IS /tmp on Linux, so building the home under it would put
    // ~/.ssh legitimately inside a permitted zone and the assertion would fail
    // for the wrong reason (it passed on macOS only because os.tmpdir() there
    // is /var/folders/…). node_modules is writable, git-ignored, and never a
    // zone. Real machines put $HOME outside /tmp, which is the case under test.
    const base = fs.mkdtempSync(
      path.join(import.meta.dirname, "..", "..", "node_modules", ".gg-sandbox-base-"),
    );
    const fakeHome = path.join(base, "home");
    const fakeTmp = path.join(base, "tmp");
    const ssh = path.join(fakeHome, ".ssh");
    fs.mkdirSync(ssh, { recursive: true });
    fs.mkdirSync(fakeTmp);
    createTestSymlinkSync(ssh, path.join(fakeHome, ".deno"), "dir");
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const tmpSpy = vi.spyOn(os, "tmpdir").mockReturnValue(fakeTmp);
    try {
      const cwd = path.join(base, "workspace");
      fs.mkdirSync(cwd);
      const settings = buildSandboxSettings(
        cwd,
        { mode: "workspace", allowedDomains: [] },
        "darwin",
      );

      expect(settings.filesystem.allowWrite).not.toContain(ssh);
      expect(settings.filesystem.allowWrite).not.toContain(fs.realpathSync(ssh));
    } finally {
      homeSpy.mockRestore();
      tmpSpy.mockRestore();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("still follows the OS temp alias, so writes to /tmp are not silently denied", () => {
    // The guard above must not break the reason withRealPath exists: macOS
    // reaches the temp dir through /var → /private/var.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gg-sandbox-workspace-"));
    const settings = buildSandboxSettings(cwd, { mode: "workspace", allowedDomains: [] }, "darwin");

    expect(settings.filesystem.allowWrite).toEqual(
      expect.arrayContaining([fs.realpathSync(path.resolve(os.tmpdir()))]),
    );
  });

  it("honors the outside-workspace opt-out instead of contradicting the user", () => {
    const settings = buildSandboxSettings(
      path.join(os.tmpdir(), "gg-sandbox-workspace"),
      { mode: "workspace", allowedDomains: [], allowOutsideWorkspaceWrites: true },
      "darwin",
    );

    expect(settings.filesystem.allowWrite).toContain(os.homedir());
    // Consenting to write outside the workspace is not consent to leak secrets.
    expect(settings.filesystem.denyRead).toContain(path.join(os.homedir(), ".ssh"));
  });

  it("always lets sandboxed commands bind a local port, on every platform", () => {
    // Dev servers, preview servers and the screenshot tool all bind loopback.
    // Upstream ties binding to loopback egress with no per-port form, so the
    // egress half rides along rather than costing everyone a working dev
    // server. There is deliberately no setting to turn this off.
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const settings = buildSandboxSettings(
        "/workspace",
        { mode: "workspace", allowedDomains: [] },
        platform,
      );

      expect(settings.network.allowLocalBinding, platform).toBe(true);
      // Local ports being open is not egress being open, nor a route to the
      // Docker socket — those stay governed independently.
      expect(settings.network.strictAllowlist, platform).toBe(true);
      expect(settings.network.allowedDomains, platform).not.toContain("api.example.com");
      expect(settings.network.allowUnixSockets, platform).toEqual([]);
    }
  });

  it("keeps unix sockets closed until the user names one", () => {
    // The Docker socket is unauthenticated root-equivalent control of the host,
    // and no domain allowlist can see it — no TCP is involved. So it is opt-in,
    // per path, and never inferred.
    const closed = buildSandboxSettings(
      "/workspace",
      { mode: "workspace", allowedDomains: [] },
      "darwin",
    );
    expect(closed.network.allowUnixSockets).toEqual([]);

    const opened = buildSandboxSettings(
      "/workspace",
      {
        mode: "workspace",
        allowedDomains: [],
        allowUnixSockets: ["/var/run/docker.sock", "/var/run/docker.sock"],
      },
      "darwin",
    );
    expect(opened.network.allowUnixSockets).toEqual(["/var/run/docker.sock"]);
    // Granting a socket is not granting anything else.
    expect(opened.network.strictAllowlist).toBe(true);
    expect(opened.network.allowedDomains).not.toContain("api.example.com");
  });

  it("ignores per-path socket grants on Linux, where they cannot be enforced", () => {
    // SRT's Linux seccomp filter blocks AF_UNIX by syscall and cannot inspect
    // paths. Passing the list through would read as enforcement that is not
    // happening — better to visibly ignore it than to imply a guarantee.
    const linux = buildSandboxSettings(
      "/workspace",
      { mode: "workspace", allowedDomains: [], allowUnixSockets: ["/var/run/docker.sock"] },
      "linux",
    );

    expect(linux.network.allowUnixSockets).toEqual([]);
  });

  it("normalizes and de-duplicates explicit network domains deterministically", () => {
    const settings = buildSandboxSettings("/workspace", {
      mode: "workspace",
      allowedDomains: [" registry.npmjs.org ", "github.com", "github.com", ""],
      strictDomains: true,
    });

    expect(settings.network.allowedDomains).toEqual(["github.com", "registry.npmjs.org"]);
  });
});

describe("sandbox defaults", () => {
  it("stays opt-in while upstream breaks core workflows", () => {
    // Verified upstream breakage: Linux pipes/redirections fail under seccomp,
    // macOS git-over-SSH fails the SOCKS handshake, and `git config --global`
    // is refused. Turning this on by default would break `git push` and piped
    // commands right after an update. Revisit when those are fixed upstream.
    expect(DEFAULT_SETTINGS.sandboxMode).toBe("off");
  });

  it("reaches mainstream toolchains out of the box, so the default is invisible", () => {
    const { network } = buildSandboxSettings("/workspace", {
      mode: "auto",
      allowedDomains: [],
    });

    // If any of these were missing, `npm install` / `pip install` / `git clone`
    // would fail for every user the moment the sandbox shipped on.
    for (const host of [
      "github.com",
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "proxy.golang.org",
      "crates.io",
      "rubygems.org",
    ]) {
      expect(network.allowedDomains).toContain(host);
    }
  });

  it("rejects patterns the sandbox itself refuses, so a bad entry cannot brick startup", () => {
    const { network } = buildSandboxSettings("/workspace", {
      mode: "auto",
      allowedDomains: [],
    });

    for (const domain of network.allowedDomains) {
      expect(domain).not.toBe("*");
      // sandbox-runtime rejects overly broad wildcards like "*.com".
      expect(domain).not.toMatch(/^\*\.[a-z]+$/);
      expect(domain).not.toMatch(/[:/]/);
    }
  });

  it("adds user hosts to the defaults, and honors an explicit takeover", () => {
    const merged = buildSandboxSettings("/workspace", {
      mode: "auto",
      allowedDomains: ["internal.example.com"],
    });
    expect(merged.network.allowedDomains).toContain("internal.example.com");
    expect(merged.network.allowedDomains).toContain("github.com");

    const strict = buildSandboxSettings("/workspace", {
      mode: "auto",
      allowedDomains: ["internal.example.com"],
      strictDomains: true,
    });
    expect(strict.network.allowedDomains).toEqual(["internal.example.com"]);
  });
});

describe("prepareSandboxLaunch", () => {
  const shell = { file: "bash", args: ["-c", "echo ok"], isCmdFallback: false };

  beforeEach(() => resetSandboxSupportProbeForTests());
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSandboxSupportProbeForTests();
  });

  it("preserves the original shell only for explicit sandbox opt-out", async () => {
    await expect(
      prepareSandboxLaunch(shell, "/workspace", { mode: "off", allowedDomains: [] }),
    ).resolves.toEqual({ ...shell, sandboxed: false });
  });

  it("wraps the command when the support probe succeeds", async () => {
    // The real probe launches sandbox-runtime and may legitimately take up to
    // its 20-second production deadline under process-heavy parallel suites.
    // Simulate support here so this unit test verifies wrapping, not host load.
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new ChildProcess();
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });

    const probe = await prepareSandboxLaunch(shell, os.tmpdir(), {
      mode: "auto",
      allowedDomains: [],
    });
    expect(probe.sandboxed).toBe(true);

    const launch = await prepareSandboxLaunch(shell, os.tmpdir(), {
      mode: "workspace",
      allowedDomains: [],
    });

    expect(launch.sandboxed).toBe(true);
    expect(launch.file).toBe(process.execPath);
    expect(launch.args).toEqual(
      expect.arrayContaining(["--settings", "--", "bash", "-c", "echo ok"]),
    );
  });

  it("degrades instead of breaking every command when prerequisites are missing", async () => {
    // An unusable interpreter makes the probe child exit non-zero, standing in
    // for bwrap-less Linux or an unprovisioned Windows sandbox user.
    vi.spyOn(process, "execPath", "get").mockReturnValue("/nonexistent/gg-node");

    await expect(
      prepareSandboxLaunch(shell, os.tmpdir(), { mode: "auto", allowedDomains: [] }),
    ).resolves.toEqual({ ...shell, sandboxed: false });
  });

  it("fails closed in strict workspace mode with actionable install guidance", async () => {
    vi.spyOn(process, "execPath", "get").mockReturnValue("/nonexistent/gg-node");

    await expect(
      prepareSandboxLaunch(shell, os.tmpdir(), { mode: "workspace", allowedDomains: [] }),
    ).rejects.toThrow(/bubblewrap \+ socat|windows-install/);
  });

  it("refuses to call reduced isolation 'workspace', and warns about it in auto", async () => {
    // Linux drops unix-socket blocking when the apply-seccomp helper is absent
    // and keeps going: the sandbox starts, the probe succeeds, and AF_UNIX
    // sockets (Docker, the SSH agent) are reachable again. `workspace` promises
    // to fail closed, so a silent pass here would be a false promise.
    const degraded = {
      supported: true,
      reason: "ok",
      degraded: "seccomp not available - unix socket access not restricted",
    };

    resetSandboxSupportProbeForTests(degraded);
    await expect(
      prepareSandboxLaunch(shell, os.tmpdir(), { mode: "workspace", allowedDomains: [] }),
    ).rejects.toThrow(/isolation is incomplete[\s\S]*apply-seccomp/);

    resetSandboxSupportProbeForTests(degraded);
    const launch = await prepareSandboxLaunch(shell, os.tmpdir(), {
      mode: "auto",
      allowedDomains: [],
    });
    // `auto` degrades rather than breaking every command — but still sandboxes.
    expect(launch.sandboxed).toBe(true);
  });

  it("keeps sandboxing when isolation is intact", async () => {
    resetSandboxSupportProbeForTests({ supported: true, reason: "ok", degraded: null });

    const launch = await prepareSandboxLaunch(shell, os.tmpdir(), {
      mode: "workspace",
      allowedDomains: [],
    });

    expect(launch.sandboxed).toBe(true);
  });
});
