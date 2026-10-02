import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  committedReleaseNotes,
  freshInstallerForPlatform,
  installedSmokeBuildRequested,
  installerManifest,
  INSTALLED_SMOKE_IDENTITY,
  LOCAL_FORK_IDENTITY,
  localBuildConfigPaths,
  releaseNotesEnvelope,
  runWithCargoTomlRestored,
  tauriBuildArgs,
  validateLocalReleaseNotes,
  windowsNsisPayloadMetadata,
} from "./build-local-hotfix.mjs";

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

  it("requires an explicit Windows-only Installed Smoke flavor", () => {
    expect(installedSmokeBuildRequested([], "win32")).toBe(false);
    expect(installedSmokeBuildRequested(["--installed-smoke"], "win32")).toBe(true);
    expect(() => installedSmokeBuildRequested(["--installed-smoke"], "darwin")).toThrow(
      "requires Windows",
    );
    expect(() => installedSmokeBuildRequested(["--unknown"], "win32")).toThrow("Usage");
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
