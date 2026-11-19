import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DRIVAH_FALLBACK_PATH,
  builtinMcpServers,
  removeBuiltinServer,
  resolveDrivahProgram,
  setBuiltinServerEnabled,
  withBuiltinServers,
  type BuiltinLookupDeps,
} from "./builtin.js";
import { parseBuiltinMcpSettings } from "./builtin-settings.js";
import type { ScopedServer } from "./store.js";

const ON_PATH = String.raw`C:\tools\drivah.exe`;

function deps(files: string[], env: NodeJS.ProcessEnv = { PATH: String.raw`C:\tools;C:\bin` }) {
  return {
    exists: (p: string) => files.includes(p),
    env,
    platform: "win32",
  } satisfies BuiltinLookupDeps;
}

describe("resolveDrivahProgram", () => {
  it("prefers the saved path, then PATH, then the local build", () => {
    const all = deps([String.raw`D:\drivah.exe`, ON_PATH, DRIVAH_FALLBACK_PATH]);
    expect(resolveDrivahProgram(String.raw`D:\drivah.exe`, all)).toEqual({
      path: String.raw`D:\drivah.exe`,
    });
    expect(resolveDrivahProgram(String.raw`D:\gone.exe`, all)).toEqual({ path: ON_PATH });
    expect(resolveDrivahProgram(undefined, deps([DRIVAH_FALLBACK_PATH]))).toEqual({
      path: DRIVAH_FALLBACK_PATH,
    });
  });

  it("explains where it looked when the program is missing", () => {
    const missing = resolveDrivahProgram(String.raw`D:\gone.exe`, deps([]));
    expect("reason" in missing && missing.reason).toContain(String.raw`D:\gone.exe`);
    expect("reason" in missing && missing.reason).toContain(DRIVAH_FALLBACK_PATH);
  });

  it("does not mention the Windows local build on other platforms", () => {
    const linux = {
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: () => false,
    } satisfies BuiltinLookupDeps;
    expect(resolveDrivahProgram(undefined, linux)).toEqual({
      reason: "Supa Drivah (drivah) was not found on PATH.",
    });
    const saved = resolveDrivahProgram("/opt/gone/drivah", linux);
    expect("reason" in saved && saved.reason).toContain("/opt/gone/drivah");
    expect("reason" in saved && saved.reason).not.toContain(DRIVAH_FALLBACK_PATH);
  });

  it("looks for a bare drivah on POSIX PATH", () => {
    const posix = {
      exists: (p: string) => p === "/opt/bin/drivah",
      env: { PATH: "/usr/bin:/opt/bin" },
      platform: "linux",
    } satisfies BuiltinLookupDeps;
    expect(resolveDrivahProgram(undefined, posix)).toEqual({ path: "/opt/bin/drivah" });
  });
});

describe("builtinMcpServers", () => {
  it("starts drivah as `<path> mcp` when found", () => {
    expect(builtinMcpServers({}, deps([ON_PATH]))).toEqual([
      { config: { name: "drivah", command: ON_PATH, args: ["mcp"] } },
    ]);
  });

  it("lists a missing program with a reason instead of a runnable command", () => {
    const [server] = builtinMcpServers({}, deps([]));
    expect(server?.unavailableReason).toContain("drivah.exe");
    expect(server?.config.command).toBe("drivah");
  });

  it("is off via the switch, gone after remove, and off for the whole suite flag", () => {
    expect(builtinMcpServers({ drivah: { enabled: false } }, deps([ON_PATH]))[0]?.config).toEqual({
      name: "drivah",
      command: ON_PATH,
      args: ["mcp"],
      enabled: false,
    });
    expect(builtinMcpServers({ drivah: { removed: true } }, deps([ON_PATH]))).toEqual([]);
    expect(
      builtinMcpServers(
        {},
        deps([ON_PATH], { PATH: String.raw`C:\tools`, GG_BUILTIN_MCP_SERVERS: "off" }),
      ),
    ).toEqual([]);
  });
});

describe("withBuiltinServers", () => {
  const user = (scope: "global" | "project"): ScopedServer => ({
    scope,
    config: { name: "drivah", url: `https://${scope}.invalid/mcp` },
  });

  it("appends the built-in as a global, marked row", () => {
    expect(withBuiltinServers([], {}, { deps: deps([ON_PATH]) })).toEqual([
      {
        scope: "global",
        builtin: true,
        config: { name: "drivah", command: ON_PATH, args: ["mcp"] },
      },
    ]);
  });

  it("lets a global or trusted project user entry win", () => {
    for (const scope of ["global", "project"] as const) {
      const out = withBuiltinServers(
        [user(scope)],
        {},
        {
          allowProjectScope: true,
          deps: deps([ON_PATH]),
        },
      );
      expect(out).toEqual([user(scope)]);
    }
  });

  it("keeps the built-in when only an untrusted project entry uses the name", () => {
    const out = withBuiltinServers(
      [user("project")],
      {},
      {
        allowProjectScope: false,
        deps: deps([ON_PATH]),
      },
    );
    expect(out.map((s) => [s.scope, s.builtin ?? false])).toEqual([
      ["project", false],
      ["global", true],
    ]);
  });
});

describe("saved built-in state", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-builtin-mcp-"));
    file = path.join(dir, "settings.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("saves the switch and remove, keeping other settings and the saved path", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        theme: "dark",
        builtinMcpServers: { drivah: { path: String.raw`D:\drivah.exe` } },
      }),
    );
    await setBuiltinServerEnabled("drivah", false, file);
    let raw = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    expect(raw).toEqual({
      theme: "dark",
      builtinMcpServers: { drivah: { path: String.raw`D:\drivah.exe`, enabled: false } },
    });

    await removeBuiltinServer("drivah", file);
    raw = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    expect(parseBuiltinMcpSettings(raw.builtinMcpServers)).toEqual({
      drivah: { path: String.raw`D:\drivah.exe`, enabled: false, removed: true },
    });
  });

  it("drops malformed entries and fields", () => {
    expect(
      parseBuiltinMcpSettings({ drivah: { path: 5, enabled: "no", removed: true }, bad: [] }),
    ).toEqual({ drivah: { removed: true } });
    expect(parseBuiltinMcpSettings("nope")).toEqual({});
  });
});
