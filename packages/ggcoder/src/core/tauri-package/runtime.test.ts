import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestSymlink } from "../../test-utils/symlink.js";
import { discoverTauriPackages } from "./discover.js";
import { commitSupportSet } from "./ownership.js";
import { detectHostTarget } from "./paths.js";
import { renderTauriSupport } from "./render.js";

const fixture = path.join(import.meta.dirname, "__fixtures__", "valid");
const roots: string[] = [];

type Runtime = {
  packageTauri(options: Record<string, unknown>): Promise<Record<string, unknown>>;
};

async function setup(): Promise<{ root: string; targetId: string; runtime: Runtime }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gg-tauri-runtime-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  const cli = path.join(root, "apps/desktop/node_modules/@tauri-apps/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(path.join(cli, "package.json"), `${JSON.stringify({ version: "2.11.2", bin: { tauri: "./tauri.js" } }, null, 2)}\n`);
  await writeFile(path.join(cli, "tauri.js"), "module.exports = {};\n");
  const host = detectHostTarget();
  const binaries = path.join(root, "apps/desktop/src-tauri/binaries");
  await mkdir(binaries, { recursive: true });
  await writeFile(path.join(binaries, `helper-${host.rust_triple}${host.platform === "win32" ? ".exe" : ""}`), "sidecar\n");
  const discovery = await discoverTauriPackages(root);
  const target = discovery.targets[0]!;
  await commitSupportSet(root, renderTauriSupport(discovery, target));
  const moduleUrl = `${pathToFileURL(path.join(root, "scripts/package-tauri.mjs")).href}?${Date.now()}-${Math.random()}`;
  const runtime = (await import(moduleUrl)) as Runtime;
  return { root, targetId: target.target_id, runtime };
}

function builder(
  root: string,
  options: { fail?: boolean; stale?: boolean; extra?: boolean; bytes?: number } = {},
  launches: Array<{ executable: string; argv: string[]; options: Record<string, unknown> }> = [],
) {
  return (executable: string, argv: string[], spawnOptions: Record<string, unknown>) => {
    launches.push({ executable, argv, options: spawnOptions });
    const child = new EventEmitter();
    queueMicrotask(async () => {
      if (options.fail) {
        child.emit("exit", 1, null);
        return;
      }
      const env = spawnOptions.env as NodeJS.ProcessEnv;
      const run = options.stale ? path.join(root, "stale-target") : env.CARGO_TARGET_DIR!;
      const release = path.join(run, "release");
      const host = detectHostTarget();
      let app: string;
      if (host.platform === "win32") app = path.join(release, "fixture.exe");
      else if (host.platform === "darwin") app = path.join(release, "bundle/macos/Fixture.app/Contents/MacOS/fixture");
      else app = path.join(release, "fixture");
      await mkdir(path.dirname(app), { recursive: true });
      await writeFile(app, Buffer.alloc(options.bytes ?? 32, 1));
      if (host.platform !== "win32") await chmod(app, 0o755);
      const bundle = path.join(release, "bundle/installer/package.bin");
      await mkdir(path.dirname(bundle), { recursive: true });
      await writeFile(bundle, "bundle\n");
      if (options.extra) await writeFile(path.join(path.dirname(bundle), "extra.bin"), "extra\n");
      child.emit("exit", 0, null);
    });
    return child;
  };
}

async function calibrate(setupValue: Awaited<ReturnType<typeof setup>>) {
  return setupValue.runtime.packageTauri({
    root: setupValue.root,
    targetId: setupValue.targetId,
    calibrate: true,
    spawnImpl: builder(setupValue.root),
    smoke: async () => undefined,
  });
}

async function temporaryArtifactEntries(root: string): Promise<string[]> {
  return (await readdir(path.join(root, "artifacts/tauri"))).filter((entry) => entry.startsWith(".gg-tauri-"));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generated package runtime", () => {
  it("runs generated fixture tests directly", async () => {
    const value = await setup();
    const result = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--test", "scripts/package-tauri.test.mjs", "scripts/smoke-tauri-package.test.mjs"], { cwd: value.root, shell: false, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(result).toBe(0);
  });

  it("uses exact argv and an empty marker-owned build workspace", async () => {
    const value = await setup();
    const launches: Array<{ executable: string; argv: string[]; options: Record<string, unknown> }> = [];
    let workspaceEntries: string[] = [];
    const spawnImpl = (executable: string, argv: string[], options: Record<string, unknown>) => {
      const env = options.env as NodeJS.ProcessEnv;
      const child = builder(value.root, {}, launches)(executable, argv, options);
      void readdir(env.CARGO_TARGET_DIR!).then((entries) => { workspaceEntries = entries; });
      return child;
    };
    await value.runtime.packageTauri({ root: value.root, targetId: value.targetId, calibrate: true, spawnImpl, smoke: async () => undefined });

    expect(launches).toHaveLength(1);
    expect(launches[0]!.executable).toBe(process.execPath);
    expect(launches[0]!.argv[1]).toBe("build");
    expect(launches[0]!.options).toMatchObject({ shell: false });
    expect(workspaceEntries).toEqual([".gg-tauri-owned.json"]);
    await expect(stat(path.join(value.root, "artifacts/tauri", value.targetId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await temporaryArtifactEntries(value.root)).toEqual([]);
  });

  it("cleans smoke state after a transient Windows file lock", async () => {
    const value = await setup();
    let smokeDirectory: string | undefined;
    await value.runtime.packageTauri({
      root: value.root,
      targetId: value.targetId,
      calibrate: true,
      spawnImpl: builder(value.root),
      smoke: async (_executable: string, options: { env: NodeJS.ProcessEnv }) => {
        smokeDirectory = options.env.TEMP;
        const lockedFile = path.join(smokeDirectory!, "locked.tmp");
        if (process.platform !== "win32") {
          await writeFile(lockedFile, "fixture\n");
          return;
        }
        const command = "$file = [System.IO.File]::Open($env:GG_LOCK_FILE, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [Console]::Out.WriteLine('locked'); Start-Sleep -Milliseconds 500; $file.Dispose()";
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
          env: { ...process.env, GG_LOCK_FILE: lockedFile },
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        await new Promise<void>((resolve, reject) => {
          child.stdout!.once("data", () => resolve());
          child.once("error", reject);
        });
      },
    });
    expect(await temporaryArtifactEntries(value.root)).toEqual([]);
    await expect(stat(smokeDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale output and builder failure without leaving workspaces", async () => {
    const stale = await setup();
    await expect(stale.runtime.packageTauri({ root: stale.root, targetId: stale.targetId, calibrate: true, spawnImpl: builder(stale.root, { stale: true }), smoke: async () => undefined })).rejects.toThrow("no release directory");
    expect(await temporaryArtifactEntries(stale.root)).toEqual([]);

    const failed = await setup();
    await expect(failed.runtime.packageTauri({ root: failed.root, targetId: failed.targetId, calibrate: true, spawnImpl: builder(failed.root, { fail: true }), smoke: async () => undefined })).rejects.toThrow("Tauri build failed");
    expect(await temporaryArtifactEntries(failed.root)).toEqual([]);
  });

  it("rejects count gates and smoke mutation after calibration", async () => {
    const gated = await setup();
    await calibrate(gated);
    await expect(gated.runtime.packageTauri({ root: gated.root, targetId: gated.targetId, spawnImpl: builder(gated.root, { extra: true }), smoke: async () => undefined })).rejects.toThrow("Artifact count changed");
    await expect(gated.runtime.packageTauri({ root: gated.root, targetId: gated.targetId, spawnImpl: builder(gated.root, { bytes: 4 * 1024 * 1024 + 33 }), smoke: async () => undefined })).rejects.toThrow("Artifact exceeds calibrated per-file size gate");

    const mutated = await setup();
    await calibrate(mutated);
    await expect(mutated.runtime.packageTauri({
      root: mutated.root,
      targetId: mutated.targetId,
      spawnImpl: builder(mutated.root),
      smoke: async (executable: string) => writeFile(executable, "mutated\n"),
    })).rejects.toThrow("Smoke test mutated");
    await expect(mutated.runtime.packageTauri({
      root: mutated.root,
      targetId: mutated.targetId,
      spawnImpl: builder(mutated.root),
      smoke: async (executable: string) => writeFile(path.join(path.dirname(executable), "unexpected.tmp"), "unexpected\n"),
    })).rejects.toThrow("Smoke test mutated");
  });

  it("restores the previous promotion after injected rename failure", async () => {
    const value = await setup();
    await calibrate(value);
    await value.runtime.packageTauri({ root: value.root, targetId: value.targetId, spawnImpl: builder(value.root), smoke: async () => undefined });
    const destination = path.join(value.root, "artifacts/tauri", value.targetId);
    const before = await readFile(path.join(destination, "manifest.sha256.json"));
    let injected = false;
    const renameImpl = async (source: string, target: string) => {
      if (!injected && path.basename(source).startsWith(".gg-tauri-stage-") && path.basename(target) === value.targetId) {
        injected = true;
        throw new Error("injected promotion failure");
      }
      await rename(source, target);
    };
    await expect(value.runtime.packageTauri({ root: value.root, targetId: value.targetId, spawnImpl: builder(value.root), smoke: async () => undefined, renameImpl })).rejects.toThrow("injected promotion failure");
    expect(await stat(destination)).toMatchObject({});
    expect(await readFile(path.join(destination, "manifest.sha256.json"))).toEqual(before);
  });

  it("restores calibration when persisted state fails revalidation", async () => {
    const value = await setup();
    await calibrate(value);
    await value.runtime.packageTauri({ root: value.root, targetId: value.targetId, spawnImpl: builder(value.root), smoke: async () => undefined });
    const destination = path.join(value.root, "artifacts/tauri", value.targetId);
    const manifestBefore = await readFile(path.join(destination, "manifest.sha256.json"));
    const configPath = path.join(value.root, "scripts/package-tauri.config.json");
    const configBefore = await readFile(configPath);
    const renameImpl = async (source: string, target: string) => {
      await rename(source, target);
      if (path.basename(source).includes(".calibrate-")) {
        await writeFile(path.join(value.root, "apps/desktop/src-tauri/resources/data.txt"), "changed during persistence\n");
      }
    };

    await expect(value.runtime.packageTauri({ root: value.root, targetId: value.targetId, calibrate: true, spawnImpl: builder(value.root), smoke: async () => undefined, renameImpl })).rejects.toThrow("Repository evidence is stale");
    expect(await readFile(path.join(destination, "manifest.sha256.json"))).toEqual(manifestBefore);
    expect(await readFile(configPath)).toEqual(configBefore);
    expect(await temporaryArtifactEntries(value.root)).toEqual([]);
  });

  it("keeps verify read-only", async () => {
    const value = await setup();
    const before = await readFile(path.join(value.root, "scripts/package-tauri.config.json"));
    const result = await value.runtime.packageTauri({ root: value.root, targetId: value.targetId, verify: true, spawnImpl: () => { throw new Error("must not spawn"); } });
    expect(result).toMatchObject({ action: "verify", verified: true });
    expect(await readFile(path.join(value.root, "scripts/package-tauri.config.json"))).toEqual(before);
  });

  it("refuses linked mutable-root ancestors before build launch", async () => {
    const value = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "gg-tauri-outside-"));
    roots.push(outside);
    await createTestSymlink(outside, path.join(value.root, "artifacts"), "dir");

    await expect(value.runtime.packageTauri({
      root: value.root,
      targetId: value.targetId,
      calibrate: true,
      spawnImpl: () => { throw new Error("must not spawn"); },
      smoke: async () => undefined,
    })).rejects.toThrow("Unsafe mutable-root ancestor");
    expect(await readdir(outside)).toEqual([]);
  });
});
