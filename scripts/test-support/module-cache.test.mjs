import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { moduleCacheSettings } from "./module-cache.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MODULE_CACHE_URL = new URL("./module-cache.mjs", import.meta.url).href;
const winPath = (posixStyle) => posixStyle.replaceAll("/", path.win32.sep);

describe("moduleCacheSettings", () => {
  const win = { platform: "win32", homedir: winPath("C:/Users/me"), packageName: "gg-app" };

  const on = { GG_VITEST_MODULE_CACHE: "on" };

  it("is off by default, including on CI", () => {
    const env = { LOCALAPPDATA: winPath("C:/Local") };
    assert.deepEqual(moduleCacheSettings({ ...win, env }), { fsModuleCache: false });
    assert.deepEqual(moduleCacheSettings({ ...win, env: { ...env, CI: "true" } }), {
      fsModuleCache: false,
    });
    for (const value of ["off", "0", "false", "", "yes"]) {
      assert.deepEqual(
        moduleCacheSettings({ ...win, env: { ...env, GG_VITEST_MODULE_CACHE: value } }),
        { fsModuleCache: false },
      );
    }
  });

  it("turns on under LOCALAPPDATA on Windows with the on variable", () => {
    for (const value of ["on", "1", "true", "ON"]) {
      const env = {
        LOCALAPPDATA: winPath("C:/Users/me/AppData/Local"),
        GG_VITEST_MODULE_CACHE: value,
      };
      assert.deepEqual(moduleCacheSettings({ ...win, env }), {
        fsModuleCache: true,
        fsModuleCachePath: winPath("C:/Users/me/AppData/Local/gg-vitest-cache/gg-app"),
      });
    }
  });

  it("uses the directory variable when set", () => {
    const env = {
      ...on,
      LOCALAPPDATA: winPath("C:/Local"),
      GG_VITEST_MODULE_CACHE_DIR: winPath("D:/cache"),
    };
    assert.deepEqual(moduleCacheSettings({ ...win, env }), {
      fsModuleCache: true,
      fsModuleCachePath: winPath("D:/cache/gg-app"),
    });
  });

  it("is off when no base folder resolves, never falling back to node_modules", () => {
    assert.deepEqual(moduleCacheSettings({ ...win, env: on }), { fsModuleCache: false });
    assert.deepEqual(
      moduleCacheSettings({ platform: "linux", homedir: "", packageName: "ggcoder", env: on }),
      { fsModuleCache: false },
    );
  });

  it("uses XDG_CACHE_HOME or ~/.cache elsewhere", () => {
    const linux = { platform: "linux", homedir: "/home/me", packageName: "ggcoder" };
    assert.deepEqual(moduleCacheSettings({ ...linux, env: on }), {
      fsModuleCache: true,
      fsModuleCachePath: "/home/me/.cache/gg-vitest-cache/ggcoder",
    });
    assert.deepEqual(moduleCacheSettings({ ...linux, env: { ...on, XDG_CACHE_HOME: "/xdg" } }), {
      fsModuleCache: true,
      fsModuleCachePath: "/xdg/gg-vitest-cache/ggcoder",
    });
  });

  it("requires a package name", () => {
    assert.throws(() => moduleCacheSettings({ env: {} }), /packageName/);
  });
});

function writeFixture(dir, { pool, values }) {
  fs.mkdirSync(path.join(dir, "src", "__mocks__"), { recursive: true });
  // Mirrors gg-app's whatsNewHeadDefines: a JSON define read from a file at config load.
  fs.writeFileSync(
    path.join(dir, "vitest.config.mjs"),
    `import { readFileSync } from "node:fs";
import { moduleCacheSettings } from ${JSON.stringify(MODULE_CACHE_URL)};
const constant = JSON.parse(readFileSync(new URL("./const.json", import.meta.url), "utf8"));
export default {
  define: { __CONST__: JSON.stringify(constant) },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    ${pool ? `pool: ${JSON.stringify(pool)},` : ""}
    experimental: moduleCacheSettings({ packageName: "fixture" }),
  },
};
`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "probe.test.ts"),
    `import { writeFileSync } from "node:fs";
import { source } from "./value";
import { factory } from "./factory";
import { dep } from "./dep";
vi.mock("./factory", () => ({ factory: ${JSON.stringify(values.factory)} }));
vi.mock("./dep");
declare const __CONST__: string;
test("records what it sees", () => {
  writeFileSync(process.env.FIXTURE_OUT!, JSON.stringify({ source, define: __CONST__, factory, dep }));
});
`,
  );
  writeValues(dir, values);
  fs.writeFileSync(path.join(dir, "src", "factory.ts"), `export const factory = "real";\n`);
  fs.writeFileSync(path.join(dir, "src", "dep.ts"), `export const dep = "real";\n`);
}

function writeValues(dir, values) {
  fs.writeFileSync(path.join(dir, "const.json"), JSON.stringify(values.define));
  fs.writeFileSync(
    path.join(dir, "src", "value.ts"),
    `export const source = ${JSON.stringify(values.source)};\n`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "__mocks__", "dep.ts"),
    `export const dep = ${JSON.stringify(values.dep)};\n`,
  );
  const testFile = path.join(dir, "src", "probe.test.ts");
  if (fs.existsSync(testFile)) {
    const source = fs.readFileSync(testFile, "utf8");
    fs.writeFileSync(
      testFile,
      source.replace(/factory: "[^"]*"/, `factory: ${JSON.stringify(values.factory)}`),
    );
  }
}

function runVitest({ vitestPackage, dir, cacheDir, debug }) {
  const out = path.join(dir, "out.json");
  fs.rmSync(out, { force: true });
  const env = {
    ...process.env,
    GG_VITEST_MODULE_CACHE: "on",
    GG_VITEST_MODULE_CACHE_DIR: cacheDir,
    FIXTURE_OUT: out,
  };
  delete env.DEBUG;
  if (debug) env.DEBUG = "vitest:cache:fs";
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, vitestPackage, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--root",
      dir,
    ],
    { cwd: dir, env, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, `vitest failed:\n${result.stdout}\n${result.stderr}`);
  return { seen: JSON.parse(fs.readFileSync(out, "utf8")), stderr: result.stderr };
}

const SCENARIOS = [
  { name: "gg-app vitest, threads pool", vitestPackage: "gg-app", pool: "threads" },
  { name: "gg-app vitest, vmThreads pool", vitestPackage: "gg-app", pool: "vmThreads" },
  { name: "ggcoder vitest, default pool", vitestPackage: "packages/ggcoder" },
];

describe("fsModuleCache never serves stale code", { concurrency: false }, () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, { timeout: 360_000 }, () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-module-cache-"));
      try {
        const dir = path.join(base, "fixture");
        const cacheDir = path.join(base, "cache");
        const first = {
          source: "source-A",
          define: "define-A",
          factory: "factory-A",
          dep: "dep-A",
        };
        const second = {
          source: "source-B",
          define: "define-B",
          factory: "factory-B",
          dep: "dep-B",
        };
        writeFixture(dir, { pool: scenario.pool, values: first });

        const cold = runVitest({ ...scenario, dir, cacheDir });
        assert.deepEqual(cold.seen, first);
        const cacheFolder = path.join(cacheDir, "fixture");
        assert.ok(
          fs.readdirSync(cacheFolder).some((name) => name !== "_metadata.json"),
          "cache folder is empty",
        );

        writeValues(dir, second);
        assert.deepEqual(runVitest({ ...scenario, dir, cacheDir }).seen, second);

        const warm = runVitest({ ...scenario, dir, cacheDir, debug: true });
        assert.deepEqual(warm.seen, second);
        assert.match(warm.stderr, /\[read\]/, "warm run did not read from the cache");
      } finally {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
  }
});
