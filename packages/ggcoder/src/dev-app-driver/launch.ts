import { execFile, spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import { join } from "node:path";
import { killProcessTree, killProcessTreeAsync } from "../utils/process.js";
import { assertDeadline, systemClock, type DriverClock } from "./clock.js";
import { DevCdpClient, type ControlClient } from "./control-client.js";
import { findAppTarget, isAppPageTarget, type DevTarget, type FetchLike } from "./targets.js";

export interface DevAppChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface DevAppSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  windowsHide: boolean;
  detached: boolean;
  stdio: StdioOptions;
}

export type SpawnDevApp = (
  command: string,
  args: readonly string[],
  options: DevAppSpawnOptions,
) => DevAppChild;

export interface DevAppDependencies {
  clock?: DriverClock;
  fetch?: FetchLike;
  connect?: (webSocketUrl: string) => Promise<ControlClient>;
  spawn?: SpawnDevApp;
  /** Kills one owned process tree. Never called for attached sessions. */
  terminate?: (pid: number) => Promise<void>;
  /** Synchronous kill for process exit, where awaited work never runs. */
  terminateNow?: (pid: number) => void;
}

export interface DevAppSession {
  owned: boolean;
  pid: number | null;
  target: DevTarget;
  client: ControlClient;
  stop(): Promise<void>;
  /** Synchronous stop for `process.on("exit")`. */
  stopNow(): void;
}

export interface LaunchDevAppOptions extends DevAppDependencies {
  appDir: string;
  configPath: string;
  env: Record<string, string>;
  cdpPort: number;
  readyDeadlineMs?: number;
  accept?: (target: DevTarget) => boolean;
  stdio?: StdioOptions;
  tauriCli?: string;
}

export interface VerifiedTerminationDependencies {
  killTree: (pid: number) => Promise<void>;
  /** Descendant pids of `pid`, captured before the kill. */
  listTree: (pid: number) => Promise<number[]>;
  isAlive: (pid: number) => boolean;
  clock?: DriverClock;
  settleMs?: number;
}

/** taskkill /T fails when part of the tree exits on its own mid-kill; the kill counts once every captured pid is gone. */
export async function terminateVerified(
  pid: number,
  {
    killTree,
    listTree,
    isAlive,
    clock = systemClock,
    settleMs = 5000,
  }: VerifiedTerminationDependencies,
): Promise<void> {
  const tree = await listTree(pid).then(
    (descendants) => [pid, ...descendants],
    () => null,
  );
  try {
    await killTree(pid);
  } catch (error) {
    if (tree === null) throw error;
    const end = clock.now() + settleMs;
    while (tree.some(isAlive)) {
      if (clock.now() >= end) throw error;
      await clock.sleep(50);
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function descendantsFromTable(table: string, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [child, parent] = [Number(match[1]), Number(match[2])];
    if (child === parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const seen = new Set([root]);
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found.sort((a, b) => a - b);
}

function windowsDescendants(pid: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + ' ' + $_.ParentProcessId }",
      ],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(descendantsFromTable(stdout, pid))),
    );
  });
}

const killTree = (pid: number): Promise<void> =>
  killProcessTreeAsync(pid, { requireSettlement: true });

const defaultTerminate = (pid: number): Promise<void> =>
  process.platform === "win32"
    ? terminateVerified(pid, { killTree, listTree: windowsDescendants, isAlive: pidAlive })
    : killTree(pid);

const defaultConnect = (url: string): Promise<ControlClient> => DevCdpClient.connect(url);

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`invalid control port: ${port}`);
  }
}

// windows.rs silently skips the control port without these, leaving launch to wait out its deadline.
function assertDevAppEnvironment(env: Record<string, string>, cdpPort: number): void {
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ["GG_PHASE25_DEV_FIXTURE_CDP_PORT", env.GG_PHASE25_DEV_FIXTURE_CDP_PORT === String(cdpPort)],
    [
      "GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP",
      env.GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP === "1",
    ],
    [
      "GG_APP_DEV_SMOKE_WINDOW",
      env.GG_APP_DEV_SMOKE_WINDOW === "minimized" || env.GG_APP_DEV_SMOKE_WINDOW === "visible",
    ],
    ["WEBVIEW2_USER_DATA_FOLDER", (env.WEBVIEW2_USER_DATA_FOLDER ?? "").trim() !== ""],
  ];
  const missing = checks.find(([, ok]) => !ok);
  if (missing) {
    throw new Error(
      `env must come from devAppEnvironment with the same control port: ${missing[0]} is missing or invalid`,
    );
  }
}

/** Starts `tauri dev --no-watch` and waits for its one app window; stop() kills only that tree. */
export async function launchDevApp({
  appDir,
  configPath,
  env,
  cdpPort,
  readyDeadlineMs = 300_000,
  accept = isAppPageTarget,
  stdio = "ignore",
  tauriCli = join(appDir, "node_modules/@tauri-apps/cli/tauri.js"),
  clock = systemClock,
  fetch,
  connect = defaultConnect,
  spawn = nodeSpawn as unknown as SpawnDevApp,
  terminate = defaultTerminate,
  terminateNow = (pid: number) => killProcessTree(pid),
}: LaunchDevAppOptions): Promise<DevAppSession> {
  assertPort(cdpPort);
  assertDeadline("readyDeadlineMs", readyDeadlineMs);
  assertDevAppEnvironment(env, cdpPort);
  const child = spawn(process.execPath, [tauriCli, "dev", "--no-watch", "--config", configPath], {
    cwd: appDir,
    env,
    windowsHide: true,
    // A POSIX process group lets stop() signal the whole owned tree.
    detached: process.platform !== "win32",
    stdio,
  });
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    throw new Error("Developer app did not expose a process id");
  }
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  let client: ControlClient | null = null;
  try {
    const target = await findAppTarget(cdpPort, {
      accept,
      deadlineMs: readyDeadlineMs,
      clock,
      ...(fetch ? { fetch } : {}),
      check: () => {
        if (spawnError) throw new Error(`Developer app failed to start: ${spawnError.message}`);
        if (child.exitCode !== null) {
          throw new Error(`Developer app exited before readiness (${child.exitCode})`);
        }
      },
    });
    client = await connect(target.webSocketDebuggerUrl);
    const connected = client;
    let stopped: Promise<void> | null = null;
    let finished = false;
    return {
      owned: true,
      pid,
      target,
      client: connected,
      stop: () => {
        stopped ??= (async () => {
          connected.close();
          await terminate(pid);
          finished = true;
        })();
        return stopped;
      },
      stopNow: () => {
        connected.close();
        if (finished) return;
        finished = true;
        stopped ??= Promise.resolve();
        terminateNow(pid);
      },
    };
  } catch (error) {
    client?.close();
    try {
      await terminate(pid);
    } catch (cleanupError) {
      // The readiness failure is the root cause; attach the cleanup failure instead of replacing it.
      throw new AggregateError([error, cleanupError], errorMessage(error), {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AttachDevAppOptions extends DevAppDependencies {
  cdpPort: number;
  accept?: (target: DevTarget) => boolean;
  deadlineMs?: number;
}

/** Connects to an app someone else started; stop() closes only the connection. */
export async function attachDevApp({
  cdpPort,
  accept = isAppPageTarget,
  deadlineMs = 5000,
  clock = systemClock,
  fetch,
  connect = defaultConnect,
}: AttachDevAppOptions): Promise<DevAppSession> {
  assertPort(cdpPort);
  const target = await findAppTarget(cdpPort, {
    accept,
    deadlineMs,
    clock,
    ...(fetch ? { fetch } : {}),
  });
  const client = await connect(target.webSocketDebuggerUrl);
  return {
    owned: false,
    pid: null,
    target,
    client,
    stop: async () => client.close(),
    stopNow: () => client.close(),
  };
}
