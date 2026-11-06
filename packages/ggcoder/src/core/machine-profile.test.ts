import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HeavyCheckSlots,
  classifyHeavyCheck,
  deriveConcurrencyBudget,
  detectProjectConcurrencyConfig,
  formatBudgetSummary,
  formatConcurrencyLine,
  leadingCdTarget,
  readMachineFacts,
  resolveConcurrencyEnv,
  scopeConcurrency,
  type HeavySlotClock,
  type MachineProbe,
} from "./machine-profile.js";

const GIB = 1024 ** 3;

function probe(shape: {
  threads: number;
  memGiB: number;
  arch?: string;
  platform?: NodeJS.Platform;
  cpuInfo?: string | null;
}): MachineProbe {
  return {
    availableParallelism: () => shape.threads,
    cpus: () => Array.from({ length: shape.threads }),
    totalmem: () => shape.memGiB * GIB,
    freemem: () => (shape.memGiB / 2) * GIB,
    platform: () => shape.platform ?? "win32",
    arch: () => shape.arch ?? "x64",
    readCpuInfo: () => shape.cpuInfo ?? null,
  };
}

function profileFor(shape: Parameters<typeof probe>[0], override = 0) {
  return deriveConcurrencyBudget(readMachineFacts(probe(shape)), override);
}

describe("deriveConcurrencyBudget", () => {
  it.each([
    ["2-thread CI runner", { threads: 2, memGiB: 7 }, 2, 1],
    ["4-core arm64", { threads: 4, memGiB: 8, arch: "arm64", platform: "linux" as const }, 4, 2],
    ["i7-8700, 12 threads", { threads: 12, memGiB: 24 }, 6, 3],
    ["32 threads, 64 GiB", { threads: 32, memGiB: 64 }, 16, 4],
    ["16 threads, 8 GiB (memory-bound)", { threads: 16, memGiB: 8 }, 4, 2],
    [
      "M-series 10 cores, 16 GiB",
      { threads: 10, memGiB: 16, arch: "arm64", platform: "darwin" as const },
      8,
      4,
    ],
  ])("%s", (_name, shape, budget, workspace) => {
    const profile = profileFor(shape);
    expect(profile.budget).toBe(budget);
    expect(profile.workspaceConcurrency).toBe(workspace);
    expect(profile.overridden).toBe(false);
  });

  it("uses the setting when above 0", () => {
    const profile = profileFor({ threads: 12, memGiB: 24 }, 3);
    expect(profile).toMatchObject({ budget: 3, workspaceConcurrency: 1, overridden: true });
    expect(formatBudgetSummary(profile)).toBe(
      "budget 3 (setting; 12 threads, ~6 cores est., 24 GiB)",
    );
  });

  it("counts physical cores from /proc/cpuinfo on Linux", () => {
    const block = (physical: number, core: number) =>
      `processor\t: x\nphysical id\t: ${physical}\ncore id\t\t: ${core}\n`;
    const cpuInfo = [
      block(0, 0),
      block(0, 0),
      block(0, 1),
      block(0, 1),
      block(0, 2),
      block(0, 3),
    ].join("\n");
    const facts = readMachineFacts(probe({ threads: 6, memGiB: 32, platform: "linux", cpuInfo }));
    expect(facts).toMatchObject({ physicalCores: 4, physicalSource: "reported" });
    expect(formatBudgetSummary(deriveConcurrencyBudget(facts))).toBe(
      "budget 4 (6 threads, 4 cores, 32 GiB)",
    );
  });

  it("labels the i7-8700 estimate", () => {
    expect(formatBudgetSummary(profileFor({ threads: 12, memGiB: 24 }))).toBe(
      "budget 6 (12 threads, ~6 cores est., 24 GiB)",
    );
  });
});

describe("resolveConcurrencyEnv", () => {
  const profile = profileFor({ threads: 12, memGiB: 24 });

  it("applies every default when nothing is set", () => {
    const result = resolveConcurrencyEnv({ profile, sourceEnv: {}, platform: "linux" });
    expect(result.env).toEqual({
      CARGO_BUILD_JOBS: "6",
      RUST_TEST_THREADS: "6",
      npm_config_workspace_concurrency: "3",
      pnpm_config_workspace_concurrency: "3",
    });
    expect(result.env).not.toHaveProperty("VITEST_MAX_WORKERS");
    expect(formatConcurrencyLine(result, "pnpm test")).toBe(
      "[Concurrency defaults (budget 6): CARGO_BUILD_JOBS=6, RUST_TEST_THREADS=6, pnpm workspace-concurrency=3.]",
    );
  });

  it("passes user values through instead of overriding them", () => {
    const result = resolveConcurrencyEnv({
      profile,
      sourceEnv: {
        RUST_TEST_THREADS: "2",
        NPM_CONFIG_WORKSPACE_CONCURRENCY: "1",
        VITEST_MAX_WORKERS: "2",
      },
      platform: "linux",
    });
    expect(result.env).toEqual({
      CARGO_BUILD_JOBS: "6",
      RUST_TEST_THREADS: "2",
      NPM_CONFIG_WORKSPACE_CONCURRENCY: "1",
      VITEST_MAX_WORKERS: "2",
    });
    expect(formatConcurrencyLine(result, "cargo test")).toBe(
      "[Concurrency defaults (budget 6): CARGO_BUILD_JOBS=6; kept yours: RUST_TEST_THREADS=2, pnpm workspace-concurrency=1.]",
    );
  });

  it("matches Windows env names case-insensitively and keeps their spelling", () => {
    const result = resolveConcurrencyEnv({
      profile,
      sourceEnv: { cargo_build_jobs: "3" },
      platform: "win32",
    });
    expect(result.env.cargo_build_jobs).toBe("3");
    expect(result.env).not.toHaveProperty("CARGO_BUILD_JOBS");
    // Elsewhere names are case-sensitive, so cargo would not read the lowercase one.
    const posix = resolveConcurrencyEnv({
      profile,
      sourceEnv: { cargo_build_jobs: "3" },
      platform: "linux",
    });
    expect(posix.env.CARGO_BUILD_JOBS).toBe("6");
  });

  it("leaves values a project config sets", () => {
    const result = resolveConcurrencyEnv({
      profile,
      sourceEnv: {},
      platform: "linux",
      projectConfig: {
        found: { cargoJobs: "/repo/.cargo/config.toml", workspaceConcurrency: "/repo/.npmrc" },
      },
    });
    expect(Object.keys(result.env)).toEqual(["RUST_TEST_THREADS"]);
    expect(formatConcurrencyLine(result, "cargo build")).toBe(
      "[Concurrency defaults (budget 6): RUST_TEST_THREADS=6; kept project config: CARGO_BUILD_JOBS (/repo/.cargo/config.toml), pnpm workspace-concurrency (/repo/.npmrc).]",
    );
  });

  it("leaves values the command sets with a flag or inline assignment", () => {
    const result = resolveConcurrencyEnv({
      profile,
      sourceEnv: {},
      platform: "linux",
      command:
        "CARGO_BUILD_JOBS=2 cargo test -- --test-threads=1 && pnpm -r --workspace-concurrency=1 test",
    });
    expect(result.env).toEqual({});
    expect(result.kept.map((entry) => entry.source)).toEqual(["command", "command", "command"]);
  });

  it("shows the line only for build-tool commands", () => {
    const result = resolveConcurrencyEnv({ profile, sourceEnv: {}, platform: "linux" });
    expect(formatConcurrencyLine(result, "git status")).toBe("");
    expect(formatConcurrencyLine(result, "cd app && cargo build")).not.toBe("");
    expect(formatConcurrencyLine(result, "npx vitest run")).not.toBe("");
  });

  it("scopes defaults for a persistent shell without overriding its exports", () => {
    const result = resolveConcurrencyEnv({ profile, sourceEnv: {}, platform: "linux" });
    const scoped = scopeConcurrency("cd x && cargo build", result);
    expect(scoped).toContain(`cd x && CARGO_BUILD_JOBS="\${CARGO_BUILD_JOBS:-'6'}"`);
    expect(scoped).toContain(
      `npm_config_workspace_concurrency="\${npm_config_workspace_concurrency:-\${pnpm_config_workspace_concurrency:-'3'}}"`,
    );
    expect(scoped.endsWith(" cargo build")).toBe(true);
    expect(scopeConcurrency("git status", result)).toBe("git status");
    expect(scopeConcurrency("cargo build", null)).toBe("cargo build");
  });
});

describe("detectProjectConcurrencyConfig", () => {
  const root = path.resolve("/work/repo");
  const files = (entries: Record<string, string>) => async (file: string) =>
    entries[path.resolve(file)] ?? null;

  it("finds cargo, npmrc and pnpm-workspace settings in ancestors", async () => {
    const found = await detectProjectConcurrencyConfig({
      dirs: [path.join(root, "crates", "app")],
      homeDir: path.resolve("/home/u"),
      readFile: files({
        [path.join(root, ".cargo", "config.toml")]: "[build]\njobs = 2\n",
        [path.join(root, "crates", ".cargo", "config")]: '[env]\nRUST_TEST_THREADS = "1"\n',
        [path.join(root, "pnpm-workspace.yaml")]: "packages:\n  - x\nworkspaceConcurrency: 1\n",
      }),
    });
    expect(found.found).toEqual({
      cargoJobs: path.join(root, ".cargo", "config.toml"),
      rustTestThreads: path.join(root, "crates", ".cargo", "config"),
      workspaceConcurrency: path.join(root, "pnpm-workspace.yaml"),
    });
  });

  it("reads home .npmrc and CARGO_HOME config", async () => {
    const home = path.resolve("/home/u");
    const cargoHome = path.resolve("/opt/cargo");
    const found = await detectProjectConcurrencyConfig({
      dirs: [root],
      homeDir: home,
      cargoHome,
      readFile: files({
        [path.join(home, ".npmrc")]: "workspace-concurrency=1\n",
        [path.join(cargoHome, "config.toml")]: "[build]\n  jobs = 4\n",
      }),
    });
    expect(found.found).toEqual({
      cargoJobs: path.join(cargoHome, "config.toml"),
      workspaceConcurrency: path.join(home, ".npmrc"),
    });
  });

  it("ignores unrelated config text", async () => {
    const found = await detectProjectConcurrencyConfig({
      dirs: [root],
      homeDir: path.resolve("/home/u"),
      readFile: files({
        [path.join(root, ".cargo", "config.toml")]: '[build]\ntarget = "x"\n# jobs\n',
      }),
    });
    expect(found.found).toEqual({});
  });

  it("resolves a leading literal cd target", () => {
    expect(leadingCdTarget("cd gg-app/src-tauri && cargo test", root)).toBe(
      path.join(root, "gg-app", "src-tauri"),
    );
    expect(leadingCdTarget('cd "a b" && cargo test', root)).toBe(path.join(root, "a b"));
    expect(leadingCdTarget("cd $HOME && cargo test", root)).toBeNull();
    expect(leadingCdTarget("cargo test", root)).toBeNull();
  });
});

describe("classifyHeavyCheck", () => {
  it.each([
    "pnpm test",
    "pnpm run build",
    "npm test",
    "yarn test",
    "bun run test",
    "pnpm -r --if-present test",
    "pnpm --recursive build",
    "pnpm test -- --reporter=dot",
    "cargo test",
    "cargo test --workspace -j 4",
    "cargo nextest run",
    "cargo build --release",
    "cd gg-app/src-tauri && cargo test -- --test-threads=2",
    "pnpm tauri build",
    "CI=1 pnpm test",
  ])("heavy: %s", (command) => {
    expect(classifyHeavyCheck(command)).not.toBeNull();
  });

  it.each([
    "pnpm --filter @kenkaiiii/ggcoder test",
    "pnpm -F gg-app build",
    "pnpm --dir gg-app test",
    "pnpm test src/a.test.ts",
    "pnpm run lint",
    "pnpm -r --filter x test",
    "cargo test -p app",
    "cargo test my_test",
    "cargo check",
    "vitest run",
    "git status",
  ])("not heavy: %s", (command) => {
    expect(classifyHeavyCheck(command)).toBeNull();
  });
});

function manualClock() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  const clock: HeavySlotClock = {
    now: () => now,
    setTimer: (callback, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return { clock, advance };
}

describe("HeavyCheckSlots", () => {
  it("refuses at once when the same session already holds the slot", async () => {
    const slots = new HeavyCheckSlots({ clock: manualClock().clock });
    const first = await slots.acquire({ label: "pnpm test", owner: "a", limit: 1 });
    if (!first.ok) throw new Error("expected a lease");
    first.lease.attachTask("bg-1");
    const second = await slots.acquire({ label: "cargo test", owner: "a", limit: 1 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.aborted).toBe(false);
    expect(second.message).toContain("`pnpm test` is already running as task bg-1");
    expect(second.message).toContain("task_output");
    expect(second.message).toContain("Nothing was run.");
  });

  it("queues another session first-in-first-out with a notice", async () => {
    const { clock, advance } = manualClock();
    const slots = new HeavyCheckSlots({ clock });
    const first = await slots.acquire({ label: "pnpm test", owner: "a", limit: 1 });
    if (!first.ok) throw new Error("expected a lease");
    advance(120_000);
    const notices: string[] = [];
    const order: string[] = [];
    const b = slots
      .acquire({ label: "cargo test", owner: "b", limit: 1, onWait: (text) => notices.push(text) })
      .then((result) => {
        order.push("b");
        return result;
      });
    const c = slots.acquire({ label: "pnpm build", owner: "c", limit: 1 }).then((result) => {
      order.push("c");
      return result;
    });
    expect(notices).toEqual([
      "Waiting for another window's `pnpm test` (started 2m ago) to finish…",
    ]);
    advance(5_000);
    first.lease.release();
    const bResult = await b;
    expect(bResult.ok && bResult.waitedMs).toBe(5_000);
    expect(order).toEqual(["b"]);
    if (bResult.ok) bResult.lease.release();
    const cResult = await c;
    expect(cResult.ok).toBe(true);
    expect(order).toEqual(["b", "c"]);
  });

  it("cancels a wait on abort and lets the next waiter through", async () => {
    const slots = new HeavyCheckSlots({ clock: manualClock().clock });
    const first = await slots.acquire({ label: "pnpm test", owner: "a", limit: 1 });
    if (!first.ok) throw new Error("expected a lease");
    const controller = new AbortController();
    const waiting = slots.acquire({
      label: "pnpm test",
      owner: "b",
      limit: 1,
      signal: controller.signal,
    });
    controller.abort();
    expect(await waiting).toEqual({ ok: false, aborted: true, message: "cancelled" });
    first.lease.release();
    expect(slots.held).toBe(0);
  });

  it("refuses with guidance after 15 minutes and never kills the holder", async () => {
    const { clock, advance } = manualClock();
    const slots = new HeavyCheckSlots({ clock });
    const first = await slots.acquire({ label: "pnpm test", owner: "a", limit: 1 });
    if (!first.ok) throw new Error("expected a lease");
    const waiting = slots.acquire({ label: "cargo test", owner: "b", limit: 1 });
    advance(15 * 60_000);
    const result = await waiting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Waited 15m for another window's `pnpm test`");
    expect(slots.held).toBe(1);
  });

  it("does nothing when the limit is 0 and tolerates double release", async () => {
    const slots = new HeavyCheckSlots({ clock: manualClock().clock });
    const a = await slots.acquire({ label: "pnpm test", owner: "a", limit: 0 });
    const b = await slots.acquire({ label: "pnpm test", owner: "a", limit: 0 });
    expect(a.ok && b.ok).toBe(true);
    expect(slots.held).toBe(0);
    const c = await slots.acquire({ label: "pnpm test", owner: "a", limit: 1 });
    if (!c.ok) throw new Error("expected a lease");
    c.lease.release();
    c.lease.release();
    expect(slots.held).toBe(0);
  });
});
