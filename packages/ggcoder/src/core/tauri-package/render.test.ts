import { describe, expect, it } from "vitest";
import { normalizedContentSha256, detectHostTarget, sha256 } from "./paths.js";
import { parseGeneratedMarker } from "./ownership.js";
import { renderTauriSupport } from "./render.js";
import { DISCOVERY_SCHEMA_VERSION, type TauriCandidate, type TauriDiscoveryResult } from "./types.js";

function input(): { discovery: TauriDiscoveryResult; target: TauriCandidate } {
  const host = detectHostTarget();
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
    required_roles: [{ role: "app", minimum: 1, directly_runnable: true }, { role: "bundle", minimum: 0, directly_runnable: false }],
    source_paths: ["apps/desktop/package.json"],
  };
  const sources = [{ path: "apps/desktop/package.json", role: "workspace-package" as const, sha256: sha256("fixture") }];
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
    expect(first.map((file) => file.bytes.equals(second.find((item) => item.path === file.path)!.bytes))).toEqual(
      Array(6).fill(true),
    );
  });

  it("keeps project-specific values only in configuration", () => {
    const { discovery, target } = input();
    const rendered = renderTauriSupport(discovery, target);
    const config = rendered.find((file) => file.path.endsWith(".json"))!;
    const fixed = rendered.filter((file) => file !== config).map((file) => file.bytes.toString("utf8")).join("\n");

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
});
