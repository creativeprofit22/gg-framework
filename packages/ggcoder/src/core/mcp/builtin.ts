import fs from "node:fs";
import path from "node:path";
import { SettingsManager } from "../settings-manager.js";
import type { BuiltinMcpSetting, BuiltinMcpSettings } from "./builtin-settings.js";
import type { ScopedServer } from "./store.js";
import type { MCPServerConfig } from "./types.js";

/** Supa Drivah: drives desktop windows and browsers. GG Coder only starts the program. */
export const DRIVAH_SERVER_NAME = "drivah";
/** This machine's local build, used when drivah is not on PATH (the desktop daemon's PATH may lack it). */
export const DRIVAH_FALLBACK_PATH = String.raw`E:\Projects\supah-drivah\target\release\drivah.exe`;

export const BUILTIN_MCP_SERVER_NAMES: readonly string[] = [DRIVAH_SERVER_NAME];

export function isBuiltinServerName(name: string): boolean {
  return BUILTIN_MCP_SERVER_NAMES.includes(name);
}

export interface BuiltinLookupDeps {
  exists?: (p: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export type ProgramLookup = { path: string } | { reason: string };

/** Find the drivah program: saved path, then PATH, then this machine's local build. */
export function resolveDrivahProgram(
  pathSetting: string | undefined,
  deps: BuiltinLookupDeps = {},
): ProgramLookup {
  const exists = deps.exists ?? isFile;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if (pathSetting && exists(pathSetting)) return { path: pathSetting };

  const win = platform === "win32";
  const pathApi = win ? path.win32 : path.posix;
  const exe = win ? "drivah.exe" : "drivah";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = pathApi.join(dir, exe);
    if (exists(candidate)) return { path: candidate };
  }
  if (win && exists(DRIVAH_FALLBACK_PATH)) return { path: DRIVAH_FALLBACK_PATH };

  return {
    reason: pathSetting
      ? `Supa Drivah was not found at the saved path ${pathSetting}, on PATH, or at ${DRIVAH_FALLBACK_PATH}.`
      : `Supa Drivah (${exe}) was not found on PATH or at ${DRIVAH_FALLBACK_PATH}.`,
  };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface BuiltinServer {
  config: MCPServerConfig;
  /** Set when the program can't be found: the server is listed but never started. */
  unavailableReason?: string;
}

/** Built-in servers the user hasn't removed, with their on/off state applied. */
export function builtinMcpServers(
  settings: BuiltinMcpSettings,
  deps: BuiltinLookupDeps = {},
): BuiltinServer[] {
  // Off switch for every built-in (the test suite sets it so no test spawns drivah).
  if ((deps.env ?? process.env).GG_BUILTIN_MCP_SERVERS === "off") return [];
  const saved: BuiltinMcpSetting = settings[DRIVAH_SERVER_NAME] ?? {};
  if (saved.removed === true) return [];
  const program = resolveDrivahProgram(saved.path, deps);
  const config: MCPServerConfig = {
    name: DRIVAH_SERVER_NAME,
    command: "path" in program ? program.path : "drivah",
    args: ["mcp"],
    ...(saved.enabled === false ? { enabled: false } : {}),
  };
  return "path" in program ? [{ config }] : [{ config, unavailableReason: program.reason }];
}

export interface WithBuiltinOptions {
  /** Whether project-scope entries load here; an untrusted project entry must not hide a built-in. */
  allowProjectScope?: boolean;
  deps?: BuiltinLookupDeps;
}

/** Append built-in servers unless a loaded user entry already uses the name (the user's wins). */
export function withBuiltinServers(
  scoped: ScopedServer[],
  settings: BuiltinMcpSettings,
  opts: WithBuiltinOptions = {},
): ScopedServer[] {
  const userNames = new Set(
    scoped
      .filter((s) => opts.allowProjectScope !== false || s.scope !== "project")
      .map((s) => s.config.name),
  );
  const extra = builtinMcpServers(settings, opts.deps)
    .filter((b) => !userNames.has(b.config.name))
    .map((b): ScopedServer => ({
      config: b.config,
      scope: "global",
      builtin: true,
      ...(b.unavailableReason ? { unavailableReason: b.unavailableReason } : {}),
    }));
  return [...scoped, ...extra];
}

/** Hide a built-in server (the panel's ✕ or `mcp remove`). */
export async function removeBuiltinServer(name: string, settingsFile?: string): Promise<void> {
  await new SettingsManager(settingsFile).setBuiltinMcpServer(name, { removed: true });
}

/** The built-in row's on/off switch. */
export async function setBuiltinServerEnabled(
  name: string,
  enabled: boolean,
  settingsFile?: string,
): Promise<void> {
  await new SettingsManager(settingsFile).setBuiltinMcpServer(name, { enabled });
}
