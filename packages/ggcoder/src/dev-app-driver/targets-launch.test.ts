import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock, FakeControlClient } from "../test-support/dev-app-driver-fakes.js";
import {
  attachDevApp,
  descendantsFromTable,
  launchDevApp,
  terminateVerified,
  type DevAppChild,
  type SpawnDevApp,
} from "./launch.js";
import {
  createIsolatedProfile,
  devAppEnvironment,
  sanitizedSmokeEnvironment,
  type IsolatedProfile,
} from "./profile.js";
import {
  AmbiguousTargetError,
  findAppTarget,
  isAppPageTarget,
  type DevTarget,
  type FetchLike,
} from "./targets.js";

const appTarget = (url = "http://localhost:1420/", id = "app"): DevTarget => ({
  id,
  type: "page",
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}`,
});

function fetchReturning(list: () => unknown[]): FetchLike & { calls: number } {
  const fake = Object.assign(
    async () => {
      fake.calls += 1;
      return { ok: true, status: 200, json: async () => list() };
    },
    { calls: 0 },
  );
  return fake;
}

const profile: IsolatedProfile = {
  root: "/r",
  home: "/r/home",
  appData: "/r/home/AppData/Roaming",
  localAppData: "/r/home/AppData/Local",
  temp: "/r/temp",
  webview2: "/r/webview2",
  project: "/r/project",
  audit: "/r/audit",
  screenshots: "/r/screenshots",
};

describe("app target discovery", () => {
  it("accepts only the dev page on 1420", () => {
    expect(isAppPageTarget(appTarget())).toBe(true);
    expect(isAppPageTarget(appTarget("http://127.0.0.1:1420/index.html"))).toBe(true);
    expect(isAppPageTarget({ ...appTarget(), type: "service_worker" })).toBe(false);
    expect(isAppPageTarget(appTarget("devtools://devtools/bundled/inspector.html"))).toBe(false);
    expect(isAppPageTarget(appTarget("http://localhost:14200/"))).toBe(false);
    expect(isAppPageTarget(appTarget("http://localhost:1420/whatsnew"))).toBe(false);
  });

  it("refuses to guess between two matching windows", async () => {
    const clock = new FakeClock();
    const fetch = fetchReturning(() => [appTarget(undefined, "a"), appTarget(undefined, "b")]);
    await expect(clock.settle(findAppTarget(9333, { clock, fetch }))).rejects.toBeInstanceOf(
      AmbiguousTargetError,
    );
  });

  it("gives up at the deadline when no target appears", async () => {
    const clock = new FakeClock();
    const fetch = fetchReturning(() => [appTarget("devtools://devtools/x")]);
    await expect(
      clock.settle(findAppTarget(9333, { clock, fetch, deadlineMs: 1000, pollMs: 100 })),
    ).rejects.toThrow(/No dev app target on port 9333 within 1000 ms \(1 targets listed/);
    expect(clock.now()).toBe(1000);
    expect(fetch.calls).toBe(10);
  });

  it("returns the target once it appears", async () => {
    const clock = new FakeClock();
    const fetch = fetchReturning(() => (clock.now() >= 300 ? [appTarget()] : []));
    const target = await clock.settle(findAppTarget(9333, { clock, fetch, pollMs: 100 }));
    expect(target.id).toBe("app");
    expect(clock.now()).toBe(300);
  });
});

function fakeChild(pid: number | undefined = 4321): DevAppChild & { exitCode: number | null } {
  return { pid, exitCode: null, once: () => undefined };
}

describe("launch and attach", () => {
  const env = devAppEnvironment({}, profile, { cdpPort: 9333 });

  it("attach never terminates a process; stop only closes the connection", async () => {
    const clock = new FakeClock();
    const client = new FakeControlClient();
    const terminate = vi.fn(async () => {});
    const session = await clock.settle(
      attachDevApp({
        cdpPort: 9333,
        clock,
        fetch: fetchReturning(() => [appTarget()]),
        connect: async () => client,
        terminate,
      }),
    );
    expect(session.owned).toBe(false);
    expect(session.pid).toBeNull();
    await session.stop();
    expect(client.closed).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("stopNow kills a launched tree synchronously, once, and not after stop finished", async () => {
    const launch = async () => {
      const clock = new FakeClock();
      const client = new FakeControlClient();
      const terminate = vi.fn(async (_pid: number) => {});
      const terminateNow = vi.fn((_pid: number) => {});
      const session = await clock.settle(
        launchDevApp({
          appDir: "/app",
          configPath: "/cfg/tauri.dev.json",
          env,
          cdpPort: 9333,
          clock,
          fetch: fetchReturning(() => [appTarget()]),
          connect: async () => client,
          spawn: () => fakeChild(),
          terminate,
          terminateNow,
        }),
      );
      return { session, client, terminate, terminateNow };
    };

    const exiting = await launch();
    exiting.session.stopNow();
    expect(exiting.client.closed).toBe(true);
    expect(exiting.terminateNow).toHaveBeenCalledExactlyOnceWith(4321);
    exiting.session.stopNow();
    await exiting.session.stop();
    expect(exiting.terminateNow).toHaveBeenCalledTimes(1);
    expect(exiting.terminate).not.toHaveBeenCalled();

    const stopped = await launch();
    await stopped.session.stop();
    stopped.session.stopNow();
    expect(stopped.terminate).toHaveBeenCalledTimes(1);
    expect(stopped.terminateNow).not.toHaveBeenCalled();
  });

  it("launch starts tauri dev with the given config and stop kills only its own tree, once", async () => {
    const clock = new FakeClock();
    const client = new FakeControlClient();
    const terminate = vi.fn(async (_pid: number) => {});
    const spawn = vi.fn<SpawnDevApp>(() => fakeChild());
    const session = await clock.settle(
      launchDevApp({
        appDir: "/app",
        configPath: "/cfg/tauri.dev.json",
        env,
        cdpPort: 9333,
        clock,
        fetch: fetchReturning(() => [appTarget()]),
        connect: async () => client,
        spawn,
        terminate,
      }),
    );
    expect(session.owned).toBe(true);
    expect(session.pid).toBe(4321);
    const [command, args, options] = spawn.mock.calls[0] ?? [];
    expect(command).toBe(process.execPath);
    expect(args?.slice(1)).toEqual(["dev", "--no-watch", "--config", "/cfg/tauri.dev.json"]);
    expect(options?.env).toBe(env);
    expect(options?.cwd).toBe("/app");
    await Promise.all([session.stop(), session.stop()]);
    expect(client.closed).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(4321);
  });

  it("fails fast when the app exits before it is ready, and cleans up its own pid", async () => {
    const clock = new FakeClock();
    const child = fakeChild(777);
    const terminate = vi.fn(async (_pid: number) => {});
    const fetch = fetchReturning(() => {
      if (clock.now() >= 400) child.exitCode = 1;
      return [];
    });
    await expect(
      clock.settle(
        launchDevApp({
          appDir: "/app",
          configPath: "/cfg.json",
          env,
          cdpPort: 9333,
          clock,
          fetch,
          spawn: () => child,
          terminate,
        }),
      ),
    ).rejects.toThrow(/exited before readiness \(1\)/);
    expect(clock.now()).toBeLessThan(1000);
    expect(terminate).toHaveBeenCalledWith(777);
  });

  it("keeps the readiness error first when cleanup of the exited app also fails", async () => {
    const clock = new FakeClock();
    const child = fakeChild(778);
    const cleanupError = new Error("Process tree cleanup was not confirmed before parent exit");
    const terminate = vi.fn(async (_pid: number) => {
      throw cleanupError;
    });
    const fetch = fetchReturning(() => {
      if (clock.now() >= 400) child.exitCode = 3;
      return [];
    });
    const failure = await clock
      .settle(
        launchDevApp({
          appDir: "/app",
          configPath: "/cfg.json",
          env,
          cdpPort: 9333,
          clock,
          fetch,
          spawn: () => child,
          terminate,
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toMatch(/exited before readiness \(3\)/);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect((aggregate.errors[0] as Error).message).toMatch(/exited before readiness \(3\)/);
    expect(aggregate.errors[1]).toBe(cleanupError);
    expect(terminate).toHaveBeenCalledWith(778);
  });

  it("refuses an environment that was not built for the same control port", async () => {
    const spawn = vi.fn<SpawnDevApp>(() => fakeChild());
    await expect(
      launchDevApp({ appDir: "/app", configPath: "/c", env: {}, cdpPort: 9333, spawn }),
    ).rejects.toThrow(/devAppEnvironment/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP", undefined],
    ["GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP", "0"],
    ["GG_APP_DEV_SMOKE_WINDOW", undefined],
    ["GG_APP_DEV_SMOKE_WINDOW", "hidden"],
    ["WEBVIEW2_USER_DATA_FOLDER", undefined],
    ["WEBVIEW2_USER_DATA_FOLDER", ""],
  ])("refuses to spawn when %s is %j", async (key, value) => {
    const broken: Record<string, string> = { ...env };
    if (value === undefined) delete broken[key];
    else broken[key] = value;
    const spawn = vi.fn<SpawnDevApp>(() => fakeChild());
    await expect(
      launchDevApp({ appDir: "/app", configPath: "/c", env: broken, cdpPort: 9333, spawn }),
    ).rejects.toThrow(new RegExp(`devAppEnvironment.*${key} is missing or invalid`));
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("dev app environment", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("starts minimized with the control port and an isolated WebView2 folder", () => {
    const env = devAppEnvironment(
      { PATH: "/bin", GG_SECRET: "x", TAURI_SIGNING: "y", WEBVIEW2_USER_DATA_FOLDER: "/shared" },
      profile,
      { cdpPort: 9333 },
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      GG_APP_DEV_SMOKE_WINDOW: "minimized",
      GG_PHASE25_DEV_FIXTURE_CDP_PORT: "9333",
      GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
      WEBVIEW2_USER_DATA_FOLDER: "/r/webview2",
      HOME: "/r/home",
      GG_APP_CWD: "/r/project",
    });
    expect(env.GG_SECRET).toBeUndefined();
    expect(env.TAURI_SIGNING).toBeUndefined();
    expect(devAppEnvironment({}, profile, { cdpPort: 1, window: "visible" })).toMatchObject({
      GG_APP_DEV_SMOKE_WINDOW: "visible",
    });
    expect(() => devAppEnvironment({}, profile, { cdpPort: 70_000 })).toThrow(RangeError);
  });

  it("legacy environment keeps fixture variables and the isolated folders", () => {
    const env = sanitizedSmokeEnvironment({ GG_X: "1" }, profile, { GG_APP_FIXTURE: "on" });
    expect(env).toMatchObject({ GG_APP_FIXTURE: "on", TEMP: "/r/temp", TMP: "/r/temp" });
    expect(env.GG_X).toBeUndefined();
  });

  it("creates every profile folder", () => {
    const root = mkdtempSync(join(tmpdir(), "gg-driver-profile-"));
    roots.push(root);
    const paths = createIsolatedProfile(root);
    for (const folder of Object.values(paths)) expect(statSync(folder).isDirectory()).toBe(true);
    expect(paths.webview2).toBe(join(root, "webview2"));
  });
});

describe("terminateVerified", () => {
  const table = "10 1\n20 10\n30 20\n31 20\n99 7\n";

  it("finds every descendant of the root", () => {
    expect(descendantsFromTable(table, 10)).toEqual([20, 30, 31]);
    expect(descendantsFromTable(table, 5)).toEqual([]);
  });

  it("accepts a failed tree kill once every captured process is gone", async () => {
    const clock = new FakeClock();
    const alive = new Set([10, 20, 30]);
    const done = terminateVerified(10, {
      killTree: async () => {
        alive.delete(10);
        alive.delete(20);
        throw new Error("Process tree cleanup was not confirmed");
      },
      listTree: async () => [20, 30],
      isAlive: (pid) => alive.has(pid),
      clock,
    });
    clock.at(200, () => alive.delete(30));
    await expect(clock.settle(done)).resolves.toBeUndefined();
  });

  it("keeps the kill error while a captured process survives, or when the tree was unknown", async () => {
    const clock = new FakeClock();
    const failing = async () => {
      throw new Error("not confirmed");
    };
    const survivor = terminateVerified(10, {
      killTree: failing,
      listTree: async () => [20],
      isAlive: (pid) => pid === 20,
      clock,
      settleMs: 1000,
    });
    await expect(clock.settle(survivor)).rejects.toThrow("not confirmed");
    expect(clock.time).toBeLessThanOrEqual(1050);
    const unknown = terminateVerified(10, {
      killTree: failing,
      listTree: async () => {
        throw new Error("no process table");
      },
      isAlive: () => false,
      clock,
    });
    await expect(clock.settle(unknown)).rejects.toThrow("not confirmed");
  });
});
