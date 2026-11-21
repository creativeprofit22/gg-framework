import { describe, expect, it } from "vitest";
import { normalizedContentSha256, detectHostTarget, sha256 } from "./paths.js";
import { parseGeneratedMarker } from "./ownership.js";
import { renderTauriSupport } from "./render.js";
import {
  DISCOVERY_SCHEMA_VERSION,
  type CalibrationBounds,
  type HostTarget,
  type TauriCandidate,
  type TauriDiscoveryResult,
} from "./types.js";

function input(host: HostTarget = detectHostTarget()): {
  discovery: TauriDiscoveryResult;
  target: TauriCandidate;
} {
  const target: TauriCandidate = {
    target_id: "tauri-fixture-target",
    package_root: "apps/desktop",
    package_manifest: "apps/desktop/package.json",
    cargo_manifest: "apps/desktop/src-tauri/Cargo.toml",
    tauri_config: "apps/desktop/src-tauri/tauri.conf.json",
    cli_package: "apps/desktop/node_modules/@tauri-apps/cli/package.json",
    cli_bin: "apps/desktop/node_modules/@tauri-apps/cli/tauri.js",
    cli_version: "2.11.2",
    product_name: "Fixture",
    identifier: "com.example.fixture",
    host,
    artifact_root: "artifacts/tauri/tauri-fixture-target",
    resources: [],
    sidecars: [],
    prune: [],
    required_roles: [
      { role: "app", minimum: 1, directly_runnable: true },
      { role: "bundle", minimum: 0, directly_runnable: false },
    ],
    source_paths: ["apps/desktop/package.json"],
  };
  const sources = [
    {
      path: "apps/desktop/package.json",
      role: "workspace-package" as const,
      sha256: sha256("fixture"),
    },
  ];
  const evidence: TauriDiscoveryResult["evidence"] = {
    schema_version: DISCOVERY_SCHEMA_VERSION,
    host,
    candidates: [target],
    sources,
    issues: [],
  };
  const discovery: TauriDiscoveryResult = {
    evidence,
    evidence_sha256: sha256(JSON.stringify(evidence)),
    targets: [target],
    summary: "fixture",
  };
  return { discovery, target };
}

describe("renderTauriSupport", () => {
  it("renders byte-identical six-file sets independently", () => {
    const { discovery, target } = input();
    const first = renderTauriSupport(discovery, target);
    const second = renderTauriSupport(structuredClone(discovery), structuredClone(target));

    expect(first.map((file) => file.path)).toEqual([
      "scripts/package-tauri.mjs",
      "scripts/package-tauri.test.mjs",
      "scripts/smoke-tauri-package.mjs",
      "scripts/smoke-tauri-package.test.mjs",
      "scripts/package-tauri.config.json",
      ".gg/commands/package-tauri.md",
    ]);
    expect(
      first.map((file) => file.bytes.equals(second.find((item) => item.path === file.path)!.bytes)),
    ).toEqual(Array(6).fill(true));
  });

  it("keeps project-specific values only in configuration", () => {
    const { discovery, target } = input();
    const rendered = renderTauriSupport(discovery, target);
    const config = rendered.find((file) => file.path.endsWith(".json"))!;
    const fixed = rendered
      .filter((file) => file !== config)
      .map((file) => file.bytes.toString("utf8"))
      .join("\n");

    expect(config.bytes.toString("utf8")).toContain("apps/desktop");
    expect(fixed).not.toContain("apps/desktop");
    expect(fixed).not.toContain(target.target_id);
  });

  it("emits valid ownership and normalized content digests", () => {
    const { discovery, target } = input();
    for (const file of renderTauriSupport(discovery, target)) {
      const content = file.bytes.toString("utf8");
      expect(parseGeneratedMarker(content)).toMatchObject({ contentSha256: file.content_sha256 });
      expect(normalizedContentSha256(content)).toBe(file.content_sha256);
    }
  });

  it("keeps golden byte digests for a fixed host with and without calibration", () => {
    const host: HostTarget = {
      platform: "win32",
      arch: "x64",
      id: "win32-x64",
      rust_triple: "x86_64-pc-windows-msvc",
    };
    const { discovery, target } = input(host);
    const calibration: CalibrationBounds = {
      evidence_sha256: discovery.evidence_sha256,
      baseline_total_bytes: 1000,
      maximum_total_bytes: 2000,
      maximum_file_bytes: 1500,
      role_counts: { app: 1, bundle: 0 },
      role_maximum_bytes: { app: 1500, bundle: 0 },
      required_paths: ["app/Fixture.exe"],
      absolute_growth_bytes: 500,
      percentage_growth: 10,
    };
    const digests = (files: ReturnType<typeof renderTauriSupport>) =>
      Object.fromEntries(files.map((file) => [file.path, sha256(file.bytes)]));

    expect(digests(renderTauriSupport(discovery, target))).toMatchInlineSnapshot(`
      {
        ".gg/commands/package-tauri.md": "1454faf5f5cef60957022ca738217871278c41f9b52b55b504c0765c7d94a752",
        "scripts/package-tauri.config.json": "fa299590a7fe45c7db70dad1ffab74f5e94ecee61214be7915599545e9681d4c",
        "scripts/package-tauri.mjs": "a893ecb4087e87f0f68dc35e15c90f46fa65677e7b6089d6c6eb445864fc934a",
        "scripts/package-tauri.test.mjs": "e26d2eb0ed3cb728b147cecc51a3614cda9576c4bec6ef61d2aac4fdfba7cc02",
        "scripts/smoke-tauri-package.mjs": "8114ea0787786466a17897acb4bbac1f3955bb39f2860f27859ec79dbbdf85fd",
        "scripts/smoke-tauri-package.test.mjs": "30162244b6b1e65ca73d73844ea3a26be2713af9140bd86bb8bdcddd3b0178e1",
      }
    `);
    expect(digests(renderTauriSupport(discovery, target, calibration))).toMatchInlineSnapshot(`
      {
        ".gg/commands/package-tauri.md": "1454faf5f5cef60957022ca738217871278c41f9b52b55b504c0765c7d94a752",
        "scripts/package-tauri.config.json": "c44f95bb99b02c8113492409ee3045156c568ad4d1eee4cf8bf14c5fff7674b8",
        "scripts/package-tauri.mjs": "a893ecb4087e87f0f68dc35e15c90f46fa65677e7b6089d6c6eb445864fc934a",
        "scripts/package-tauri.test.mjs": "e26d2eb0ed3cb728b147cecc51a3614cda9576c4bec6ef61d2aac4fdfba7cc02",
        "scripts/smoke-tauri-package.mjs": "8114ea0787786466a17897acb4bbac1f3955bb39f2860f27859ec79dbbdf85fd",
        "scripts/smoke-tauri-package.test.mjs": "30162244b6b1e65ca73d73844ea3a26be2713af9140bd86bb8bdcddd3b0178e1",
      }
    `);
  });
});
