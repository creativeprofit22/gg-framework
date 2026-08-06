import { afterEach, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseNpxPackage,
  findPackageBinScript,
  resolveStdioCommand,
  resolveWindowsExecutable,
  resolveWindowsLauncher,
} from "./resolve-stdio.js";

/** Lay out a fake npx cache entry: `<cache>/_npx/<hash>/node_modules/<pkg>`
 *  with a package.json + real bin file. Returns the cache root to point
 *  `npm_config_cache` at. */
function seedNpxCache(
  cacheRoot: string,
  hash: string,
  pkgName: string,
  version: string,
  binRel = "build/index.js",
): void {
  const pkgDir = path.join(cacheRoot, "_npx", hash, "node_modules", ...pkgName.split("/"));
  fs.mkdirSync(path.join(pkgDir, path.dirname(binRel)), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, binRel), "#!/usr/bin/env node\n");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkgName,
      version,
      bin: { [pkgName.split("/").pop()!]: binRel },
    }),
  );
}

describe("parseNpxPackage", () => {
  it("extracts the package from `npx -y <pkg>`", () => {
    expect(parseNpxPackage("npx", ["-y", "@kenkaiiii/kencode-search"])).toBe(
      "@kenkaiiii/kencode-search",
    );
  });

  it("extracts the package from a full npx path", () => {
    expect(parseNpxPackage("/usr/local/bin/npx", ["--yes", "some-pkg"])).toBe("some-pkg");
  });

  it("handles `npm exec <pkg>`", () => {
    expect(parseNpxPackage("npm", ["exec", "-y", "some-pkg"])).toBe("some-pkg");
  });

  it("skips `-p`/`--package` flag values to find the positional", () => {
    expect(parseNpxPackage("npx", ["-p", "helper-pkg", "real-pkg", "--", "arg"])).toBe("real-pkg");
  });

  it("returns null for non-npx commands", () => {
    expect(parseNpxPackage("node", ["server.js"])).toBeNull();
    expect(parseNpxPackage("uvx", ["mcp-server"])).toBeNull();
    expect(parseNpxPackage("npm", ["install"])).toBeNull();
  });
});

describe("findPackageBinScript", () => {
  it("resolves the kencode-search bin script from ggcoder's install", () => {
    // kencode-search is a ggcoder dependency, so its bin must resolve from here.
    const script = findPackageBinScript("@kenkaiiii/kencode-search", "kencode-search");
    expect(script).toBeTruthy();
    expect(script).toMatch(/kencode-search[/\\].*index\.js$/);
  });

  it("returns null for an unknown package", () => {
    expect(findPackageBinScript("this-package-does-not-exist-xyz", "x")).toBeNull();
  });
});

describe("resolveStdioCommand", () => {
  it("rewrites a dependency-backed npx server to `node <binScript>`", () => {
    const out = resolveStdioCommand("npx", ["-y", "@kenkaiiii/kencode-search"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args).toHaveLength(1);
    expect(out.args[0]).toMatch(/kencode-search[/\\].*index\.js$/);
  });

  it("forwards server args that follow the package spec", () => {
    const out = resolveStdioCommand("npx", [
      "-y",
      "@kenkaiiii/kencode-search",
      "--",
      "--flag",
      "value",
    ]);
    expect(out.command).toBe(process.execPath);
    // [binScript, "--flag", "value"] — the `--` separator is dropped.
    expect(out.args.slice(1)).toEqual(["--flag", "value"]);
  });

  // Windows cannot spawn a bare `npx` shell-lessly, so "passthrough" there
  // means `node <npx-cli.js>` with the original args preserved after it.
  it.skipIf(process.platform === "win32")(
    "passes through an npx server that isn't locally resolvable",
    () => {
      const out = resolveStdioCommand("npx", ["-y", "@vendor/not-installed-mcp"]);
      expect(out.command).toBe("npx");
      expect(out.args).toEqual(["-y", "@vendor/not-installed-mcp"]);
    },
  );

  it("passes through a non-npx command unchanged", () => {
    const out = resolveStdioCommand("uvx", ["some-mcp-server", "--port", "0"]);
    expect(out.command).toBe("uvx");
    expect(out.args).toEqual(["some-mcp-server", "--port", "0"]);
  });
});

describe("resolveStdioCommand npx-cache fallback (covers user-added MCPs)", () => {
  let tmp: string | undefined;
  const prevCache = process.env.npm_config_cache;

  afterEach(() => {
    if (prevCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = prevCache;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("rewrites a non-bundled but npx-cached server to `node <binScript>`", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "hash1", "@vendor/cool-mcp", "1.0.0");
    process.env.npm_config_cache = tmp;

    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/cool-mcp[/\\]build[/\\]index\.js$/);
  });

  it("honours a version pin: a mismatched cached version falls through to npx", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "hash1", "@vendor/cool-mcp", "1.0.0");
    process.env.npm_config_cache = tmp;

    // Requested @2.0.0, only 1.0.0 cached → do NOT rewrite to the wrong version.
    // The npx invocation is preserved; only its launcher differs by OS.
    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp@2.0.0"]);
    expect(out.args.slice(-2)).toEqual(["-y", "@vendor/cool-mcp@2.0.0"]);
    if (process.platform !== "win32") expect(out.command).toBe("npx");
  });

  it("uses a cached copy whose version matches the pin exactly", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "hash1", "@vendor/cool-mcp", "2.0.0");
    process.env.npm_config_cache = tmp;

    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp@2.0.0"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/cool-mcp[/\\]build[/\\]index\.js$/);
  });

  it("picks the highest cached version when the spec is unpinned", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "old", "@vendor/cool-mcp", "1.2.0", "build/old.js");
    seedNpxCache(tmp, "new", "@vendor/cool-mcp", "1.10.0", "build/new.js");
    process.env.npm_config_cache = tmp;

    // 1.10.0 > 1.2.0 numerically (not lexically) → the newer bin wins.
    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/new\.js$/);
  });

  it("resolves a sole bin whose key differs from the package name (e.g. zai)", () => {
    // @z_ai/mcp-server exposes bin `zai-mcp-server`, NOT `mcp-server`. A sole
    // bin must be used regardless of its key, or the rewrite silently misses.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    const pkgDir = path.join(tmp, "_npx", "h", "node_modules", "@z_ai", "mcp-server");
    fs.mkdirSync(path.join(pkgDir, "build"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "build", "index.js"), "#!/usr/bin/env node\n");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@z_ai/mcp-server",
        version: "0.1.4",
        bin: { "zai-mcp-server": "./build/index.js" },
      }),
    );
    process.env.npm_config_cache = tmp;

    const out = resolveStdioCommand("npx", ["-y", "@z_ai/mcp-server"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/mcp-server[/\\]build[/\\]index\.js$/);
  });
});

describe("resolveWindowsLauncher", () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);
  const env = { PATH: "C:\\nodejs", PATHEXT: ".cmd" };

  it("maps npx to node + npm's npx-cli.js (the .cmd shim is unspawnable)", () => {
    const got = resolveWindowsLauncher(
      "npx",
      env,
      "win32",
      exists(["C:\\nodejs\\npx.cmd", "C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"]),
    );
    expect(got).toEqual({
      command: process.execPath,
      prefixArgs: ["C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"],
    });
  });

  it("maps npm to its own CLI script", () => {
    const got = resolveWindowsLauncher(
      "npm",
      env,
      "win32",
      exists(["C:\\nodejs\\npm.cmd", "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"]),
    );
    expect(got?.prefixArgs).toEqual(["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"]);
  });

  it("returns null off Windows, for other commands, and when the CLI is absent", () => {
    expect(resolveWindowsLauncher("npx", env, "darwin", () => true)).toBeNull();
    expect(resolveWindowsLauncher("some-server", env, "win32", () => true)).toBeNull();
    expect(resolveWindowsLauncher("npx", env, "win32", exists(["C:\\nodejs\\npx.cmd"]))).toBeNull();
  });
});

describe("resolveWindowsExecutable", () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it("resolves a bare npx to npx.cmd via PATH x PATHEXT", () => {
    // The MCP SDK spawns with shell:false and CreateProcess ignores PATHEXT,
    // so a bare "npx" is ENOENT on Windows even though npx.cmd is right there.
    expect(
      resolveWindowsExecutable(
        "npx",
        { PATH: "C:\\nodejs;C:\\other", PATHEXT: ".com;.exe;.cmd" },
        "win32",
        exists(["C:\\nodejs\\npx.cmd"]),
      ),
    ).toBe("C:\\nodejs\\npx.cmd");
  });

  it("honors Windows' lowercase Path spelling", () => {
    expect(
      resolveWindowsExecutable(
        "npx",
        { Path: "C:\\nodejs", PATHEXT: ".cmd" },
        "win32",
        exists(["C:\\nodejs\\npx.cmd"]),
      ),
    ).toBe("C:\\nodejs\\npx.cmd");
  });

  it("never searches the current directory (no hijack by a local npx.cmd)", () => {
    expect(
      resolveWindowsExecutable(
        "npx",
        { PATH: "C:\\nodejs", PATHEXT: ".cmd" },
        "win32",
        exists(["npx.cmd"]),
      ),
    ).toBe("npx");
  });

  it("extends an explicit path in place", () => {
    expect(
      resolveWindowsExecutable(
        "C:\\tools\\server",
        { PATHEXT: ".exe" },
        "win32",
        exists(["C:\\tools\\server.exe"]),
      ),
    ).toBe("C:\\tools\\server.exe");
  });

  it("passes through off Windows, when extensioned, and when unresolvable", () => {
    expect(resolveWindowsExecutable("npx", { PATH: "/usr/bin" }, "darwin", () => true)).toBe("npx");
    expect(resolveWindowsExecutable("npx.cmd", {}, "win32", () => true)).toBe("npx.cmd");
    expect(resolveWindowsExecutable("npx", { PATH: "C:\\nodejs" }, "win32", () => false)).toBe(
      "npx",
    );
  });
});

/**
 * REAL Windows launcher resolution — runs only on an actual Windows host (the
 * CI `windows-latest` matrix leg), skipped everywhere else.
 *
 * The unit tests above inject a fake PATH and a fake `exists`, so they only
 * prove the algorithm. This proves the PREMISE, and it is the reason the fix
 * is what it is: on a real Windows box a bare `npx` is ENOENT for a shell-less
 * spawn, AND the `npx.cmd` it resolves to is ALSO unspawnable (EINVAL, since
 * the CVE-2024-27980 hardening). Only `node <npx-cli.js>` actually runs — a
 * fact no mocked test could have told us.
 */
describe.skipIf(process.platform !== "win32")("npx launching on real Windows", () => {
  const run = (command: string, args: string[]) =>
    spawnSync(command, args, { shell: false, encoding: "utf8", windowsHide: true });

  it("confirms neither bare npx nor its .cmd shim can be spawned shell-lessly", () => {
    const bare = run("npx", ["--version"]);
    expect((bare.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");

    // resolveWindowsExecutable does find the real file on PATH…
    const shim = resolveWindowsExecutable("npx");
    expect(shim).not.toBe("npx");
    expect(fs.existsSync(shim)).toBe(true);
    expect(path.extname(shim).toLowerCase()).toBe(".cmd");

    // …but Node refuses to execute a .cmd without a shell, so resolving the
    // shim alone would NOT have fixed anything.
    expect((run(shim, ["--version"]).error as NodeJS.ErrnoException | undefined)?.code).toBe(
      "EINVAL",
    );
  }, 60_000);

  it("resolves npx to a node + CLI-script invocation that really runs", () => {
    const launcher = resolveWindowsLauncher("npx");
    if (!launcher) throw new Error("expected a Windows npx launcher");
    expect(launcher.command).toBe(process.execPath);
    expect(launcher.prefixArgs[0]).toMatch(/npx-cli\.js$/);
    expect(fs.existsSync(launcher.prefixArgs[0])).toBe(true);

    const out = run(launcher.command, [...launcher.prefixArgs, "--version"]);
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);

  it("hands the MCP SDK a spawnable command for the ubiquitous npx config", () => {
    // `{ "command": "npx", "args": ["-y", …] }` is the most common MCP config
    // in existence. Even on the passthrough branch (package not resolvable),
    // what we hand the SDK must be executable, or the server dies as an opaque
    // "Connection closed".
    const out = resolveStdioCommand("npx", ["-y", "definitely-not-a-real-package-xyz"]);
    expect(out.command).toBe(process.execPath);
    expect(fs.existsSync(out.args[0])).toBe(true);
    expect(out.args.slice(-2)).toEqual(["-y", "definitely-not-a-real-package-xyz"]);
  });
});
