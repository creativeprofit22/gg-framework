import { canonicalJson, CONTENT_DIGEST_SENTINEL, GENERATED_PATHS, sha256 } from "./paths.js";
import { finalizeGeneratedContent, generatedMarker } from "./ownership.js";
import { PACKAGE_COMMAND_TEMPLATE } from "./templates/package-command.js";
import { PACKAGE_SCRIPT_TEMPLATE } from "./templates/package-script.js";
import { PACKAGE_TEST_TEMPLATE } from "./templates/package-test.js";
import { SMOKE_SCRIPT_TEMPLATE } from "./templates/smoke-script.js";
import { SMOKE_TEST_TEMPLATE } from "./templates/smoke-test.js";
import {
  GENERATED_CONFIG_SCHEMA_VERSION,
  TEMPLATE_VERSION,
  type CalibrationBounds,
  type GeneratedFile,
  type GeneratedTauriConfig,
  type TauriCandidate,
  type TauriDiscoveryResult,
} from "./types.js";

const FIXED_TEMPLATES = [
  [GENERATED_PATHS[0], PACKAGE_SCRIPT_TEMPLATE],
  [GENERATED_PATHS[1], PACKAGE_TEST_TEMPLATE],
  [GENERATED_PATHS[2], SMOKE_SCRIPT_TEMPLATE],
  [GENERATED_PATHS[3], SMOKE_TEST_TEMPLATE],
  [GENERATED_PATHS[5], PACKAGE_COMMAND_TEMPLATE],
] as const;
const CONFIG_TEMPLATE_IDENTITY = "ggcoder-tauri-package-config-schema-v1";

export function renderTauriSupport(
  discovery: TauriDiscoveryResult,
  target: TauriCandidate,
  calibration: CalibrationBounds | null = null,
): GeneratedFile[] {
  const discovered = discovery.targets.find(
    (candidate) => candidate.target_id === target.target_id,
  );
  if (!discovered || JSON.stringify(discovered) !== JSON.stringify(target)) {
    throw new Error(`Target is not an exact candidate from this discovery: ${target.target_id}`);
  }
  const rendered = FIXED_TEMPLATES.map(([repositoryPath, template]) =>
    renderFixed(repositoryPath, template),
  );
  rendered.push(renderConfig(discovery, target, calibration));
  const byPath = new Map(rendered.map((file) => [file.path, file]));
  return GENERATED_PATHS.map((repositoryPath) => byPath.get(repositoryPath)!);
}

function renderFixed(repositoryPath: string, template: string): GeneratedFile {
  const templateSha256 = sha256(template);
  const marker = generatedMarker(templateSha256, CONTENT_DIGEST_SENTINEL);
  const placeholder = repositoryPath.endsWith(".md") ? "<!--__GG_MARKER__-->" : "/*__GG_MARKER__*/";
  const replacement = repositoryPath.endsWith(".md") ? `<!-- ${marker} -->` : `// ${marker}`;
  if (template.split(placeholder).length !== 2)
    throw new Error(`Invalid fixed template marker: ${repositoryPath}`);
  const final = finalizeGeneratedContent(template.replace(placeholder, replacement));
  return {
    path: repositoryPath,
    bytes: final.bytes,
    template_sha256: templateSha256,
    content_sha256: final.contentSha256,
  };
}

function renderConfig(
  discovery: TauriDiscoveryResult,
  target: TauriCandidate,
  calibration: CalibrationBounds | null,
): GeneratedFile {
  const templateSha256 = sha256(CONFIG_TEMPLATE_IDENTITY);
  const config: GeneratedTauriConfig = {
    schema_version: GENERATED_CONFIG_SCHEMA_VERSION,
    template_version: TEMPLATE_VERSION,
    ownership: generatedMarker(templateSha256, CONTENT_DIGEST_SENTINEL),
    evidence_sha256: discovery.evidence_sha256,
    target,
    sources: discovery.evidence.sources,
    calibration,
  };
  const provisional = canonicalJson(config);
  const final = finalizeGeneratedContent(provisional);
  return {
    path: GENERATED_PATHS[4],
    bytes: final.bytes,
    template_sha256: templateSha256,
    content_sha256: final.contentSha256,
  };
}

export const EXPECTED_TEMPLATE_SHA256 = Object.fromEntries([
  ...FIXED_TEMPLATES.map(([repositoryPath, template]) => [repositoryPath, sha256(template)]),
  [GENERATED_PATHS[4], sha256(CONFIG_TEMPLATE_IDENTITY)],
]) as Record<(typeof GENERATED_PATHS)[number], string>;
