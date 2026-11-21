import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFrameworkPackages,
  committedReleaseNotes,
  decidePackageBuild,
  FRAMEWORK_PACKAGES,
  freshInstallerForPlatform,
  installerManifest,
  INSTALLED_SMOKE_IDENTITY,
  LOCAL_CARGO_RELEASE_SETTINGS,
  LOCAL_FORK_IDENTITY,
  localBuildConfigPaths,
  localCargoBuildEnv,
  missingPhaseLeaseRegressionGuards,
  parseLocalBuildArgs,
  PHASE_LEASE_REGRESSION_GATE,
  phaseLeaseRegressionGateArgs,
  readAppSidecarSources,
  readPackageBuildStamp,
  releaseNotesEnvelope,
  runWithCargoTomlRestored,
  tauriBuildArgs,
  treeContentHash,
  validateLocalReleaseNotes,
  windowsNsisPayloadMetadata,
} from "./build-local-hotfix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories: string[] = [];
const sourceRevision = "a".repeat(40);
const validReleaseNotes = {
  schemaVersion: 1,
  date: "2026-08-29",
  label: "Roadmap completion now fails closed",
  sections: [{ title: "Safer phase completion", items: ["Roadmap completion fails closed."] }],
};

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function fixture(): { root: string; nsis: string } {
  const root = mkdtempSync(join(tmpdir(), "gg-local-installer-"));
  temporaryDirectories.push(root);
  const nsis = join(root, "target", "release", "bundle", "nsis");
  mkdirSync(nsis, { recursive: true });
  return { root, nsis };
}

describe("local installer freshness", () => {
  it("selects the exact Local Fork Windows NSIS installer after build start", () => {
    const { root, nsis } = fixture();
    const startedAt = Date.now();
    const installer = join(nsis, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    writeFileSync(installer, "installer");
    const completedAt = new Date(startedAt + 1_000);
    utimesSync(installer, completedAt, completedAt);

    expect(freshInstallerForPlatform(root, "win32", startedAt)).toBe(installer);
  });

  it("rejects stale and non-Local Fork Windows installers", () => {
    const { root, nsis } = fixture();
    const staleInstaller = join(nsis, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    const localForkInstaller = join(nsis, "GG Coder_1.2.3_x64-setup.exe");
    writeFileSync(staleInstaller, "stale installer");
    writeFileSync(localForkInstaller, "wrong identity");
    const old = new Date(Date.now() - 60_000);
    utimesSync(staleInstaller, old, old);

    expect(freshInstallerForPlatform(root, "win32", Date.now())).toBeNull();
  });

  it("rejects ambiguous fresh Local Fork installers", () => {
    const { root, nsis } = fixture();
    const startedAt = Date.now();
    for (const name of [
      "GG Coder Local Fork_1.2.3_x64-setup.exe",
      "GG Coder Local Fork_1.2.4_x64-setup.exe",
    ]) {
      const installer = join(nsis, name);
      writeFileSync(installer, name);
      const completedAt = new Date(startedAt + 1_000);
      utimesSync(installer, completedAt, completedAt);
    }

    expect(() => freshInstallerForPlatform(root, "win32", startedAt)).toThrow(
      "multiple fresh Local Fork NSIS installers",
    );
  });

  it("selects only the dedicated Installed Smoke artifact", () => {
    const { root, nsis } = fixture();
    const startedAt = Date.now();
    const production = join(nsis, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    const smoke = join(nsis, "GG Coder Local Fork Installed Smoke_1.2.3_x64-setup.exe");
    writeFileSync(production, "production");
    writeFileSync(smoke, "smoke");
    const completedAt = new Date(startedAt + 1_000);
    utimesSync(production, completedAt, completedAt);
    utimesSync(smoke, completedAt, completedAt);

    expect(freshInstallerForPlatform(root, "win32", startedAt, INSTALLED_SMOKE_IDENTITY)).toBe(
      smoke,
    );
  });
});

describe("local installer manifest", () => {
  it("hashes the NSIS-patched payload bytes that Tauri embeds", () => {
    const { root } = fixture();
    const payload = join(root, "target", "release", "gg-coder-local-fork.exe");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    const sourceBytes = Buffer.from("before__TAURI_BUNDLE_TYPE_VAR_UNKafter");
    const installerBytes = Buffer.from("before__TAURI_BUNDLE_TYPE_VAR_NSSafter");
    writeFileSync(payload, sourceBytes);

    expect(windowsNsisPayloadMetadata(payload)).toEqual({
      size: sourceBytes.length,
      sha256: createHash("sha256").update(installerBytes).digest("hex"),
    });
  });

  it("fails closed when the Tauri bundle marker is absent", () => {
    const { root } = fixture();
    const payload = join(root, "target", "release", "gg-coder-local-fork.exe");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(payload, "payload without marker");

    expect(() => windowsNsisPayloadMetadata(payload)).toThrow(
      "Expected exactly one unpatched Tauri bundle-type marker",
    );
  });

  it("keeps installer compatibility fields and authenticates the Local Fork payload", () => {
    const { root, nsis } = fixture();
    const installer = join(nsis, "GG Coder Local Fork_1.2.3_x64-setup.exe");
    const payload = join(root, "target", "release", "gg-coder-local-fork.exe");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(installer, "installer bytes");
    writeFileSync(payload, "payload bytes");

    const releaseMetadata = releaseNotesEnvelope(sourceRevision, validReleaseNotes);
    const manifest = installerManifest(installer, payload, releaseMetadata);

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      sourceRevision,
      releaseNotes: releaseMetadata.releaseNotes,
      path: installer,
      size: Buffer.byteLength("installer bytes"),
      identity: LOCAL_FORK_IDENTITY,
      payload: {
        name: "gg-coder-local-fork.exe",
        size: Buffer.byteLength("payload bytes"),
      },
    });
    expect(manifest.mtimeMs).toBeGreaterThan(0);
    expect(manifest.sha256).toBe(createHash("sha256").update("installer bytes").digest("hex"));
    expect(manifest.payload.sha256).toBe(
      createHash("sha256").update("payload bytes").digest("hex"),
    );
  });

  it("records the dedicated Installed Smoke identity and payload", () => {
    const { root, nsis } = fixture();
    const installer = join(nsis, "GG Coder Local Fork Installed Smoke_1.2.3_x64-setup.exe");
    const payload = join(root, "target", "release", INSTALLED_SMOKE_IDENTITY.executableName);
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(installer, "smoke installer");
    writeFileSync(payload, "smoke payload");

    const manifest = installerManifest(
      installer,
      payload,
      releaseNotesEnvelope(sourceRevision, validReleaseNotes),
      undefined,
      INSTALLED_SMOKE_IDENTITY,
    );

    expect(manifest.identity).toEqual(INSTALLED_SMOKE_IDENTITY);
    expect(manifest.path).toBe(installer);
    expect(manifest.payload.name).toBe(INSTALLED_SMOKE_IDENTITY.executableName);
  });
});

describe("commit-bound Local Fork release notes", () => {
  function releaseFixture(bytes?: Buffer): { root: string } {
    const root = mkdtempSync(join(tmpdir(), "gg-local-release-notes-"));
    temporaryDirectories.push(root);
    const directory = join(root, "gg-app", "src");
    mkdirSync(directory, { recursive: true });
    if (bytes) writeFileSync(join(directory, "local-release-notes.json"), bytes);
    return { root };
  }

  function fakeGit({
    status = "",
    tracked = true,
    committedBytes = Buffer.from(JSON.stringify(validReleaseNotes)),
    revision = sourceRevision,
  } = {}) {
    return (args: string[]): Buffer => {
      if (args[0] === "status") return Buffer.from(status);
      if (args[0] === "rev-parse") return Buffer.from(`${revision}\n`);
      if (args[0] === "ls-files") {
        if (!tracked) throw new Error("not tracked");
        return Buffer.from("gg-app/src/local-release-notes.json\n");
      }
      if (args[0] === "show") return committedBytes;
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    };
  }

  it("stamps deterministic envelope bytes with the full source revision", () => {
    const first = releaseNotesEnvelope(sourceRevision.toUpperCase(), validReleaseNotes);
    const second = releaseNotesEnvelope(sourceRevision, validReleaseNotes);
    const envelopeBytes = Buffer.from(first.releaseNotes.base64, "base64");

    expect(first).toEqual(second);
    expect(first.sourceRevision).toBe(sourceRevision);
    expect(first.releaseNotes.size).toBe(envelopeBytes.length);
    expect(first.releaseNotes.sha256).toBe(
      createHash("sha256").update(envelopeBytes).digest("hex"),
    );
    expect(JSON.parse(envelopeBytes.toString("utf8"))).toEqual({
      schemaVersion: 1,
      sourceRevision,
      note: validReleaseNotes,
    });
  });

  it.each([
    ["unknown fields", { ...validReleaseNotes, surprise: true }],
    ["empty label", { ...validReleaseNotes, label: "" }],
    [
      "oversized item",
      {
        ...validReleaseNotes,
        sections: [{ title: "Section", items: ["x".repeat(501)] }],
      },
    ],
    [
      "unknown section fields",
      {
        ...validReleaseNotes,
        sections: [{ title: "Section", items: ["Item"], surprise: true }],
      },
    ],
  ])("rejects malformed notes with %s", (_name, note) => {
    expect(() => validateLocalReleaseNotes(note)).toThrow(/release-note/);
  });

  it.each([
    ["dirty", " M gg-app/src/file.ts"],
    ["untracked", "?? surprise.txt"],
  ])("rejects a %s worktree before reading notes", (_name, status) => {
    const { root } = releaseFixture();
    expect(() => committedReleaseNotes(root, fakeGit({ status }))).toThrow("clean worktree");
  });

  it("rejects missing or untracked release notes", () => {
    const { root } = releaseFixture();
    expect(() => committedReleaseNotes(root, fakeGit())).toThrow(/ENOENT/);
    expect(() => committedReleaseNotes(root, fakeGit({ tracked: false }))).toThrow(
      "tracked by Git",
    );
  });

  it("rejects release-note bytes that differ from HEAD", () => {
    const currentBytes = Buffer.from(JSON.stringify(validReleaseNotes));
    const { root } = releaseFixture(currentBytes);
    expect(() =>
      committedReleaseNotes(root, fakeGit({ committedBytes: Buffer.from("stale") })),
    ).toThrow("differ from the source commit");
  });

  it("rejects malformed committed release notes", () => {
    const malformed = Buffer.from("{");
    const { root } = releaseFixture(malformed);
    expect(() => committedReleaseNotes(root, fakeGit({ committedBytes: malformed }))).toThrow(
      "valid JSON",
    );
  });

  it("loads committed note bytes into the manifest envelope", () => {
    const currentBytes = Buffer.from(JSON.stringify(validReleaseNotes));
    const { root } = releaseFixture(currentBytes);
    const metadata = committedReleaseNotes(root, fakeGit({ committedBytes: currentBytes }));
    expect(metadata.sourceRevision).toBe(sourceRevision);
    expect(
      JSON.parse(Buffer.from(metadata.releaseNotes.base64, "base64").toString("utf8")),
    ).toEqual({ schemaVersion: 1, sourceRevision, note: validReleaseNotes });
  });
});

describe("Tauri build arguments", () => {
  it("selects only NSIS on Windows and preserves non-Windows bundles", () => {
    const configPath = "local-config.json";

    expect(tauriBuildArgs("win32", configPath)).toEqual([
      "--filter",
      "gg-app",
      "tauri",
      "build",
      "--bundles",
      "nsis",
      "--no-sign",
      "--config",
      configPath,
    ]);
    expect(tauriBuildArgs("darwin", configPath)).toEqual([
      "--filter",
      "gg-app",
      "tauri",
      "build",
      "--no-sign",
      "--config",
      configPath,
    ]);
  });

  it("merges Local Fork before Installed Smoke without changing normal arguments", () => {
    const normalPaths = localBuildConfigPaths("src-tauri");
    const smokePaths = localBuildConfigPaths("src-tauri", true);

    expect(normalPaths).toEqual([join("src-tauri", "tauri.local.conf.json")]);
    expect(smokePaths).toEqual([
      join("src-tauri", "tauri.local.conf.json"),
      join("src-tauri", "tauri.installed-smoke.conf.json"),
    ]);
    expect(tauriBuildArgs("win32", smokePaths)).toEqual([
      "--filter",
      "gg-app",
      "tauri",
      "build",
      "--bundles",
      "nsis",
      "--no-sign",
      "--config",
      smokePaths[0],
      "--config",
      smokePaths[1],
    ]);
  });
});

describe("Roadmap phase-lease regression build gate", () => {
  const ggcoderRoot = join(here, "..", "..", "packages", "ggcoder");

  it("finds every regression guard in the real ggcoder test files", () => {
    expect(PHASE_LEASE_REGRESSION_GATE.length).toBeGreaterThan(0);
    expect(missingPhaseLeaseRegressionGuards(ggcoderRoot)).toEqual([]);
  });

  it("blocks the build when a guard file or its regression marker disappears", () => {
    const [first, ...rest] = PHASE_LEASE_REGRESSION_GATE;
    const contents = new Map(
      rest.map(({ file, marker }) => [join(ggcoderRoot, file), `describe("${marker}")`]),
    );
    contents.set(join(ggcoderRoot, first!.file), "describe('renamed')");
    const read = (path: string) => {
      const text = contents.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    };

    expect(missingPhaseLeaseRegressionGuards(ggcoderRoot, read)).toEqual([first]);
    contents.delete(join(ggcoderRoot, rest[0]!.file));
    expect(missingPhaseLeaseRegressionGuards(ggcoderRoot, read)).toEqual([first, rest[0]]);
  });

  it("runs exactly the guarded files through ggcoder's vitest", () => {
    expect(phaseLeaseRegressionGateArgs()).toEqual([
      "--filter",
      "@kenkaiiii/ggcoder",
      "exec",
      "vitest",
      "run",
      ...PHASE_LEASE_REGRESSION_GATE.map(({ file }) => file),
    ]);
  });

  it("runs the gate after the framework builds and before the sidecar is bundled", () => {
    const source = readFileSync(join(here, "build-local-hotfix.mjs"), "utf8");
    const main = source.slice(source.indexOf("async function main()"));
    const lastPackageBuild = main.indexOf('"@kenkaiiii/ggcoder"');
    const gate = main.indexOf("runPhaseLeaseRegressionGate();");
    const bundle = main.indexOf('"bundle:sidecar"');
    expect(lastPackageBuild).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(lastPackageBuild);
    expect(bundle).toBeGreaterThan(gate);
  });

  it("guards the daemon's own phase-lease wiring, not only the unit-level contracts", () => {
    expect(PHASE_LEASE_REGRESSION_GATE.map(({ file }) => file)).toContain(
      "src/app-sidecar-phase-lease-wiring.test.ts",
    );
    const sidecar = readAppSidecarSources(ggcoderRoot);
    const construction = sidecar.slice(sidecar.indexOf("new RoadmapPhaseLeaseRepository("));
    expect(construction.slice(0, construction.indexOf("});"))).toMatch(
      /hasLiveLocalSession:[\s\S]*hasLivePhaseLeaseSession\(/,
    );
    const compactionEnd = sidecar.slice(sidecar.indexOf('target.eventBus.on("compaction_end"'));
    expect(compactionEnd.slice(0, compactionEnd.indexOf("\n    });"))).toContain(
      "phaseBinding\n          .handOffCompactedSession(target",
    );
  });
});

describe("Cargo.toml restoration", () => {
  const originalCargoToml = Buffer.from(
    '[package]\r\nname = "gg-app"\r\nversion = "1.2.3"\r\n',
    "utf8",
  );

  function cargoFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "gg-local-cargo-"));
    temporaryDirectories.push(root);
    const cargoTomlPath = join(root, "Cargo.toml");
    writeFileSync(cargoTomlPath, originalCargoToml);
    return cargoTomlPath;
  }

  it("restores the original CRLF bytes after a successful build", () => {
    const cargoTomlPath = cargoFixture();

    const result = runWithCargoTomlRestored(cargoTomlPath, () => {
      writeFileSync(cargoTomlPath, '[package]\nversion = "9.9.9"\n');
      return 0;
    });

    expect(result).toBe(0);
    expect(readFileSync(cargoTomlPath)).toEqual(originalCargoToml);
  });

  it("restores the original CRLF bytes after a throwing build", () => {
    const cargoTomlPath = cargoFixture();
    const buildError = new Error("Tauri failed");

    expect(() =>
      runWithCargoTomlRestored(cargoTomlPath, () => {
        writeFileSync(cargoTomlPath, '[package]\nversion = "9.9.9"\n');
        throw buildError;
      }),
    ).toThrow(buildError);
    expect(readFileSync(cargoTomlPath)).toEqual(originalCargoToml);
  });
});

describe("local-only Cargo settings", () => {
  const srcTauri = join(here, "..", "src-tauri");

  it("adds only incremental release builds and leaves the input untouched", () => {
    const base = { PATH: "C:/bin", CARGO_BUILD_JOBS: "6" };
    const childEnv = localCargoBuildEnv(base);

    expect(LOCAL_CARGO_RELEASE_SETTINGS).toEqual({ CARGO_PROFILE_RELEASE_INCREMENTAL: "true" });
    expect(childEnv).toEqual({ ...base, CARGO_PROFILE_RELEASE_INCREMENTAL: "true" });
    expect(base).toEqual({ PATH: "C:/bin", CARGO_BUILD_JOBS: "6" });
    expect(Object.keys(childEnv)).not.toContain("CARGO_TARGET_DIR");
    expect(Object.keys(childEnv).filter((key) => /OPT_LEVEL|LTO/.test(key))).toEqual([]);
  });

  it("lets a user-set Cargo value win", () => {
    expect(localCargoBuildEnv({ CARGO_PROFILE_RELEASE_INCREMENTAL: "false" })).toEqual({
      CARGO_PROFILE_RELEASE_INCREMENTAL: "false",
    });
    expect(localCargoBuildEnv({ cargo_profile_release_incremental: "false" })).toEqual({
      cargo_profile_release_incremental: "false",
    });
    expect(localCargoBuildEnv({ CARGO_INCREMENTAL: "0" })).toEqual({ CARGO_INCREMENTAL: "0" });
  });

  it("passes the settings to the Tauri build child only", () => {
    const source = readFileSync(join(here, "build-local-hotfix.mjs"), "utf8");
    const moduleEnv = source.match(/^const env = .*$/m)?.[0];
    expect(moduleEnv).toBeDefined();
    expect(moduleEnv).not.toContain("CARGO_");
    const main = source.slice(source.indexOf("async function main()"));
    expect(main.match(/localCargoBuildEnv\(/g)).toHaveLength(1);
    expect(main).toContain(
      "run(pnpm, tauriBuildArgs(process.platform, configPaths), localCargoBuildEnv(env))",
    );
  });

  it("leaves the official release and CI build settings untouched", () => {
    const baseConfig = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));
    expect(baseConfig.bundle?.windows?.nsis?.compression).toBeUndefined();
    expect(readFileSync(join(srcTauri, "Cargo.toml"), "utf8")).not.toMatch(/^\[profile/m);
    expect(existsSync(join(srcTauri, ".cargo", "config.toml"))).toBe(false);
    expect(existsSync(join(srcTauri, ".cargo", "config"))).toBe(false);
  });
});

describe("sidecar dependency reuse opt-in", () => {
  const repoRoot = join(here, "..", "..");

  it("turns reuse on only for the local hotfix bundle step", () => {
    const source = readFileSync(join(here, "build-local-hotfix.mjs"), "utf8");
    const main = source.slice(source.indexOf("async function main()"));
    expect(main).toContain('run(pnpm, ["--filter", "gg-app", "bundle:sidecar", "--reuse-deps"])');
  });

  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/phase-26-macos-dev.yml",
    ".github/ci/size-gate.mjs",
    "gg-app/package.json",
    "gg-app/scripts/smoke-sidecar.mjs",
  ])("keeps %s on the full-copy path", (path) => {
    expect(readFileSync(join(repoRoot, ...path.split("/")), "utf8")).not.toContain("--reuse-deps");
  });
});

describe("framework package build stamps", () => {
  const repoRoot = join(here, "..", "..");
  const nodeVersion = "v22.0.0";

  type BuildOptions = {
    force?: boolean;
    nodeVersion?: string;
    fail?: string;
    readFile?: (path: string) => Buffer;
  };

  function packagesFixture(): { root: string; stampDir: string } {
    const root = mkdtempSync(join(tmpdir(), "gg-local-packages-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{}}\n');
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    for (const { name, dir } of FRAMEWORK_PACKAGES) {
      const packageRoot = join(root, "packages", dir);
      mkdirSync(join(packageRoot, "src", "nested"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
      writeFileSync(join(packageRoot, "tsconfig.json"), '{"extends":"../../tsconfig.json"}\n');
      if (dir === "ggcoder") writeFileSync(join(packageRoot, "tsconfig.build.json"), "{}\n");
      else writeFileSync(join(packageRoot, "tsup.config.ts"), "export default {};\n");
      writeFileSync(join(packageRoot, "src", "index.ts"), `export const name = "${dir}";\n`);
      writeFileSync(join(packageRoot, "src", "nested", "util.ts"), "export const util = 1;\n");
    }
    return { root, stampDir: join(root, ".gg", "local-fixes", "package-build-stamps") };
  }

  function build(root: string, stampDir: string, options: BuildOptions = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const result = buildFrameworkPackages({
      root,
      stampDir,
      force: options.force ?? false,
      nodeVersion: options.nodeVersion ?? nodeVersion,
      platform: "win32",
      arch: "x64",
      log: (line: string) => logs.push(line),
      ...(options.readFile ? { readFile: options.readFile } : {}),
      runBuild: (packageName: string) => {
        calls.push(packageName);
        if (packageName === options.fail) return 2;
        const pkg = FRAMEWORK_PACKAGES.find(({ name }) => name === packageName);
        const packageRoot = join(root, "packages", pkg!.dir);
        mkdirSync(join(packageRoot, "dist"), { recursive: true });
        writeFileSync(
          join(packageRoot, "dist", "index.js"),
          readFileSync(join(packageRoot, "src", "index.ts")),
        );
        return 0;
      },
    });
    return { ...result, calls, logs };
  }

  const all = FRAMEWORK_PACKAGES.map(({ name }) => name);
  const stampFile = (stampDir: string, dir: string) => join(stampDir, `${dir}.json`);

  it("keeps the gg-ai → gg-agent → gg-core → ggcoder order and dependency table", () => {
    expect(FRAMEWORK_PACKAGES.map(({ name, deps }) => [name, [...deps]])).toEqual([
      ["@kenkaiiii/gg-ai", []],
      ["@kenkaiiii/gg-agent", ["gg-ai"]],
      ["@kenkaiiii/gg-core", ["gg-ai"]],
      ["@kenkaiiii/ggcoder", ["gg-ai", "gg-agent", "gg-core"]],
    ]);
  });

  it("builds every package on the first run and stamps each one", () => {
    const { root, stampDir } = packagesFixture();
    const first = build(root, stampDir);
    expect(first.status).toBe(0);
    expect(first.calls).toEqual(all);
    for (const { name, dir } of FRAMEWORK_PACKAGES) {
      const read = readPackageBuildStamp(stampFile(stampDir, dir));
      expect(read.ok).toBe(true);
      expect(read.ok && read.stamp.package).toBe(name);
    }
  });

  it("skips every package when nothing changed", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    const second = build(root, stampDir);
    expect(second.status).toBe(0);
    expect(second.calls).toEqual([]);
    expect(second.results.map(({ built, reason }) => [built, reason])).toEqual(
      all.map(() => [false, "inputs and output unchanged"]),
    );
  });

  it("rebuilds a changed package and its dependants only", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    writeFileSync(
      join(root, "packages", "gg-core", "src", "nested", "util.ts"),
      "export const util = 2;\n",
    );
    const next = build(root, stampDir);
    expect(next.calls).toEqual(["@kenkaiiii/gg-core", "@kenkaiiii/ggcoder"]);
    expect(next.results.find(({ name }) => name === "@kenkaiiii/gg-core")?.reason).toBe(
      "inputs changed",
    );
    expect(build(root, stampDir).calls).toEqual([]);
  });

  it("rebuilds a package when a source file is added", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    writeFileSync(join(root, "packages", "gg-agent", "src", "extra.ts"), "export {};\n");
    expect(build(root, stampDir).calls).toEqual(["@kenkaiiii/gg-agent", "@kenkaiiii/ggcoder"]);
  });

  it.each([
    [
      "gg-ai package.json",
      "packages/gg-ai/package.json",
      '{"name":"@kenkaiiii/gg-ai","version":"1.0.1"}',
    ],
    ["gg-ai tsup config", "packages/gg-ai/tsup.config.ts", "export default { clean: false };\n"],
    ["root lockfile", "pnpm-lock.yaml", "lockfileVersion: '9.1'\n"],
    ["root tsconfig", "tsconfig.json", '{"compilerOptions":{"strict":true}}\n'],
  ])("rebuilds everything when the %s changes", (_label, path, content) => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    writeFileSync(join(root, ...path.split("/")), content);
    expect(build(root, stampDir).calls).toEqual(all);
  });

  it("rebuilds a package when an optional config file appears", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    writeFileSync(join(root, "packages", "ggcoder", "tsup.config.ts"), "export default {};\n");
    expect(build(root, stampDir).calls).toEqual(["@kenkaiiii/ggcoder"]);
  });

  it("rebuilds everything when the Node version changes", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    expect(build(root, stampDir, { nodeVersion: "v24.0.0" }).calls).toEqual(all);
  });

  it("rebuilds a package with missing output and cascades to its dependants", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    rmSync(join(root, "packages", "gg-ai", "dist"), { force: true, recursive: true });
    const next = build(root, stampDir);
    expect(next.calls).toEqual(all);
    expect(next.results.map(({ reason }) => reason)).toEqual([
      "output missing",
      "a package it depends on was rebuilt",
      "a package it depends on was rebuilt",
      "a package it depends on was rebuilt",
    ]);
  });

  it("rebuilds a package whose output is empty or was edited after stamping", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    writeFileSync(join(root, "packages", "gg-agent", "dist", "index.js"), "tampered\n");
    const edited = build(root, stampDir);
    expect(edited.calls).toEqual(["@kenkaiiii/gg-agent", "@kenkaiiii/ggcoder"]);
    expect(edited.results[1]?.reason).toBe("output changed since it was stamped");

    rmSync(join(root, "packages", "ggcoder", "dist"), { force: true, recursive: true });
    mkdirSync(join(root, "packages", "ggcoder", "dist"));
    const empty = build(root, stampDir);
    expect(empty.calls).toEqual(["@kenkaiiii/ggcoder"]);
    expect(empty.results[3]?.reason).toBe("output missing");
  });

  it("rebuilds and restamps everything when forced", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    const forced = build(root, stampDir, { force: true });
    expect(forced.calls).toEqual(all);
    expect(forced.results.every(({ reason }) => reason === "forced")).toBe(true);
    expect(build(root, stampDir).calls).toEqual([]);
  });

  it("stops at a failed build, removes its old stamp and leaves later packages unbuilt", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    writeFileSync(
      join(root, "packages", "gg-agent", "src", "index.ts"),
      "export const changed = 1;\n",
    );
    const failed = build(root, stampDir, { fail: "@kenkaiiii/gg-agent" });
    expect(failed.status).toBe(2);
    expect(failed.calls).toEqual(["@kenkaiiii/gg-agent"]);
    expect(failed.results.map(({ name, built }) => [name, built])).toEqual([
      ["@kenkaiiii/gg-ai", false],
      ["@kenkaiiii/gg-agent", false],
    ]);
    expect(existsSync(stampFile(stampDir, "gg-agent"))).toBe(false);
    expect(readdirSync(stampDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(build(root, stampDir).calls).toEqual(["@kenkaiiii/gg-agent", "@kenkaiiii/ggcoder"]);
  });

  it.each([
    ["is not valid JSON", () => "{not json", "stamp is not valid JSON"],
    [
      "has another schema",
      (stamp: Record<string, unknown>) => JSON.stringify({ ...stamp, schema: "other/1" }),
      "stamp schema differs",
    ],
    [
      "fails its checksum",
      (stamp: Record<string, unknown>) => JSON.stringify({ ...stamp, output: "0".repeat(64) }),
      "stamp checksum mismatch",
    ],
    [
      "has malformed fields",
      (stamp: Record<string, unknown>) => JSON.stringify({ ...stamp, fingerprint: "short" }),
      "stamp fields are malformed",
    ],
  ])("rebuilds when the stamp %s", (_label, corrupt, reason) => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    const path = stampFile(stampDir, "gg-ai");
    writeFileSync(path, corrupt(JSON.parse(readFileSync(path, "utf8"))));
    const next = build(root, stampDir);
    expect(next.calls).toEqual(all);
    expect(next.results[0]?.reason).toBe(reason);
  });

  it("rebuilds when a stamp is missing", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    rmSync(stampFile(stampDir, "gg-core"));
    const next = build(root, stampDir);
    expect(next.calls).toEqual(["@kenkaiiii/gg-core", "@kenkaiiii/ggcoder"]);
    expect(next.results[2]?.reason).toBe("no stamp");
  });

  it("rebuilds a package and its dependants when its inputs cannot be hashed", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    const failingSource = join(root, "packages", "gg-core", "src", "index.ts");
    const readFile = (path: string) => {
      if (path === failingSource) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      return readFileSync(path);
    };
    const next = build(root, stampDir, { readFile });
    expect(next.calls).toEqual(["@kenkaiiii/gg-core", "@kenkaiiii/ggcoder"]);
    expect(next.results[2]?.reason).toBe("inputs could not be hashed (locked)");
    expect(existsSync(stampFile(stampDir, "gg-core"))).toBe(false);
    expect(build(root, stampDir).calls).toEqual(["@kenkaiiii/gg-core", "@kenkaiiii/ggcoder"]);
  });

  it("treats any error in the build check as a reason to build", () => {
    const { root, stampDir } = packagesFixture();
    build(root, stampDir);
    const decision = decidePackageBuild({
      stampPath: stampFile(stampDir, "gg-ai"),
      pkg: "@kenkaiiii/gg-ai",
      fingerprint: JSON.parse(readFileSync(stampFile(stampDir, "gg-ai"), "utf8")).fingerprint,
      outputDir: join(root, "packages", "gg-ai", "dist"),
      readFile: () => {
        throw new Error("disk gone");
      },
    });
    expect(decision).toEqual({ build: true, reason: "build check failed: disk gone" });
  });

  it("hashes trees by content and path, independent of timestamps", () => {
    const { root } = packagesFixture();
    const src = join(root, "packages", "gg-ai", "src");
    const before = treeContentHash(src);
    utimesSync(join(src, "index.ts"), new Date(0), new Date(0));
    expect(treeContentHash(src)).toEqual(before);
    writeFileSync(join(src, "index.ts"), "export const name = 'changed';\n");
    expect(treeContentHash(src).hash).not.toBe(before.hash);
  });

  it("parses the force flag alone or with Installed Smoke and rejects anything else", () => {
    expect(parseLocalBuildArgs([], "win32")).toEqual({
      installedSmoke: false,
      forcePackageBuilds: false,
    });
    expect(parseLocalBuildArgs(["--installed-smoke"], "win32")).toEqual({
      installedSmoke: true,
      forcePackageBuilds: false,
    });
    expect(parseLocalBuildArgs(["--force-package-builds"], "darwin")).toEqual({
      installedSmoke: false,
      forcePackageBuilds: true,
    });
    expect(parseLocalBuildArgs(["--installed-smoke", "--force-package-builds"], "win32")).toEqual({
      installedSmoke: true,
      forcePackageBuilds: true,
    });
    expect(() => parseLocalBuildArgs(["--installed-smoke"], "darwin")).toThrow(
      "Installed Smoke packaging requires Windows.",
    );
    expect(() => parseLocalBuildArgs(["--unknown"], "win32")).toThrow("Usage");
    expect(() =>
      parseLocalBuildArgs(["--force-package-builds", "--force-package-builds"], "win32"),
    ).toThrow("Usage");
  });

  it("runs the package step through the stamps with the real pnpm build command", () => {
    const source = readFileSync(join(here, "build-local-hotfix.mjs"), "utf8");
    const main = source.slice(source.indexOf("async function main()"));
    expect(main).toContain(
      'runBuild: (packageName) => run(pnpm, ["--filter", packageName, "build"])',
    );
    expect(main).toContain('join(repoRoot, ".gg", "local-fixes", "package-build-stamps")');
    expect(main).toContain("force: forcePackageBuilds");
  });

  it("leaves the root build unchanged", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(rootPackage.scripts.build).toBe("pnpm -r build");
  });

  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/phase-26-macos-dev.yml",
    ".github/ci/size-gate.mjs",
    "package.json",
    "gg-app/package.json",
    "packages/gg-ai/package.json",
    "packages/gg-agent/package.json",
    "packages/gg-core/package.json",
    "packages/ggcoder/package.json",
  ])("keeps %s free of package build stamps", (path) => {
    const text = readFileSync(join(repoRoot, ...path.split("/")), "utf8");
    expect(text).not.toContain("package-build-stamps");
    expect(text).not.toContain("--force-package-builds");
  });
});
